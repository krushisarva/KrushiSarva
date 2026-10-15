/**
 * AI credits can no longer be bought (owner decision, 2026-10-15).
 *
 * The credit-pack purchase flow (PAY-004) was removed. The ledger stays as a
 * hidden monthly fair-use limit. This suite pins the three things that removal
 * must not get wrong:
 *
 *   1. The purchase endpoints are gone, and the balance summary carries no packs
 *      or prices.
 *   2. A late Razorpay event for an OLD AI-credits payment (a capture retried for
 *      24 hours, or an order raised just before the deploy) is acknowledged with
 *      200 and grants NOTHING. It must not 5xx, because Razorpay would retry for
 *      24 hours, and it must not mint credits that nothing now sells.
 *   3. Running out of the monthly allowance keeps its 402, which installed apps
 *      key on, but the message no longer mentions credits or buying.
 *
 * The gateway is mocked exactly as paymentPurposeScope.api.test.js mocks it, so
 * nothing here reaches the network.
 */
import { jest } from '@jest/globals';

let seq = 0;

jest.unstable_mockModule('../../../src/services/payment.service.js', () => ({
  createPaymentOrder: jest.fn(async (amount, currency, receipt) => ({
    id: `order_retired_${Date.now()}_${++seq}`, amount, currency, receipt, status: 'created', mock: true,
  })),
  fetchPaymentOrder: jest.fn(async (id) => ({ id, mock: true })),
  verifyPaymentSignature: jest.fn(() => true),
  verifyWebhookSignature: jest.fn(() => true),
  fetchPayment: jest.fn(async (id) => ({ id, status: 'captured' })),
  fetchOrderPayments: jest.fn(async () => []),
  isMockPayments: () => true,
  processRefund: jest.fn(async (paymentId, amount) => ({ id: `rfnd_${paymentId}`, payment_id: paymentId, amount, status: 'processed' })),
}));

const { default: request } = await import('supertest');
const { getApp, createTestUser, cleanupTestData, prisma } = await import('../../fixtures/setup.js');
const { default: logger } = await import('../../../src/utils/logger.js');

const API = '/api/v1/ai';
const HOOK = '/api/v1/webhooks/razorpay';
const LIMIT_MESSAGE = "You've reached this month's free AI limit. It resets on the 1st of next month.";

let app; let farmer;

beforeAll(async () => {
  app = await getApp();
}, 60_000);

beforeEach(async () => {
  farmer = await createTestUser({ name: 'Retired Credits Farmer' });
  // Materialise the AICredit row (with its free monthly grant) through the
  // app's own endpoint, so every balance below is measured against a real
  // baseline rather than the lazy first-access grant.
  await request(app).get(`${API}/credits`).set(farmer.headers);
  await prisma.paymentWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
});

afterAll(async () => { await cleanupTestData(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

const creditRow = (userId) => prisma.aICredit.findUnique({ where: { userId } });

/** Every ledger row for a user. A grant, of any kind, would add one. */
const ledgerRows = async (userId) => {
  const credit = await creditRow(userId);
  return prisma.aICreditTransaction.findMany({ where: { creditId: credit.id } });
};

/** An AI-credits intent shaped exactly as the removed /purchase/initiate wrote it. */
async function oldCreditIntent({ status = 'CREATED', paid = false } = {}) {
  const tag = `retired_${Date.now()}_${++seq}`;
  return prisma.paymentIntent.create({
    data: {
      userId: farmer.user.id,
      purpose: 'AI_CREDITS',
      refType: 'creditPack',
      refId: 'pack_100',
      providerOrderId: `order_${tag}`,
      ...(paid ? { providerPaymentId: `pay_${tag}` } : {}),
      amount: '49.00',
      amountPaise: 4900,
      receipt: `r_${tag}`,
      status,
      metadata: { packId: 'pack_100', credits: 100, pricePaise: 4900, label: '100 Credits' },
    },
  });
}

/** A signed Razorpay delivery. The signature check is mocked. */
const deliver = (event, payload) => request(app)
  .post(HOOK)
  .set('X-Razorpay-Signature', 'a'.repeat(64))
  .set('Content-Type', 'application/json')
  .send(JSON.stringify({ event, payload }));

const capture = (orderId, paymentId) => deliver('payment.captured', {
  payment: { entity: { id: paymentId, order_id: orderId, amount: 4900 } },
});

const lastEvent = () => prisma.paymentWebhookEvent.findFirst({ orderBy: { receivedAt: 'desc' } });

/** Did any log line at this level carry this text? */
const logged = (spy, text) => spy.mock.calls.some((args) => args.some((a) => typeof a === 'string' && a.includes(text)));

// ── 1. Nothing is for sale ────────────────────────────────────────────────────

describe('the purchase endpoints are gone', () => {
  test.each([
    ['get', '/credits/packs'],
    ['post', '/credits/purchase/initiate'],
    ['post', '/credits/purchase/confirm'],
    ['get', '/credits/purchase/status/order_anything'],
  ])('%s %s answers 404', async (method, path) => {
    const req = request(app)[method](`${API}${path}`).set(farmer.headers);
    const res = method === 'post' ? await req.send({ packId: 'pack_100' }) : await req;

    expect(res.status).toBe(404);
  });

  test('an initiate from an old app raises no gateway order and writes no intent', async () => {
    await request(app).post(`${API}/credits/purchase/initiate`).set(farmer.headers).send({ packId: 'pack_100' });
    expect(await prisma.paymentIntent.count()).toBe(0);
  });

  test('GET /ai/credits still answers, with the balance and no packs or prices', async () => {
    const res = await request(app).get(`${API}/credits`).set(farmer.headers);

    expect(res.status).toBe(200);
    expect(typeof res.body.data.balance).toBe('number');
    expect(res.body.data).toHaveProperty('monthlyAllowance');
    expect(res.body.data).toHaveProperty('nextRefill');
    expect(res.body.data).not.toHaveProperty('packs');
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/priceInr|pricePaise|pack_\d+/);
  });
});

// ── 2. A late event for an old payment ────────────────────────────────────────

describe('a webhook for an old AI-credits payment', () => {
  // Spies only — the real logger still runs. Restored individually rather than
  // through restoreAllMocks, which on Jest 29 would also strip the gateway
  // mock's implementations above.
  let warn; let error;
  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn');
    error = jest.spyOn(logger, 'error');
  });
  afterEach(() => { warn.mockRestore(); error.mockRestore(); });

  test('payment.captured is acknowledged with 200 and grants nothing', async () => {
    const intent = await oldCreditIntent();
    const before = await creditRow(farmer.user.id);
    const rowsBefore = (await ledgerRows(farmer.user.id)).length;

    const res = await capture(intent.providerOrderId, `pay_late_${++seq}`);

    expect(res.status).toBe(200);
    // Not one credit, and no ledger row of any kind.
    const after = await creditRow(farmer.user.id);
    expect(after.balance).toBe(before.balance);
    expect(after.lifetimeEarned).toBe(before.lifetimeEarned);
    expect(await ledgerRows(farmer.user.id)).toHaveLength(rowsBefore);
    // Acknowledged as a decision, not as missing code: IGNORED, at WARN.
    expect((await lastEvent()).status).toBe('IGNORED');
    expect(logged(warn, 'retired payment purpose')).toBe(true);
    expect(logged(error, 'no handler for this payment purpose')).toBe(false);
  });

  test('the money is still recorded, so the payment stays visible for a manual refund', async () => {
    const intent = await oldCreditIntent();
    const paymentId = `pay_late_${++seq}`;

    await capture(intent.providerOrderId, paymentId);

    const after = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(after.status).toBe('PAID');
    expect(after.providerPaymentId).toBe(paymentId);
  });

  test('a redelivery of the same capture is still 200 and still grants nothing', async () => {
    const intent = await oldCreditIntent();
    const paymentId = `pay_late_${++seq}`;
    const before = (await creditRow(farmer.user.id)).balance;

    const first = await capture(intent.providerOrderId, paymentId);
    const second = await capture(intent.providerOrderId, paymentId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect((await creditRow(farmer.user.id)).balance).toBe(before);
  });

  test('payment.failed is acknowledged with 200 and changes no balance', async () => {
    const intent = await oldCreditIntent();
    const before = (await creditRow(farmer.user.id)).balance;

    const res = await deliver('payment.failed', {
      payment: { entity: { id: `pay_failed_${++seq}`, order_id: intent.providerOrderId, error_description: 'declined' } },
    });

    expect(res.status).toBe(200);
    expect((await creditRow(farmer.user.id)).balance).toBe(before);
    expect((await prisma.paymentIntent.findUnique({ where: { id: intent.id } })).status).toBe('FAILED');
    expect((await lastEvent()).status).toBe('IGNORED');
  });

  test('a refund event is acknowledged with 200 and claws nothing back', async () => {
    const intent = await oldCreditIntent({ status: 'ORDER_CREATED', paid: true });
    const before = (await creditRow(farmer.user.id)).balance;

    const res = await deliver('refund.processed', {
      refund: { entity: { id: `rfnd_${++seq}`, payment_id: intent.providerPaymentId, amount: 4900 } },
    });

    expect(res.status).toBe(200);
    expect((await creditRow(farmer.user.id)).balance).toBe(before);
    expect((await lastEvent()).status).toBe('IGNORED');
  });
});

// ── 3. Running out of the monthly allowance ───────────────────────────────────

describe('when the monthly allowance runs out', () => {
  test('the gate keeps its 402 and says "free AI limit", never credits or buying', async () => {
    await prisma.aICredit.update({ where: { userId: farmer.user.id }, data: { balance: 0 } });

    // Price prediction reserves BEFORE it calls the prediction service, so an
    // empty allowance answers here without any upstream call.
    const res = await request(app).post('/api/v1/agripredict/predict').set(farmer.headers)
      .send({ commodity: 'Onion', state: 'Maharashtra' });

    expect(res.status).toBe(402);
    expect(res.body.error.message).toBe(LIMIT_MESSAGE);
    expect(res.body.error.message).not.toMatch(/credit|buy|purchase/i);
  });
});
