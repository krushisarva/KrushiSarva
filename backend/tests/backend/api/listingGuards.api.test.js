/**
 * What a seller may do to an offer while buyers still depend on it.
 *
 *   #24  Deleting an offer with open orders made those orders impossible to
 *        cancel: order_items.listingId has no FK, so the cancel's restock found
 *        no row and failed "sold out". The delete is now refused, and a restock
 *        onto an offer that is gone anyway is skipped instead of failing.
 *   #25  A price / minimum-order change, a pause or a delete while a buyer is
 *        mid-payment failed their confirm after the money had moved. Refused
 *        while a stock hold exists; stock-only edits still go through.
 *   #27  The legacy /seller/products/:id routes resolved the offer by product,
 *        so with two pack sizes they could edit or delete the wrong one.
 */
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData, prisma,
} from '../../fixtures/setup.js';
import { applyListingStockDeltas } from '../../../src/utils/stockBatch.js';
import { releaseReservations } from '../../../src/services/stockReservation.service.js';

const API = '/api/v1/agristore';

const address = {
  type: 'HOME', name: 'Guard Buyer', phone: '9876543210',
  flat: '1A', street: 'Main', city: 'Pune', state: 'Maharashtra', pincode: '411001',
};

let app; let kendra; let category;

beforeAll(async () => {
  app = await getApp();
  kendra = await createTestSeller({ name: 'Guard Kendra', district: 'Pune' });
  category = await createTestCategory({ name: `Guard Seeds ${Date.now()}` });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

async function offer({ stockQty = 10, sellingPrice = 100 } = {}) {
  const product = await createTestCatalogProduct(category.id, { name: `Guard Seed ${Date.now()}-${Math.random()}` });
  const listing = await createTestListing(kendra.user.id, product.variants[0].id, { stockQty, sellingPrice });
  return { product, listing };
}

async function fillCart(buyer, listing, product, quantity = 1) {
  await prisma.cartItem.deleteMany({ where: { userId: buyer.user.id } });
  await prisma.cartItem.create({
    data: { userId: buyer.user.id, listingId: listing.id, productId: product.id, quantity, unitPriceSnapshot: listing.sellingPrice },
  });
}

async function codOrder(buyer, listing, product, quantity = 1) {
  await fillCart(buyer, listing, product, quantity);
  const res = await request(app).post(`${API}/orders`).set(buyer.headers)
    .send({ paymentMethod: 'cod', deliveryAddress: address });
  expect(res.status).toBe(201);
  return res.body.data;
}

const stockOf = async (id) => (await prisma.sellerListing.findUnique({ where: { id } }))?.stockQty;

// ── #24 ──────────────────────────────────────────────────────────────────────
describe('Deleting an offer that has open orders', () => {
  test('409 while an order on it is open; the buyer can still cancel; then the delete goes through', async () => {
    const buyer = await createTestUser({ district: 'Pune' });
    const { product, listing } = await offer({ stockQty: 5 });
    const order = await codOrder(buyer, listing, product, 2);

    const refused = await request(app).delete(`${API}/listings/${listing.id}`).set(kendra.headers);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.code).toBe('OFFER_HAS_OPEN_ORDERS');
    expect(refused.body.error.message).toMatch(/pause the offer/i);
    expect(await prisma.sellerListing.findUnique({ where: { id: listing.id } })).not.toBeNull();

    const cancel = await request(app).put(`${API}/orders/${order.id}/cancel`).set(buyer.headers);
    expect(cancel.status).toBe(200);
    expect(await stockOf(listing.id)).toBe(5);

    const ok = await request(app).delete(`${API}/listings/${listing.id}`).set(kendra.headers);
    expect(ok.status).toBe(200);
    expect(await prisma.sellerListing.findUnique({ where: { id: listing.id } })).toBeNull();
  });

  test('the legacy DELETE /seller/products/:id is refused the same way', async () => {
    const buyer = await createTestUser({ district: 'Pune' });
    const { product, listing } = await offer();
    await codOrder(buyer, listing, product);

    const res = await request(app).delete(`${API}/seller/products/${product.id}`).set(kendra.headers);
    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('OFFER_HAS_OPEN_ORDERS');
    expect(await prisma.sellerListing.findUnique({ where: { id: listing.id } })).not.toBeNull();
  });

  test('an order whose offer is already gone can still be cancelled', async () => {
    const buyer = await createTestUser({ district: 'Pune' });
    const { product, listing } = await offer();
    const order = await codOrder(buyer, listing, product);
    // Deleted before this fix existed (or by an admin): nothing left to restock.
    await prisma.sellerListing.delete({ where: { id: listing.id } });

    const res = await request(app).put(`${API}/orders/${order.id}/cancel`).set(buyer.headers);
    expect(res.status).toBe(200);
    expect((await prisma.order.findUnique({ where: { id: order.id } })).status).toBe('CANCELLED');
  });

  test('a restock onto a missing offer is skipped; a decrement on one still fails', async () => {
    const { listing } = await offer({ stockQty: 3 });
    const gone = '00000000-0000-4000-8000-000000000000';

    const r = await prisma.$transaction((tx) => applyListingStockDeltas(tx, [
      { listingId: listing.id, delta: 2 },
      { listingId: gone, delta: 1 },
    ]));
    expect(r.rows).toBe(1);
    expect(await stockOf(listing.id)).toBe(5);

    await expect(prisma.$transaction((tx) => applyListingStockDeltas(tx, [{ listingId: gone, delta: -1 }])))
      .rejects.toMatchObject({ statusCode: 400 });
    // Same for an oversell on a live one: the guard is unchanged.
    await expect(prisma.$transaction((tx) => applyListingStockDeltas(tx, [{ listingId: listing.id, delta: -99 }])))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(await stockOf(listing.id)).toBe(5);
  });
});

// ── #25 ──────────────────────────────────────────────────────────────────────
describe('Changing an offer while a buyer is paying for it', () => {
  let buyer; let product; let listing; let providerOrderId;

  beforeEach(async () => {
    buyer = await createTestUser({ district: 'Pune' });
    ({ product, listing } = await offer({ stockQty: 5, sellingPrice: 200 }));
    await fillCart(buyer, listing, product, 2);
    const init = await request(app).post(`${API}/orders/initiate`).set(buyer.headers)
      .send({ paymentMethod: 'upi', deliveryAddress: address });
    expect(init.status).toBe(200);
    providerOrderId = init.body.data.razorpayOrderId;
    expect(await stockOf(listing.id)).toBe(3); // held
  });

  afterEach(async () => { await releaseReservations(providerOrderId, 'test cleanup'); });

  const patch = (body) => request(app).patch(`${API}/listings/${listing.id}`).set(kendra.headers).send(body);

  test('a price change is refused with how long to wait', async () => {
    const res = await patch({ sellingPrice: 250 });
    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('PAYMENT_IN_PROGRESS');
    expect(res.body.error.message).toMatch(/paying for this offer right now — try again in about \d+ minutes/);
    const wait = res.body.error.details.retryAfterMinutes;
    expect(wait).toBeGreaterThanOrEqual(2);
    expect(wait).toBeLessThanOrEqual(15); // the default hold TTL
    expect(String((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).sellingPrice)).toBe('200');
  });

  test('raising the minimum order and pausing are refused; so is deleting', async () => {
    expect((await patch({ minOrderQty: 5 })).status).toBe(409);
    expect((await patch({ status: 'INACTIVE' })).status).toBe(409);
    const del = await request(app).delete(`${API}/listings/${listing.id}`).set(kendra.headers);
    expect(del.status).toBe(409);
    expect(del.body.error.details.code).toBe('PAYMENT_IN_PROGRESS');

    const after = await prisma.sellerListing.findUnique({ where: { id: listing.id } });
    expect(after).toMatchObject({ minOrderQty: 1, status: 'ACTIVE' });
    // The hold (and the buyer's cart line) survived.
    expect(await prisma.stockReservation.count({ where: { providerOrderId, status: 'HELD' } })).toBe(1);
  });

  test('the legacy routes are guarded too', async () => {
    const put = await request(app).put(`${API}/seller/products/${product.id}`).set(kendra.headers).send({ price: 150 });
    expect(put.status).toBe(409);
    const pause = await request(app).put(`${API}/seller/products/${product.id}`).set(kendra.headers).send({ isActive: false });
    expect(pause.status).toBe(409);
    const del = await request(app).delete(`${API}/seller/products/${product.id}`).set(kendra.headers);
    expect(del.status).toBe(409);
  });

  test('stock-only edits and harmless changes still go through', async () => {
    const stock = await patch({ stockQty: 7, expectedStockQty: 3 });
    expect(stock.status).toBe(200);
    expect(stock.body.data.stockQty).toBe(7);
    // Same price as now, and a lower minimum, cannot break the buyer's confirm.
    expect((await patch({ sellingPrice: 200, minOrderQty: 1, dispatchSlaDays: 3 })).status).toBe(200);
  });

  test('once the hold is gone the change is allowed', async () => {
    await releaseReservations(providerOrderId, 'payment abandoned');
    const res = await patch({ sellingPrice: 250 });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.sellingPrice)).toBe(250);
  });
});

// ── #27 ──────────────────────────────────────────────────────────────────────
describe('Legacy /seller/products/:id with two pack sizes of one product', () => {
  async function twoPacks() {
    const product = await createTestCatalogProduct(category.id, {
      name: `Guard Two Packs ${Date.now()}-${Math.random()}`,
      variants: [
        { unit: 'packet', attributes: { packSize: '1kg' }, isDefault: true },
        { unit: 'bag', attributes: { packSize: '5kg' } },
      ],
    });
    const small = await createTestListing(kendra.user.id, product.variants[0].id, { sellingPrice: 100 });
    const big = await createTestListing(kendra.user.id, product.variants[1].id, { sellingPrice: 450 });
    return { product, small, big };
  }
  const priceOf = async (id) => String((await prisma.sellerListing.findUnique({ where: { id } })).sellingPrice);

  test('without listingId the edit is refused rather than guessed', async () => {
    const { product, small, big } = await twoPacks();
    const res = await request(app).put(`${API}/seller/products/${product.id}`).set(kendra.headers).send({ price: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('LISTING_AMBIGUOUS');
    expect(await priceOf(small.id)).toBe('100');
    expect(await priceOf(big.id)).toBe('450');
  });

  test('listingId picks exactly that offer for an edit and for a delete', async () => {
    const { product, small, big } = await twoPacks();

    const put = await request(app).put(`${API}/seller/products/${product.id}`).set(kendra.headers)
      .send({ price: 480, listingId: big.id });
    expect(put.status).toBe(200);
    expect(put.body.data.id).toBe(big.id);
    expect(await priceOf(big.id)).toBe('480');
    expect(await priceOf(small.id)).toBe('100');

    const noId = await request(app).delete(`${API}/seller/products/${product.id}`).set(kendra.headers);
    expect(noId.status).toBe(409);

    const del = await request(app).delete(`${API}/seller/products/${product.id}?listingId=${small.id}`).set(kendra.headers);
    expect(del.status).toBe(200);
    expect(await prisma.sellerListing.findUnique({ where: { id: small.id } })).toBeNull();
    expect(await prisma.sellerListing.findUnique({ where: { id: big.id } })).not.toBeNull();

    // One pack left: an old build with no listingId works as before.
    const last = await request(app).put(`${API}/seller/products/${product.id}`).set(kendra.headers).send({ price: 470 });
    expect(last.status).toBe(200);
    expect(await priceOf(big.id)).toBe('470');
  });

  test("another seller's listingId is not found", async () => {
    const { product, big } = await twoPacks();
    const other = await createTestSeller({ name: 'Guard Other Kendra' });
    const res = await request(app).put(`${API}/seller/products/${product.id}`).set(other.headers)
      .send({ price: 1, listingId: big.id });
    expect(res.status).toBe(404);
    expect(await priceOf(big.id)).toBe('450');
  });

  test('a malformed listingId is a 400', async () => {
    const { product } = await twoPacks();
    const res = await request(app).delete(`${API}/seller/products/${product.id}?listingId=nope`).set(kendra.headers);
    expect(res.status).toBe(400);
  });
});
