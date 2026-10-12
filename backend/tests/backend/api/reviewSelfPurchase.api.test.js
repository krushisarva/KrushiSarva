/**
 * A seller must not be able to review their own product as a verified purchase.
 *
 * POST /products/:id/review accepts any DELIVERED order item of the caller's for
 * that product, and that item is what the storefront shows as "verified
 * purchase". Nothing made the two ends of the sale different people: no route
 * between cart and checkout stops a Kendra ordering its OWN offer cash on
 * delivery, and DELIVERED is a transition the seller makes
 * (PUT /seller/orders/:orderId/status). So a seller could manufacture the
 * delivered line alone, and the review landed under their own sellerId — moving
 * product.rating, which orders the storefront, and the seller rating the buy box
 * weighs.
 *
 * The orders are inserted directly, as the review tests in agristore.api.test.js
 * and catalogSplit.api.test.js do: what is under test is which delivered lines
 * the review route accepts, not how such a line comes to exist.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, createTestProduct,
  cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const API = '/api/v1/agristore';
const NOT_ELIGIBLE = 'You can only review a product you have received.';

let app; let category; let kendra; let rival; let buyer;

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory({ name: `Self Review Seeds ${Date.now()}` });
  kendra = await createTestSeller({ name: 'Self Review Kendra', district: 'Pune', taluka: 'Junnar' });
  rival  = await createTestSeller({ name: 'Rival Kendra',       district: 'Pune', taluka: 'Junnar' });
  buyer  = await createTestUser({ name: 'Honest Buyer', district: 'Pune' });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

/** A catalog product with one offer on it, from `seller`. */
async function productSoldBy(seller) {
  const product = await createTestCatalogProduct(category.id, {
    name: `Self Review Seed ${Date.now()}-${Math.round(Math.random() * 1e6)}`,
  });
  const listing = await createTestListing(seller.user.id, product.variants[0].id, { stockQty: 5 });
  return { product, listing };
}

/**
 * One DELIVERED order line: `buyerId` received `productId`, sold by `sellerId`.
 * Returns the order item's id.
 */
async function deliveredLine(buyerId, productId, sellerId, extra = {}) {
  const order = await prisma.order.create({
    data: {
      userId: buyerId, totalAmount: 100, deliveryAddress: {}, status: 'DELIVERED',
      items: {
        create: [{
          productId, sellerId, quantity: 1, unitPrice: 100, totalPrice: 100,
          status: 'DELIVERED', deliveredAt: new Date(), ...extra,
        }],
      },
    },
    select: { items: { select: { id: true } } },
  });
  return order.items[0].id;
}

const review = (who, productId, body) => request(app)
  .post(`${API}/products/${productId}/review`).set(who.headers).send(body);

describe('POST /products/:id/review — a sale to yourself is not a purchase', () => {
  test('403 — a seller who bought and received their own offer cannot review it', async () => {
    const { product, listing } = await productSoldBy(kendra);
    // Both ends of the sale are the same account.
    const itemId = await deliveredLine(kendra.user.id, product.id, kendra.user.id, {
      listingId: listing.id, variantId: listing.variantId,
    });

    const named = await review(kendra, product.id, { rating: 5, comment: 'Best in Junnar', orderItemId: itemId });
    expect(named.status).toBe(403);
    // The same refusal, in the same words, as having no delivered purchase at all.
    expect(named.body.error.message).toBe(NOT_ELIGIBLE);

    // Without orderItemId the route picks the caller's latest delivered line
    // itself — it must not pick this one either.
    const unnamed = await review(kendra, product.id, { rating: 5 });
    expect(unnamed.status).toBe(403);

    // Nothing was written, and the rating that orders the storefront did not move.
    expect(await prisma.review.count({ where: { productId: product.id } })).toBe(0);
    const after = await prisma.product.findUnique({ where: { id: product.id }, select: { ratingCount: true } });
    expect(after.ratingCount).toBe(0);
  });

  test('201 — a different buyer who received the same offer still can', async () => {
    const { product, listing } = await productSoldBy(kendra);
    const itemId = await deliveredLine(buyer.user.id, product.id, kendra.user.id, {
      listingId: listing.id, variantId: listing.variantId,
    });

    const res = await review(buyer, product.id, { rating: 4, comment: 'Good germination', orderItemId: itemId });
    expect(res.status).toBe(201);
    expect(res.body.data.sellerId).toBe(kendra.user.id);
    expect(res.body.data.orderItemId).toBe(itemId);

    const after = await prisma.product.findUnique({ where: { id: product.id }, select: { ratingCount: true } });
    expect(after.ratingCount).toBe(1);
  });

  test('201 — a seller who also bought it from ANOTHER Kendra reviews that purchase', async () => {
    // The exclusion is per order line, not per account: a Kendra is a farmer's
    // shop and buys from other Kendras like anyone else. The self-sale is the
    // NEWER line, so a check made after picking the latest line would refuse.
    const { product } = await productSoldBy(kendra);
    const genuine = await deliveredLine(kendra.user.id, product.id, rival.user.id, {
      createdAt: new Date(Date.now() - 60_000),
    });
    await deliveredLine(kendra.user.id, product.id, kendra.user.id);

    const res = await review(kendra, product.id, { rating: 3 });
    expect(res.status).toBe(201);
    expect(res.body.data.orderItemId).toBe(genuine);
    expect(res.body.data.sellerId).toBe(rival.user.id);
  });

  test('201 — a line with no seller on it is still reviewable by its buyer', async () => {
    // order_items.sellerId is nullable, and in SQL `sellerId <> $me` is not true
    // for NULL. Excluding the caller's own sales with a bare not-equals would
    // quietly take review rights from every buyer of an unattributed line.
    const product = await createTestProduct(kendra.user.id, category.id, {
      name: `Self Review Legacy ${Date.now()}`,
    });
    const itemId = await deliveredLine(buyer.user.id, product.id, null);

    const res = await review(buyer, product.id, { rating: 5, orderItemId: itemId });
    expect(res.status).toBe(201);
    expect(res.body.data.sellerId).toBeNull();
  });
});
