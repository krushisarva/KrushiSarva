/**
 * Rent booking payments (PAY-002).
 *
 * ── What this suite is actually protecting ───────────────────────────────────
 * A booking holds a SLOT, which is indivisible: there is no partial fulfilment
 * and no second unit to sell. So the failure this code exists to prevent is not
 * overselling in the shop's sense — it is KEEPING MONEY FOR A SLOT SOMEBODY ELSE
 * TOOK. That cannot be designed away, because the money moves at the gateway,
 * outside any database transaction; what can be guaranteed is that the money
 * goes straight back and the farmer is told so.
 *
 * The mechanism under test is a Serializable transaction that does the
 * availability check, the re-pricing and the `bookings` INSERT together:
 *
 *     BEGIN ISOLATION LEVEL SERIALIZABLE
 *       SELECT ... FROM bookings WHERE <listing> AND <range overlaps>   -- free?
 *       <re-price from the listing>                                     -- moved?
 *       INSERT INTO bookings ...                                        -- take it
 *       UPDATE payment_intents SET status='ORDER_CREATED' WHERE id=$1
 *              AND status NOT IN ('REFUND_INITIATED','REFUNDED')        -- claim
 *     COMMIT
 *
 * Two farmers confirming the same slot both read "free", both insert, and
 * Postgres aborts one with 40001. withSerializableRetry replays it, the replay
 * sees the winner's booking, and the loser is refunded instead of double-booked.
 * `concurrent confirm on the same slot` attacks exactly that.
 *
 * The second property is price authority: the client sends dates and a listing,
 * never an amount. `a client-supplied amount is ignored` is the test that stops
 * that eroding.
 *
 * The third is that the LEGACY unpaid POST /rent/bookings still works untouched
 * — installed app builds call it, and it is the fallback when the gateway is
 * down. `the legacy unpaid endpoint is unchanged` pins that.
 *
 * ── How the gateway is faked ─────────────────────────────────────────────────
 * payment.service.js is mocked, so nothing here reaches the network or spends
 * money. The fake reproduces the real module's two modes faithfully:
 *   mock mode  (no keys)  → orders get a `mock_` id and every signature passes
 *   keyed mode            → a signature is valid only if it matches the pair
 * which is what makes the tampered-signature test meaningful at all: against the
 * real module with no keys configured, verifyPaymentSignature returns true for
 * everything.
 *
 * Raw-body webhook signature verification is NOT re-tested here — it has one
 * implementation for the whole application and shopPayment.api.test.js owns it.
 */
import { jest } from '@jest/globals';

/** Flipped per test: false = keys configured, true = no keys (mock mode). */
const gateway = { mock: false };

let orderSeq = 0;
/** Every order this suite handed out, so fetchPaymentOrder can answer honestly. */
const issuedOrders = new Map();
/** Every refund the code under test asked for, keyed by payment id. */
const refunds = [];

/** The shape a real Razorpay checkout signature binds: order id + payment id. */
const fakeSignature = (orderId, paymentId) => `sig_${orderId}_${paymentId}`;

jest.unstable_mockModule('../../../src/services/payment.service.js', () => ({
  createPaymentOrder: jest.fn(async (amountInPaise, currency = 'INR', receipt = '') => {
    const id = `${gateway.mock ? 'mock_order' : 'order'}_rent_${Date.now()}_${++orderSeq}`;
    const order = { id, amount: amountInPaise, currency, receipt, status: 'created', ...(gateway.mock ? { mock: true } : {}) };
    issuedOrders.set(id, order);
    return order;
  }),
  fetchPaymentOrder: jest.fn(async (id) => (gateway.mock
    ? { id, mock: true }
    : issuedOrders.get(id) || { id, amount: 0, receipt: 'unknown' })),
  verifyPaymentSignature: jest.fn((orderId, paymentId, signature) =>
    (gateway.mock ? true : signature === fakeSignature(orderId, paymentId))),
  verifyWebhookSignature: jest.fn(() => true),
  fetchPayment: jest.fn(async (id) => ({ id, status: 'captured' })),
  fetchOrderPayments: jest.fn(async () => null),
  isMockPayments: () => gateway.mock,
  processRefund: jest.fn(async (paymentId, amountPaise) => {
    refunds.push({ paymentId, amountPaise });
    return { id: `rfnd_${paymentId}`, payment_id: paymentId, amount: amountPaise, status: 'processed' };
  }),
}));

const { default: request } = await import('supertest');
const { getApp, createTestUser, createTestMachinery, cleanupTestData, prisma } = await import('../../fixtures/setup.js');
const { rentWebhookHandler } = await import('../../../src/services/rentPayment.service.js');
const {
  claimWebhookEvent, finishWebhookEvent, markIntentPaid, findIntent,
} = await import('../../../src/services/paymentIntent.service.js');

const API = '/api/v1/rent';

/** ₹2500/day for three days (inclusive) — the fixture tractor. */
const RATE = 2500;
const START = '2031-03-03';
const END = '2031-03-05';
const DAYS = 3;
const TOTAL = RATE * DAYS;          // 7500
const TOTAL_PAISE = TOTAL * 100;    // advancePct defaults to 100 → payable == total

let app; let farmer; let other; let owner; let machinery; let paySeq = 0;

beforeAll(async () => {
  app = await getApp();
}, 60_000);

beforeEach(async () => {
  gateway.mock = false;
  issuedOrders.clear();
  refunds.length = 0;
  owner = await createTestUser({ name: 'Rent Owner' });
  farmer = await createTestUser({ name: 'Rent Payer' });
  other = await createTestUser({ name: 'Rent Rival' });
  machinery = await createTestMachinery(owner.user.id, { pricePerDay: RATE });
  await prisma.paymentWebhookEvent.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.paymentIntent.deleteMany();
}, 30_000);

afterAll(async () => { await cleanupTestData(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

const initiate = (user = farmer, body = {}) =>
  request(app).post(`${API}/bookings/initiate`).set(user.headers).send({
    listingId: machinery.id, type: 'machinery', startDate: START, endDate: END, ...body,
  });

const confirm = (user, body) =>
  request(app).post(`${API}/bookings/confirm`).set(user.headers).send(body);

const statusOf = (user, providerOrderId) =>
  request(app).get(`${API}/bookings/payment-status/${providerOrderId}`).set(user.headers);

const bookingsFor = (listingId) =>
  prisma.booking.findMany({ where: { machineryListingId: listingId } });

/** initiate → the ids a real checkout would come back with. */
async function startBooking(user = farmer, body = {}) {
  const res = await initiate(user, body);
  expect(res.status).toBe(200);
  const razorpayOrderId = res.body.data.razorpayOrderId;
  const razorpayPaymentId = `pay_rent_${++paySeq}_${Date.now()}`;
  return {
    res,
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature: fakeSignature(razorpayOrderId, razorpayPaymentId),
  };
}

/**
 * Deliver a `payment.captured` the way routes/paymentWebhooks.routes.js does:
 * claim the event id through its UNIQUE index, record the money against the
 * intent, then hand it to the purpose handler.
 *
 * Replayed here rather than POSTed to the endpoint so these tests exercise the
 * rent handler independently of the one-line PURPOSE_HANDLERS registration,
 * which lives in a shared file and is asserted separately below.
 *
 * @returns {Promise<boolean>} false when the event id was a redelivery (the
 *          dispatcher's short-circuit — no handler runs at all).
 */
async function deliverCapture(providerOrderId, providerPaymentId) {
  const eventId = `payment.captured:${providerPaymentId}`;
  const claimed = await claimWebhookEvent({
    eventId, eventType: 'payment.captured', providerOrderId, providerPaymentId, payloadDigest: `digest_${eventId}`,
  });
  if (!claimed) return false;

  await markIntentPaid({ providerOrderId, providerPaymentId });
  const intent = await findIntent(providerOrderId);
  await rentWebhookHandler.captured({ intent, providerOrderId, providerPaymentId });
  await finishWebhookEvent(eventId, { status: 'PROCESSED' });
  return true;
}

// ── Pricing ───────────────────────────────────────────────────────────────────

describe('POST /rent/bookings/initiate', () => {
  test('prices the booking from the listing and the date range, in integer paise', async () => {
    const res = await initiate();

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({
      razorpayOrderId: expect.any(String),
      amount: String(TOTAL.toFixed(2)),
      amountInPaise: TOTAL_PAISE,
      currency: 'INR',
      receipt: expect.any(String),
      mock: false,
    }));
    expect(res.body.data.quote).toEqual({
      days: DAYS,
      rate: RATE.toFixed(2),
      total: TOTAL.toFixed(2),
      advancePct: 100,
      payable: TOTAL.toFixed(2),
    });
    // Integer paise at the gateway boundary — never `price * 100` on a float.
    expect(Number.isSafeInteger(res.body.data.amountInPaise)).toBe(true);
    // The listing row itself must never reach the client through the quote.
    expect(res.body.data.quote.listing).toBeUndefined();
  });

  test('records a RENT_BOOKING intent with the quote frozen into it, and no booking yet', async () => {
    const { razorpayOrderId } = await startBooking();

    const intent = await prisma.paymentIntent.findUnique({ where: { providerOrderId: razorpayOrderId } });
    expect(intent).toMatchObject({
      userId: farmer.user.id,
      purpose: 'RENT_BOOKING',
      refType: 'booking',
      refId: null,
      status: 'CREATED',
      amountPaise: TOTAL_PAISE,
    });
    expect(intent.metadata).toMatchObject({ type: 'machinery', listingId: machinery.id, days: DAYS, payable: TOTAL.toFixed(2) });

    // Nothing is held and nothing is created until the money is confirmed.
    expect(await bookingsFor(machinery.id)).toHaveLength(0);
  });

  test('a client-supplied amount is ignored — the server prices the booking', async () => {
    const res = await initiate(farmer, { totalAmount: 1, amount: 1, payable: 1, amountInPaise: 100 });

    expect(res.status).toBe(200);
    expect(res.body.data.amountInPaise).toBe(TOTAL_PAISE);
    expect(res.body.data.quote.total).toBe(TOTAL.toFixed(2));

    const intent = await prisma.paymentIntent.findUnique({
      where: { providerOrderId: res.body.data.razorpayOrderId },
    });
    expect(intent.amountPaise).toBe(TOTAL_PAISE);
  });

  test('the billed day count comes from the range, not from a `days` field', async () => {
    // 1–30 March with days:1 used to block the machine for a month and charge
    // for a day. The range is the only thing both sides can verify.
    const res = await initiate(farmer, { startDate: '2031-03-01', endDate: '2031-03-30', days: 1 });

    expect(res.status).toBe(200);
    expect(res.body.data.quote.days).toBe(30);
    expect(res.body.data.amountInPaise).toBe(RATE * 30 * 100);
  });

  test('refuses an already-booked slot with 409 before any payment sheet opens', async () => {
    await prisma.booking.create({
      data: {
        userId: other.user.id, machineryListingId: machinery.id,
        startDate: new Date(START), endDate: new Date(END),
        days: DAYS, totalAmount: TOTAL, status: 'CONFIRMED',
      },
    });

    const res = await initiate();
    expect(res.status).toBe(409);
    expect(await prisma.paymentIntent.count()).toBe(0);
  });

  test('refuses the owner booking their own listing, and requires auth', async () => {
    const mine = await initiate(owner);
    expect(mine.status).toBe(403);

    const anon = await request(app).post(`${API}/bookings/initiate`).send({
      listingId: machinery.id, type: 'machinery', startDate: START, endDate: END,
    });
    expect(anon.status).toBe(401);
  });
});

// ── Confirm: the happy path ───────────────────────────────────────────────────

describe('POST /rent/bookings/confirm', () => {
  test('happy path: initiate → confirm → the booking exists and is paid', async () => {
    const ids = await startBooking();
    const res = await confirm(farmer, ids);

    expect(res.status).toBe(200);
    expect(res.body.data.paymentStatus).toBe('PAID');
    expect(res.body.data.booking).toEqual(expect.objectContaining({
      userId: farmer.user.id,
      machineryListingId: machinery.id,
      days: DAYS,
      status: 'PENDING',
      paymentStatus: 'PAID',
    }));

    const [booking] = await bookingsFor(machinery.id);
    expect(booking).toBeTruthy();
    // Prisma.Decimal — compared numerically, because its toString() drops
    // trailing zeros ("7500", not "7500.00") and the precision is the point.
    expect(Number(booking.totalAmount)).toBe(TOTAL);
    expect(Number(booking.paidAmount)).toBe(TOTAL);
    expect(Number(booking.advanceAmount)).toBe(TOTAL);

    // The intent is bound to the booking it produced, in the same transaction.
    const intent = await findIntent(ids.razorpayOrderId);
    expect(intent).toMatchObject({
      status: 'ORDER_CREATED', refType: 'booking', refId: booking.id,
      providerPaymentId: ids.razorpayPaymentId,
    });
    expect(booking.paymentIntentId).toBe(intent.id);
    expect(refunds).toHaveLength(0);
  });

  test('a tampered signature is refused with 400 and creates no booking', async () => {
    const ids = await startBooking();

    const res = await confirm(farmer, { ...ids, razorpaySignature: 'sig_forged' });

    expect(res.status).toBe(400);
    expect(await bookingsFor(machinery.id)).toHaveLength(0);
    // Nothing was recorded against the payment either — the refusal is total.
    const intent = await findIntent(ids.razorpayOrderId);
    expect(intent.status).toBe('CREATED');
    expect(refunds).toHaveLength(0);
  });

  test("another farmer cannot confirm this farmer's payment", async () => {
    const ids = await startBooking(farmer);

    // A valid signature proves Razorpay signed the pair — NOT that the pair
    // belongs to the caller. The intent's userId is the authorization check.
    const res = await confirm(other, ids);

    expect(res.status).toBe(400);
    expect(await bookingsFor(machinery.id)).toHaveLength(0);
  });

  test('a retried confirm returns the same booking rather than making a second', async () => {
    const ids = await startBooking();

    const first = await confirm(farmer, ids);
    const second = await confirm(farmer, ids);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.booking.id).toBe(first.body.data.booking.id);
    expect(second.body.data.paymentStatus).toBe('PAID');
    expect(await bookingsFor(machinery.id)).toHaveLength(1);
  });

  test('the price moving between payment and confirmation refunds instead of booking', async () => {
    const ids = await startBooking();

    // The owner raises the daily rate while the farmer is on the payment sheet.
    await prisma.machineryListing.update({
      where: { id: machinery.id }, data: { pricePerDay: RATE * 2 },
    });

    const res = await confirm(farmer, ids);

    expect(res.status).toBe(409);
    expect(await bookingsFor(machinery.id)).toHaveLength(0);
    // The money is not kept for a booking that was never made.
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ paymentId: ids.razorpayPaymentId, amountPaise: TOTAL_PAISE });
    const intent = await findIntent(ids.razorpayOrderId);
    expect(['REFUND_INITIATED', 'REFUNDED']).toContain(intent.status);
  });
});

// ── The race this module exists for ───────────────────────────────────────────

describe('one slot, two paying farmers', () => {
  test('concurrent confirm on the same slot → exactly one booking and exactly one refund', async () => {
    // Both initiate before either confirms, so neither advisory check sees a
    // conflict — this is the window the Serializable transaction has to close.
    const a = await startBooking(farmer);
    const b = await startBooking(other);

    const [resA, resB] = await Promise.all([confirm(farmer, a), confirm(other, b)]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    // ONE booking for the slot. This is the whole point.
    const bookings = await bookingsFor(machinery.id);
    expect(bookings).toHaveLength(1);

    // …and the loser's money went back. Keeping it would be this module's
    // version of overselling.
    expect(refunds).toHaveLength(1);
    const loser = resA.status === 409 ? a : b;
    expect(refunds[0].paymentId).toBe(loser.razorpayPaymentId);

    const loserRes = resA.status === 409 ? resA : resB;
    expect(loserRes.body.error.details).toMatchObject({ refunded: true, paymentCaptured: true });
    expect(loserRes.body.error.message).toMatch(/refunded/i);

    const loserIntent = await findIntent(loser.razorpayOrderId);
    expect(['REFUND_INITIATED', 'REFUNDED']).toContain(loserIntent.status);
    expect(loserIntent.refId).toBeNull();
  });

  test('a confirm arriving after the slot was taken is refunded, not double-booked', async () => {
    const ids = await startBooking(farmer);

    // The rival books through the LEGACY unpaid endpoint while the farmer pays.
    await prisma.booking.create({
      data: {
        userId: other.user.id, machineryListingId: machinery.id,
        startDate: new Date(START), endDate: new Date(END),
        days: DAYS, totalAmount: TOTAL, status: 'PENDING',
      },
    });

    const res = await confirm(farmer, ids);

    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ refunded: true, code: 'SLOT_TAKEN' });
    expect(await bookingsFor(machinery.id)).toHaveLength(1); // the rival's, untouched
    expect(refunds).toHaveLength(1);
  });
});

// ── Webhook ordering ──────────────────────────────────────────────────────────

describe('webhook and confirm in either order', () => {
  test('webhook first: the intent is PAID with no booking, and confirm still creates one', async () => {
    const ids = await startBooking();

    expect(await deliverCapture(ids.razorpayOrderId, ids.razorpayPaymentId)).toBe(true);

    // A webhook CANNOT create the booking: it has no way to know the slot is
    // still free, and inventing one would race the confirm very likely in
    // flight. The confirm creates it; the reconciler is the backstop.
    let intent = await findIntent(ids.razorpayOrderId);
    expect(intent.status).toBe('PAID');
    expect(intent.refId).toBeNull();
    expect(await bookingsFor(machinery.id)).toHaveLength(0);

    const res = await confirm(farmer, ids);
    expect(res.status).toBe(200);
    expect(await bookingsFor(machinery.id)).toHaveLength(1);

    intent = await findIntent(ids.razorpayOrderId);
    expect(intent.status).toBe('ORDER_CREATED');
    expect(intent.refId).toBe(res.body.data.booking.id);
    expect(refunds).toHaveLength(0);
  });

  test('duplicate webhook delivery has a single effect', async () => {
    const ids = await startBooking();

    expect(await deliverCapture(ids.razorpayOrderId, ids.razorpayPaymentId)).toBe(true);
    // Redelivery is normal, not exceptional — Razorpay retries for 24 hours.
    // The event id is claimed through a UNIQUE index, so the second delivery
    // short-circuits before any handler runs.
    expect(await deliverCapture(ids.razorpayOrderId, ids.razorpayPaymentId)).toBe(false);

    expect(await prisma.paymentWebhookEvent.count()).toBe(1);
    expect(await bookingsFor(machinery.id)).toHaveLength(0);

    const res = await confirm(farmer, ids);
    expect(res.status).toBe(200);
    expect(await bookingsFor(machinery.id)).toHaveLength(1);
  });

  test('confirm first, then the webhook — the late capture binds to the booking it found', async () => {
    const ids = await startBooking();
    const res = await confirm(farmer, ids);
    expect(res.status).toBe(200);

    expect(await deliverCapture(ids.razorpayOrderId, ids.razorpayPaymentId)).toBe(true);

    // markIntentPaid never regresses a settled state, so ORDER_CREATED stands.
    const intent = await findIntent(ids.razorpayOrderId);
    expect(intent.status).toBe('ORDER_CREATED');
    expect(intent.refId).toBe(res.body.data.booking.id);
    expect(await bookingsFor(machinery.id)).toHaveLength(1);
  });

  test('a refund event marks the booking refunded rather than leaving it reading PAID', async () => {
    const ids = await startBooking();
    const res = await confirm(farmer, ids);
    const intent = await findIntent(ids.razorpayOrderId);

    await rentWebhookHandler.refunded({ intent, eventType: 'refund.processed' });

    const booking = await prisma.booking.findUnique({ where: { id: res.body.data.booking.id } });
    expect(booking.paymentStatus).toBe('REFUNDED');
  });
});

// ── Payment status ────────────────────────────────────────────────────────────

describe('GET /rent/bookings/payment-status/:providerOrderId', () => {
  test('reports the truth before and after confirmation', async () => {
    const ids = await startBooking();

    const before = await statusOf(farmer, ids.razorpayOrderId);
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual(expect.objectContaining({
      status: 'PENDING', paid: false, amount: TOTAL.toFixed(2), booking: null,
    }));

    await confirm(farmer, ids);

    const after = await statusOf(farmer, ids.razorpayOrderId);
    expect(after.status).toBe(200);
    expect(after.body.data.status).toBe('ORDER_CREATED');
    expect(after.body.data.paid).toBe(true);
    expect(after.body.data.booking).toEqual(expect.objectContaining({
      machineryListingId: machinery.id, paymentStatus: 'PAID',
    }));
  });

  test("another farmer's payment is a 404, not a peek", async () => {
    const ids = await startBooking(farmer);

    const res = await statusOf(other, ids.razorpayOrderId);
    expect(res.status).toBe(404);
  });

  test('an unknown reference is a 404 and auth is required', async () => {
    expect((await statusOf(farmer, 'order_does_not_exist')).status).toBe(404);
    expect((await request(app).get(`${API}/bookings/payment-status/whatever`)).status).toBe(401);
  });
});

// ── Mock mode ─────────────────────────────────────────────────────────────────

describe('mock mode (no gateway keys configured)', () => {
  test('a full booking completes with deterministic fake gateway responses', async () => {
    gateway.mock = true;

    const init = await initiate();
    expect(init.status).toBe(200);
    expect(init.body.data.mock).toBe(true);
    expect(init.body.data.razorpayOrderId).toMatch(/^mock_order_/);
    // Mock mode changes the gateway, never the price.
    expect(init.body.data.amountInPaise).toBe(TOTAL_PAISE);

    const razorpayOrderId = init.body.data.razorpayOrderId;
    const res = await confirm(farmer, {
      razorpayOrderId,
      razorpayPaymentId: `pay_mock_${Date.now()}`,
      // In mock mode nothing can be verified, so any signature passes — which is
      // precisely why every other test in this suite runs with keys configured.
      razorpaySignature: 'anything',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.booking.paymentStatus).toBe('PAID');
    expect(await bookingsFor(machinery.id)).toHaveLength(1);
  });
});

// ── The legacy path must not have moved ───────────────────────────────────────

describe('the legacy unpaid POST /rent/bookings', () => {
  test('still creates an UNPAID booking with no payment attached', async () => {
    // Installed APKs call this, and it is the fallback when the gateway is down.
    // A booking made here is unpaid — which is what every booking was until
    // PAY-002 — and must stay that way.
    const res = await request(app).post(`${API}/bookings`).set(farmer.headers).send({
      machineryListingId: machinery.id, startDate: START, endDate: END,
    });

    expect(res.status).toBe(201);
    const [booking] = await bookingsFor(machinery.id);
    expect(booking).toMatchObject({ paymentStatus: 'UNPAID', paymentIntentId: null });
    expect(Number(booking.paidAmount)).toBe(0);
    expect(booking.advanceAmount).toBeNull();
    expect(Number(booking.totalAmount)).toBe(TOTAL);
    expect(await prisma.paymentIntent.count()).toBe(0);
  });
});
