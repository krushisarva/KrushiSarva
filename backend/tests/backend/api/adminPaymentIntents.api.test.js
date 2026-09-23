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
async function intent({ status, failureReason = null, purpose = undefined }) {
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
      ...(purpose ? { purpose } : {}),
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

describe('GET /admin/payment-intents?purpose — one queue, several product areas', () => {
  test('a purpose filter returns only that area, and the row carries its purpose', async () => {
    // Seeded here rather than in beforeAll: the refundFailed and orphaned tests
    // above match fixed id sets, and a fifth row would change them.
    const rent = await intent({ status: 'PAID', purpose: 'RENT_BOOKING' });

    const res = await request(app).get('/api/v1/admin/payment-intents?purpose=RENT_BOOKING').set(admin.headers);

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([rent.id]);
    expect(res.body.data.items[0].purpose).toBe('RENT_BOOKING');

    await prisma.paymentIntent.delete({ where: { id: rent.id } });
  });

  test('the shop queue excludes other areas', async () => {
    const rent = await intent({ status: 'PAID', purpose: 'RENT_BOOKING' });

    const res = await request(app).get('/api/v1/admin/payment-intents?purpose=SHOP_ORDER').set(admin.headers);

    expect(res.status).toBe(200);
    expect(ids(res)).not.toContain(rent.id);
    // Rows written before the column existed default to SHOP_ORDER, so the
    // shop view must still contain them.
    expect(ids(res)).toContain(paidNoOrder.id);

    await prisma.paymentIntent.delete({ where: { id: rent.id } });
  });

  test('purpose ANDs with the view rather than replacing it', async () => {
    const rentOrphan = await intent({ status: 'PAID', purpose: 'RENT_BOOKING' });

    const res = await request(app)
      .get('/api/v1/admin/payment-intents?orphaned=true&purpose=RENT_BOOKING')
      .set(admin.headers);

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([rentOrphan.id]);
    // The orphan view deletes where.status; the purpose must survive that.
    expect(ids(res)).not.toContain(paidNoOrder.id);

    await prisma.paymentIntent.delete({ where: { id: rentOrphan.id } });
  });

  test('an unknown purpose is rejected, not silently ignored', async () => {
    const res = await request(app).get('/api/v1/admin/payment-intents?purpose=RENT_BOOKINGS').set(admin.headers);
    expect(res.status).toBe(400);
  });

  test('no purpose filter still returns every area', async () => {
    const rent = await intent({ status: 'PAID', purpose: 'RENT_BOOKING' });

    const res = await request(app).get('/api/v1/admin/payment-intents').set(admin.headers);

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(expect.arrayContaining([rent.id, paidNoOrder.id]));

    await prisma.paymentIntent.delete({ where: { id: rent.id } });
  });
});

/**
 * GET /admin/payment-intents/summary — the number on the admin panel's triage
 * chips. The list is keyset-paginated, so a count derived from the loaded page
 * would understate how much money is stranded; these assertions pin the summary
 * to the list it links to rather than to a hard-coded figure, so they stay true
 * whatever else is in the table.
 */
describe('GET /admin/payment-intents/summary', () => {
  const SUMMARY = `${API}/summary`;
  const listCount = async (qs) => {
    const res = await request(app).get(`${API}?${qs}&limit=100`).set(admin.headers);
    expect(res.status).toBe(200);
    expect(res.body.meta.hasMore).toBe(false); // otherwise the comparison below is meaningless
    return res.body.data.items.length;
  };

  test('each count equals the list that clicking the chip opens', async () => {
    const res = await request(app).get(SUMMARY).set(admin.headers);
    expect(res.status).toBe(200);
    const { orphaned, refundFailed, cap } = res.body.data;

    expect(cap).toBeGreaterThan(0);
    expect(orphaned.capped).toBe(false);
    expect(refundFailed.capped).toBe(false);
    expect(orphaned.count).toBe(await listCount('orphaned=true'));
    expect(refundFailed.count).toBe(await listCount('refundFailed=true'));
  });

  test('the fixtures land on the side of the line they belong to', async () => {
    const res = await request(app).get(SUMMARY).set(admin.headers);
    // paidNoOrder + refundFailed are orphans; refundUnderWay and refundDone are not.
    expect(res.body.data.orphaned.count).toBe(2);
    expect(res.body.data.refundFailed.count).toBe(1);
  });

  test('purpose narrows the counts exactly as it narrows the list', async () => {
    const rentOrphan = await intent({ status: 'PAID', purpose: 'RENT_BOOKING' });

    const scoped = await request(app).get(`${SUMMARY}?purpose=RENT_BOOKING`).set(admin.headers);
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.orphaned.count).toBe(await listCount('orphaned=true&purpose=RENT_BOOKING'));
    expect(scoped.body.data.orphaned.count).toBe(1);

    // …and the unscoped summary counts it too.
    const all = await request(app).get(SUMMARY).set(admin.headers);
    expect(all.body.data.orphaned.count).toBe(3);

    await prisma.paymentIntent.delete({ where: { id: rentOrphan.id } });
  });

  test('byPurpose splits the orphan queue and sums back to its count', async () => {
    const rentOrphan = await intent({ status: 'PAID', purpose: 'RENT_BOOKING' });

    const res = await request(app).get(SUMMARY).set(admin.headers);
    const { orphaned, byPurpose } = res.body.data;
    expect(byPurpose).not.toBeNull();
    expect(byPurpose.RENT_BOOKING).toBe(1);
    // Rows written before the purpose column existed carry the SHOP_ORDER default.
    expect(byPurpose.SHOP_ORDER).toBe(2);
    expect(Object.values(byPurpose).reduce((a, b) => a + b, 0)).toBe(orphaned.count);

    await prisma.paymentIntent.delete({ where: { id: rentOrphan.id } });
  });

  test('an empty queue reports zero and an empty split, not null', async () => {
    const res = await request(app).get(`${SUMMARY}?purpose=AI_CREDITS`).set(admin.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.orphaned).toEqual({ count: 0, capped: false });
    expect(res.body.data.refundFailed).toEqual({ count: 0, capped: false });
    expect(res.body.data.byPurpose).toEqual({});
  });

  test('an unknown purpose is rejected, not silently ignored', async () => {
    const res = await request(app).get(`${SUMMARY}?purpose=RENT_BOOKINGS`).set(admin.headers);
    expect(res.status).toBe(400);
  });

  test('a non-admin cannot read the summary', async () => {
    const farmer = await createTestUser();
    const res = await request(app).get(SUMMARY).set(farmer.headers);
    expect(res.status).toBe(403);
  });
});
