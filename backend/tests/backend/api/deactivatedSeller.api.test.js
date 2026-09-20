/**
 * A deactivated or demoted seller must stop taking orders (bug #11).
 *
 * PATCH /admin/users/:id changed only isActive / role and left the seller's
 * offers alone, and the buy box never looked at the account behind an offer. So
 * after an admin pulled a fraudulent seller, their ACTIVE listings kept winning
 * the product page and "Add to cart"; buyers paid, and nobody could confirm or
 * cancel — the seller could not log in, or failed requireRole on every seller
 * route.
 *
 * Two layers, tested separately:
 *   1. the admin action pulls the seller's live offers (ACTIVE / OUT_OF_STOCK
 *      → INACTIVE) in the same transaction as the user update;
 *   2. the buy box itself ignores any offer whose seller is inactive — the
 *      defence for rows that were left ACTIVE before the fix.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const API = '/api/v1/agristore';
const ADMIN_API = '/api/v1/admin/users';

let app; let admin; let buyer; let category;

beforeAll(async () => {
  app = await getApp();
  // adminScopes = [] is SUPER_ADMIN (loadAdminContext), which covers SUPPORT.
  admin = await createTestUser({ role: 'ADMIN', name: 'Deactivation Admin' });
  buyer = await createTestUser({ name: 'Deactivation Buyer' });
  category = await createTestCategory({ name: `Deactivation Seeds ${Date.now()}` });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

/**
 * One product, two competing Kendras. The `target` is cheaper so it wins the buy
 * box — the case that matters is the seller being pulled while they are WINNING.
 */
async function contestedProduct() {
  const product = await createTestCatalogProduct(category.id, {
    name: `Deactivation Seed ${Date.now()}-${Math.round(Math.random() * 1e6)}`,
  });
  const variantId = product.variants[0].id;
  const target = await createTestSeller({ name: 'Target Kendra' });
  const rival  = await createTestSeller({ name: 'Rival Kendra' });
  const targetListing = await createTestListing(target.user.id, variantId, { sellingPrice: 90 });
  const rivalListing  = await createTestListing(rival.user.id,  variantId, { sellingPrice: 120 });
  return { product, variantId, target, rival, targetListing, rivalListing };
}

async function buyBoxOf(productId) {
  const res = await request(app).get(`${API}/products/${productId}`);
  expect(res.status).toBe(200);
  return res.body.data;
}

async function offerIdsOf(productId) {
  const res = await request(app).get(`${API}/products/${productId}/offers`);
  expect(res.status).toBe(200);
  return res.body.data.variants.flatMap((g) => g.offers.map((o) => o.listingId));
}

async function statusOf(listingId) {
  return (await prisma.sellerListing.findUnique({ where: { id: listingId }, select: { status: true } })).status;
}

// ═══════════════════════════════════════════════════════════════════════════════
describe('PATCH /admin/users/:id — deactivation pulls the seller\'s offers', () => {
  test('deactivating a winning seller takes their offer out of the buy box and the offer list', async () => {
    const { product, target, targetListing, rivalListing } = await contestedProduct();

    // Precondition: the seller about to be pulled is the one winning.
    expect((await buyBoxOf(product.id)).buyBox.listingId).toBe(targetListing.id);

    const res = await request(app).patch(`${ADMIN_API}/${target.user.id}`)
      .set(admin.headers).send({ isActive: false, reason: 'fraud report' });
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
    expect(res.body.data.listingsDeactivated).toBe(1);

    expect(await statusOf(targetListing.id)).toBe('INACTIVE');
    // The rival is untouched and takes over.
    expect(await statusOf(rivalListing.id)).toBe('ACTIVE');

    const page = await buyBoxOf(product.id);
    expect(page.buyBox.listingId).toBe(rivalListing.id);
    expect(page.offerCount).toBe(1);
    expect(await offerIdsOf(product.id)).toEqual([rivalListing.id]);
  });

  test('pulls OUT_OF_STOCK offers too, but leaves a BLOCKED one alone', async () => {
    // OUT_OF_STOCK flips back to ACTIVE by itself when stock returns, so it has
    // to come down as well. BLOCKED is trust-and-safety's state, not ours.
    const seller = await createTestSeller();
    const [p1, p2, p3] = await Promise.all([1, 2, 3].map((i) =>
      createTestCatalogProduct(category.id, { name: `Deactivation State ${i} ${Date.now()}` })));
    const active  = await createTestListing(seller.user.id, p1.variants[0].id);
    const soldOut = await createTestListing(seller.user.id, p2.variants[0].id, { stockQty: 0, status: 'OUT_OF_STOCK' });
    const blocked = await createTestListing(seller.user.id, p3.variants[0].id, { status: 'BLOCKED' });

    const res = await request(app).patch(`${ADMIN_API}/${seller.user.id}`)
      .set(admin.headers).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.listingsDeactivated).toBe(2);

    expect(await statusOf(active.id)).toBe('INACTIVE');
    expect(await statusOf(soldOut.id)).toBe('INACTIVE');
    expect(await statusOf(blocked.id)).toBe('BLOCKED');
  });

  test('reactivating the seller does NOT put their offers back on sale', async () => {
    // Deliberate: stock and prices may be months stale by then. The seller
    // re-enables each offer after checking it.
    const { product, target, targetListing, rivalListing } = await contestedProduct();
    await request(app).patch(`${ADMIN_API}/${target.user.id}`).set(admin.headers).send({ isActive: false });

    const res = await request(app).patch(`${ADMIN_API}/${target.user.id}`)
      .set(admin.headers).send({ isActive: true });
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.listingsDeactivated).toBe(0);

    expect(await statusOf(targetListing.id)).toBe('INACTIVE');
    expect((await buyBoxOf(product.id)).buyBox.listingId).toBe(rivalListing.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('PATCH /admin/users/:id — demotion out of a seller role', () => {
  test('SELLER → FARMER pulls the offer out of the buy box', async () => {
    const { product, target, targetListing, rivalListing } = await contestedProduct();
    expect((await buyBoxOf(product.id)).buyBox.listingId).toBe(targetListing.id);

    const res = await request(app).patch(`${ADMIN_API}/${target.user.id}`)
      .set(admin.headers).send({ role: 'FARMER', reason: 'not a Kendra' });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('FARMER');
    // Still an active account — the offers come down because of the ROLE.
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.listingsDeactivated).toBe(1);

    expect(await statusOf(targetListing.id)).toBe('INACTIVE');
    expect((await buyBoxOf(product.id)).buyBox.listingId).toBe(rivalListing.id);
    expect(await offerIdsOf(product.id)).toEqual([rivalListing.id]);
  });

  test('a move between two seller roles leaves the offers live', async () => {
    // SELLER → VERIFIED_FARMER can still manage listings, so nothing is pulled.
    const { product, target, targetListing } = await contestedProduct();

    const res = await request(app).patch(`${ADMIN_API}/${target.user.id}`)
      .set(admin.headers).send({ role: 'VERIFIED_FARMER' });
    expect(res.status).toBe(200);
    expect(res.body.data.listingsDeactivated).toBe(0);

    expect(await statusOf(targetListing.id)).toBe('ACTIVE');
    expect((await buyBoxOf(product.id)).buyBox.listingId).toBe(targetListing.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('Buy box — an ACTIVE listing of an inactive seller is never sold', () => {
  // The defence for existing data: a listing left ACTIVE by a deactivation that
  // happened before the fix, or by any path that flips users.isActive directly.
  let product; let targetListing; let rivalListing;

  beforeAll(async () => {
    const setup = await contestedProduct();
    ({ product, targetListing, rivalListing } = setup);
    // Straight to the DB — bypassing the admin route is the point.
    await prisma.user.update({ where: { id: setup.target.user.id }, data: { isActive: false } });
    expect(await statusOf(targetListing.id)).toBe('ACTIVE');
  });

  test('the product page ranks only the active seller\'s offer', async () => {
    const page = await buyBoxOf(product.id);
    expect(page.buyBox.listingId).toBe(rivalListing.id);
    expect(page.offerCount).toBe(1);
    expect(page.lowestPrice).toBe(120);
  });

  test('the offers list omits it', async () => {
    expect(await offerIdsOf(product.id)).toEqual([rivalListing.id]);
  });

  test('the storefront card does not advertise its cheaper price', async () => {
    const res = await request(app).get(`${API}/products`).query({ search: product.name });
    expect(res.status).toBe(200);
    const card = res.body.data.find((p) => p.id === product.id);
    expect(card).toBeDefined();
    expect(Number(card.lowestPrice)).toBe(120);
    expect(card.offerCount).toBe(1);
    expect(card.sellerCount).toBe(1);
  });

  test('"Add to cart" by productId resolves to the active seller, not the cheaper inactive one', async () => {
    const res = await request(app).post(`${API}/cart`)
      .set(buyer.headers).send({ productId: product.id, quantity: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.listingId).toBe(rivalListing.id);
  });

  // The paths that take a listing id straight from the client never reach the
  // buy box, so each checks the seller itself.
  test('"Add to cart" by the inactive seller\'s exact listingId is refused', async () => {
    const res = await request(app).post(`${API}/cart`)
      .set(buyer.headers).send({ listingId: targetListing.id, quantity: 1 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.cartItem.count({ where: { userId: buyer.user.id, listingId: targetListing.id } })).toBe(0);
  });

  test('a line already in the cart cannot be changed, and checkout refuses it', async () => {
    await prisma.cartItem.deleteMany({ where: { userId: buyer.user.id } });
    // As if added while the seller was still active.
    await prisma.cartItem.create({
      data: { userId: buyer.user.id, productId: product.id, listingId: targetListing.id, quantity: 1 },
    });

    const update = await request(app).put(`${API}/cart/${targetListing.id}`)
      .set(buyer.headers).send({ quantity: 2 });
    expect(update.status).toBe(400);

    const order = await request(app).post(`${API}/orders`).set(buyer.headers).send({
      paymentMethod: 'cod',
      deliveryAddress: { name: 'Buyer', phone: '9999999999', flat: '1', street: 'Main', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    });
    expect(order.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.order.count({ where: { userId: buyer.user.id } })).toBe(0);
    await prisma.cartItem.deleteMany({ where: { userId: buyer.user.id } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The three reads that still resolved a seller's offer without looking at the
// account behind it, after the buy box and the offer list were fixed.
// ═══════════════════════════════════════════════════════════════════════════════
describe('PIN serviceability ignores an inactive seller\'s offer', () => {
  // A pulled seller must not promise a delivery date: the product page is not
  // showing their offer, and they cannot log in to dispatch it.
  //
  // Each assertion uses its OWN pin, because checkProductServiceability caches
  // per (product, pin) — a before/after pair on one pin would be answered twice
  // from the same entry wherever Redis is up.
  const ask = (productId, pincode) =>
    request(app).get(`${API}/products/${productId}/serviceability`).query({ pincode });

  test('the ETA and seller count come from the active seller only', async () => {
    const { product, target, rival } = await contestedProduct();
    // The cheap seller is also the fast one, so excluding them has to be visible.
    await prisma.sellerServiceArea.createMany({
      data: [
        { sellerId: target.user.id, pincodePrefix: '413', matchKey: 'pre:413', etaMinDays: 1, etaMaxDays: 2 },
        { sellerId: rival.user.id,  pincodePrefix: '413', matchKey: 'pre:413', etaMinDays: 5, etaMaxDays: 6 },
      ],
    });

    const before = await ask(product.id, '413501');
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ serviceable: true, etaMaxDays: 2, sellerCount: 2 });

    await prisma.user.update({ where: { id: target.user.id }, data: { isActive: false } });

    const after = await ask(product.id, '413502');
    expect(after.status).toBe(200);
    expect(after.body.data).toMatchObject({ serviceable: true, etaMinDays: 5, etaMaxDays: 6, sellerCount: 1 });
  });

  test('a product whose only seller is inactive is not serviceable anywhere', async () => {
    const product = await createTestCatalogProduct(category.id, { name: `Sole Seller ${Date.now()}` });
    const seller = await createTestSeller({ name: 'Sole Kendra' });
    await createTestListing(seller.user.id, product.variants[0].id);
    await prisma.user.update({ where: { id: seller.user.id }, data: { isActive: false } });

    const res = await ask(product.id, '413503');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ serviceable: false, reason: 'NO_SELLERS' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('GET /agristore/catalog/search — the offer summary a seller is shown', () => {
  // "3 Kendras already sell this, from Rs 1,150" is a claim about what a buyer can
  // buy, so a pulled Kendra's price must not appear in it. The catalog entry
  // itself still has to come back, or the duplicate gate would let a second copy
  // of the product through.
  let searcher; let product; let gtin; let target;

  beforeAll(async () => {
    searcher = await createTestSeller({ name: 'Searching Kendra' });
    gtin = `89${Date.now().toString().slice(-11)}`;
    product = await createTestCatalogProduct(category.id, {
      name: `Catalog Summary Seed ${Date.now()}`,
      variants: [{ unit: 'packet', attributes: { packSize: '1kg' }, isDefault: true, gtin }],
    });
    target = await createTestSeller({ name: 'Summary Target Kendra' });
    const rival = await createTestSeller({ name: 'Summary Rival Kendra' });
    await createTestListing(target.user.id, product.variants[0].id, { sellingPrice: 90 });
    await createTestListing(rival.user.id,  product.variants[0].id, { sellingPrice: 120 });
  });

  const search = () => request(app).get(`${API}/catalog/search`).query({ gtin }).set(searcher.headers);

  test('counts both live offers while both sellers are active', async () => {
    const res = await search();
    expect(res.status).toBe(200);
    expect(res.body.data.matchType).toBe('gtin');
    const hit = res.body.data.results.find((p) => p.id === product.id);
    expect(hit).toMatchObject({ offerCount: 2 });
    expect(Number(hit.lowestPrice)).toBe(90);
  });

  test('drops the inactive seller\'s offer but still returns the catalog entry', async () => {
    await prisma.user.update({ where: { id: target.user.id }, data: { isActive: false } });

    const res = await search();
    expect(res.status).toBe(200);
    // Still matched — the duplicate gate is untouched.
    expect(res.body.data.matchType).toBe('gtin');
    const hit = res.body.data.results.find((p) => p.id === product.id);
    expect(hit).toBeDefined();
    expect(hit.offerCount).toBe(1);
    expect(Number(hit.lowestPrice)).toBe(120);
    expect(hit.variants[0].offerCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /admin/team/:id/revoke — a demoted admin stops selling too', () => {
  // ADMIN is one of the AgriStore SELLER_ROLES, so an admin can hold offers and
  // FARMER cannot. Revoke is the same seller demotion PATCH /admin/users/:id
  // already handles — it just reaches the user row by a different route.
  test('pulls the revoked admin\'s live offers and hands the buy box to the rival', async () => {
    const { product, targetListing, rivalListing } = await contestedProduct();
    const adminSeller = await createTestSeller({ role: 'ADMIN', name: 'Admin Kendra' });
    // Cheapest, so it is the one winning when the revoke lands.
    const adminListing = await createTestListing(adminSeller.user.id, product.variants[0].id, { sellingPrice: 80 });
    expect((await buyBoxOf(product.id)).buyBox.listingId).toBe(adminListing.id);

    const res = await request(app).post(`/api/v1/admin/team/${adminSeller.user.id}/revoke`)
      .set(admin.headers).send({ reason: 'left the team' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ role: 'FARMER', listingsDeactivated: 1 });

    expect(await statusOf(adminListing.id)).toBe('INACTIVE');
    // The other sellers are untouched.
    expect(await statusOf(targetListing.id)).toBe('ACTIVE');
    expect((await buyBoxOf(product.id)).buyBox.listingId).toBe(targetListing.id);
    expect(await offerIdsOf(product.id)).toEqual([targetListing.id, rivalListing.id]);
  });

  test('an admin with no offers reports zero and is still revoked', async () => {
    const plainAdmin = await createTestUser({ role: 'ADMIN', name: 'Officeless Admin' });
    const res = await request(app).post(`/api/v1/admin/team/${plainAdmin.user.id}/revoke`)
      .set(admin.headers).send({ reason: 'role cleanup' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ role: 'FARMER', listingsDeactivated: 0 });
  });
});
