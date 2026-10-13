/**
 * GET /agristore/seller/reviews — a seller's own ratings and reviews.
 *
 *   - only reviews attributed to the CALLER (never another Kendra's, even of
 *     the same catalogue product)
 *   - newest first, keyset-paged; the average / count / star split ride in
 *     `meta.summary` on the first page and are not recomputed on later ones
 *   - the buyer is a first name. No phone, no id, nothing to find them with
 *   - sellers only
 *
 * Reviews are written through the real route against directly-inserted
 * delivered lines, as reviewSelfPurchase.api.test.js does.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const API = '/api/v1/agristore';

let app; let category; let kendra; let rival; let quiet; let buyer; let secondBuyer; let product;

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory({ name: `Seller Reviews Tools ${Date.now()}` });
  kendra = await createTestSeller({ name: 'Reviewed Kendra', district: 'Pune' });
  rival = await createTestSeller({ name: 'Rival Kendra', district: 'Pune' });
  quiet = await createTestSeller({ name: 'Unreviewed Kendra', district: 'Pune' });
  buyer = await createTestUser({ name: 'Dattatray Mane', phone: `98${String(Date.now()).slice(-8)}`, district: 'Pune' });
  secondBuyer = await createTestUser({ name: 'Sunita', district: 'Pune' });

  // One catalogue product, sold by both Kendras.
  product = await createTestCatalogProduct(category.id, {
    name: `Seller Reviews Khurpi ${Date.now()}`, nameMr: 'खुरपी',
    images: ['https://example.test/khurpi.jpg', 'https://example.test/khurpi-2.jpg'],
  });
  await createTestListing(kendra.user.id, product.variants[0].id, { stockQty: 5 });
  await createTestListing(rival.user.id, product.variants[0].id, { stockQty: 5 });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

/** `who` received `product` from `seller`, and rates it. Returns the review. */
async function rated(who, seller, rating, comment) {
  const order = await prisma.order.create({
    data: {
      userId: who.user.id, totalAmount: 100, deliveryAddress: {}, status: 'DELIVERED',
      items: {
        create: [{
          productId: product.id, sellerId: seller.user.id, quantity: 1, unitPrice: 100, totalPrice: 100,
          status: 'DELIVERED', deliveredAt: new Date(),
        }],
      },
    },
    select: { items: { select: { id: true } } },
  });
  const res = await request(app).post(`${API}/products/${product.id}/review`).set(who.headers)
    .send({ rating, ...(comment ? { comment } : {}), orderItemId: order.items[0].id });
  expect(res.status).toBe(201);
  return res.body.data;
}

const mine = (who, qs = '') => request(app).get(`${API}/seller/reviews${qs}`).set(who.headers);

describe('GET /seller/reviews', () => {
  test('a seller nobody has rated gets an empty list and a zeroed summary, not an error', async () => {
    const res = await mine(quiet);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.summary).toEqual({ average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    expect(res.body.meta.hasMore).toBe(false);
  });

  test('the seller sees their own reviews — newest first — and never the other Kendra\'s', async () => {
    const first = await rated(buyer, kendra, 5, 'Strong blade, delivered the same day');
    const second = await rated(secondBuyer, kendra, 2);
    const theirs = await rated(buyer, rival, 1, 'Never again');

    const res = await mine(kendra);

    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(res.body.data.map((r) => r.id)).not.toContain(theirs.id);
    expect(res.body.meta.summary).toEqual({
      average: 3.5, count: 2, distribution: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 },
    });

    const rivalView = await mine(rival);
    expect(rivalView.body.data.map((r) => r.id)).toEqual([theirs.id]);
    expect(rivalView.body.meta.summary).toMatchObject({ average: 1, count: 1 });
  });

  test('each review names the product and shows the buyer\'s first name only', async () => {
    const res = await mine(kendra);
    const withComment = res.body.data.find((r) => r.comment);

    expect(withComment).toEqual({
      id: expect.any(String),
      rating: 5,
      comment: 'Strong blade, delivered the same day',
      createdAt: expect.any(String),
      product: {
        id: product.id, name: product.name, nameHi: null, nameMr: 'खुरपी',
        image: 'https://example.test/khurpi.jpg',
      },
      buyer: { firstName: 'Dattatray' },
    });

    // Nothing in the whole response to find the buyer with.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(buyer.user.phone);
    expect(body).not.toContain(buyer.user.id);
    expect(body).not.toContain('Mane');
  });

  test('a rating with no comment comes back with comment: null', async () => {
    const res = await mine(kendra);
    expect(res.body.data.find((r) => r.rating === 2).comment).toBeNull();
  });

  test('it pages by cursor, and only the first page carries the summary', async () => {
    const first = await mine(kendra, '?limit=1');
    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.hasMore).toBe(true);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    expect(first.body.meta.summary).toMatchObject({ count: 2 });

    const next = await mine(kendra, `?limit=1&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`);
    expect(next.status).toBe(200);
    expect(next.body.data).toHaveLength(1);
    expect(next.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(next.body.meta.hasMore).toBe(false);
    expect(next.body.meta).not.toHaveProperty('summary');
  });

  test('sellers only: a farmer is refused, and so is a signed-out caller', async () => {
    expect((await mine(buyer)).status).toBe(403);
    expect((await request(app).get(`${API}/seller/reviews`)).status).toBe(401);
  });

  test('a bad limit is a 400, not a full table read', async () => {
    expect((await mine(kendra, '?limit=5000')).status).toBe(400);
  });
});
