/**
 * API tests for the products a Krushi Kendra recommends on a shared crop report.
 *
 * Since the catalog split, price and stock live on the seller's OFFER
 * (seller_listings), not on `products`. resolveRecommendedProducts used to read
 * the deprecated Product.price/stock, so the farmer saw no price, "Out of stock",
 * and a disabled Add to cart. These tests pin that each card carries the
 * RECOMMENDING Kendra's own live offer — never another shop's, never a paused one.
 */
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, createTestProduct,
  createTestCropReport, createTestCropShare,
  cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const BASE = '/api/v1/crop-reports';
const SHOP = '/api/v1/agristore';

let app;
let category;
let farmer;   // owns the report
let kendra;   // the recommending seller (share.sellerId)
let rival;    // another Kendra selling the same product, cheaper

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory();
  farmer = await createTestUser({ name: 'Recommend Farmer', district: 'Pune' });
  kendra = await createTestSeller({ name: 'Shivneri Agro', businessType: 'krushi_kendra', district: 'Pune' });
  rival  = await createTestSeller({ name: 'Jai Kisan Agro', businessType: 'krushi_kendra', district: 'Pune' });
});

afterAll(async () => {
  await cleanupTestData();
});

/** A report shared with `seller`, replied to through the real route. */
async function recommend(seller, productIds) {
  const report = await createTestCropReport(farmer.user.id);
  const share = await createTestCropShare(report.id, farmer.user.id, seller.user.id);
  const res = await request(app)
    .post(`${BASE}/seller/inbox/${share.id}/reply`)
    .set(seller.headers)
    .send({ reply: 'Spray Mancozeb 2.5 g/L.', recommendedProductIds: productIds });
  expect(res.status).toBe(200);
  return { report, share };
}

async function farmerCards(reportId, shareId) {
  const res = await request(app).get(`${BASE}/${reportId}/shares`).set(farmer.headers);
  expect(res.status).toBe(200);
  return res.body.data.find((s) => s.id === shareId).recommendedProducts;
}

describe('recommended products carry the recommending Kendra\'s offer', () => {
  test('price, mrp, stock and listingId come from THIS seller\'s ACTIVE listing', async () => {
    const product = await createTestCatalogProduct(category.id, { name: 'Indofil M-45 Recommend' });
    const variantId = product.variants[0].id;
    const mine = await createTestListing(kendra.user.id, variantId, { sellingPrice: 350, mrp: 400, stockQty: 7 });
    // Cheaper — would win the buy box, and must NOT leak into this card.
    await createTestListing(rival.user.id, variantId, { sellingPrice: 300, mrp: 400, stockQty: 50 });

    const { report, share } = await recommend(kendra, [product.id]);
    const cards = await farmerCards(report.id, share.id);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: product.id,
      name: 'Indofil M-45 Recommend',
      price: 350,
      mrp: 400,
      stock: 7,
      unit: 'packet',
      minOrderQty: 1,
      listingId: mine.id,
      variantId,
      sellerId: kendra.user.id,
    });
  });

  test('the seller-side echo returns the same card', async () => {
    const product = await createTestCatalogProduct(category.id, { name: 'Echo Product' });
    const mine = await createTestListing(kendra.user.id, product.variants[0].id, { sellingPrice: 120, stockQty: 3 });
    const { share } = await recommend(kendra, [product.id]);

    const res = await request(app).get(`${BASE}/seller/inbox/${share.id}`).set(kendra.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.recommendedProducts).toEqual([
      expect.objectContaining({ id: product.id, price: 120, stock: 3, listingId: mine.id }),
    ]);
  });

  test('a product whose listing went INACTIVE is not returned as purchasable', async () => {
    const product = await createTestCatalogProduct(category.id, { name: 'Paused Product' });
    const variantId = product.variants[0].id;
    const mine = await createTestListing(kendra.user.id, variantId, { sellingPrice: 200, stockQty: 9 });
    // Another shop still sells it — that must not make THIS Kendra's card buyable.
    await createTestListing(rival.user.id, variantId, { sellingPrice: 190, stockQty: 9 });

    const { report, share } = await recommend(kendra, [product.id]);
    expect(await farmerCards(report.id, share.id)).toHaveLength(1);

    // The Kendra pauses the offer after recommending it.
    await prisma.sellerListing.update({ where: { id: mine.id }, data: { status: 'INACTIVE' } });

    expect(await farmerCards(report.id, share.id)).toEqual([]);
  });

  test('two Kendras recommending one product each show their own price (batched lookup)', async () => {
    const product = await createTestCatalogProduct(category.id, { name: 'Shared Product' });
    const variantId = product.variants[0].id;
    const mine = await createTestListing(kendra.user.id, variantId, { sellingPrice: 410, stockQty: 4 });
    const theirs = await createTestListing(rival.user.id, variantId, { sellingPrice: 380, stockQty: 12 });

    // One report, shared with both Kendras — one GET resolves both shares.
    const report = await createTestCropReport(farmer.user.id);
    const shareA = await createTestCropShare(report.id, farmer.user.id, kendra.user.id, {
      status: 'REPLIED', sellerReply: 'x', recommendedProductIds: [product.id],
    });
    const shareB = await createTestCropShare(report.id, farmer.user.id, rival.user.id, {
      status: 'REPLIED', sellerReply: 'y', recommendedProductIds: [product.id],
    });

    const res = await request(app).get(`${BASE}/${report.id}/shares`).set(farmer.headers);
    expect(res.status).toBe(200);
    const byShare = new Map(res.body.data.map((s) => [s.id, s.recommendedProducts]));
    expect(byShare.get(shareA.id)).toEqual([expect.objectContaining({ price: 410, stock: 4, listingId: mine.id })]);
    expect(byShare.get(shareB.id)).toEqual([expect.objectContaining({ price: 380, stock: 12, listingId: theirs.id })]);
  });

  test('prefers the default pack when the Kendra lists several', async () => {
    const product = await createTestCatalogProduct(category.id, {
      name: 'Two Pack Product',
      variants: [
        { unit: 'packet', attributes: { packSize: '250g' }, isDefault: false },
        { unit: 'packet', attributes: { packSize: '1kg' }, isDefault: true },
      ],
    });
    const small = product.variants.find((v) => !v.isDefault);
    const big = product.variants.find((v) => v.isDefault);
    await createTestListing(kendra.user.id, small.id, { sellingPrice: 90, stockQty: 5 });
    const defaultOffer = await createTestListing(kendra.user.id, big.id, { sellingPrice: 320, stockQty: 5 });

    const { report, share } = await recommend(kendra, [product.id]);
    const cards = await farmerCards(report.id, share.id);
    expect(cards).toEqual([expect.objectContaining({ listingId: defaultOffer.id, price: 320, variantId: big.id })]);
  });

  test('DUAL-READ: a pre-split product keeps its own price/stock and has no listingId', async () => {
    const legacy = await createTestProduct(kendra.user.id, category.id, { price: 199.99, mrp: 249.99, stock: 15 });
    const { report, share } = await recommend(kendra, [legacy.id]);

    const cards = await farmerCards(report.id, share.id);
    expect(cards).toEqual([
      expect.objectContaining({ id: legacy.id, price: 199.99, mrp: 249.99, stock: 15, listingId: null }),
    ]);
  });

  test('Add to cart with the card\'s listingId buys THIS Kendra\'s offer, not the buy-box winner', async () => {
    const product = await createTestCatalogProduct(category.id, { name: 'Cart Product' });
    const variantId = product.variants[0].id;
    const mine = await createTestListing(kendra.user.id, variantId, { sellingPrice: 260, stockQty: 6 });
    await createTestListing(rival.user.id, variantId, { sellingPrice: 199, stockQty: 60 });

    const { report, share } = await recommend(kendra, [product.id]);
    const [card] = await farmerCards(report.id, share.id);

    const added = await request(app).post(`${SHOP}/cart`).set(farmer.headers)
      .send({ listingId: card.listingId, quantity: card.minOrderQty || 1 });
    expect(added.status).toBe(201);
    expect(added.body.data.listingId).toBe(mine.id);
    expect(Number(added.body.data.unitPriceSnapshot)).toBe(260);
  });
});
