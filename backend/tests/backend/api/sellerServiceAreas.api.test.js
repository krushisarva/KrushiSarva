/**
 * Seller delivery, phase 2 — the delivery-area routes.
 * Contract: docs/SELLER_DELIVERY_DESIGN.md §5 (phase 2).
 *
 *   GET    /agristore/seller-compliance/service-areas
 *   POST   /agristore/seller-compliance/service-areas      upsert on matchKey
 *   DELETE /agristore/seller-compliance/service-areas/:id
 *
 * The routes have existed since the serviceability work and the farmer's quote
 * has always read their rows — but no screen called them, so in practice every
 * seller was "everywhere, 3 to 7 days, no extra charge" and nothing exercised
 * the write side over HTTP except two upsert cases in shopCompliance.api.test.js.
 * The seller app's new "Delivery areas" screen is the first real caller, so this
 * pins what it depends on: the validation, the ownership rules, and — the part
 * that matters to a farmer — that a saved area actually changes the quote.
 */
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData, prisma,
} from '../../fixtures/setup.js';
import { setSetting } from '../../../src/services/settings.service.js';

const API = '/api/v1/agristore';
const AREAS = `${API}/seller-compliance/service-areas`;

let app, category, kendraA, kendraB, farmer;

const save = (seller, body) => request(app).post(AREAS).set(seller.headers).send(body);
const list = (seller) => request(app).get(AREAS).set(seller.headers);
const remove = (seller, id) => request(app).delete(`${AREAS}/${id}`).set(seller.headers);
const rowsOf = (seller) => prisma.sellerServiceArea.findMany({ where: { sellerId: seller.user.id } });

async function offer(kendra, { sellingPrice = 100, stockQty = 50 } = {}) {
  const product = await createTestCatalogProduct(category.id, {
    name: `Area Seed ${Date.now()}-${Math.round(Math.random() * 1e9)}`,
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

const quoteFor = async (user, pincode) => {
  const res = await request(app).get(`${API}/cart/quote`).query({ pincode }).set(user.headers);
  expect(res.status).toBe(200);
  return res.body.data;
};

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory({ name: `ServiceAreas ${Date.now()}` });
  kendraA = await createTestSeller({ name: 'Area Kendra A', district: 'Pune' });
  kendraB = await createTestSeller({ name: 'Area Kendra B', district: 'Pune' });
  farmer  = await createTestUser({ name: 'Area Farmer', district: 'Pune' });
}, 60_000);

beforeEach(async () => {
  await prisma.sellerServiceArea.deleteMany({ where: { sellerId: { in: [kendraA.user.id, kendraB.user.id] } } });
});

afterAll(async () => {
  await setSetting('shop.serviceability.strict', false, null).catch(() => {});
  await cleanupTestData();
});

describe('GET /service-areas', () => {
  test('a seller with nothing saved gets an empty list, not an error', async () => {
    const res = await list(kendraA);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  test('returns the caller\'s own areas and nobody else\'s', async () => {
    await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
    await save(kendraA, { pincodePrefix: '416', etaMinDays: 2, etaMaxDays: 4 });
    await save(kendraB, { pincode: '415404', etaMinDays: 5, etaMaxDays: 6 });

    const res = await list(kendraA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((a) => a.sellerId === kendraA.user.id)).toBe(true);
    const exact = res.body.data.find((a) => a.pincode === '415404');
    expect(exact).toMatchObject({
      pincode: '415404', pincodePrefix: null, etaMinDays: 1, etaMaxDays: 2,
      surcharge: 30, codAvailable: true, pickupAvailable: false, isActive: true,
    });
  });

  test('401 without a session, 403 for a farmer', async () => {
    expect((await request(app).get(AREAS)).status).toBe(401);
    expect((await request(app).get(AREAS).set(farmer.headers)).status).toBe(403);
  });
});

describe('POST /service-areas', () => {
  test('saving the same area again returns the SAME row, updated', async () => {
    const first = await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
    expect(first.status).toBe(201);

    const second = await save(kendraA, { pincode: '415404', etaMinDays: 2, etaMaxDays: 5, surcharge: 45.5 });
    expect(second.status).toBe(201);

    // The same id is what lets the screen treat "Change" as an edit of one row
    // rather than a delete-and-recreate.
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data).toMatchObject({ etaMinDays: 2, etaMaxDays: 5, surcharge: 45.5 });
    expect(await rowsOf(kendraA)).toHaveLength(1);
  });

  test('the same PIN code saved by two sellers is two rows — the key is per seller', async () => {
    const a = await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2 });
    const b = await save(kendraB, { pincode: '415404', etaMinDays: 3, etaMaxDays: 4 });
    expect(a.body.data.id).not.toBe(b.body.data.id);
    expect(b.body.data.sellerId).toBe(kendraB.user.id);
  });

  test('each kind of area gets its own key: PIN, prefix, district, state', async () => {
    await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2 });
    await save(kendraA, { pincodePrefix: '415', etaMinDays: 1, etaMaxDays: 2 });
    await save(kendraA, { district: 'Sangli', etaMinDays: 1, etaMaxDays: 2 });
    await save(kendraA, { state: 'Maharashtra', etaMinDays: 1, etaMaxDays: 2 });

    const keys = (await rowsOf(kendraA)).map((r) => r.matchKey).sort();
    expect(keys).toEqual(['dist:sangli', 'pin:415404', 'pre:415', 'state:maharashtra']);
  });

  test('a district differing only in case is the same area', async () => {
    const first = await save(kendraA, { district: 'Sangli', etaMinDays: 1, etaMaxDays: 2 });
    const second = await save(kendraA, { district: 'SANGLI', etaMinDays: 3, etaMaxDays: 4 });
    expect(second.body.data.id).toBe(first.body.data.id);
  });

  test('an omitted optional field goes back to its default — the save is a full replace', async () => {
    // What the seller app has to know: this is not a PATCH. A row saved with a
    // charge and then re-saved without one has NO charge afterwards, and the
    // same holds for codAvailable / pickupAvailable / isActive. An edit screen
    // that does not show a field must send its stored value back.
    const first = await save(kendraA, {
      pincode: '415404', etaMinDays: 1, etaMaxDays: 2,
      surcharge: 30, codAvailable: false, pickupAvailable: true, isActive: false,
    });
    expect(first.body.data).toMatchObject({ surcharge: 30, codAvailable: false, pickupAvailable: true, isActive: false });

    const second = await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2 });
    expect(second.body.data).toMatchObject({ surcharge: 0, codAvailable: true, pickupAvailable: false, isActive: true });
  });

  test('stored flags survive an edit that sends them back', async () => {
    await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, codAvailable: false, pickupAvailable: true });
    const edited = await save(kendraA, {
      pincode: '415404', etaMinDays: 2, etaMaxDays: 3, surcharge: 20, codAvailable: false, pickupAvailable: true,
    });
    expect(edited.body.data).toMatchObject({ etaMaxDays: 3, surcharge: 20, codAvailable: false, pickupAvailable: true });
  });

  test('HTML in a district name is stripped before it is stored', async () => {
    const res = await save(kendraA, { district: '<b>Sangli</b>', etaMinDays: 1, etaMaxDays: 2 });
    expect(res.status).toBe(201);
    expect(res.body.data.district).toBe('Sangli');
    expect(res.body.data.matchKey).toBe('dist:sangli');
  });

  describe('refusals', () => {
    test.each([
      ['starts with 0', '015404'],
      ['five digits', '41540'],
      ['seven digits', '4154041'],
      ['letters', '4154o4'],
    ])('400 — bad PIN code (%s)', async (_label, pincode) => {
      const res = await save(kendraA, { pincode, etaMinDays: 1, etaMaxDays: 2 });
      expect(res.status).toBe(400);
      expect(await rowsOf(kendraA)).toHaveLength(0);
    });

    test.each([
      ['starts with 0', '041'],
      ['two digits', '41'],
      ['four digits', '4154'],
      ['letters', '4a5'],
    ])('400 — bad PIN prefix (%s)', async (_label, pincodePrefix) => {
      const res = await save(kendraA, { pincodePrefix, etaMinDays: 1, etaMaxDays: 2 });
      expect(res.status).toBe(400);
      expect(await rowsOf(kendraA)).toHaveLength(0);
    });

    test('400 — the slowest estimate is earlier than the fastest', async () => {
      const res = await save(kendraA, { pincode: '415404', etaMinDays: 5, etaMaxDays: 2 });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/slowest/i);
      expect(await rowsOf(kendraA)).toHaveLength(0);
    });

    test('equal fastest and slowest is allowed — "tomorrow" is a real promise', async () => {
      const res = await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 1 });
      expect(res.status).toBe(201);
    });

    test('400 — no area given at all', async () => {
      const res = await save(kendraA, { etaMinDays: 1, etaMaxDays: 2 });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/PIN code/);
    });

    test('400 — an area that is only markup is no area', async () => {
      const res = await save(kendraA, { district: '<b></b>', etaMinDays: 1, etaMaxDays: 2 });
      expect(res.status).toBe(400);
      expect(await rowsOf(kendraA)).toHaveLength(0);
    });

    test.each([
      ['missing days', { pincode: '415404' }],
      ['negative days', { pincode: '415404', etaMinDays: -1, etaMaxDays: 2 }],
      ['more than 90 days', { pincode: '415404', etaMinDays: 1, etaMaxDays: 91 }],
      ['negative charge', { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: -5 }],
      ['absurd charge', { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 100001 }],
    ])('400 — %s', async (_label, body) => {
      const res = await save(kendraA, body);
      expect(res.status).toBe(400);
      expect(await rowsOf(kendraA)).toHaveLength(0);
    });

    test.each([
      ['sellerId', { sellerId: 'someone-else' }],
      ['id', { id: '00000000-0000-4000-8000-000000000000' }],
      ['status', { status: 'APPROVED' }],
      ['reviewedBy', { reviewedBy: 'me' }],
    ])('403 — the protected field %s is refused, not ignored', async (field, extra) => {
      const res = await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, ...extra });
      expect(res.status).toBe(403);
      expect(res.body.error.details.rejectedFields).toContain(field);
      expect(await rowsOf(kendraA)).toHaveLength(0);
    });

    test('a seller cannot write an area onto another seller by naming them', async () => {
      const res = await save(kendraA, { sellerId: kendraB.user.id, pincode: '415404', etaMinDays: 1, etaMaxDays: 2 });
      expect(res.status).toBe(403);
      expect(await rowsOf(kendraB)).toHaveLength(0);
    });

    test('401 without a session, 403 for a farmer', async () => {
      const body = { pincode: '415404', etaMinDays: 1, etaMaxDays: 2 };
      expect((await request(app).post(AREAS).send(body)).status).toBe(401);
      expect((await request(app).post(AREAS).set(farmer.headers).send(body)).status).toBe(403);
    });
  });
});

describe('DELETE /service-areas/:id', () => {
  test('removes the caller\'s own row, and a second delete is a harmless no-op', async () => {
    const saved = await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2 });

    const first = await remove(kendraA, saved.body.data.id);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ deleted: true });
    expect(await rowsOf(kendraA)).toHaveLength(0);

    // A double tap on Remove, or a retry after a dropped connection.
    const again = await remove(kendraA, saved.body.data.id);
    expect(again.status).toBe(200);
  });

  test('403 — a seller cannot delete another seller\'s row, and it survives', async () => {
    const saved = await save(kendraB, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2 });

    const res = await remove(kendraA, saved.body.data.id);
    expect(res.status).toBe(403);
    expect(await rowsOf(kendraB)).toHaveLength(1);
  });

  test('400 — an id that is not a UUID never reaches the database', async () => {
    const res = await remove(kendraA, 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  test('401 without a session, 403 for a farmer', async () => {
    const saved = await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2 });
    const url = `${AREAS}/${saved.body.data.id}`;
    expect((await request(app).delete(url)).status).toBe(401);
    expect((await request(app).delete(url).set(farmer.headers)).status).toBe(403);
    expect(await rowsOf(kendraA)).toHaveLength(1);
  });
});

describe('a saved area changes what the farmer is quoted', () => {
  test('with no area: the platform fee and the default 3–7 days', async () => {
    const a = await offer(kendraA);
    await fillCart(farmer, [[a, 1]]);

    const quote = await quoteFor(farmer, '415404');
    expect(quote.shipments).toHaveLength(1);
    expect(quote.shipments[0]).toMatchObject({ deliveryFee: '49.00', etaMinDays: 3, etaMaxDays: 7, serviceable: true });
  });

  test('the seller\'s charge is added to THAT seller\'s shipment, and their days are used', async () => {
    const a = await offer(kendraA);
    const b = await offer(kendraB);
    await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
    await fillCart(farmer, [[a, 1], [b, 1]]);

    const quote = await quoteFor(farmer, '415404');
    const shipA = quote.shipments.find((s) => s.sellerId === kendraA.user.id);
    const shipB = quote.shipments.find((s) => s.sellerId === kendraB.user.id);

    // 49 platform fee + 30 of the seller's own, on A's shipment only.
    expect(shipA).toMatchObject({ deliveryFee: '79.00', etaMinDays: 1, etaMaxDays: 2 });
    expect(shipB).toMatchObject({ deliveryFee: '49.00', etaMinDays: 3, etaMaxDays: 7 });
    expect(quote.deliveryFee).toBe('128.00');
    expect(quote.total).toBe('328.00');
    // The order's promise is its SLOWEST shipment.
    expect(quote.promisedEtaMaxDays).toBe(7);
  });

  test('the charge is not waived by free delivery — it is the seller\'s cost, not a promotion', async () => {
    const a = await offer(kendraA, { sellingPrice: 1200 });   // above the 999 free threshold
    await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
    await fillCart(farmer, [[a, 1]]);

    const quote = await quoteFor(farmer, '415404');
    expect(quote.shipments[0]).toMatchObject({ deliveryFee: '30.00', freeDeliveryApplied: true });
  });

  test('a 3-digit prefix covers every PIN under it; the exact PIN still wins', async () => {
    const a = await offer(kendraA);
    await save(kendraA, { pincodePrefix: '415', etaMinDays: 2, etaMaxDays: 3, surcharge: 10 });
    await save(kendraA, { pincode: '415404', etaMinDays: 4, etaMaxDays: 6, surcharge: 60 });
    await fillCart(farmer, [[a, 1]]);

    const exact = await quoteFor(farmer, '415404');
    expect(exact.shipments[0]).toMatchObject({ deliveryFee: '109.00', etaMaxDays: 6 });

    const nearby = await quoteFor(farmer, '415409');
    expect(nearby.shipments[0]).toMatchObject({ deliveryFee: '59.00', etaMaxDays: 3 });
  });

  test('removing the area puts the quote back', async () => {
    const a = await offer(kendraA);
    const saved = await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
    await fillCart(farmer, [[a, 1]]);
    expect((await quoteFor(farmer, '415404')).shipments[0].deliveryFee).toBe('79.00');

    await remove(kendraA, saved.body.data.id);
    expect((await quoteFor(farmer, '415404')).shipments[0]).toMatchObject({ deliveryFee: '49.00', etaMaxDays: 7 });
  });

  test('an area switched off is not applied', async () => {
    const a = await offer(kendraA);
    await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30, isActive: false });
    await fillCart(farmer, [[a, 1]]);

    expect((await quoteFor(farmer, '415404')).shipments[0]).toMatchObject({ deliveryFee: '49.00', etaMaxDays: 7 });
  });

  test('the order records the quoted fee and the promised days', async () => {
    const a = await offer(kendraA);
    await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
    await fillCart(farmer, [[a, 1]]);

    const res = await request(app).post(`${API}/orders`).set(farmer.headers).send({
      paymentMethod: 'cod',
      deliveryAddress: { name: 'Farmer', phone: '9876501234', flat: '1', street: 'Main', city: 'Kasegaon', state: 'Maharashtra', pincode: '415404' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ deliveryFee: 79, totalAmount: 179, promisedEtaDays: 2, deliveryPincode: '415404' });
  });

  // The cart printed ONE "Delivery charges" figure, with the seller's extra
  // folded into it unannounced. The quote now says what the fee is made of
  // (`deliveryBreakdown`), per shipment and for the whole order, and the order
  // freezes it. The one property that matters: the parts always add up to the
  // fee that is charged — they are an explanation of it, never a second number.
  describe('the farmer is told what the delivery charge is made of', () => {
    const sum = (b) => ['base', 'heavy', 'area', 'cod']
      .reduce((paise, k) => paise + Math.round(Number(b[k] ?? 0) * 100), 0) / 100;

    afterEach(async () => {
      await setSetting('shop.delivery.codFee', 0, null);
    });

    test('no area: all of it is the standard fee', async () => {
      const a = await offer(kendraA);
      await fillCart(farmer, [[a, 1]]);

      const quote = await quoteFor(farmer, '415404');
      expect(quote.deliveryBreakdown).toEqual({ base: '49.00', heavy: '0.00', area: '0.00', cod: '0.00' });
      expect(quote.shipments[0].deliveryBreakdown).toEqual({ base: '49.00', heavy: '0.00', area: '0.00' });
    });

    test('the seller\'s charge is its own line, on that seller\'s shipment only', async () => {
      const a = await offer(kendraA);
      const b = await offer(kendraB);
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
      await fillCart(farmer, [[a, 1], [b, 1]]);

      const quote = await quoteFor(farmer, '415404');
      const shipA = quote.shipments.find((s) => s.sellerId === kendraA.user.id);
      const shipB = quote.shipments.find((s) => s.sellerId === kendraB.user.id);

      expect(shipA.deliveryBreakdown).toEqual({ base: '49.00', heavy: '0.00', area: '30.00' });
      expect(shipB.deliveryBreakdown).toEqual({ base: '49.00', heavy: '0.00', area: '0.00' });
      // Two standard fees and one seller's extra — and together, the fee charged.
      expect(quote.deliveryBreakdown).toEqual({ base: '98.00', heavy: '0.00', area: '30.00', cod: '0.00' });
      expect(sum(quote.deliveryBreakdown)).toBe(Number(quote.deliveryFee));
      expect(quote.deliveryFee).toBe('128.00');
    });

    test('free delivery waives the standard fee, not the seller\'s charge — and says so', async () => {
      const a = await offer(kendraA, { sellingPrice: 1200 });
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
      await fillCart(farmer, [[a, 1]]);

      const quote = await quoteFor(farmer, '415404');
      expect(quote.shipments[0]).toMatchObject({
        deliveryFee: '30.00', freeDeliveryApplied: true,
        deliveryBreakdown: { base: '0.00', heavy: '0.00', area: '30.00' },
      });
      expect(quote.deliveryBreakdown).toEqual({ base: '0.00', heavy: '0.00', area: '30.00', cod: '0.00' });
    });

    test('a cash-on-delivery fee is its own part, and only on a cash quote', async () => {
      const a = await offer(kendraA);
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
      await fillCart(farmer, [[a, 1]]);
      await setSetting('shop.delivery.codFee', 15, null);

      const cash = (await request(app).get(`${API}/cart/quote`)
        .query({ pincode: '415404', paymentMethod: 'cod' }).set(farmer.headers)).body.data;
      expect(cash.deliveryBreakdown).toEqual({ base: '49.00', heavy: '0.00', area: '30.00', cod: '15.00' });
      expect(cash.deliveryFee).toBe('94.00');
      expect(sum(cash.deliveryBreakdown)).toBe(94);

      const online = (await request(app).get(`${API}/cart/quote`)
        .query({ pincode: '415404', paymentMethod: 'upi' }).set(farmer.headers)).body.data;
      expect(online.deliveryBreakdown.cod).toBe('0.00');
      expect(sum(online.deliveryBreakdown)).toBe(Number(online.deliveryFee));
    });

    test('heavy-item handling is its own part', async () => {
      const product = await createTestCatalogProduct(category.id, {
        name: `Area Pump ${Date.now()}-${Math.round(Math.random() * 1e9)}`, shippingClass: 'HEAVY',
      });
      const pump = await createTestListing(kendraA.user.id, product.variants[0].id, { sellingPrice: 100, stockQty: 50, district: 'Pune' });
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
      await fillCart(farmer, [[pump, 1]]);

      const quote = await quoteFor(farmer, '415404');
      // A heavy-only delivery pays handling instead of the standard fee.
      expect(quote.shipments[0].deliveryBreakdown).toEqual({ base: '0.00', heavy: '250.00', area: '30.00' });
      expect(sum(quote.deliveryBreakdown)).toBe(Number(quote.deliveryFee));
      expect(quote.deliveryFee).toBe('280.00');
    });

    test('showing the parts changes nothing that is charged', async () => {
      const a = await offer(kendraA);
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
      await fillCart(farmer, [[a, 2]]);

      const quote = await quoteFor(farmer, '415404');
      expect(quote).toMatchObject({ subtotal: '200.00', deliveryFee: '79.00', total: '279.00' });
    });

    test('the order freezes the split it was placed on', async () => {
      const a = await offer(kendraA);
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
      await fillCart(farmer, [[a, 1]]);

      const res = await request(app).post(`${API}/orders`).set(farmer.headers).send({
        paymentMethod: 'cod',
        deliveryAddress: { name: 'Farmer', phone: '9876501234', flat: '1', street: 'Main', city: 'Kasegaon', state: 'Maharashtra', pincode: '415404' },
      });
      expect(res.status).toBe(201);

      // The seller changes their charge afterwards. The order must still say
      // what THIS farmer was charged, not what the charge is today.
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 90 });

      const saved = await prisma.order.findUnique({ where: { id: res.body.data.id }, select: { deliveryFee: true, pricingSnapshot: true } });
      expect(saved.pricingSnapshot.deliveryBreakdown).toEqual({ base: '49.00', heavy: '0.00', area: '30.00', cod: '0.00' });
      expect(saved.pricingSnapshot.shipments[0].deliveryBreakdown).toEqual({ base: '49.00', heavy: '0.00', area: '30.00' });
      expect(sum(saved.pricingSnapshot.deliveryBreakdown)).toBe(Number(saved.deliveryFee));
    });

    test('an empty cart has an all-zero split, not a missing one', async () => {
      await prisma.cartItem.deleteMany({ where: { userId: farmer.user.id } });
      const quote = await quoteFor(farmer, '415404');
      expect(quote.deliveryBreakdown).toEqual({ base: '0.00', heavy: '0.00', area: '0.00', cod: '0.00' });
    });
  });

  describe('outside the seller\'s areas', () => {
    afterEach(async () => {
      await setSetting('shop.serviceability.strict', false, null);
    });

    test('strict OFF (today): still orderable, at the default days and no charge', async () => {
      const a = await offer(kendraA);
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
      await fillCart(farmer, [[a, 1]]);

      const quote = await quoteFor(farmer, '411001');
      expect(quote.issues).toEqual([]);
      expect(quote.shipments[0]).toMatchObject({ serviceable: true, deliveryFee: '49.00', etaMaxDays: 7 });
    });

    test('strict ON: a seller WITH areas cannot be ordered from outside them', async () => {
      const a = await offer(kendraA);
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 2 });
      await fillCart(farmer, [[a, 1]]);
      await setSetting('shop.serviceability.strict', true, null);

      const outside = await quoteFor(farmer, '411001');
      expect(outside.issues.map((i) => i.code)).toContain('PINCODE_UNSERVICEABLE');
      expect(outside.shipments[0].serviceable).toBe(false);

      const inside = await quoteFor(farmer, '415404');
      expect(inside.issues).toEqual([]);
    });

    test('strict ON: a seller with NO areas is not affected', async () => {
      const b = await offer(kendraB);
      await fillCart(farmer, [[b, 1]]);
      await setSetting('shop.serviceability.strict', true, null);

      const quote = await quoteFor(farmer, '411001');
      expect(quote.issues).toEqual([]);
      expect(quote.shipments[0].serviceable).toBe(true);
    });
  });

  /**
   * District and state areas — found while writing this suite.
   *
   * The quote and the checkout look a seller's areas up by PIN CODE ONLY; no
   * caller passes the buyer's district, and nothing maps a PIN code to one. So a
   * "whole district" row can never match there.
   *
   * Before the fix that made such a seller "has areas, and this PIN is outside
   * them" for EVERY PIN in the country — so turning `shop.serviceability.strict`
   * on (owner decision D1) silently took every Kendra that had chosen "whole
   * district" off sale, to farmers in that very district as well. The lookup now
   * refuses to hard-block on an area it was given no way to judge.
   */
  describe('a district-only area', () => {
    afterEach(async () => {
      await setSetting('shop.serviceability.strict', false, null);
    });

    const sangliAddress = {
      name: 'Farmer', phone: '9876501234', flat: '1', street: 'Main',
      city: 'Sangli', state: 'Maharashtra', pincode: '415404',
    };

    test('strict ON: does NOT take the seller offline — the order still goes through', async () => {
      const a = await offer(kendraA);
      const saved = await save(kendraA, { district: 'Sangli', state: 'Maharashtra', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
      expect(saved.status).toBe(201);
      await fillCart(farmer, [[a, 1]]);
      await setSetting('shop.serviceability.strict', true, null);

      const quote = await quoteFor(farmer, '415404');
      expect(quote.issues).toEqual([]);
      expect(quote.shipments[0].serviceable).toBe(true);

      const order = await request(app).post(`${API}/orders`).set(farmer.headers)
        .send({ paymentMethod: 'cod', deliveryAddress: sangliAddress });
      expect(order.status).toBe(201);
    });

    test('strict ON: a state-only area does not take the seller offline either', async () => {
      const a = await offer(kendraA);
      await save(kendraA, { state: 'Maharashtra', etaMinDays: 2, etaMaxDays: 5 });
      await fillCart(farmer, [[a, 1]]);
      await setSetting('shop.serviceability.strict', true, null);

      const quote = await quoteFor(farmer, '415404');
      expect(quote.issues).toEqual([]);
      expect(quote.shipments[0].serviceable).toBe(true);
    });

    test('strict ON: a PIN area next to a district area — the district still cannot be ruled out', async () => {
      const a = await offer(kendraA);
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 1, surcharge: 15 });
      await save(kendraA, { district: 'Sangli', etaMinDays: 2, etaMaxDays: 4 });
      await fillCart(farmer, [[a, 1]]);
      await setSetting('shop.serviceability.strict', true, null);

      // The exact PIN still wins where it applies …
      expect((await quoteFor(farmer, '415404')).shipments[0]).toMatchObject({ deliveryFee: '64.00', etaMaxDays: 1 });
      // … and another PIN — which may well be in Sangli — is not refused.
      const other = await quoteFor(farmer, '416416');
      expect(other.issues).toEqual([]);
      expect(other.shipments[0].serviceable).toBe(true);
    });

    test('a switched-off district area changes nothing: PIN-only sellers are still blocked outside', async () => {
      const a = await offer(kendraA);
      await save(kendraA, { pincode: '415404', etaMinDays: 1, etaMaxDays: 1 });
      await save(kendraA, { district: 'Sangli', etaMinDays: 2, etaMaxDays: 4, isActive: false });
      await fillCart(farmer, [[a, 1]]);
      await setSetting('shop.serviceability.strict', true, null);

      expect((await quoteFor(farmer, '411001')).issues.map((i) => i.code)).toContain('PINCODE_UNSERVICEABLE');
    });

    test('KNOWN GAP — its days and charge are NOT applied to the quote', async () => {
      // Not a behaviour to rely on: the seller asked for 1–2 days and ₹30 and the
      // farmer is quoted the platform default instead, because the quote cannot
      // tell that 415404 is in Sangli. Pinned so the gap is visible and so
      // closing it (a PIN → district lookup, or a district on the quote request)
      // has to be a deliberate change that updates this test. Until then the
      // seller app's "whole district" option saves a row that prices nothing.
      const a = await offer(kendraA);
      await save(kendraA, { district: 'Sangli', state: 'Maharashtra', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
      await fillCart(farmer, [[a, 1]]);

      const quote = await quoteFor(farmer, '415404');
      expect(quote.shipments[0]).toMatchObject({ deliveryFee: '49.00', etaMinDays: 3, etaMaxDays: 7 });
    });
  });
});

describe('resolveServiceability — the caller that DOES know the district is unchanged', () => {
  test('strict ON: a district area still blocks a buyer in a different district', async () => {
    const { resolveServiceability } = await import('../../../src/services/serviceability.service.js');
    await save(kendraA, { district: 'Sangli', etaMinDays: 1, etaMaxDays: 2, surcharge: 30 });
    await setSetting('shop.serviceability.strict', true, null);
    try {
      const inside = await resolveServiceability({ sellerIds: [kendraA.user.id], pincode: '415404', district: 'Sangli' });
      expect(inside.get(kendraA.user.id)).toMatchObject({ serviceable: true, source: 'region', etaMaxDays: 2, surcharge: '30' });

      const outside = await resolveServiceability({ sellerIds: [kendraA.user.id], pincode: '411001', district: 'Pune' });
      expect(outside.get(kendraA.user.id)).toMatchObject({ serviceable: false, source: 'default' });
    } finally {
      await setSetting('shop.serviceability.strict', false, null);
    }
  });
});
