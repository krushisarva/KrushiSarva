/**
 * Seller delivery, phase 1 — the seller is told about a new order.
 * Contract: docs/SELLER_DELIVERY_DESIGN.md §8.1.
 *
 * Order creation used to notify nobody: the only order push in the backend went
 * to the BUYER, on a status change. A Kendra found out about an order by opening
 * the app.
 *
 * The push service is replaced before the app loads, so these assert exactly
 * what the route hands to it — who, how many times, and with what — without
 * touching Expo or the queue.
 */
import { jest } from '@jest/globals';

const sendPushToUser = jest.fn(async () => ({ enqueued: false, ranInline: true }));
jest.unstable_mockModule('../../../src/services/push.service.js', () => ({
  sendPushToUser,
  deliverUserNotification: jest.fn(async () => {}),
  NOTIFICATION_CATEGORIES: { ACTIVITY: 'ACTIVITY', SECURITY: 'SECURITY' },
}));

const { default: request } = await import('supertest');
const {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData, prisma,
} = await import('../../fixtures/setup.js');
const { newOrderPushes, pushCity } = await import('../../../src/services/orderDelivery.service.js');

const API = '/api/v1/agristore';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let app, category, kendraA, kendraB, buyer;

const address = (over = {}) => ({
  name: 'Sunita Patil', phone: '9876501234', flat: '4', street: 'Bazaar Road',
  city: 'Kasegaon', state: 'Maharashtra', pincode: '415404', ...over,
});

/** One fresh offer per seller, so stock and price are known for every test. */
async function offer(kendra, { sellingPrice = 100, stockQty = 50 } = {}) {
  const product = await createTestCatalogProduct(category.id, {
    name: `NewOrder Seed ${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  });
  return createTestListing(kendra.user.id, product.variants[0].id, { sellingPrice, stockQty, district: 'Pune' });
}

async function fillCart(user, lines) {
  await prisma.cartItem.deleteMany({ where: { userId: user.user.id } });
  for (const [listing, quantity] of lines) {
    const res = await request(app).post(`${API}/cart`).set(user.headers).send({ listingId: listing.id, quantity });
    expect(res.status).toBeLessThan(300);
  }
}

const placeCod = (user, addr = address()) => request(app).post(`${API}/orders`).set(user.headers)
  .send({ paymentMethod: 'cod', deliveryAddress: addr });

const newOrderCalls = () => sendPushToUser.mock.calls.map(([p]) => p).filter((p) => p.type === 'NEW_ORDER');

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory({ name: `NewOrderPush ${Date.now()}` });
  kendraA = await createTestSeller({ name: 'Push Kendra A', district: 'Pune' });
  kendraB = await createTestSeller({ name: 'Push Kendra B', district: 'Pune' });
  buyer   = await createTestUser({ name: 'Push Buyer', district: 'Pune' });
}, 60_000);

beforeEach(() => {
  sendPushToUser.mockClear();
  sendPushToUser.mockImplementation(async () => ({ enqueued: false, ranInline: true }));
});

afterAll(async () => {
  await cleanupTestData();
});

describe('cash order → one NEW_ORDER push per seller', () => {
  test('a two-seller order sends exactly two, each with that seller\'s own goods total', async () => {
    const a = await offer(kendraA, { sellingPrice: 620 });
    const b = await offer(kendraB, { sellingPrice: 150 });
    await fillCart(buyer, [[a, 2], [b, 1]]);

    const res = await placeCod(buyer);
    expect(res.status).toBe(201);
    const orderId = res.body.data.id;

    const pushes = newOrderCalls();
    expect(pushes).toHaveLength(2);

    const toA = pushes.find((p) => p.userId === kendraA.user.id);
    const toB = pushes.find((p) => p.userId === kendraB.user.id);
    // Goods only, per seller: 2 × 620 for A, 1 × 150 for B. Not the order total
    // (which would tell each Kendra about the other's sale) and not the
    // delivery fee.
    expect(toA).toEqual({
      userId: kendraA.user.id,
      type: 'NEW_ORDER',
      title: 'New order',
      body: '₹1,240 · Kasegaon',
      data: { kind: 'new_order', orderId },
    });
    expect(toB.body).toBe('₹150 · Kasegaon');
    expect(toB.data).toEqual({ kind: 'new_order', orderId });
    expect(orderId).toMatch(UUID);
  });

  test('carries no farmer phone or name, and no category that would bypass the mute', async () => {
    const a = await offer(kendraA);
    await fillCart(buyer, [[a, 1]]);
    const addr = address({ phone: '9812345670', name: 'Ganpat Unique-Name' });
    expect((await placeCod(buyer, addr)).status).toBe(201);

    const [push] = newOrderCalls();
    const wire = JSON.stringify(push);
    expect(wire).not.toContain('9812345670');
    expect(wire).not.toContain(buyer.user.phone);
    expect(wire).not.toContain('Ganpat');
    // Default (ACTIVITY) category: the seller's notification switch applies.
    expect(push.category).toBeUndefined();
  });

  test('two lines from the same seller are ONE push for their sum', async () => {
    const a1 = await offer(kendraA, { sellingPrice: 100 });
    const a2 = await offer(kendraA, { sellingPrice: 250 });
    await fillCart(buyer, [[a1, 3], [a2, 2]]);
    expect((await placeCod(buyer)).status).toBe(201);

    const pushes = newOrderCalls();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].userId).toBe(kendraA.user.id);
    expect(pushes[0].body).toBe('₹800 · Kasegaon');
  });

  test('a seller who is the BUYER of the order is not told about it', async () => {
    // Nothing at cart or checkout stops a Kendra ordering its own offer.
    const own = await offer(kendraA, { sellingPrice: 90 });
    const other = await offer(kendraB, { sellingPrice: 110 });
    await fillCart(kendraA, [[own, 1], [other, 1]]);

    const res = await placeCod(kendraA);
    expect(res.status).toBe(201);

    const pushes = newOrderCalls();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].userId).toBe(kendraB.user.id);
    expect(pushes.some((p) => p.userId === kendraA.user.id)).toBe(false);
  });

  test('a push that fails does not change the response or the order', async () => {
    sendPushToUser.mockImplementation(async () => { throw new Error('queue down'); });
    const a = await offer(kendraA);
    await fillCart(buyer, [[a, 1]]);

    const res = await placeCod(buyer);
    expect(res.status).toBe(201);
    expect(await prisma.order.count({ where: { id: res.body.data.id } })).toBe(1);
  });

  test('a refused checkout sends nothing', async () => {
    await prisma.cartItem.deleteMany({ where: { userId: buyer.user.id } });
    const res = await placeCod(buyer);   // empty cart
    expect(res.status).toBe(400);
    expect(newOrderCalls()).toHaveLength(0);
  });
});

describe('online-payment confirm → the same push, once', () => {
  const confirm = (paymentId, providerOrderId) => request(app).post(`${API}/orders/confirm`).set(buyer.headers).send({
    razorpayOrderId: providerOrderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: 'x'.repeat(64),   // mock mode accepts any well-formed signature
    deliveryAddress: address(),
  });

  test('two sellers → two pushes; replaying the confirm sends no more', async () => {
    const a = await offer(kendraA, { sellingPrice: 300 });
    const b = await offer(kendraB, { sellingPrice: 400 });
    await fillCart(buyer, [[a, 1], [b, 2]]);

    const init = await request(app).post(`${API}/orders/initiate`).set(buyer.headers)
      .send({ paymentMethod: 'upi', deliveryAddress: address() });
    expect(init.status).toBe(200);
    // Nothing is created at initiate, so nobody is told anything yet.
    expect(newOrderCalls()).toHaveLength(0);

    const paymentId = `pay_push_${Date.now()}`;
    const done = await confirm(paymentId, init.body.data.razorpayOrderId);
    expect(done.status).toBe(201);
    const orderId = done.body.data.id;

    const pushes = newOrderCalls();
    expect(pushes).toHaveLength(2);
    expect(pushes.find((p) => p.userId === kendraA.user.id).body).toBe('₹300 · Kasegaon');
    expect(pushes.find((p) => p.userId === kendraB.user.id).body).toBe('₹800 · Kasegaon');
    expect(pushes.every((p) => p.data.orderId === orderId && p.data.kind === 'new_order')).toBe(true);

    // The app retries a confirm after a dropped connection. The order already
    // exists, so this returns it — and must not tell the sellers again.
    const again = await confirm(paymentId, init.body.data.razorpayOrderId);
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(orderId);
    expect(newOrderCalls()).toHaveLength(2);
  });
});

describe('the delivery code never travels in a push', () => {
  // A push body is read on a lock screen and is also stored, in plain text, in
  // `notifications` — either would undo "encrypted at rest, shown only on the
  // buyer's own signed-in order".
  test('shipping and delivering send the buyer the usual copy and nothing else', async () => {
    const { decrypt } = await import('../../../src/utils/encrypt.js');
    const a = await offer(kendraA);
    await fillCart(buyer, [[a, 1]]);
    const orderId = (await placeCod(buyer)).body.data.id;
    sendPushToUser.mockClear();

    const put = (body) => request(app).put(`${API}/seller/orders/${orderId}/status`).set(kendraA.headers).send(body);
    expect((await put({ status: 'SHIPPED' })).status).toBe(200);

    const saved = await prisma.orderDelivery.findUnique({
      where: { orderId_sellerId: { orderId, sellerId: kendraA.user.id } },
    });
    const code = decrypt(saved.code);
    expect(code).toMatch(/^[0-9]{4}$/);

    const wrong = String((Number(code) + 1) % 10_000).padStart(4, '0');
    expect((await put({ status: 'DELIVERED', deliveryCode: wrong })).status).toBe(409);
    expect((await put({ status: 'DELIVERED', deliveryCode: code })).status).toBe(200);

    const pushes = sendPushToUser.mock.calls.map(([p]) => p);
    // One per rollup change — SHIPPED, then DELIVERED — and both to the buyer.
    // The refused wrong code sent nothing to anybody.
    expect(pushes.map((p) => [p.userId, p.data.status])).toEqual([
      [buyer.user.id, 'SHIPPED'],
      [buyer.user.id, 'DELIVERED'],
    ]);
    for (const p of pushes) {
      expect(p.title).not.toContain(code);
      expect(p.body).not.toContain(code);
      expect(Object.keys(p.data).sort()).toEqual(['orderId', 'screen', 'status']);
      expect(JSON.stringify(p)).not.toContain(saved.code);   // nor the ciphertext
    }
    // Nothing at all went to the seller.
    expect(pushes.some((p) => p.userId === kendraA.user.id)).toBe(false);
  });
});

describe('newOrderPushes (pure)', () => {
  const order = (over = {}) => ({
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'buyer',
    deliveryAddress: { city: 'Islampur' },
    items: [],
    ...over,
  });

  test('paise are shown when there are any, and never otherwise', () => {
    const [p] = newOrderPushes(order({ items: [{ sellerId: 's1', totalPrice: '1240.50' }] }));
    expect(p.body).toBe('₹1,240.50 · Islampur');
    const [q] = newOrderPushes(order({ items: [{ sellerId: 's1', totalPrice: '125000.00' }] }));
    expect(q.body).toBe('₹1,25,000 · Islampur');
  });

  test('adds exactly: three lines of 0.10 are 0.30, not 0.30000000000000004', () => {
    const items = [1, 2, 3].map(() => ({ sellerId: 's1', totalPrice: '0.10' }));
    expect(newOrderPushes(order({ items }))[0].body).toBe('₹0.30 · Islampur');
  });

  test('a line with no seller is nobody\'s to be told about', () => {
    expect(newOrderPushes(order({ items: [{ sellerId: null, totalPrice: '50.00' }] }))).toEqual([]);
  });

  test('no city on the address → the amount alone, not a dangling separator', () => {
    const [p] = newOrderPushes(order({ deliveryAddress: {}, items: [{ sellerId: 's1', totalPrice: '99.00' }] }));
    expect(p.body).toBe('₹99');
  });

  test('a "city" that is really a message is left out of the push', () => {
    // The city is free text the BUYER typed, and it lands on the seller's lock
    // screen under the title "New order". A cash order costs nothing to place.
    const items = [{ sellerId: 's1', totalPrice: '99.00' }];
    for (const city of [
      'Call 9876543210 to collect payment',
      'pay at http://example.test/pay',
      'UPI: someone@bank',
      'x'.repeat(41),
    ]) {
      const [p] = newOrderPushes(order({ deliveryAddress: { city }, items }));
      expect(p.body).toBe('₹99');
      expect(p.title).toBe('New order');
    }
  });
});

describe('pushCity', () => {
  test('keeps a place name, in any script', () => {
    expect(pushCity('Kasegaon')).toBe('Kasegaon');
    expect(pushCity('  Tal.  Karad,   Satara ')).toBe('Tal. Karad, Satara');
    expect(pushCity('कासेगाव')).toBe('कासेगाव');
    expect(pushCity('पिंपरी-चिंचवड')).toBe('पिंपरी-चिंचवड');
    expect(pushCity('Chhatrapati Sambhajinagar (Aurangabad)')).toBe('Chhatrapati Sambhajinagar (Aurangabad)');
  });

  test('drops anything with a digit, a URL character or no letters at all', () => {
    expect(pushCity('Pune 411001')).toBe('');
    expect(pushCity('9876543210')).toBe('');
    expect(pushCity('a@b')).toBe('');
    expect(pushCity('x/y')).toBe('');
    expect(pushCity('...')).toBe('');
    expect(pushCity('')).toBe('');
    expect(pushCity(null)).toBe('');
    expect(pushCity(42)).toBe('');
  });
});
