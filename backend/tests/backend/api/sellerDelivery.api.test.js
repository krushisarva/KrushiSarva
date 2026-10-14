/**
 * Seller delivery, phases 3 and 4.
 * Contract: docs/SELLER_DELIVERY_DESIGN.md §8.2 – §8.6.
 *
 *   Phase 3  what the FARMER sees on an order: `expectedBy`, and per seller a
 *            name, a status, and — only while it is being brought to them — a
 *            phone number.
 *   Phase 4  proof of delivery (a 4-digit code) and "could not deliver".
 *
 * The properties these exist to pin, in the order they would hurt if lost:
 *   1. the code is never shown to the seller;
 *   2. a wrong try is counted even though the request is refused, and the limit
 *      holds under concurrency;
 *   3. "could not deliver" puts stock back and refunds exactly once;
 *   4. an older seller app, which sends only { status }, behaves as it always did
 *      while `shop.delivery.codeRequired` is off.
 */
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing,
  cleanupTestData, prisma,
} from '../../fixtures/setup.js';
import { setSetting } from '../../../src/services/settings.service.js';
import { encrypt, decrypt } from '../../../src/utils/encrypt.js';
import {
  sellerShipmentStatus, expectedByFor, generateDeliveryCode, isDeliveryCode,
  DELIVERY_CODE_MAX_ATTEMPTS, DELIVERY_CODE_LOCK_MINUTES,
  deliveryTableReady, __setDeliveryTableReadyForTests,
} from '../../../src/services/orderDelivery.service.js';

const API = '/api/v1/agristore';
const DAY_MS = 86_400_000;

let app, category;
let kendraA, kendraB, outsider, buyer, otherBuyer;

// One listener for the whole file: prisma.$on cannot be removed, so a
// per-test listener would leak one more on every call.
let querySink = null;

beforeAll(async () => {
  app = await getApp();
  prisma.$on('query', (e) => { if (querySink) querySink.push(e.query); });
  category   = await createTestCategory({ name: `Delivery ${Date.now()}` });
  kendraA    = await createTestSeller({ name: 'Delivery Kendra A', district: 'Pune' });
  kendraB    = await createTestSeller({ name: 'Delivery Kendra B', district: 'Pune' });
  outsider   = await createTestSeller({ name: 'Delivery Kendra Outsider', district: 'Pune' });
  buyer      = await createTestUser({ name: 'Delivery Buyer', district: 'Pune' });
  otherBuyer = await createTestUser({ name: 'Delivery Other Buyer', district: 'Pune' });
}, 60_000);

afterEach(async () => {
  await setSetting('shop.delivery.codeRequired', false, null);
});

afterAll(async () => {
  await cleanupTestData();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const ADDRESS = { name: 'Buyer', phone: '9999999999', flat: '1', street: 'Main', city: 'Pune', state: 'Maharashtra', pincode: '411001' };

/** A cash order with lines from A (qty 2 @ 100) and, unless `single`, B (qty 1 @ 120). */
async function placeOrder({ single = false, as = buyer } = {}) {
  const product = await createTestCatalogProduct(category.id, { name: `Delivery Seed ${Date.now()}-${Math.round(Math.random() * 1e9)}` });
  const variantId = product.variants[0].id;
  const a = await createTestListing(kendraA.user.id, variantId, { sellingPrice: 100, stockQty: 20, district: 'Pune' });
  const b = single ? null : await createTestListing(kendraB.user.id, variantId, { sellingPrice: 120, stockQty: 20, district: 'Pune' });

  await prisma.cartItem.deleteMany({ where: { userId: as.user.id } });
  await request(app).post(`${API}/cart`).set(as.headers).send({ listingId: a.id, quantity: 2 });
  if (b) await request(app).post(`${API}/cart`).set(as.headers).send({ listingId: b.id, quantity: 1 });

  const res = await request(app).post(`${API}/orders`).set(as.headers).send({ paymentMethod: 'cod', deliveryAddress: ADDRESS });
  expect(res.status).toBe(201);
  return { orderId: res.body.data.id, listingA: a, listingB: b };
}

/** Turn an order into an online-paid one, the way /orders/confirm leaves it. */
const markPaid = (orderId) => prisma.order.update({
  where: { id: orderId },
  data: { paymentMethod: 'upi', paymentStatus: 'paid', paymentRef: `pay_dlv_${Date.now()}_${Math.round(Math.random() * 1e9)}` },
});

const setStatus = (kendra, orderId, body) => request(app)
  .put(`${API}/seller/orders/${orderId}/status`).set(kendra.headers)
  .send(typeof body === 'string' ? { status: body } : body);

const farmerOrder = async (orderId, as = buyer) => {
  const res = await request(app).get(`${API}/orders/${orderId}`).set(as.headers);
  expect(res.status).toBe(200);
  return res.body.data;
};
const deliveryFor = (order, kendra) => order.deliveries.find((d) => d.sellerId === kendra.user.id);

const row = (orderId, kendra) => prisma.orderDelivery.findUnique({
  where: { orderId_sellerId: { orderId, sellerId: kendra.user.id } },
});
const linesOf = (orderId, kendra) => prisma.orderItem.findMany({ where: { orderId, sellerId: kendra.user.id } });
const statusesOf = async (orderId, kendra) => [...new Set((await linesOf(orderId, kendra)).map((l) => l.status))];
const stockOf = async (listing) => (await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty;

/** The real code for a shipment, read the way only the server can. */
const codeOf = async (orderId, kendra) => decrypt((await row(orderId, kendra)).code);
/** A valid-looking code that is guaranteed not to be the right one. */
const wrongCodeFor = (code) => String((Number(code) + 1) % 10_000).padStart(4, '0');

const sellerRows = async (kendra, orderId) => {
  const res = await request(app).get(`${API}/seller/orders`).query({ limit: 50 }).set(kendra.headers);
  expect(res.status).toBe(200);
  return res.body.data.filter((r) => r.order.id === orderId);
};

/** Every property NAME anywhere in a JSON value. */
function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out); }
  }
  return out;
}

async function shipped({ single = true } = {}) {
  const made = await placeOrder({ single });
  expect((await setStatus(kendraA, made.orderId, 'SHIPPED')).status).toBe(200);
  return { ...made, code: await codeOf(made.orderId, kendraA) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 3 — the farmer's order
// ═══════════════════════════════════════════════════════════════════════════════

describe('farmer order responses — expectedBy + deliveries (§8.2)', () => {
  test('a new two-seller order: one delivery per seller, nothing private yet', async () => {
    const { orderId } = await placeOrder();
    const order = await farmerOrder(orderId);

    // 411001 is in nobody's saved areas, so the promise is the default 7 days.
    expect(order.promisedEtaDays).toBe(7);
    expect(order.expectedBy).toBe(new Date(new Date(order.createdAt).getTime() + 7 * DAY_MS).toISOString());

    expect(order.deliveries).toHaveLength(2);
    expect(deliveryFor(order, kendraA)).toEqual({
      sellerId: kendraA.user.id,
      sellerName: 'Delivery Kendra A',
      status: 'PENDING',
      sellerPhone: null,
      deliveryCode: null,
      failedReason: null,
    });
    expect(deliveryFor(order, kendraB)).toMatchObject({ sellerName: 'Delivery Kendra B', status: 'PENDING', sellerPhone: null });
  });

  test('the seller\'s phone is visible only while CONFIRMED or SHIPPED — and per seller', async () => {
    const { orderId } = await placeOrder();
    const phoneA = kendraA.user.phone;

    const seen = async () => {
      const order = await farmerOrder(orderId);
      return { a: deliveryFor(order, kendraA), b: deliveryFor(order, kendraB) };
    };

    expect((await seen()).a.sellerPhone).toBeNull();                       // PENDING

    await setStatus(kendraA, orderId, 'CONFIRMED');
    let now = await seen();
    expect(now.a).toMatchObject({ status: 'CONFIRMED', sellerPhone: phoneA });
    // B has not accepted anything: their number stays private.
    expect(now.b).toMatchObject({ status: 'PENDING', sellerPhone: null });

    await setStatus(kendraA, orderId, 'SHIPPED');
    now = await seen();
    expect(now.a).toMatchObject({ status: 'SHIPPED', sellerPhone: phoneA });

    await setStatus(kendraA, orderId, 'DELIVERED');
    now = await seen();
    expect(now.a).toMatchObject({ status: 'DELIVERED', sellerPhone: null, deliveryCode: null });

    await setStatus(kendraB, orderId, 'CANCELLED');
    now = await seen();
    expect(now.b).toMatchObject({ status: 'CANCELLED', sellerPhone: null, deliveryCode: null });
  });

  test('the list returns the same fields in page mode and in cursor mode', async () => {
    const { orderId } = await placeOrder();
    await setStatus(kendraA, orderId, 'SHIPPED');
    const detail = await farmerOrder(orderId);

    const page = await request(app).get(`${API}/orders`).query({ limit: 50 }).set(buyer.headers);
    expect(page.status).toBe(200);
    const fromPage = page.body.data.find((o) => o.id === orderId);
    expect(fromPage.expectedBy).toBe(detail.expectedBy);
    expect(fromPage.deliveries).toEqual(detail.deliveries);

    const cursor = await request(app).get(`${API}/orders`).query({ paginate: 'cursor', limit: 50 }).set(buyer.headers);
    expect(cursor.status).toBe(200);
    expect(cursor.body.meta).toHaveProperty('hasMore');
    const fromCursor = cursor.body.data.find((o) => o.id === orderId);
    expect(fromCursor.expectedBy).toBe(detail.expectedBy);
    expect(fromCursor.deliveries).toEqual(detail.deliveries);

    // The shipped half carries a code and a phone; the pending half neither.
    expect(deliveryFor(fromCursor, kendraA)).toMatchObject({ status: 'SHIPPED', sellerPhone: kendraA.user.phone });
    expect(deliveryFor(fromCursor, kendraA).deliveryCode).toMatch(/^[0-9]{4}$/);
    expect(deliveryFor(fromCursor, kendraB)).toMatchObject({ status: 'PENDING', sellerPhone: null, deliveryCode: null });
  });

  test('the extra data is two batched queries per page — for 8 orders as for 2', async () => {
    const fresh = await createTestUser({ name: 'Delivery Query Counter', district: 'Pune' });
    const make = async () => {
      const { orderId } = await placeOrder({ as: fresh });
      // Both sellers shipped, so the page needs BOTH lookups (phones and codes)
      // for two sellers on every order — the shape an N+1 would be worst on.
      await setStatus(kendraA, orderId, 'SHIPPED');
      await setStatus(kendraB, orderId, 'SHIPPED');
    };
    // The seller lookup, told apart from every other read of `users` (the auth
    // check, the push preference) by selecting exactly id, phone and name.
    const SELLER_LOOKUP = /^SELECT (?:"public"\."users"\."(?:id|phone|name)"(?:, )?){3} FROM "public"\."users" WHERE/;
    const count = async (mode) => {
      // Let the pushes fired by the status changes above finish first: they run
      // inline in tests and would otherwise land inside the capture window.
      await new Promise((r) => setTimeout(r, 400));
      querySink = [];
      const res = await request(app).get(`${API}/orders`).query({ limit: 50, ...mode }).set(fresh.headers);
      await new Promise((r) => setTimeout(r, 200));   // query events are emitted asynchronously
      const queries = querySink;
      querySink = null;
      expect(res.status).toBe(200);
      return {
        orders: res.body.data.length,
        codes: res.body.data.flatMap((o) => o.deliveries).filter((d) => d.deliveryCode).length,
        phones: res.body.data.flatMap((o) => o.deliveries).filter((d) => d.sellerPhone).length,
        deliveryReads: queries.filter((q) => /FROM "public"\."order_deliveries"/.test(q)).length,
        sellerReads: queries.filter((q) => SELLER_LOOKUP.test(q)).length,
      };
    };

    await make(); await make();
    const few = { page: await count({}), cursor: await count({ paginate: 'cursor' }) };
    for (let i = 0; i < 6; i++) await make();
    const many = { page: await count({}), cursor: await count({ paginate: 'cursor' }) };

    for (const mode of ['page', 'cursor']) {
      expect(few[mode]).toEqual({ orders: 2, codes: 4, phones: 4, deliveryReads: 1, sellerReads: 1 });
      // Four times the orders, sixteen codes and sixteen phones — the same two reads.
      expect(many[mode]).toEqual({ orders: 8, codes: 16, phones: 16, deliveryReads: 1, sellerReads: 1 });
    }
  }, 90_000);

  test('a page with nothing in flight runs neither lookup', async () => {
    const fresh = await createTestUser({ name: 'Delivery Idle Counter', district: 'Pune' });
    const { orderId } = await placeOrder({ as: fresh, single: true });
    await setStatus(kendraA, orderId, 'DELIVERED');
    await new Promise((r) => setTimeout(r, 400));

    querySink = [];
    const res = await request(app).get(`${API}/orders`).set(fresh.headers);
    await new Promise((r) => setTimeout(r, 200));
    const queries = querySink;
    querySink = null;

    expect(res.body.data).toHaveLength(1);
    // Delivered, with the seller's name frozen on the line: nothing to look up.
    expect(res.body.data[0].deliveries).toEqual([{
      sellerId: kendraA.user.id, sellerName: 'Delivery Kendra A', status: 'DELIVERED', sellerPhone: null, deliveryCode: null, failedReason: null,
    }]);
    expect(queries.filter((q) => /"order_deliveries"/.test(q))).toHaveLength(0);
  });

  test('an order cancelled before it left the shop reads no delivery row either', async () => {
    // Most cancelled orders. A reason for a failed delivery can only exist for
    // goods that went out, so this page must not ask the database for one.
    const fresh = await createTestUser({ name: 'Delivery Cancel Counter', district: 'Pune' });
    const pending = await placeOrder({ as: fresh, single: true });
    await setStatus(kendraA, pending.orderId, 'CANCELLED');
    const confirmed = await placeOrder({ as: fresh, single: true });
    await setStatus(kendraA, confirmed.orderId, 'CONFIRMED');
    await setStatus(kendraA, confirmed.orderId, 'CANCELLED');
    await new Promise((r) => setTimeout(r, 400));

    querySink = [];
    const res = await request(app).get(`${API}/orders`).set(fresh.headers);
    await new Promise((r) => setTimeout(r, 200));
    const queries = querySink;
    querySink = null;

    expect(res.body.data).toHaveLength(2);
    for (const order of res.body.data) {
      expect(order.deliveries).toEqual([{
        sellerId: kendraA.user.id, sellerName: 'Delivery Kendra A', status: 'CANCELLED', sellerPhone: null, deliveryCode: null, failedReason: null,
      }]);
    }
    expect(queries.filter((q) => /"order_deliveries"/.test(q))).toHaveLength(0);
  });

  test('a line with no seller is not listed, and a missing frozen name falls back to the account name', async () => {
    // Shapes only older orders have: written before lines carried a seller, or
    // before the seller's name was frozen onto the line.
    const product = await createTestCatalogProduct(category.id, { name: `Delivery Legacy ${Date.now()}` });
    const order = await prisma.order.create({
      data: {
        userId: buyer.user.id, totalAmount: 300, deliveryAddress: ADDRESS, promisedEtaDays: null,
        items: {
          create: [
            { productId: product.id, quantity: 1, unitPrice: 100, totalPrice: 100, sellerId: null },
            { productId: product.id, quantity: 2, unitPrice: 100, totalPrice: 200, sellerId: kendraA.user.id, sellerName: null, status: 'CONFIRMED' },
          ],
        },
      },
    });

    const seen = await farmerOrder(order.id);
    // No promise was recorded, so none is invented.
    expect(seen.expectedBy).toBeNull();
    expect(seen.deliveries).toEqual([{
      sellerId: kendraA.user.id,
      sellerName: 'Delivery Kendra A',
      status: 'CONFIRMED',
      sellerPhone: kendraA.user.phone,
      deliveryCode: null,
      failedReason: null,
    }]);
  });

  test('another buyer cannot read the order — and so cannot read its code', async () => {
    const { orderId } = await shipped();
    const res = await request(app).get(`${API}/orders/${orderId}`).set(otherBuyer.headers);
    expect(res.status).toBe(404);

    // Nor can the seller come at it through the buyer's route.
    const asSeller = await request(app).get(`${API}/orders/${orderId}`).set(kendraA.headers);
    expect(asSeller.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4 — the delivery code
// ═══════════════════════════════════════════════════════════════════════════════

describe('"Out for delivery" issues a code (§8.4)', () => {
  test('SHIPPED creates the row; the code is stored encrypted and shown to the farmer only', async () => {
    const { orderId } = await placeOrder({ single: true });
    expect(await row(orderId, kendraA)).toBeNull();
    expect(deliveryFor(await farmerOrder(orderId), kendraA).deliveryCode).toBeNull();

    const ship = await setStatus(kendraA, orderId, 'SHIPPED');
    expect(ship.status).toBe(200);

    const saved = await row(orderId, kendraA);
    expect(saved).toMatchObject({ codeAttempts: 0, codeLockedUntil: null, deliveredVia: null, noCodeReason: null, failedReason: null });
    // Ciphertext at rest: not four digits, and not readable without the key.
    expect(saved.code).not.toMatch(/^[0-9]{4}$/);
    expect(saved.code.split(':').length).toBeGreaterThanOrEqual(3);
    const code = decrypt(saved.code);
    expect(code).toMatch(/^[0-9]{4}$/);
    // Phase 5 columns exist and are untouched.
    expect(saved).toMatchObject({ codAmountDue: null, codCollectedAmount: null, codCollectedAt: null });

    // The farmer sees it on their own order.
    expect(deliveryFor(await farmerOrder(orderId), kendraA).deliveryCode).toBe(code);

    // The seller does not — not in the response to the tap that created it …
    expect(keysDeep(ship.body)).not.toContain('deliveryCode');
    expect(keysDeep(ship.body)).not.toContain('code');
    expect(JSON.stringify(ship.body)).not.toContain(saved.code);

    // … and not in their order list, as plain text or as ciphertext.
    const mine = await sellerRows(kendraA, orderId);
    expect(mine.length).toBeGreaterThan(0);
    for (const line of mine) {
      expect(line.order.delivery).toEqual({ hasCode: true, codeRequired: false, lockedUntil: null });
    }
    const keys = keysDeep(mine);
    expect(keys).not.toContain('deliveryCode');
    expect(keys).not.toContain('code');
    expect(keys).not.toContain('codeAttempts');
    expect(JSON.stringify(mine)).not.toContain(saved.code);
  });

  test('before it is shipped the list says there is no code', async () => {
    const { orderId } = await placeOrder({ single: true });
    const mine = await sellerRows(kendraA, orderId);
    expect(mine[0].order.delivery).toEqual({ hasCode: false, codeRequired: false, lockedUntil: null });
  });

  test('a repeated "Out for delivery" does not change the code on the farmer\'s screen', async () => {
    const { orderId, code } = await shipped();
    const again = await setStatus(kendraA, orderId, 'SHIPPED');
    expect(again.status).toBe(200);
    expect(again.body.data.unchanged).toBe(true);
    expect(await codeOf(orderId, kendraA)).toBe(code);
    expect(await prisma.orderDelivery.count({ where: { orderId } })).toBe(1);
  });

  test('the code is hidden from the farmer again once the order is delivered', async () => {
    const { orderId, code } = await shipped();
    await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });
    expect(deliveryFor(await farmerOrder(orderId), kendraA)).toMatchObject({ status: 'DELIVERED', deliveryCode: null });
  });
});

describe('marking delivered with the code (§8.4)', () => {
  test('the right code delivers, and says so', async () => {
    const { orderId, code } = await shipped();

    const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ itemStatus: 'DELIVERED', orderStatus: 'DELIVERED', deliveredVia: 'CODE', itemsUpdated: 1 });
    expect(await statusesOf(orderId, kendraA)).toEqual(['DELIVERED']);
    expect(await row(orderId, kendraA)).toMatchObject({ deliveredVia: 'CODE', noCodeReason: null, codeAttempts: 0, codeLockedUntil: null });
  });

  test('a wrong code is refused — and the attempt survives the refusal', async () => {
    const { orderId, code } = await shipped();
    const wrong = wrongCodeFor(code);

    const first = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong });
    expect(first.status).toBe(409);
    expect(first.body.success).toBe(false);
    expect(first.body.error.details).toEqual({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 4 });
    // Nothing moved …
    expect(await statusesOf(orderId, kendraA)).toEqual(['SHIPPED']);
    // … but the count did. It is written outside the status transaction for
    // exactly this reason: inside it, the refusal would have rolled it back.
    expect(await row(orderId, kendraA)).toMatchObject({ codeAttempts: 1, codeLockedUntil: null, deliveredVia: null });

    const second = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong });
    expect(second.body.error.details).toEqual({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 3 });
    expect((await row(orderId, kendraA)).codeAttempts).toBe(2);

    // The right code still works, and is not itself counted as a wrong try.
    const ok = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.deliveredVia).toBe('CODE');
    expect(await row(orderId, kendraA)).toMatchObject({ codeAttempts: 2, deliveredVia: 'CODE' });
  });

  test('the fifth wrong try locks the code for 15 minutes', async () => {
    const { orderId, code } = await shipped();
    const wrong = wrongCodeFor(code);
    const before = Date.now();

    for (let n = 1; n <= DELIVERY_CODE_MAX_ATTEMPTS - 1; n++) {
      const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong });
      expect(res.body.error.details).toEqual({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: DELIVERY_CODE_MAX_ATTEMPTS - n });
    }

    const fifth = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong });
    expect(fifth.status).toBe(409);
    expect(fifth.body.error.details.code).toBe('DELIVERY_CODE_WRONG');
    expect(fifth.body.error.details.attemptsLeft).toBe(0);
    // The try that locks says until when, so the app need not ask again.
    const lockedUntil = new Date(fifth.body.error.details.lockedUntil).getTime();
    const lockMs = DELIVERY_CODE_LOCK_MINUTES * 60_000;
    expect(lockedUntil).toBeGreaterThanOrEqual(before + lockMs - 2_000);
    expect(lockedUntil).toBeLessThanOrEqual(Date.now() + lockMs + 2_000);

    const saved = await row(orderId, kendraA);
    expect(saved.codeAttempts).toBe(5);
    // Stored as the same instant it was reported as — a time-zone slip between
    // the raw UPDATE and Prisma's read would show up here as hours.
    expect(saved.codeLockedUntil.getTime()).toBe(lockedUntil);

    // Locked: even the RIGHT code is refused now, and nothing is compared.
    const locked = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });
    expect(locked.status).toBe(409);
    expect(locked.body.error.details).toEqual({ code: 'DELIVERY_CODE_LOCKED', lockedUntil: new Date(lockedUntil).toISOString() });
    expect(await statusesOf(orderId, kendraA)).toEqual(['SHIPPED']);
    expect((await row(orderId, kendraA)).codeAttempts).toBe(5);

    // The seller's list shows the lock, so the app can grey the field out.
    const mine = await sellerRows(kendraA, orderId);
    expect(mine[0].order.delivery).toEqual({ hasCode: true, codeRequired: false, lockedUntil: new Date(lockedUntil).toISOString() });
  });

  test('four wrong tries and then the RIGHT code on the last one: delivered, and not locked', async () => {
    // The attempt is claimed before the comparison, so the fifth claim sets the
    // lock. A right code has to hand both back — otherwise the seller who
    // finally typed it correctly would be told the code is locked.
    const { orderId, code } = await shipped();
    const wrong = wrongCodeFor(code);
    for (let n = 0; n < DELIVERY_CODE_MAX_ATTEMPTS - 1; n++) {
      await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong });
    }
    expect((await row(orderId, kendraA)).codeAttempts).toBe(4);

    const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });
    expect(res.status).toBe(200);
    expect(res.body.data.deliveredVia).toBe('CODE');
    expect(await row(orderId, kendraA)).toMatchObject({ codeAttempts: 4, codeLockedUntil: null, deliveredVia: 'CODE' });
  });

  test('the right code tapped twice at the same moment: one delivery, one no-op, nothing counted', async () => {
    const { orderId, code } = await shipped();
    const results = await Promise.all([
      setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code }),
      setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.data.itemsUpdated).sort()).toEqual([0, 1]);
    expect(await statusesOf(orderId, kendraA)).toEqual(['DELIVERED']);
    expect(await row(orderId, kendraA)).toMatchObject({ codeAttempts: 0, codeLockedUntil: null, deliveredVia: 'CODE' });
  });

  test('while locked, delivering WITHOUT the code (with a reason) still works', async () => {
    const { orderId, code } = await shipped();
    const wrong = wrongCodeFor(code);
    for (let n = 0; n < DELIVERY_CODE_MAX_ATTEMPTS; n++) {
      await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong });
    }
    expect((await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code })).body.error.details.code)
      .toBe('DELIVERY_CODE_LOCKED');

    // The lock stops guessing. It must not strand a van at a farm gate.
    const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', noCodeReason: 'FARMER_PHONE_OFF' });
    expect(res.status).toBe(200);
    expect(res.body.data.deliveredVia).toBe('NO_CODE');
    expect(await row(orderId, kendraA)).toMatchObject({ deliveredVia: 'NO_CODE', noCodeReason: 'FARMER_PHONE_OFF' });
  });

  test('once the lock has passed, the seller gets a fresh five tries', async () => {
    const { orderId, code } = await shipped();
    const wrong = wrongCodeFor(code);
    for (let n = 0; n < DELIVERY_CODE_MAX_ATTEMPTS; n++) {
      await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong });
    }
    // Fifteen minutes later.
    await prisma.orderDelivery.update({
      where: { orderId_sellerId: { orderId, sellerId: kendraA.user.id } },
      data: { codeLockedUntil: new Date(Date.now() - 1_000) },
    });
    const mine = await sellerRows(kendraA, orderId);
    expect(mine[0].order.delivery.lockedUntil).toBeNull();   // an expired lock is not a lock

    const again = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong });
    expect(again.body.error.details).toEqual({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 4 });
    expect(await row(orderId, kendraA)).toMatchObject({ codeAttempts: 1, codeLockedUntil: null });

    const ok = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.deliveredVia).toBe('CODE');
  });

  test('two wrong tries sent at the same moment both count', async () => {
    const { orderId, code } = await shipped();
    const wrong = wrongCodeFor(code);

    const results = await Promise.all([
      setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong }),
      setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong }),
    ]);
    expect(results.map((r) => r.status)).toEqual([409, 409]);
    // Each took a different attempt: 4 left and 3 left, in some order.
    expect(results.map((r) => r.body.error.details.attemptsLeft).sort()).toEqual([3, 4]);
    expect((await row(orderId, kendraA)).codeAttempts).toBe(2);
  });

  test('a burst of parallel guesses gets five comparisons, not one each', async () => {
    const { orderId, code } = await shipped();
    const wrong = wrongCodeFor(code);
    const BURST = 12;

    const results = await Promise.all(
      Array.from({ length: BURST }, () => setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrong })),
    );
    const codes = results.map((r) => r.body.error?.details?.code);
    // Counting after comparing would let all twelve through as "wrong". The
    // attempt is claimed first, so exactly five are compared.
    expect(codes.filter((c) => c === 'DELIVERY_CODE_WRONG')).toHaveLength(DELIVERY_CODE_MAX_ATTEMPTS);
    expect(codes.filter((c) => c === 'DELIVERY_CODE_LOCKED')).toHaveLength(BURST - DELIVERY_CODE_MAX_ATTEMPTS);
    for (const r of results.filter((x) => x.body.error.details.code === 'DELIVERY_CODE_LOCKED')) {
      expect(Number.isNaN(new Date(r.body.error.details.lockedUntil).getTime())).toBe(false);
    }

    const saved = await row(orderId, kendraA);
    expect(saved.codeAttempts).toBe(DELIVERY_CODE_MAX_ATTEMPTS);
    expect(saved.codeLockedUntil.getTime()).toBeGreaterThan(Date.now());
    expect(await statusesOf(orderId, kendraA)).toEqual(['SHIPPED']);
  });

  test('a malformed code is a 400, not a wrong try', async () => {
    const { orderId } = await shipped();
    for (const bad of ['123', '12345', '12a4', 1234, ' 1234', '१२३४']) {
      const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: bad });
      expect(res.status).toBe(400);
    }
    const reason = await setStatus(kendraA, orderId, { status: 'DELIVERED', noCodeReason: 'BECAUSE' });
    expect(reason.status).toBe(400);

    expect(await row(orderId, kendraA)).toMatchObject({ codeAttempts: 0, deliveredVia: null });
    expect(await statusesOf(orderId, kendraA)).toEqual(['SHIPPED']);
  });

  test('the new fields are ignored on a status they do not belong to', async () => {
    const { orderId } = await placeOrder({ single: true });
    // An older or careless client sending junk alongside CONFIRMED is not refused.
    const res = await setStatus(kendraA, orderId, { status: 'CONFIRMED', deliveryCode: 'zz', noCodeReason: 'nope', failedReason: 'nope' });
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('deliveredVia');
    expect(await row(orderId, kendraA)).toBeNull();
  });

  test('a seller who is not on the order cannot spend its attempts', async () => {
    const { orderId, code } = await shipped();
    const res = await setStatus(outsider, orderId, { status: 'DELIVERED', deliveryCode: wrongCodeFor(code) });
    expect(res.status).toBe(404);
    expect((await row(orderId, kendraA)).codeAttempts).toBe(0);
    expect(await row(orderId, outsider)).toBeNull();
  });
});

describe('a repeated tap stays a harmless no-op', () => {
  test('"Mark delivered" twice with the right code', async () => {
    const { orderId, code } = await shipped();
    await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });

    const again = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ itemsUpdated: 0, unchanged: true });
  });

  test('a wrong code on an order that is ALREADY delivered burns nothing', async () => {
    const { orderId, code } = await shipped();
    await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });

    const again = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrongCodeFor(code) });
    expect(again.status).toBe(200);
    expect(again.body.data.unchanged).toBe(true);
    expect(await row(orderId, kendraA)).toMatchObject({ codeAttempts: 0, codeLockedUntil: null, deliveredVia: 'CODE' });
  });

  test('with the code required, a repeat on a delivered order is still a no-op, not a refusal', async () => {
    const { orderId, code } = await shipped();
    await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });
    await setSetting('shop.delivery.codeRequired', true, null);

    const again = await setStatus(kendraA, orderId, 'DELIVERED');
    expect(again.status).toBe(200);
    expect(again.body.data.unchanged).toBe(true);
  });
});

describe('delivering without the code (§8.4)', () => {
  test('a reason and no code delivers a shipped order as NO_CODE', async () => {
    const { orderId } = await shipped();
    const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', noCodeReason: 'RECEIVED_BY_OTHER' });
    expect(res.status).toBe(200);
    expect(res.body.data.deliveredVia).toBe('NO_CODE');
    expect(await row(orderId, kendraA)).toMatchObject({ deliveredVia: 'NO_CODE', noCodeReason: 'RECEIVED_BY_OTHER', codeAttempts: 0 });
  });

  test('handed over at the counter: PENDING → DELIVERED creates the row, with no code', async () => {
    const { orderId } = await placeOrder({ single: true });
    const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', noCodeReason: 'HANDED_AT_SHOP' });
    expect(res.status).toBe(200);
    expect(res.body.data.deliveredVia).toBe('NO_CODE');
    expect(await row(orderId, kendraA)).toMatchObject({ code: null, deliveredVia: 'NO_CODE', noCodeReason: 'HANDED_AT_SHOP' });
  });

  test('an empty code field next to a reason is treated as "no code sent"', async () => {
    const { orderId } = await shipped();
    const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: '', noCodeReason: 'OTHER' });
    expect(res.status).toBe(200);
    expect(res.body.data.deliveredVia).toBe('NO_CODE');
  });

  test('a code AND a reason: the code is what is checked', async () => {
    const { orderId, code } = await shipped();
    const wrong = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrongCodeFor(code), noCodeReason: 'OTHER' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.details.code).toBe('DELIVERY_CODE_WRONG');

    const right = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code, noCodeReason: 'OTHER' });
    expect(right.body.data.deliveredVia).toBe('CODE');
    expect((await row(orderId, kendraA)).noCodeReason).toBeNull();
  });
});

describe('shop.delivery.codeRequired (§8.5)', () => {
  describe('OFF — the default; what an older seller app relies on', () => {
    test('a bare { status: "DELIVERED" } delivers exactly as before, deliveredVia null', async () => {
      const { orderId } = await shipped();
      const res = await setStatus(kendraA, orderId, 'DELIVERED');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ orderId, itemsUpdated: 1, itemStatus: 'DELIVERED', orderStatus: 'DELIVERED', deliveredVia: null });
      expect(await statusesOf(orderId, kendraA)).toEqual(['DELIVERED']);
      // The code was issued at SHIPPED; how it was delivered stays unrecorded.
      expect(await row(orderId, kendraA)).toMatchObject({ deliveredVia: null, noCodeReason: null, codeAttempts: 0 });
    });

    test('the whole old flow, PENDING → CONFIRMED → SHIPPED → DELIVERED, with { status } only', async () => {
      const { orderId } = await placeOrder({ single: true });
      for (const status of ['CONFIRMED', 'SHIPPED', 'DELIVERED']) {
        const res = await setStatus(kendraA, orderId, status);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ itemStatus: status, orderStatus: status, itemsUpdated: 1 });
      }
    });

    test('skipping straight to DELIVERED from PENDING writes no delivery row at all', async () => {
      const { orderId } = await placeOrder({ single: true });
      const res = await setStatus(kendraA, orderId, 'DELIVERED');
      expect(res.status).toBe(200);
      expect(res.body.data.deliveredVia).toBeNull();
      expect(await row(orderId, kendraA)).toBeNull();
    });

    test('a code sent for an order that never had one is not held against the seller', async () => {
      const { orderId } = await placeOrder({ single: true });
      const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: '1234' });
      expect(res.status).toBe(200);
      expect(res.body.data.deliveredVia).toBeNull();
    });

    test('a code that IS sent is still checked — optional means not demanded, not ignored', async () => {
      const { orderId, code } = await shipped();
      const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: wrongCodeFor(code) });
      expect(res.status).toBe(409);
      expect(res.body.error.details.code).toBe('DELIVERY_CODE_WRONG');
    });
  });

  describe('ON', () => {
    test('a bare { status: "DELIVERED" } is refused with DELIVERY_CODE_REQUIRED', async () => {
      const { orderId } = await shipped();
      await setSetting('shop.delivery.codeRequired', true, null);

      const res = await setStatus(kendraA, orderId, 'DELIVERED');
      expect(res.status).toBe(409);
      expect(res.body.error.details).toEqual({ code: 'DELIVERY_CODE_REQUIRED' });
      expect(await statusesOf(orderId, kendraA)).toEqual(['SHIPPED']);
      // Not sending a code is not a wrong guess.
      expect((await row(orderId, kendraA)).codeAttempts).toBe(0);

      const mine = await sellerRows(kendraA, orderId);
      expect(mine[0].order.delivery).toEqual({ hasCode: true, codeRequired: true, lockedUntil: null });
    });

    test('a code sent when none was ever issued is refused the same way', async () => {
      const { orderId } = await placeOrder({ single: true });
      await setSetting('shop.delivery.codeRequired', true, null);

      const res = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: '1234' });
      expect(res.status).toBe(409);
      expect(res.body.error.details).toEqual({ code: 'DELIVERY_CODE_REQUIRED' });
      expect(await statusesOf(orderId, kendraA)).toEqual(['PENDING']);
    });

    test('the right code, or a reason, both still deliver', async () => {
      await setSetting('shop.delivery.codeRequired', true, null);

      const withCode = await shipped();
      const a = await setStatus(kendraA, withCode.orderId, { status: 'DELIVERED', deliveryCode: withCode.code });
      expect(a.status).toBe(200);
      expect(a.body.data.deliveredVia).toBe('CODE');

      const overCounter = await placeOrder({ single: true });
      const b = await setStatus(kendraA, overCounter.orderId, { status: 'DELIVERED', noCodeReason: 'HANDED_AT_SHOP' });
      expect(b.status).toBe(200);
      expect(b.body.data.deliveredVia).toBe('NO_CODE');
    });

    test('confirming, shipping and cancelling are not affected', async () => {
      await setSetting('shop.delivery.codeRequired', true, null);
      const one = await placeOrder({ single: true });
      expect((await setStatus(kendraA, one.orderId, 'CONFIRMED')).status).toBe(200);
      expect((await setStatus(kendraA, one.orderId, 'SHIPPED')).status).toBe(200);

      const two = await placeOrder({ single: true });
      expect((await setStatus(kendraA, two.orderId, 'CANCELLED')).status).toBe(200);
    });
  });
});

describe('two sellers on one order have independent codes', () => {
  test('each has their own row, code, counter and outcome', async () => {
    const { orderId } = await placeOrder();
    await setStatus(kendraA, orderId, 'SHIPPED');
    await setStatus(kendraB, orderId, 'SHIPPED');
    expect(await prisma.orderDelivery.count({ where: { orderId } })).toBe(2);

    const codeA = await codeOf(orderId, kendraA);
    // Two random 4-digit codes collide once in ten thousand runs. Pin B's to a
    // different value so "A's code does not open B's delivery" is a statement
    // about the rows, not about luck.
    const codeB = wrongCodeFor(codeA);
    await prisma.orderDelivery.update({
      where: { orderId_sellerId: { orderId, sellerId: kendraB.user.id } },
      data: { code: encrypt(codeB) },
    });

    // The farmer sees one code per delivery.
    let order = await farmerOrder(orderId);
    expect(deliveryFor(order, kendraA).deliveryCode).toBe(codeA);
    expect(deliveryFor(order, kendraB).deliveryCode).toBe(codeB);

    // A's code does not deliver B's goods — and the wrong try lands on B alone.
    const cross = await setStatus(kendraB, orderId, { status: 'DELIVERED', deliveryCode: codeA });
    expect(cross.status).toBe(409);
    expect(cross.body.error.details).toEqual({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 4 });
    expect((await row(orderId, kendraB)).codeAttempts).toBe(1);
    expect((await row(orderId, kendraA)).codeAttempts).toBe(0);

    // A delivers. B is still out for delivery, with its code still showing.
    const a = await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: codeA });
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ deliveredVia: 'CODE', orderStatus: 'SHIPPED' });
    order = await farmerOrder(orderId);
    expect(deliveryFor(order, kendraA)).toMatchObject({ status: 'DELIVERED', deliveryCode: null, sellerPhone: null });
    expect(deliveryFor(order, kendraB)).toMatchObject({ status: 'SHIPPED', deliveryCode: codeB, sellerPhone: kendraB.user.phone });

    // Each seller's list describes only their own delivery.
    expect((await sellerRows(kendraB, orderId))[0].order.delivery.hasCode).toBe(true);

    const b = await setStatus(kendraB, orderId, { status: 'DELIVERED', noCodeReason: 'RECEIVED_BY_OTHER' });
    expect(b.body.data).toMatchObject({ deliveredVia: 'NO_CODE', orderStatus: 'DELIVERED' });
    expect(await row(orderId, kendraA)).toMatchObject({ deliveredVia: 'CODE' });
    expect(await row(orderId, kendraB)).toMatchObject({ deliveredVia: 'NO_CODE', noCodeReason: 'RECEIVED_BY_OTHER' });
  });

  test('two sellers shipping the same order at the same moment each get a code', async () => {
    const { orderId } = await placeOrder();
    const [a, b] = await Promise.all([
      setStatus(kendraA, orderId, 'SHIPPED'),
      setStatus(kendraB, orderId, 'SHIPPED'),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await codeOf(orderId, kendraA)).toMatch(/^[0-9]{4}$/);
    expect(await codeOf(orderId, kendraB)).toMatch(/^[0-9]{4}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4 — "could not deliver"
// ═══════════════════════════════════════════════════════════════════════════════

describe('SHIPPED → CANCELLED, "could not deliver" (§8.4)', () => {
  test('without a reason it is refused with FAILED_REASON_REQUIRED, and nothing moves', async () => {
    const { orderId, listingA } = await shipped();
    expect(await stockOf(listingA)).toBe(18);   // 20 − 2 sold

    const res = await setStatus(kendraA, orderId, 'CANCELLED');
    expect(res.status).toBe(409);
    // `from` is what an older seller app already gets; `code` is added to it.
    expect(res.body.error.details).toEqual({ code: 'FAILED_REASON_REQUIRED', from: ['SHIPPED'] });
    expect(res.body.error.message).toBe('This order is already shipped and cannot be marked cancelled.');
    expect(await statusesOf(orderId, kendraA)).toEqual(['SHIPPED']);
    expect(await stockOf(listingA)).toBe(18);
    expect((await row(orderId, kendraA)).failedReason).toBeNull();
  });

  test('a reason that is not one of the three is a 400', async () => {
    const { orderId, listingA } = await shipped();
    const res = await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'DID_NOT_FEEL_LIKE_IT' });
    expect(res.status).toBe(400);
    expect(await statusesOf(orderId, kendraA)).toEqual(['SHIPPED']);
    expect(await stockOf(listingA)).toBe(18);
  });

  test('with a reason: cancelled, reason stored, stock back exactly once', async () => {
    const { orderId, listingA } = await shipped();

    const res = await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'REFUSED' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ itemsUpdated: 1, itemStatus: 'CANCELLED', orderStatus: 'CANCELLED' });
    expect(res.body.data).not.toHaveProperty('deliveredVia');

    const lines = await linesOf(orderId, kendraA);
    expect(lines.map((l) => l.status)).toEqual(['CANCELLED']);
    expect(lines[0].cancelledAt).toBeInstanceOf(Date);
    expect(lines[0].shippedAt).toBeInstanceOf(Date);       // it did go out
    expect(await row(orderId, kendraA)).toMatchObject({ failedReason: 'REFUSED', deliveredVia: null });
    expect(await stockOf(listingA)).toBe(20);

    // The same request again — a double tap, or a retry on a bad connection.
    const again = await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'REFUSED' });
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ itemsUpdated: 0, unchanged: true });
    expect(await stockOf(listingA)).toBe(20);              // not 22

    // The code is gone from the farmer's screen with the delivery.
    expect(deliveryFor(await farmerOrder(orderId), kendraA)).toMatchObject({ status: 'CANCELLED', deliveryCode: null, sellerPhone: null });
  });

  test('two "could not deliver" requests at the same moment restore stock once', async () => {
    const { orderId, listingA } = await shipped();
    const results = await Promise.all([
      setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'UNREACHABLE' }),
      setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'UNREACHABLE' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.data.itemsUpdated).sort()).toEqual([0, 1]);
    expect(await stockOf(listingA)).toBe(20);
  });

  test('paid online: the refund is planned and settled exactly once', async () => {
    const { orderId, listingA } = await placeOrder();   // two sellers
    await markPaid(orderId);
    await setStatus(kendraA, orderId, 'SHIPPED');

    const refunds = () => prisma.auditLog.count({ where: { action: 'ORDER_REFUND', entityId: orderId } });
    expect(await refunds()).toBe(0);

    const res = await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'ADDRESS_NOT_FOUND' });
    expect(res.status).toBe(200);
    // A's half went back; B's half is still coming.
    expect((await prisma.order.findUnique({ where: { id: orderId } })).paymentStatus).toBe('partially_refunded');
    expect(await refunds()).toBe(1);
    expect(await stockOf(listingA)).toBe(20);

    const again = await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'ADDRESS_NOT_FOUND' });
    expect(again.body.data.unchanged).toBe(true);
    expect(await refunds()).toBe(1);
    expect((await prisma.order.findUnique({ where: { id: orderId } })).paymentStatus).toBe('partially_refunded');
    expect(await stockOf(listingA)).toBe(20);
  });

  test('a cash order has nothing to refund, and its payment status is left alone', async () => {
    const { orderId } = await shipped();
    await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'REFUSED' });
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order).toMatchObject({ status: 'CANCELLED', paymentMethod: 'cod', paymentStatus: 'pending' });
    expect(await prisma.auditLog.count({ where: { action: 'ORDER_REFUND', entityId: orderId } })).toBe(0);
  });

  test('PENDING and CONFIRMED still cancel with no reason, and write no delivery row', async () => {
    const pending = await placeOrder({ single: true });
    expect((await setStatus(kendraA, pending.orderId, 'CANCELLED')).status).toBe(200);
    expect(await stockOf(pending.listingA)).toBe(20);
    expect(await row(pending.orderId, kendraA)).toBeNull();

    const confirmed = await placeOrder({ single: true });
    await setStatus(kendraA, confirmed.orderId, 'CONFIRMED');
    // A reason sent with an ordinary cancel is not recorded as a failed delivery.
    expect((await setStatus(kendraA, confirmed.orderId, { status: 'CANCELLED', failedReason: 'REFUSED' })).status).toBe(200);
    expect(await stockOf(confirmed.listingA)).toBe(20);
    expect(await row(confirmed.orderId, kendraA)).toBeNull();
  });

  test('a DELIVERED order cannot be cancelled, reason or no reason', async () => {
    const { orderId, code, listingA } = await shipped();
    await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });

    const res = await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'REFUSED' });
    expect(res.status).toBe(409);
    // No `code`: a reason is not what is missing here.
    expect(res.body.error.details).toEqual({ from: ['DELIVERED'] });
    expect(await stockOf(listingA)).toBe(18);
    expect((await row(orderId, kendraA)).failedReason).toBeNull();
  });

  test('one seller\'s failed delivery does not touch the other seller\'s half', async () => {
    const { orderId, listingA, listingB } = await placeOrder();
    await setStatus(kendraA, orderId, 'SHIPPED');
    await setStatus(kendraB, orderId, 'SHIPPED');

    const res = await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'REFUSED' });
    expect(res.body.data).toMatchObject({ itemStatus: 'CANCELLED', orderStatus: 'SHIPPED' });
    expect(await stockOf(listingA)).toBe(20);
    expect(await stockOf(listingB)).toBe(19);
    expect(await statusesOf(orderId, kendraB)).toEqual(['SHIPPED']);
    expect((await row(orderId, kendraB)).failedReason).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Order tracking — the farmer is told WHY a delivery came back
// ═══════════════════════════════════════════════════════════════════════════════

describe('farmer order responses — deliveries[].failedReason', () => {
  test('nothing to say while the order is on its way, or once it has arrived', async () => {
    const { orderId, code } = await shipped();
    expect(deliveryFor(await farmerOrder(orderId), kendraA)).toMatchObject({ status: 'SHIPPED', failedReason: null });

    await setStatus(kendraA, orderId, { status: 'DELIVERED', deliveryCode: code });
    expect(deliveryFor(await farmerOrder(orderId), kendraA)).toMatchObject({ status: 'DELIVERED', failedReason: null });
  });

  test.each(['REFUSED', 'UNREACHABLE', 'ADDRESS_NOT_FOUND'])('"could not deliver" (%s) reaches the farmer on every read of the order', async (reason) => {
    const { orderId } = await shipped();
    expect((await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: reason })).status).toBe(200);

    const detail = await farmerOrder(orderId);
    expect(deliveryFor(detail, kendraA)).toEqual({
      sellerId: kendraA.user.id,
      sellerName: 'Delivery Kendra A',
      status: 'CANCELLED',
      sellerPhone: null,
      deliveryCode: null,
      failedReason: reason,
    });
    // The times the timeline is drawn from travel with the line.
    const [line] = detail.items;
    expect(line).toMatchObject({ status: 'CANCELLED' });
    expect(new Date(line.shippedAt).getTime()).toBeLessThanOrEqual(new Date(line.cancelledAt).getTime());

    for (const mode of [{}, { paginate: 'cursor' }]) {
      const res = await request(app).get(`${API}/orders`).query({ limit: 50, ...mode }).set(buyer.headers);
      expect(res.status).toBe(200);
      expect(res.body.data.find((o) => o.id === orderId).deliveries).toEqual(detail.deliveries);
    }
  });

  test('two shops: the reason sits on the delivery that came back, not on the other one', async () => {
    const { orderId } = await placeOrder();
    await setStatus(kendraA, orderId, 'SHIPPED');
    await setStatus(kendraB, orderId, 'SHIPPED');
    await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'UNREACHABLE' });

    const order = await farmerOrder(orderId);
    expect(deliveryFor(order, kendraA)).toMatchObject({ status: 'CANCELLED', failedReason: 'UNREACHABLE', deliveryCode: null });
    // B is still on its way: its code is still shown, and it has no reason.
    expect(deliveryFor(order, kendraB)).toMatchObject({ status: 'SHIPPED', failedReason: null });
    expect(deliveryFor(order, kendraB).deliveryCode).toMatch(/^[0-9]{4}$/);
  });

  test('a cancel before the goods left carries no reason, even when one was sent', async () => {
    const { orderId } = await placeOrder({ single: true });
    await setStatus(kendraA, orderId, 'CONFIRMED');
    await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'REFUSED' });
    expect(deliveryFor(await farmerOrder(orderId), kendraA)).toMatchObject({ status: 'CANCELLED', failedReason: null });
  });

  test('the farmer cancelling their own order is not a failed delivery', async () => {
    const { orderId } = await placeOrder({ single: true });
    const res = await request(app).put(`${API}/orders/${orderId}/cancel`).set(buyer.headers);
    expect(res.status).toBe(200);
    expect(deliveryFor(await farmerOrder(orderId), kendraA)).toMatchObject({ status: 'CANCELLED', failedReason: null });
  });

  test('anything else stored in the column never reaches the farmer', async () => {
    const { orderId } = await shipped();
    await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'REFUSED' });
    await prisma.orderDelivery.update({
      where: { orderId_sellerId: { orderId, sellerId: kendraA.user.id } },
      data: { failedReason: 'customer was rude <script>' },
    });
    expect(deliveryFor(await farmerOrder(orderId), kendraA)).toMatchObject({ status: 'CANCELLED', failedReason: null });
  });

  test('the reason is not shown to another buyer, and the seller is not shown the code through it', async () => {
    const { orderId } = await shipped();
    await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'REFUSED' });
    expect((await request(app).get(`${API}/orders/${orderId}`).set(otherBuyer.headers)).status).toBe(404);
    // The seller's own list still carries no code, cancelled or not.
    for (const r of await sellerRows(kendraA, orderId)) expect(keysDeep(r)).not.toContain('deliveryCode');
  });

  test('a page of orders with a failed delivery is still one read of order_deliveries', async () => {
    const fresh = await createTestUser({ name: 'Delivery Failed Counter', district: 'Pune' });
    for (let i = 0; i < 3; i++) {
      const { orderId } = await placeOrder({ as: fresh, single: true });
      await setStatus(kendraA, orderId, 'SHIPPED');
      await setStatus(kendraA, orderId, { status: 'CANCELLED', failedReason: 'ADDRESS_NOT_FOUND' });
    }
    await new Promise((r) => setTimeout(r, 400));

    querySink = [];
    const res = await request(app).get(`${API}/orders`).set(fresh.headers);
    await new Promise((r) => setTimeout(r, 200));
    const queries = querySink;
    querySink = null;

    expect(res.body.data).toHaveLength(3);
    expect(res.body.data.flatMap((o) => o.deliveries).map((d) => d.failedReason))
      .toEqual(['ADDRESS_NOT_FOUND', 'ADDRESS_NOT_FOUND', 'ADDRESS_NOT_FOUND']);
    expect(queries.filter((q) => /FROM "public"\."order_deliveries"/.test(q))).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1, the stored half — NEW_ORDER is a real notification type
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Deployed before the script — the table is not there yet
// ═══════════════════════════════════════════════════════════════════════════════

describe('the code is deployed before order_deliveries exists', () => {
  // The table arrives by a manual script and nothing forces it to be applied
  // first. "Mark shipped" writes to it INSIDE the status transaction, so without
  // a guard every seller would get a 500 on every shipment. The feature has to
  // stand aside instead: everything works as it did before it existed.
  //
  // The absence is simulated through the service's own switch rather than by
  // dropping the table — every suite shares this database.
  beforeEach(() => __setDeliveryTableReadyForTests(false));
  afterEach(() => __setDeliveryTableReadyForTests(null));

  test('the whole flow still works, and touches the table nowhere', async () => {
    const { orderId } = await placeOrder({ single: true });
    for (const status of ['CONFIRMED', 'SHIPPED', 'DELIVERED']) {
      const res = await setStatus(kendraA, orderId, status);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ itemStatus: status, orderStatus: status, itemsUpdated: 1 });
    }
    expect(await row(orderId, kendraA)).toBeNull();
  });

  test('while shipped: the farmer is shown no code, and the seller list carries no `delivery`', async () => {
    const { orderId } = await placeOrder({ single: true });
    expect((await setStatus(kendraA, orderId, 'SHIPPED')).status).toBe(200);

    const order = await farmerOrder(orderId);
    // The parts that need no table are still there.
    expect(deliveryFor(order, kendraA)).toMatchObject({ status: 'SHIPPED', deliveryCode: null });
    expect(deliveryFor(order, kendraA).sellerPhone).toBeTruthy();

    // No `delivery` is what the seller app reads as "an older backend": it then
    // offers one-tap delivery and no "could not deliver" — both accepted below.
    const rows = await sellerRows(kendraA, orderId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.order).not.toHaveProperty('delivery');
  });

  test('a code cannot be demanded when none can be issued: delivery is not blocked', async () => {
    const { orderId } = await placeOrder({ single: true });
    expect((await setStatus(kendraA, orderId, 'SHIPPED')).status).toBe(200);
    await setSetting('shop.delivery.codeRequired', true, null);

    const res = await setStatus(kendraA, orderId, 'DELIVERED');
    expect(res.status).toBe(200);
    expect(res.body.data.deliveredVia).toBeNull();
    expect(await statusesOf(orderId, kendraA)).toEqual(['DELIVERED']);
  });

  test('a shipped order cannot be cancelled, reason or no reason — exactly as before the feature', async () => {
    const { orderId, listingA } = await placeOrder({ single: true });
    expect((await setStatus(kendraA, orderId, 'SHIPPED')).status).toBe(200);

    for (const body of ['CANCELLED', { status: 'CANCELLED', failedReason: 'REFUSED' }]) {
      const res = await setStatus(kendraA, orderId, body);
      expect(res.status).toBe(409);
      // No FAILED_REASON_REQUIRED: a reason would not help on this database.
      expect(res.body.error.details).toEqual({ from: ['SHIPPED'] });
    }
    expect(await statusesOf(orderId, kendraA)).toEqual(['SHIPPED']);
    expect(await stockOf(listingA)).toBe(18);
  });

  test('applying the script switches the feature on without a restart', async () => {
    const { orderId } = await placeOrder({ single: true });

    __setDeliveryTableReadyForTests(null);            // "the 30 s re-check comes round"
    expect(await deliveryTableReady()).toBe(true);    // asks the real database

    expect((await setStatus(kendraA, orderId, 'SHIPPED')).status).toBe(200);
    expect(await codeOf(orderId, kendraA)).toMatch(/^[0-9]{4}$/);
    expect((await sellerRows(kendraA, orderId))[0].order.delivery).toMatchObject({ hasCode: true });
  });
});

describe('the NEW_ORDER notification reaches the seller\'s inbox', () => {
  test('placing an order writes one row per seller, with the contract\'s payload', async () => {
    // The real push service runs here (no Redis in tests → delivered inline).
    // `type` is a database ENUM: without NEW_ORDER on it the push still goes to
    // the phone but this insert is refused, as 'animal_chat' once was.
    const { orderId } = await placeOrder();

    let rows = [];
    for (let i = 0; i < 40 && rows.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
      rows = await prisma.notification.findMany({ where: { type: 'NEW_ORDER', data: { path: ['orderId'], equals: orderId } } });
    }
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual([kendraA.user.id, kendraB.user.id].sort());
    const toA = rows.find((r) => r.userId === kendraA.user.id);
    expect(toA).toMatchObject({ title: 'New order', body: '₹200 · Pune', data: { kind: 'new_order', orderId } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════════

describe('sellerShipmentStatus', () => {
  test.each([
    [['PENDING'], 'PENDING'],
    [['SHIPPED', 'CONFIRMED'], 'CONFIRMED'],          // the least advanced live line
    [['DELIVERED', 'SHIPPED'], 'SHIPPED'],
    [['DELIVERED', 'CANCELLED'], 'DELIVERED'],        // cancelled lines do not count
    [['CANCELLED', 'CANCELLED'], 'CANCELLED'],        // nothing live
    [[], 'CANCELLED'],
  ])('%j → %s', (statuses, expected) => {
    expect(sellerShipmentStatus(statuses)).toBe(expected);
  });
});

describe('expectedByFor', () => {
  const createdAt = new Date('2026-10-13T06:30:00.000Z');
  test('createdAt + promisedEtaDays', () => {
    expect(expectedByFor({ createdAt, promisedEtaDays: 3 })).toBe('2026-10-16T06:30:00.000Z');
    expect(expectedByFor({ createdAt: createdAt.toISOString(), promisedEtaDays: 0 })).toBe('2026-10-13T06:30:00.000Z');
  });
  test('null when no promise was recorded', () => {
    expect(expectedByFor({ createdAt, promisedEtaDays: null })).toBeNull();
    expect(expectedByFor({ createdAt })).toBeNull();
  });
});

describe('the code', () => {
  test('is always four digits, leading zeros kept', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const code = generateDeliveryCode();
      expect(code).toMatch(/^[0-9]{4}$/);
      seen.add(code);
    }
    // 2000 draws from 10,000 values: a constant or a tiny range would show here.
    expect(seen.size).toBeGreaterThan(1500);
  });

  test('isDeliveryCode accepts only a 4-digit STRING', () => {
    expect(isDeliveryCode('0042')).toBe(true);
    expect(isDeliveryCode(42)).toBe(false);       // 0042 sent as a number is 42
    expect(isDeliveryCode('42')).toBe(false);
    expect(isDeliveryCode('00420')).toBe(false);
    expect(isDeliveryCode(null)).toBe(false);
  });
});
