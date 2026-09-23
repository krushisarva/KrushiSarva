/**
 * The reconciler settles only the purposes it has rules for.
 *
 * ── The bug this prevents ────────────────────────────────────────────────────
 * `reconcilePendingPayments` is written entirely in AgriStore terms: look for an
 * `Order` by `paymentRef`, find none, release the stock reservations, and past
 * the 30-minute window refund the capture. Those are the right rules for a cart.
 * They are the wrong rules for a rent booking, and wrong in an expensive
 * direction — a farmer who takes eleven minutes over a UPI approval, which is
 * ordinary on a village connection, would have their booking money sent back
 * while the booking itself was being created. Nothing in the logs would call it
 * an error, because by shop rules it is correct behaviour.
 *
 * So the sweep is opt-in per purpose (`RECONCILED_PURPOSES`). This suite is the
 * only thing that stops that filter being removed as "an unnecessary where
 * clause" — the behaviour it protects belongs to a feature that does not exist
 * yet, so no other test would notice it going.
 *
 * Both intents below are identical apart from `purpose`. That is the point.
 */
import { jest } from '@jest/globals';

let seq = 0;
const processRefund = jest.fn(async (paymentId, amount) => ({
  id: `rfnd_scope_${++seq}`, payment_id: paymentId, amount, status: 'processed',
}));
const fetchPayment = jest.fn(async (id) => ({ id, status: 'captured' }));

jest.unstable_mockModule('../../../src/services/payment.service.js', () => ({
  createPaymentOrder: jest.fn(async (amount, currency, receipt) => ({
    id: `order_scope_${Date.now()}_${++seq}`, amount, currency, receipt, status: 'created', mock: true,
  })),
  fetchPaymentOrder: jest.fn(async (id) => ({ id, mock: true })),
  verifyPaymentSignature: jest.fn(() => true),
  verifyWebhookSignature: jest.fn(() => true),
  fetchPayment,
  fetchOrderPayments: jest.fn(async () => []),
  isMockPayments: () => false,
  processRefund,
}));

const { default: request } = await import('supertest');
const { getApp, createTestUser, cleanupTestData, prisma } = await import('../../fixtures/setup.js');
const { reconcilePendingPayments } = await import('../../../src/services/shopPayment.service.js');

/** The URL already configured in the Razorpay dashboard. */
const LEGACY_HOOK = '/api/v1/shop-webhooks/razorpay';
/** The purpose-neutral name, added by PAY-001. */
const HOOK = '/api/v1/webhooks/razorpay';

let app; let buyer;

beforeAll(async () => {
  app = await getApp();
  buyer = await createTestUser({ name: 'Purpose Scope Buyer', district: 'Pune' });
}, 60_000);

beforeEach(async () => {
  processRefund.mockClear();
  await prisma.paymentIntent.deleteMany();
  await prisma.paymentWebhookEvent.deleteMany();
});

afterAll(async () => { await cleanupTestData(); });

/**
 * A captured payment with nothing to show for it, old enough that the shop
 * rules would refund it. `purpose` is the only variable.
 */
async function orphanedIntent(purpose, { minutesAgo = 90 } = {}) {
  const tag = `${purpose.toLowerCase()}_${Date.now()}_${++seq}`;
  return prisma.paymentIntent.create({
    data: {
      userId: buyer.user.id,
      purpose,
      providerOrderId: `order_${tag}`,
      providerPaymentId: `pay_${tag}`,
      amount: '449.00',
      amountPaise: 44900,
      receipt: `r_${tag}`,
      status: minutesAgo === 0 ? 'CREATED' : 'PAID',
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
      ...(purpose === 'RENT_BOOKING' ? { refType: 'booking', refId: `bk_${tag}` } : {}),
    },
  });
}

const statusOf = async (id) => (await prisma.paymentIntent.findUnique({ where: { id } })).status;

describe('reconcilePendingPayments — purpose scoping', () => {
  test('a SHOP_ORDER orphan is still refunded, exactly as before', async () => {
    const shop = await orphanedIntent('SHOP_ORDER');

    const stats = await reconcilePendingPayments({ olderThanMinutes: 10 });

    expect(stats.refunded).toBe(1);
    expect(await statusOf(shop.id)).toBe('REFUNDED');
    expect(processRefund).toHaveBeenCalledTimes(1);
  });

  test('a RENT_BOOKING orphan is left alone — shop rules must not spend rent money', async () => {
    const rent = await orphanedIntent('RENT_BOOKING');

    const stats = await reconcilePendingPayments({ olderThanMinutes: 10 });

    // Not scanned at all: not refunded, not expired, not touched.
    expect(stats.scanned).toBe(0);
    expect(stats.refunded).toBe(0);
    expect(processRefund).not.toHaveBeenCalled();
    expect(await statusOf(rent.id)).toBe('PAID');
  });

  test('with both present, the sweep takes the shop one and only the shop one', async () => {
    const shop = await orphanedIntent('SHOP_ORDER');
    const rent = await orphanedIntent('RENT_BOOKING');
    const credits = await orphanedIntent('AI_CREDITS');

    const stats = await reconcilePendingPayments({ olderThanMinutes: 10 });

    expect(stats.scanned).toBe(1);
    expect(processRefund).toHaveBeenCalledTimes(1);
    expect(processRefund).toHaveBeenCalledWith(shop.providerPaymentId, 44900);
    expect(await statusOf(shop.id)).toBe('REFUNDED');
    expect(await statusOf(rent.id)).toBe('PAID');
    expect(await statusOf(credits.id)).toBe('PAID');
  });

  test('an intent written with no purpose inherits SHOP_ORDER and is swept', async () => {
    // The column default is load-bearing: every row written before `purpose`
    // existed is an AgriStore checkout, and must keep being reconciled as one.
    const tag = `legacy_${Date.now()}_${++seq}`;
    const legacy = await prisma.paymentIntent.create({
      data: {
        userId: buyer.user.id,
        providerOrderId: `order_${tag}`,
        providerPaymentId: `pay_${tag}`,
        amount: '449.00', amountPaise: 44900, receipt: `r_${tag}`,
        status: 'PAID',
        createdAt: new Date(Date.now() - 90 * 60_000),
      },
    });

    expect((await prisma.paymentIntent.findUnique({ where: { id: legacy.id } })).purpose).toBe('SHOP_ORDER');

    const stats = await reconcilePendingPayments({ olderThanMinutes: 10 });
    expect(stats.refunded).toBe(1);
    expect(await statusOf(legacy.id)).toBe('REFUNDED');
  });
});

/** Post a signed capture for a gateway order. The signature check is mocked. */
const capture = (providerOrderId, providerPaymentId, path = HOOK) => request(app)
  .post(path)
  .set('X-Razorpay-Signature', 'a'.repeat(64))
  .set('Content-Type', 'application/json')
  .send(JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: providerPaymentId, order_id: providerOrderId, amount: 44900 } } },
  }));

const lastEvent = () => prisma.paymentWebhookEvent.findFirst({ orderBy: { receivedAt: 'desc' } });

describe('the webhook dispatcher — a purpose with no handler', () => {
  // ANIMAL_TOKEN is the unhandled purpose, and deliberately so: PAY-005 is an
  // open product decision (a token payment on a live animal changes the
  // platform's legal posture), so the enum value exists while the handler does
  // not. This block used AI_CREDITS until PAY-004 registered one for it — which
  // is exactly why the assertion flipped to PROCESSED and this comment exists:
  // the next purpose to be implemented must move this block on again, not
  // delete it.
  test('is IGNORED with 200, never a 5xx', async () => {
    // A 5xx would make Razorpay retry for 24 hours, and every retry would reach
    // the same missing handler. The answer will not change; the gateway should
    // not keep asking.
    const intent = await orphanedIntent('ANIMAL_TOKEN', { minutesAgo: 0 });

    const res = await capture(intent.providerOrderId, intent.providerPaymentId);

    expect(res.status).toBe(200);
    expect((await lastEvent()).status).toBe('IGNORED');
  });

  test('still records that the money arrived', async () => {
    // The handler is what is missing, not the payment. Leaving the intent
    // CREATED would mean a real capture whose only trace is a webhook row —
    // exactly the silence the intent machinery exists to prevent. PAID with no
    // fulfilment is visible in the admin orphan queue; CREATED is not.
    const intent = await orphanedIntent('ANIMAL_TOKEN', { minutesAgo: 0 });

    await capture(intent.providerOrderId, intent.providerPaymentId);

    const after = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(after.status).toBe('PAID');
    expect(after.providerPaymentId).toBe(intent.providerPaymentId);
  });

  test('a SHOP_ORDER capture is still PROCESSED, not ignored', async () => {
    const intent = await orphanedIntent('SHOP_ORDER', { minutesAgo: 0 });

    const res = await capture(intent.providerOrderId, intent.providerPaymentId);

    expect(res.status).toBe(200);
    expect((await lastEvent()).status).toBe('PROCESSED');
  });
});

describe('both webhook URLs are the same endpoint', () => {
  test.each([
    ['the neutral path', HOOK],
    ['the legacy path Razorpay is already configured with', LEGACY_HOOK],
  ])('%s handles a capture identically', async (_label, path) => {
    const intent = await orphanedIntent('SHOP_ORDER', { minutesAgo: 0 });

    const res = await capture(intent.providerOrderId, intent.providerPaymentId, path);

    expect(res.status).toBe(200);
    expect((await lastEvent()).status).toBe('PROCESSED');
    expect(await statusOf(intent.id)).toBe('PAID');
  });

  test('they share ONE event inbox — the same delivery on the other path is a replay', async () => {
    // This is the property that makes the alias safe rather than merely
    // convenient. If the two mounts had separate idempotency, Razorpay
    // retrying a capture against a different URL would be processed twice.
    const intent = await orphanedIntent('SHOP_ORDER', { minutesAgo: 0 });

    const first = await capture(intent.providerOrderId, intent.providerPaymentId, LEGACY_HOOK);
    const second = await capture(intent.providerOrderId, intent.providerPaymentId, HOOK);

    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();

    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.headers['x-webhook-replay']).toBe('true');

    expect(await prisma.paymentWebhookEvent.count()).toBe(1);
  });
});
