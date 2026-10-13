/**
 * The buyer's own reviews on their order lines (services/orderReview.service.js).
 *
 * "My Orders" in the farmer app shows "Rate this product" on a delivered line,
 * or "Your rating ★★★★☆ · Edit" once it has been rated. Both come from
 * `items[].myReview` on the buyer's order reads:
 *
 *   delivered, not rated yet   myReview: null
 *   delivered and rated        myReview: { rating, comment }
 *   any other line state       no field at all — it cannot be reviewed
 *
 * and never anybody else's review of the same product.
 *
 * Orders are inserted directly, as reviewSelfPurchase.api.test.js does: what is
 * under test is the read, not how a delivered line comes to exist.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const API = '/api/v1/agristore';

let app; let category; let kendra; let buyer; let otherBuyer;

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory({ name: `My Review Tools ${Date.now()}` });
  kendra = await createTestSeller({ name: 'My Review Kendra', district: 'Pune' });
  buyer = await createTestUser({ name: 'Rating Buyer', district: 'Pune' });
  otherBuyer = await createTestUser({ name: 'Other Buyer', district: 'Pune' });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

async function newProduct() {
  const product = await createTestCatalogProduct(category.id, {
    name: `My Review Khurpi ${Date.now()}-${Math.round(Math.random() * 1e6)}`,
  });
  await createTestListing(kendra.user.id, product.variants[0].id, { stockQty: 5 });
  return product;
}

/** One order for `buyerId` with a line per `{ productId, status }`. Returns the order with its items. */
function orderWith(buyerId, lines) {
  return prisma.order.create({
    data: {
      userId: buyerId, totalAmount: 100 * lines.length, deliveryAddress: {},
      status: lines.every((l) => l.status === 'DELIVERED') ? 'DELIVERED' : 'CONFIRMED',
      items: {
        create: lines.map((l) => ({
          productId: l.productId, sellerId: kendra.user.id, quantity: 1, unitPrice: 100, totalPrice: 100,
          status: l.status, ...(l.status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
        })),
      },
    },
    include: { items: true },
  });
}

const rate = (who, productId, body) => request(app)
  .post(`${API}/products/${productId}/review`).set(who.headers).send(body);

async function listedOrder(who, orderId, qs = 'paginate=cursor&limit=50') {
  const res = await request(app).get(`${API}/orders?${qs}`).set(who.headers);
  expect(res.status).toBe(200);
  return res.body.data.find((o) => o.id === orderId);
}

const lineFor = (order, productId) => order.items.find((i) => i.productId === productId);

describe('GET /orders — items[].myReview', () => {
  test('a delivered line starts as myReview: null, then carries the rating the buyer gave', async () => {
    const product = await newProduct();
    const order = await orderWith(buyer.user.id, [{ productId: product.id, status: 'DELIVERED' }]);
    const itemId = order.items[0].id;

    expect(lineFor(await listedOrder(buyer, order.id), product.id).myReview).toBeNull();

    const posted = await rate(buyer, product.id, { rating: 4, comment: 'Strong blade', orderItemId: itemId });
    expect(posted.status).toBe(201);

    expect(lineFor(await listedOrder(buyer, order.id), product.id).myReview)
      .toEqual({ rating: 4, comment: 'Strong blade' });
  });

  test('rating again edits it — the line shows the latest, and a cleared comment is null', async () => {
    const product = await newProduct();
    const order = await orderWith(buyer.user.id, [{ productId: product.id, status: 'DELIVERED' }]);
    const itemId = order.items[0].id;

    await rate(buyer, product.id, { rating: 2, comment: 'Handle came loose', orderItemId: itemId });
    const again = await rate(buyer, product.id, { rating: 5, orderItemId: itemId });
    expect(again.status).toBe(201);

    expect(lineFor(await listedOrder(buyer, order.id), product.id).myReview).toEqual({ rating: 5, comment: null });
    expect(await prisma.review.count({ where: { orderItemId: itemId } })).toBe(1);
  });

  test('only delivered lines carry the field; a line still on its way has none', async () => {
    const delivered = await newProduct();
    const onItsWay = await newProduct();
    const order = await orderWith(buyer.user.id, [
      { productId: delivered.id, status: 'DELIVERED' },
      { productId: onItsWay.id, status: 'SHIPPED' },
    ]);

    const listed = await listedOrder(buyer, order.id);

    expect(lineFor(listed, delivered.id)).toHaveProperty('myReview', null);
    expect(lineFor(listed, onItsWay.id)).not.toHaveProperty('myReview');
  });

  test('another buyer\'s review of the same product never shows up as mine', async () => {
    const product = await newProduct();
    const mine = await orderWith(buyer.user.id, [{ productId: product.id, status: 'DELIVERED' }]);
    const theirs = await orderWith(otherBuyer.user.id, [{ productId: product.id, status: 'DELIVERED' }]);

    const posted = await rate(otherBuyer, product.id, { rating: 1, comment: 'Bent on day one', orderItemId: theirs.items[0].id });
    expect(posted.status).toBe(201);

    expect(lineFor(await listedOrder(buyer, mine.id), product.id).myReview).toBeNull();
    expect(lineFor(await listedOrder(otherBuyer, theirs.id), product.id).myReview)
      .toEqual({ rating: 1, comment: 'Bent on day one' });
  });

  test('the page-number mode and the single-order read say the same thing', async () => {
    const product = await newProduct();
    const order = await orderWith(buyer.user.id, [{ productId: product.id, status: 'DELIVERED' }]);
    await rate(buyer, product.id, { rating: 3, orderItemId: order.items[0].id });

    const paged = await listedOrder(buyer, order.id, 'page=1&limit=50');
    expect(lineFor(paged, product.id).myReview).toEqual({ rating: 3, comment: null });

    const one = await request(app).get(`${API}/orders/${order.id}`).set(buyer.headers);
    expect(one.status).toBe(200);
    expect(lineFor(one.body.data, product.id).myReview).toEqual({ rating: 3, comment: null });
  });
});
