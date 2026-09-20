/**
 * API tests for EDITING an offer — PATCH /api/v1/agristore/listings/:id and the
 * two read paths the seller app opens the edit form from.
 *
 * The bugs these pin down:
 *   - the edit sent the whole form, so `images: []` wiped the offer's photos and
 *     fields the form never received (dispatch days, MOQ, reach) went back to
 *     their defaults. A price-only PATCH must touch nothing else.
 *   - a cleared optional field was dropped from the JSON and the old value kept
 *     (MRP below the new price; a stale taluka after a district change). null
 *     must clear it.
 *   - GET /seller/products and /catalog/search did not return the whole offer,
 *     so the edit form opened on defaults.
 *
 * Run with:
 *   node --experimental-vm-modules node_modules/jest/bin/jest.js --testTimeout=60000
 */
import request from 'supertest';
import {
  getApp, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing,
  cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const API = '/api/v1/agristore';

let app;
let category;
let kendra;

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory({ name: `Offer Edit ${Date.now()}` });
  kendra = await createTestSeller({ name: 'Shivneri Agro', district: 'Pune', taluka: 'Junnar' });
}, 60_000);

afterAll(async () => {
  await cleanupTestData();
});

const OFFER_PHOTOS = ['https://res.cloudinary.com/demo/image/upload/offer-stock-1.jpg'];
const CATALOG_PHOTOS = ['https://res.cloudinary.com/demo/image/upload/catalog-pack.jpg'];

/** A catalog product and one fully-populated offer on it — every field non-default. */
async function fullOffer(productOverrides = {}) {
  const product = await createTestCatalogProduct(category.id, {
    name: `Mahyco Bt Cotton Seed ${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    brand: 'Mahyco',
    images: CATALOG_PHOTOS,
    ...productOverrides,
  });
  const listing = await createTestListing(kendra.user.id, product.variants[0].id, {
    sellingPrice: 810,
    mrp: 900,
    stockQty: 40,
    minOrderQty: 3,
    dispatchSlaDays: 5,
    sellerSku: 'KSK-1042',
    sellScope: 'taluka',
    district: 'Pune',
    taluka: 'Junnar',
    village: 'Narayangaon',
    state: 'Maharashtra',
    harvestDate: '2026-08',
    images: OFFER_PHOTOS,
  });
  return { product, listing };
}

const reload = (id) => prisma.sellerListing.findUnique({ where: { id } });

// ═══════════════════════════════════════════════════════════════════════════════
describe('PATCH /listings/:id — an edit changes only what it sends', () => {
  test('a price-only edit leaves photos, dispatch days, MOQ, reach and location untouched', async () => {
    const { listing } = await fullOffer();

    const res = await request(app).patch(`${API}/listings/${listing.id}`).set(kendra.headers)
      .send({ sellingPrice: 850 });
    expect(res.status).toBe(200);

    const after = await reload(listing.id);
    expect(Number(after.sellingPrice)).toBe(850);
    // Everything else is exactly what it was.
    expect(after.images).toEqual(OFFER_PHOTOS);
    expect(after.dispatchSlaDays).toBe(5);
    expect(after.minOrderQty).toBe(3);
    expect(after.sellScope).toBe('taluka');
    expect(after).toMatchObject({
      district: 'Pune', taluka: 'Junnar', village: 'Narayangaon', state: 'Maharashtra',
      harvestDate: '2026-08', sellerSku: 'KSK-1042', stockQty: 40,
    });
    expect(Number(after.mrp)).toBe(900);
  });

  test('null clears MRP — raising the price above the old MRP does not leave it behind', async () => {
    const { listing } = await fullOffer();

    const res = await request(app).patch(`${API}/listings/${listing.id}`).set(kendra.headers)
      .send({ sellingPrice: 1000, mrp: null });
    expect(res.status).toBe(200);

    const after = await reload(listing.id);
    expect(Number(after.sellingPrice)).toBe(1000);
    expect(after.mrp).toBeNull();
  });

  test('null clears taluka on a district change — no stale taluka gating the wrong buyers', async () => {
    const { listing } = await fullOffer();

    const res = await request(app).patch(`${API}/listings/${listing.id}`).set(kendra.headers)
      .send({ district: 'Nashik', taluka: null });
    expect(res.status).toBe(200);

    const after = await reload(listing.id);
    expect(after.district).toBe('Nashik');
    expect(after.taluka).toBeNull();
    // Untouched by this edit.
    expect(after.village).toBe('Narayangaon');
    expect(after.sellScope).toBe('taluka');
  });

  test('null clears every other optional text field', async () => {
    const { listing } = await fullOffer();

    const res = await request(app).patch(`${API}/listings/${listing.id}`).set(kendra.headers)
      .send({ village: null, harvestDate: null, sellerSku: null });
    expect(res.status).toBe(200);

    const after = await reload(listing.id);
    expect(after).toMatchObject({ village: null, harvestDate: null, sellerSku: null });
    expect(after.taluka).toBe('Junnar');
  });

  test('null is refused for fields that cannot be empty, and nothing is written', async () => {
    const { listing } = await fullOffer();

    for (const body of [{ dispatchSlaDays: null }, { minOrderQty: null }, { sellScope: null }, { images: null }]) {
      const res = await request(app).patch(`${API}/listings/${listing.id}`).set(kendra.headers).send(body);
      expect(res.status).toBe(400);
    }

    const after = await reload(listing.id);
    expect(after.dispatchSlaDays).toBe(5);
    expect(after.minOrderQty).toBe(3);
    expect(after.sellScope).toBe('taluka');
    expect(after.images).toEqual(OFFER_PHOTOS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('Read paths the edit form opens from return the whole offer', () => {
  test('GET /seller/products carries dispatch days, stock code and the offer\'s own photos', async () => {
    const { product, listing } = await fullOffer();

    // Newest first, so a fresh offer is on page 1.
    const res = await request(app).get(`${API}/seller/products?page=1&limit=50`).set(kendra.headers);
    expect(res.status).toBe(200);

    const row = res.body.data.find((r) => r.listingId === listing.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      id: product.id,
      dispatchSlaDays: 5,
      sellerSku: 'KSK-1042',
      minOrderQty: 3,
      sellScope: 'taluka',
      district: 'Pune', taluka: 'Junnar', village: 'Narayangaon', state: 'Maharashtra',
      harvestDate: '2026-08',
    });
    expect(Number(row.mrp)).toBe(900);
    // The offer's photos under their own name; `images` stays the catalog's,
    // which is what the list thumbnail (and older clients) read.
    expect(row.listingImages).toEqual(OFFER_PHOTOS);
    expect(row.images).toEqual(CATALOG_PHOTOS);
  });

  test('GET /catalog/search returns the whole offer as myListing', async () => {
    const gtin = `892${Date.now()}`.slice(0, 13);
    const { listing } = await fullOffer({
      variants: [{ unit: 'packet', attributes: { packSize: '450g' }, gtin, isDefault: true }],
    });

    const res = await request(app).get(`${API}/catalog/search?gtin=${gtin}`).set(kendra.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.matchType).toBe('gtin');

    const mine = res.body.data.results[0].variants[0].myListing;
    expect(mine).toMatchObject({
      id: listing.id,
      stockQty: 40,
      minOrderQty: 3,
      dispatchSlaDays: 5,
      sellerSku: 'KSK-1042',
      sellScope: 'taluka',
      district: 'Pune', taluka: 'Junnar', village: 'Narayangaon', state: 'Maharashtra',
      harvestDate: '2026-08',
      images: OFFER_PHOTOS,
    });
    expect(Number(mine.sellingPrice)).toBe(810);
    expect(Number(mine.mrp)).toBe(900);
  });
});
