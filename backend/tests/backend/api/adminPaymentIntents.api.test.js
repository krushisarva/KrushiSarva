/**
 * The admin payment-intent queue — GET /admin/payment-intents.
 *
 * Since a captured payment with no order is refunded automatically, an intent in
 * REFUND_INITIATED means one of two opposite things: a refund the gateway is
 * processing (nobody has to act) or a refund whose gateway call FAILED (the money
 * is still out and a human must refund it by hand). `status` alone cannot tell
 * them apart, so support gets a filter — `refundFailed=true` — that returns only
 * the second kind.
 */
import request from 'supertest';
import { getApp, createTestUser, cleanupTestData, prisma } from '../../fixtures/setup.js';

const API = '/api/v1/admin/payment-intents';
const AUTO_REFUND_FAILED = 'AUTO-REFUND FAILED';

let app; let admin; let buyer;
let paidNoOrder; let refundUnderWay; let refundDone; let refundFailed;

/** One intent in a given state, with a unique gateway order/payment id. */
let seq = 0;
async function intent({ status, failureReason = null }) {
  seq += 1;
  return prisma.paymentIntent.create({
    data: {
      userId: buyer.user.id,
      providerOrderId: `order_pi_${Date.now()}_${seq}`,
      providerPaymentId: `pay_pi_${Date.now()}_${seq}`,
      amount: '449.00',
      amountPaise: 44900,
      receipt: `rcpt_pi_${seq}`,
      status,
      failureReason,
    },
  });
}

beforeAll(async () => {
  app = await getApp();
  admin = await createTestUser({ role: 'ADMIN', name: 'Intents Admin' });
  buyer = await createTestUser({ name: 'Intents Buyer' });
  await prisma.paymentIntent.deleteMany();
  paidNoOrder = await intent({ status: 'PAID' });
  refundUnderWay = await intent({ status: 'REFUND_INITIATED' });
  refundDone = await intent({ status: 'REFUNDED' });
  refundFailed = await intent({ status: 'REFUND_INITIATED', failureReason: `${AUTO_REFUND_FAILED}: gateway down` });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

const ids = (res) => res.body.data.items.map((i) => i.id);

describe('the orphaned-payment queue', () => {
  test('refundFailed=true returns only refunds that need a human', async () => {
    const res = await request(app).get(`${API}?refundFailed=true`).set(admin.headers);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([refundFailed.id]);
    // Every row carries the reason, so the queue is actionable without a second call.
    for (const row of res.body.data.items) {
      expect(row.failureReason.startsWith(AUTO_REFUND_FAILED)).toBe(true);
    }
  });

  test('a refund under way and a finished refund are NOT in that queue', async () => {
    const res = await request(app).get(`${API}?refundFailed=true`).set(admin.headers);
    expect(ids(res)).not.toContain(refundUnderWay.id);
    expect(ids(res)).not.toContain(refundDone.id);
    expect(ids(res)).not.toContain(paidNoOrder.id);
  });

  test('orphaned=true still lists paid-with-no-order together with the failures', async () => {
    const res = await request(app).get(`${API}?orphaned=true`).set(admin.headers);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(expect.arrayContaining([paidNoOrder.id, refundFailed.id]));
    expect(ids(res)).not.toContain(refundUnderWay.id);
    expect(ids(res)).not.toContain(refundDone.id);
  });

  test('status=REFUND_INITIATED alone cannot separate the two — which is why the filter exists', async () => {
    const res = await request(app).get(`${API}?status=REFUND_INITIATED`).set(admin.headers);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(expect.arrayContaining([refundUnderWay.id, refundFailed.id]));
    // …but each row says which it is.
    const byId = new Map(res.body.data.items.map((i) => [i.id, i]));
    expect(byId.get(refundUnderWay.id).failureReason).toBeNull();
    expect(byId.get(refundFailed.id).failureReason).toMatch(/^AUTO-REFUND FAILED/);
  });

  test('a non-boolean refundFailed is rejected, not silently ignored', async () => {
    const res = await request(app).get(`${API}?refundFailed=maybe`).set(admin.headers);
    expect(res.status).toBe(400);
  });

  test('a non-admin cannot read the queue', async () => {
    const farmer = await createTestUser();
    const res = await request(app).get(`${API}?refundFailed=true`).set(farmer.headers);
    expect(res.status).toBe(403);
  });
});
