/**
 * AI credit-pack purchase (PAY-004).
 *
 * ── What this suite is actually protecting ───────────────────────────────────
 * Credits are fungible and spendable the instant they land, so a double grant
 * is minted money, not a cosmetic duplicate. Three callers converge on one
 * payment — the app's confirm, Razorpay's `payment.captured` (retried for 24
 * hours), and a retry of either — in any order. Every one of them must be able
 * to arrive first, arrive twice, and arrive concurrently, and the farmer must
 * end up with exactly one pack of credits.
 *
 * The mechanism under test is NOT a lock or a cache: the grant rides a
 * conditional transition of the payment intent row
 *
 *     UPDATE payment_intents SET status='ORDER_CREATED'
 *      WHERE id=$1 AND status NOT IN ('ORDER_CREATED','REFUND_INITIATED','REFUNDED')
 *
 * inside the same transaction as the balance increment. `providerOrderId` is
 * UNIQUE so there is exactly one row to race for, and Postgres re-evaluates the
 * WHERE after the winner commits, so the loser matches zero rows and grants
 * nothing. Tests 'duplicate delivery', 'webhook first', 'confirm first' and
 * 'simultaneous' each attack that from a different direction.
 *
 * The second property is price authority: the client names a PACK, never an
 * amount. `a price in the body is ignored` is the test that stops that eroding.
 *
 * ── How the gateway is faked ─────────────────────────────────────────────────
 * payment.service.js is mocked, so nothing here reaches the network or spends
 * money. The fake reproduces the real module's two modes faithfully:
 *   mock mode  (no keys)  → orders get a `mock_` id and every signature passes
 *   keyed mode            → a signature is valid only if it matches the pair
 * which is what makes the tampered-signature test meaningful at all: against
 * the real module with no keys configured, verifyPaymentSignature returns true
 * for everything.
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

/** The shape a real Razorpay checkout signature binds: order id + payment id. */
const fakeSignature = (orderId, paymentId) => `sig_${orderId}_${paymentId}`;

jest.unstable_mockModule('../../../src/services/payment.service.js', () => ({
  createPaymentOrder: jest.fn(async (amountInPaise, currency = 'INR', receipt = '') => {
    const id = `${gateway.mock ? 'mock_order' : 'order'}_credits_${Date.now()}_${++orderSeq}`;
    const order = { id, amount: amountInPaise, currency, receipt, status: 'created', ...(gateway.mock ? { mock: true } : {}) };
    issuedOrders.set(id, order);
    return order;
  }),
  fetchPaymentOrder: jest.fn(async (id) => (gateway.mock
    ? { id, mock: true }
    : issuedOrders.get(id) || { id, amount: 0, receipt: 'unknown' })),
  // Mirrors the real module: in mock mode nothing can be verified, so
  // everything passes; with keys, only the signature over this exact pair does.
  verifyPaymentSignature: jest.fn((orderId, paymentId, signature) =>
    (gateway.mock ? true : signature === fakeSignature(orderId, paymentId))),
  verifyWebhookSignature: jest.fn(() => true),
  fetchPayment: jest.fn(async (id) => ({ id, status: 'captured' })),
  fetchOrderPayments: jest.fn(async () => null),
  isMockPayments: () => gateway.mock,
  processRefund: jest.fn(async (paymentId, amount) => ({ id: `rfnd_${paymentId}`, payment_id: paymentId, amount, status: 'processed' })),
}));

const { default: request } = await import('supertest');
const { getApp, createTestUser, cleanupTestData, prisma } = await import('../../fixtures/setup.js');
const { CREDIT_PACKS } = await import('../../../src/services/aiCredit.service.js');
const { aiCreditsWebhookHandler } = await import('../../../src/services/aiCreditPayment.service.js');
const {
  claimWebhookEvent, finishWebhookEvent, markIntentPaid, markIntentFailed, findIntent,
} = await import('../../../src/services/paymentIntent.service.js');

const API = '/api/v1/ai';
const HOOK = '/api/v1/webhooks/razorpay';

/** The ₹49 / 100-credit pack — the one a farmer actually buys. */
const PACK = CREDIT_PACKS.find((p) => p.id === 'pack_100');

let app; let farmer; let payerSeq = 0;

beforeAll(async () => {
  app = await getApp();
}, 60_000);

beforeEach(async () => {
  gateway.mock = false;
  issuedOrders.clear();
  // A fresh buyer per test: credits accumulate on an account, so a shared user
  // would let one test's grant satisfy another test's assertion.
  farmer = await createTestUser({ name: 'Credit Buyer' });
  // Materialise the AICredit row BEFORE any test reads its `before` baseline.
  //
  // getOrCreateCredits() seeds a brand-new row with the free monthly grant (100
  // by default), lazily, on first access — so a `before` captured while no row
  // exists reads 0, and the same read after a purchase returns
  // free_grant + pack_credits. Every balance assertion in this suite would then
  // be off by exactly the free grant, and would look like a double grant rather
  // than a missing baseline. Warming it here through the app's own endpoint
  // keeps `before` an honest measurement of the state the grant is applied to.
  await request(app).get(`${API}/credits`).set(farmer.headers);
  await prisma.paymentWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
});

afterAll(async () => { await cleanupTestData(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

const balanceOf = async (userId) =>
  (await prisma.aICredit.findUnique({ where: { userId }, select: { balance: true } }))?.balance ?? 0;

/** Every 'purchase' ledger row for a user — the count IS the grant count. */
const purchaseRows = async (userId) => {
  const credit = await prisma.aICredit.findUnique({ where: { userId }, select: { id: true } });
  if (!credit) return [];
  return prisma.aICreditTransaction.findMany({ where: { creditId: credit.id, type: 'purchase' } });
};

const initiate = (user = farmer, body = { packId: PACK.id }) =>
  request(app).post(`${API}/credits/purchase/initiate`).set(user.headers).send(body);

const confirm = (user, body) =>
  request(app).post(`${API}/credits/purchase/confirm`).set(user.headers).send(body);

/** initiate → the ids a real checkout would come back with. */
async function startPurchase(user = farmer, packId = PACK.id) {
  const res = await initiate(user, { packId });
  expect(res.status).toBe(200);
  const razorpayOrderId = res.body.data.razorpayOrderId;
  const razorpayPaymentId = `pay_credits_${++payerSeq}_${Date.now()}`;
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
 * AI-credits handler independently of the one-line PURPOSE_HANDLERS
 * registration that lives in a file this change does not own. The wiring itself
 * is asserted separately, in the last describe block.
 *
 * @returns {Promise<boolean>} false when the event id was a redelivery (the
 *          dispatcher's short-circuit — no handler runs at all).
 */
async function deliverCapture(providerOrderId, providerPaymentId, { amountPaise } = {}) {
  const eventId = `payment.captured:${providerPaymentId}`;
  const claimed = await claimWebhookEvent({
    eventId, eventType: 'payment.captured', providerOrderId, providerPaymentId, payloadDigest: `digest_${eventId}`,
  });
  if (!claimed) return false;

  await markIntentPaid({ providerOrderId, providerPaymentId, amountPaise });
  const intent = await findIntent(providerOrderId);
  await aiCreditsWebhookHandler.captured({ intent, providerOrderId, providerPaymentId });
  await finishWebhookEvent(eventId, { status: 'PROCESSED' });
  return true;
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

describe('GET /ai/credits/packs', () => {
  test('lists every pack with an exact integer paise price', async () => {
    const res = await request(app).get(`${API}/credits/packs`).set(farmer.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.packs).toHaveLength(CREDIT_PACKS.length);
    for (const pack of res.body.data.packs) {
      expect(pack).toEqual(expect.objectContaining({
        id: expect.any(String), credits: expect.any(Number),
        priceInr: expect.any(Number), pricePaise: expect.any(Number), label: expect.any(String),
      }));
      // Integer paise at the gateway boundary — never `price * 100` on a float.
      expect(Number.isSafeInteger(pack.pricePaise)).toBe(true);
      expect(pack.pricePaise).toBe(Math.round(pack.priceInr * 100));
    }
  });

  test('401 without a token — packs are behind auth like every other AI route', async () => {
    expect((await request(app).get(`${API}/credits/packs`)).status).toBe(401);
  });
});

// ── Initiate: the server owns the price ───────────────────────────────────────

describe('POST /ai/credits/purchase/initiate', () => {
  test('raises a gateway order for the PACK price and records the intent first', async () => {
    const res = await initiate();

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({
      razorpayOrderId: expect.any(String),
      amountInPaise: PACK.pricePaise,
      currency: 'INR',
      receipt: expect.any(String),
      mock: false,
    }));
    expect(res.body.data.pack).toEqual(expect.objectContaining({ id: PACK.id, credits: PACK.credits }));

    // The row exists BEFORE the app is handed the order id, so an interrupted
    // payment is a queryable state rather than a silence.
    const intent = await prisma.paymentIntent.findUnique({
      where: { providerOrderId: res.body.data.razorpayOrderId },
    });
    expect(intent).toBeTruthy();
    expect(intent.userId).toBe(farmer.user.id);
    expect(intent.purpose).toBe('AI_CREDITS');
    expect(intent.refType).toBe('creditPack');
    expect(intent.refId).toBe(PACK.id);
    expect(intent.amountPaise).toBe(PACK.pricePaise);
    expect(intent.status).toBe('CREATED');
    // The pack is FROZEN here: repricing it later must not change what an
    // in-flight purchase costs or delivers.
    expect(intent.metadata).toEqual(expect.objectContaining({ packId: PACK.id, credits: PACK.credits, pricePaise: PACK.pricePaise }));
  });

  test('a price, amount or credit count in the body is ignored entirely', async () => {
    const res = await initiate(farmer, {
      packId: PACK.id,
      // Everything a tampered client might try. None of it is read.
      amount: 1, amountInPaise: 100, pricePaise: 100, priceInr: 1, credits: 999_999, price: 1,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.amountInPaise).toBe(PACK.pricePaise);
    expect(res.body.data.pack.credits).toBe(PACK.credits);

    const intent = await prisma.paymentIntent.findUnique({
      where: { providerOrderId: res.body.data.razorpayOrderId },
    });
    expect(intent.amountPaise).toBe(PACK.pricePaise);
    expect(intent.metadata.credits).toBe(PACK.credits);
  });

  test('400 for a pack id the server does not define — and no intent is written', async () => {
    const res = await initiate(farmer, { packId: 'pack_free_1000000' });

    expect(res.status).toBe(400);
    expect(await prisma.paymentIntent.count()).toBe(0);
  });

  test('400 when packId is missing', async () => {
    expect((await initiate(farmer, {})).status).toBe(400);
  });

  test('the receipt is unique per attempt, not a per-user constant', async () => {
    const a = await initiate();
    const b = await initiate();
    expect(a.body.data.receipt).not.toBe(b.body.data.receipt);
  });
});

// ── Confirm: the happy path and the signature gate ────────────────────────────

describe('POST /ai/credits/purchase/confirm', () => {
  test('grants exactly the pack\'s credits, once, and settles the intent', async () => {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = await startPurchase();
    const before = await balanceOf(farmer.user.id);

    const res = await confirm(farmer, { razorpayOrderId, razorpayPaymentId, razorpaySignature });

    expect(res.status).toBe(200);
    expect(res.body.data.credited).toBe(PACK.credits);
    expect(res.body.data.alreadyProcessed).toBe(false);
    expect(res.body.data.balance).toBe(before + PACK.credits);
    expect(await balanceOf(farmer.user.id)).toBe(before + PACK.credits);

    // One ledger row, carrying the payment it came from — the audit link.
    const rows = await purchaseRows(farmer.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(PACK.credits);
    expect(rows[0].metadata).toEqual(expect.objectContaining({ packId: PACK.id, providerPaymentId: razorpayPaymentId }));

    const intent = await findIntent(razorpayOrderId);
    expect(intent.status).toBe('ORDER_CREATED');
    expect(intent.providerPaymentId).toBe(razorpayPaymentId);
  });

  test('400 on a tampered signature — and NOT one credit is granted', async () => {
    const { razorpayOrderId, razorpayPaymentId } = await startPurchase();
    const before = await balanceOf(farmer.user.id);

    const res = await confirm(farmer, {
      razorpayOrderId, razorpayPaymentId,
      razorpaySignature: fakeSignature(razorpayOrderId, 'pay_somebody_elses_payment'),
    });

    expect(res.status).toBe(400);
    expect(await balanceOf(farmer.user.id)).toBe(before);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(0);
    // The intent is untouched: a bad signature is not a failed payment.
    expect((await findIntent(razorpayOrderId)).status).toBe('CREATED');
  });

  test('400 on a malformed signature rather than a 500', async () => {
    const { razorpayOrderId, razorpayPaymentId } = await startPurchase();
    const res = await confirm(farmer, { razorpayOrderId, razorpayPaymentId, razorpaySignature: 'zz' });
    expect(res.status).toBe(400);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(0);
  });

  test('400 when a required field is missing', async () => {
    const res = await confirm(farmer, { razorpayOrderId: 'order_x' });
    expect(res.status).toBe(400);
  });

  test('404 for another farmer\'s purchase — a valid signature is not authorization', async () => {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = await startPurchase();
    const attacker = await createTestUser({ name: 'Credit Attacker' });

    const res = await confirm(attacker, { razorpayOrderId, razorpayPaymentId, razorpaySignature });

    expect(res.status).toBe(404);
    expect(await balanceOf(attacker.user.id)).toBe(0);      // no account even created
    expect(await purchaseRows(farmer.user.id)).toHaveLength(0);
  });

  test('a retried confirm (same ids) grants once and reports alreadyProcessed', async () => {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = await startPurchase();
    const before = await balanceOf(farmer.user.id);

    const first = await confirm(farmer, { razorpayOrderId, razorpayPaymentId, razorpaySignature });
    const second = await confirm(farmer, { razorpayOrderId, razorpayPaymentId, razorpaySignature });

    expect(first.body.data.credited).toBe(PACK.credits);
    // 200 with credited 0: the purchase DID succeed, there was simply nothing
    // left to do. Anything else and a retrying app retries forever.
    expect(second.status).toBe(200);
    expect(second.body.data.credited).toBe(0);
    expect(second.body.data.alreadyProcessed).toBe(true);
    expect(await balanceOf(farmer.user.id)).toBe(before + PACK.credits);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(1);
  });
});

// ── Exactly once, whoever gets there first ────────────────────────────────────

describe('exactly-once granting', () => {
  test('a redelivered webhook grants once', async () => {
    const { razorpayOrderId, razorpayPaymentId } = await startPurchase();
    const before = await balanceOf(farmer.user.id);

    const first = await deliverCapture(razorpayOrderId, razorpayPaymentId, { amountPaise: PACK.pricePaise });
    // Razorpay redelivers the SAME event for up to 24 hours. The event id is
    // claimed through a UNIQUE index, so the second delivery never reaches a
    // handler at all.
    const second = await deliverCapture(razorpayOrderId, razorpayPaymentId, { amountPaise: PACK.pricePaise });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await balanceOf(farmer.user.id)).toBe(before + PACK.credits);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(1);
  });

  test('a redelivery that slips PAST the event claim still grants once', async () => {
    // The event inbox is the first line of defence; the intent transition is the
    // one that has to hold on its own. Calling the handler directly, twice,
    // removes the inbox from the picture entirely — which is also what a
    // different event id for the same capture (order.paid after payment.captured)
    // would do in production.
    const { razorpayOrderId, razorpayPaymentId } = await startPurchase();
    const before = await balanceOf(farmer.user.id);

    await markIntentPaid({ providerOrderId: razorpayOrderId, providerPaymentId: razorpayPaymentId });
    const intent = await findIntent(razorpayOrderId);
    await aiCreditsWebhookHandler.captured({ intent, providerOrderId: razorpayOrderId, providerPaymentId: razorpayPaymentId });
    await aiCreditsWebhookHandler.captured({ intent, providerOrderId: razorpayOrderId, providerPaymentId: razorpayPaymentId });

    expect(await balanceOf(farmer.user.id)).toBe(before + PACK.credits);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(1);
  });

  test('webhook first, then confirm — one grant, and the app is told so', async () => {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = await startPurchase();
    const before = await balanceOf(farmer.user.id);

    await deliverCapture(razorpayOrderId, razorpayPaymentId, { amountPaise: PACK.pricePaise });
    const res = await confirm(farmer, { razorpayOrderId, razorpayPaymentId, razorpaySignature });

    expect(res.status).toBe(200);
    expect(res.body.data.credited).toBe(0);
    expect(res.body.data.alreadyProcessed).toBe(true);
    // The balance the app renders is the real one, not a stale pre-grant read.
    expect(res.body.data.balance).toBe(before + PACK.credits);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(1);
  });

  test('confirm first, then webhook — one grant', async () => {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = await startPurchase();
    const before = await balanceOf(farmer.user.id);

    const res = await confirm(farmer, { razorpayOrderId, razorpayPaymentId, razorpaySignature });
    await deliverCapture(razorpayOrderId, razorpayPaymentId, { amountPaise: PACK.pricePaise });

    expect(res.body.data.credited).toBe(PACK.credits);
    expect(await balanceOf(farmer.user.id)).toBe(before + PACK.credits);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(1);
    // markIntentPaid must not regress a settled intent back to PAID.
    expect((await findIntent(razorpayOrderId)).status).toBe('ORDER_CREATED');
  });

  test('confirm and webhook racing simultaneously — still one grant', async () => {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = await startPurchase();
    const before = await balanceOf(farmer.user.id);

    // The real race: no ordering imposed, both paths in flight at once. Only the
    // row lock on the intent decides.
    const [confirmRes] = await Promise.all([
      confirm(farmer, { razorpayOrderId, razorpayPaymentId, razorpaySignature }),
      deliverCapture(razorpayOrderId, razorpayPaymentId, { amountPaise: PACK.pricePaise }),
    ]);

    expect(confirmRes.status).toBe(200);
    expect(await balanceOf(farmer.user.id)).toBe(before + PACK.credits);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(1);
  });

  test('two separate purchases grant twice — dedupe is per payment, not per pack', async () => {
    const before = await balanceOf(farmer.user.id);
    const a = await startPurchase();
    const b = await startPurchase();

    await confirm(farmer, a);
    await confirm(farmer, b);

    expect(await balanceOf(farmer.user.id)).toBe(before + PACK.credits * 2);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(2);
  });
});

// ── A payment that did not succeed ────────────────────────────────────────────

describe('failed and refunded payments', () => {
  test('payment.failed grants nothing and leaves the intent FAILED', async () => {
    const { razorpayOrderId, razorpayPaymentId } = await startPurchase();
    const before = await balanceOf(farmer.user.id);

    await markIntentFailed({ providerOrderId: razorpayOrderId, reason: 'payment failed' });
    await aiCreditsWebhookHandler.failed({
      intent: await findIntent(razorpayOrderId),
      providerOrderId: razorpayOrderId,
      providerPaymentId: razorpayPaymentId,
    });

    expect(await balanceOf(farmer.user.id)).toBe(before);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(0);
    expect((await findIntent(razorpayOrderId)).status).toBe('FAILED');
  });

  test('a SECOND attempt on the same order still grants — FAILED is not settled', async () => {
    // Razorpay allows another payment attempt against the same order. A first
    // attempt failing must not lock the farmer out of the pack they are paying
    // for; only a grant or a refund is final.
    const { razorpayOrderId } = await startPurchase();
    await markIntentFailed({ providerOrderId: razorpayOrderId, reason: 'card declined' });
    const before = await balanceOf(farmer.user.id);

    const retryPaymentId = `pay_credits_retry_${Date.now()}`;
    const res = await confirm(farmer, {
      razorpayOrderId,
      razorpayPaymentId: retryPaymentId,
      razorpaySignature: fakeSignature(razorpayOrderId, retryPaymentId),
    });

    expect(res.body.data.credited).toBe(PACK.credits);
    expect(await balanceOf(farmer.user.id)).toBe(before + PACK.credits);
  });

  test('a refunded purchase is never granted, and granted credits are not clawed back', async () => {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = await startPurchase();
    await prisma.paymentIntent.update({
      where: { providerOrderId: razorpayOrderId },
      data: { status: 'REFUNDED', providerPaymentId: razorpayPaymentId },
    });
    const before = await balanceOf(farmer.user.id);

    const res = await confirm(farmer, { razorpayOrderId, razorpayPaymentId, razorpaySignature });

    expect(res.status).toBe(200);
    expect(res.body.data.credited).toBe(0);
    expect(await balanceOf(farmer.user.id)).toBe(before);
    expect(await purchaseRows(farmer.user.id)).toHaveLength(0);

    // Clawback is a human decision with a ledger entry behind it, never an
    // automatic deduction that could strand a farmer mid-session.
    await aiCreditsWebhookHandler.refunded({
      intent: await findIntent(razorpayOrderId), providerPaymentId: razorpayPaymentId, status: 'REFUNDED',
    });
    expect(await balanceOf(farmer.user.id)).toBe(before);
  });
});
