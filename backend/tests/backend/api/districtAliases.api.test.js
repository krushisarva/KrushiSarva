/**
 * Renamed districts on the buyer ↔ seller discovery paths.
 *
 * The farmer app stores the new name (Dharashiv); the seller app has saved the
 * same place under the old one (Osmanabad). Every path below matched a buyer's
 * district against a seller's or a listing's by one spelling, so a Dharashiv
 * farmer never found an Osmanabad Kendra, listing or rental — and the reverse.
 */
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory, createTestProduct,
  createTestCatalogProduct, createTestListing, createTestMachinery,
  cleanupTestData, prisma,
} from '../../fixtures/setup.js';
import { encryptNumber } from '../../../src/utils/encrypt.js';
import { rankOffersForVariant } from '../../../src/services/buyBox.service.js';
import { resolveServiceability } from '../../../src/services/serviceability.service.js';

let app;
const ids = (res) => res.body.data.map((r) => r.id);

beforeAll(async () => {
  app = await getApp();
});

afterAll(async () => {
  await cleanupTestData();
});

// ── Nearby Krushi Kendra lookup ──────────────────────────────────────────────
describe('GET /crop-reports/sellers/nearby', () => {
  const kendra = (name, district, extra = {}) => createTestSeller({
    name, district, businessType: 'krushi_kendra', kycStatus: 'VERIFIED', lat: null, lng: null, ...extra,
  });
  const farmerIn = (district, extra = {}) =>
    createTestUser({ name: `Farmer ${district}`, district, lat: null, lng: null, ...extra });

  let osmanabadKendra;
  let dharashivKendra;
  let puneKendra;

  beforeAll(async () => {
    osmanabadKendra = await kendra('Old-name Kendra', 'Osmanabad');
    dharashivKendra = await kendra('New-name Kendra', 'Dharashiv');
    puneKendra      = await kendra('Pune Kendra', 'Pune');
  });

  it('a Dharashiv farmer finds an Osmanabad Kendra (district fallback)', async () => {
    const farmer = await farmerIn('Dharashiv');
    const res = await request(app).get('/api/v1/crop-reports/sellers/nearby').set(farmer.headers);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(expect.arrayContaining([osmanabadKendra.user.id, dharashivKendra.user.id]));
    expect(ids(res)).not.toContain(puneKendra.user.id);
  });

  it('an Osmanabad farmer finds a Dharashiv Kendra, whatever the case', async () => {
    const farmer = await farmerIn('Osmanabad');
    const res = await request(app).get('/api/v1/crop-reports/sellers/nearby?district=osmanabad').set(farmer.headers);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(expect.arrayContaining([osmanabadKendra.user.id, dharashivKendra.user.id]));
    expect(ids(res)).not.toContain(puneKendra.user.id);
  });

  it('the GPS path still returns Kendras under either spelling', async () => {
    const coords = { lat: encryptNumber(18.18), lng: encryptNumber(76.04) };
    const located = await kendra('Located Old-name Kendra', 'Osmanabad', coords);
    const farmer = await farmerIn('Dharashiv');
    const res = await request(app)
      .get('/api/v1/crop-reports/sellers/nearby?lat=18.18&lng=76.04&radiusKm=50')
      .set(farmer.headers);
    expect(res.status).toBe(200);
    const hit = res.body.data.find((s) => s.id === located.user.id);
    expect(hit).toMatchObject({ proximity: 'gps' });
  });
});

// ── AgriStore: listing geo filter + legacy fused products ────────────────────
describe('AgriStore district scope', () => {
  let category;
  let osmanabadSeller;
  let dharashivSeller;

  beforeAll(async () => {
    category = await createTestCategory({ name: `District Alias ${Date.now()}` });
    osmanabadSeller = await createTestSeller({ name: 'Osmanabad Agro', district: 'Osmanabad' });
    dharashivSeller = await createTestSeller({ name: 'Dharashiv Agro', district: 'Dharashiv' });
  });

  it('a district-scoped Osmanabad offer wins the buy box for a Dharashiv buyer', async () => {
    const product = await createTestCatalogProduct(category.id);
    const variantId = product.variants[0].id;
    const offer = await createTestListing(osmanabadSeller.user.id, variantId, { district: 'Osmanabad' });

    expect((await rankOffersForVariant(variantId, { district: 'Dharashiv' })).winner?.id).toBe(offer.id);
    expect((await rankOffersForVariant(variantId, { district: 'Pune' })).winner).toBeNull();
  });

  it('a district-scoped Dharashiv offer wins the buy box for an Osmanabad buyer', async () => {
    const product = await createTestCatalogProduct(category.id);
    const variantId = product.variants[0].id;
    const offer = await createTestListing(dharashivSeller.user.id, variantId, { district: 'Dharashiv' });

    expect((await rankOffersForVariant(variantId, { district: 'osmanabad' })).winner?.id).toBe(offer.id);
  });

  it('the storefront lists split and legacy products across the rename', async () => {
    const split = await createTestCatalogProduct(category.id);
    await createTestListing(osmanabadSeller.user.id, split.variants[0].id, { district: 'Osmanabad' });
    const legacy = await createTestProduct(dharashivSeller.user.id, category.id, { district: 'Dharashiv' });

    const forDharashiv = await request(app).get(`/api/v1/agristore/products?category=${category.id}&district=Dharashiv&limit=50`);
    expect(forDharashiv.status).toBe(200);
    expect(ids(forDharashiv)).toEqual(expect.arrayContaining([split.id, legacy.id]));

    const forOsmanabad = await request(app).get(`/api/v1/agristore/products?category=${category.id}&district=Osmanabad&limit=50`);
    expect(ids(forOsmanabad)).toEqual(expect.arrayContaining([split.id, legacy.id]));

    const forNashik = await request(app).get(`/api/v1/agristore/products?category=${category.id}&district=Nashik&limit=50`);
    expect(ids(forNashik)).not.toContain(split.id);
    expect(ids(forNashik)).not.toContain(legacy.id);
  });
});

// ── Serviceability ───────────────────────────────────────────────────────────
describe('resolveServiceability by district', () => {
  it('a seller area written as Osmanabad serves a Dharashiv buyer, and the reverse', async () => {
    const seller = await createTestSeller({ name: 'Area Seller', district: 'Osmanabad' });
    await prisma.sellerServiceArea.create({
      data: { sellerId: seller.user.id, district: 'Osmanabad', matchKey: 'dist:osmanabad', etaMinDays: 1, etaMaxDays: 2 },
    });
    const other = await createTestSeller({ name: 'Area Seller 2', district: 'Dharashiv' });
    await prisma.sellerServiceArea.create({
      data: { sellerId: other.user.id, district: 'Dharashiv', matchKey: 'dist:dharashiv', etaMinDays: 1, etaMaxDays: 2 },
    });

    // A PIN that matches no pincode/prefix row, so only the district can match.
    const map = await resolveServiceability({
      sellerIds: [seller.user.id], pincode: '413501', district: 'Dharashiv',
    });
    expect(map.get(seller.user.id)).toMatchObject({ source: 'region', etaMinDays: 1, etaMaxDays: 2 });

    const reverse = await resolveServiceability({
      sellerIds: [other.user.id], pincode: '413501', district: 'Osmanabad',
    });
    expect(reverse.get(other.user.id)).toMatchObject({ source: 'region', etaMinDays: 1 });

    const elsewhere = await resolveServiceability({
      sellerIds: [seller.user.id], pincode: '411001', district: 'Pune',
    });
    expect(elsewhere.get(seller.user.id).source).toBe('default');
  });
});

// ── Rent ─────────────────────────────────────────────────────────────────────
describe('Rent district filter', () => {
  const CAT = 'category=districtalias';
  let owner;
  let dharashivTractor;
  let puneTractor;
  let osmanabadCrew;

  beforeAll(async () => {
    owner = await createTestUser({ name: 'Rent Owner' });
    dharashivTractor = await createTestMachinery(owner.user.id, {
      category: 'districtalias', district: 'Dharashiv', lat: 18.18, lng: 76.04,
    });
    puneTractor = await createTestMachinery(owner.user.id, {
      category: 'districtalias', district: 'Pune', lat: 18.52, lng: 73.85,
    });
    osmanabadCrew = await prisma.labourListing.create({
      data: {
        providerId: owner.user.id, name: 'Alias Crew', skills: ['districtalias'], pricePerDay: 500,
        location: 'Tuljapur', district: 'Osmanabad', state: 'Maharashtra', status: 'ACTIVE', available: true,
        languages: [], images: [], videos: [], lat: 18.01, lng: 76.07,
      },
    });
  });

  it('the district picker\'s Osmanabad finds a Dharashiv machine, with and without GPS', async () => {
    const plain = await request(app).get(`/api/v1/rent/machinery?district=Osmanabad&${CAT}`);
    expect(plain.status).toBe(200);
    expect(ids(plain)).toEqual([dharashivTractor.id]);

    const located = await request(app)
      .get(`/api/v1/rent/machinery?district=Osmanabad&lat=18.2&lng=76.0&radius=all&${CAT}`);
    expect(located.status).toBe(200);
    expect(ids(located)).toEqual([dharashivTractor.id]);
    expect(ids(located)).not.toContain(puneTractor.id);
  });

  it('a Dharashiv search finds an Osmanabad labour crew, with and without GPS', async () => {
    const plain = await request(app).get('/api/v1/rent/labour?district=Dharashiv&skill=districtalias');
    expect(ids(plain)).toEqual([osmanabadCrew.id]);

    const located = await request(app)
      .get('/api/v1/rent/labour?district=Dharashiv&skill=districtalias&lat=18.2&lng=76.0&radius=all');
    expect(ids(located)).toEqual([osmanabadCrew.id]);
  });

  it('a district that was never renamed still narrows to itself', async () => {
    const res = await request(app).get(`/api/v1/rent/machinery?district=Pune&${CAT}`);
    expect(ids(res)).toEqual([puneTractor.id]);
  });
});

// ── Animals ──────────────────────────────────────────────────────────────────
describe('Animal listings district filter', () => {
  let oldName;
  let newName;
  let pune;

  beforeAll(async () => {
    const seller = await createTestUser({ name: 'Animal Seller' });
    const base = {
      sellerId: seller.user.id, animal: 'Aliasbuffalo', breed: 'Murrah', age: '4 years', gender: 'FEMALE',
      weight: '520 kg', price: 85000, description: 'Healthy', images: [], tags: [], status: 'ACTIVE',
      lat: 18.18, lng: 76.04,
    };
    oldName = await prisma.animalListing.create({ data: { ...base, sellerLocation: 'Tuljapur, Osmanabad, Maharashtra' } });
    newName = await prisma.animalListing.create({ data: { ...base, sellerLocation: 'Kalamb, Dharashiv, Maharashtra' } });
    pune    = await prisma.animalListing.create({ data: { ...base, sellerLocation: 'Baramati, Pune, Maharashtra', lat: 18.15, lng: 74.58 } });
  });

  it('a PIN-resolved Dharashiv finds listings under either name, with and without GPS', async () => {
    const plain = await request(app).get('/api/v1/animals').query({ animal: 'Aliasbuffalo', district: 'Dharashiv' });
    expect(plain.status).toBe(200);
    expect(ids(plain).sort()).toEqual([oldName.id, newName.id].sort());

    const located = await request(app).get('/api/v1/animals')
      .query({ animal: 'Aliasbuffalo', district: 'Dharashiv', lat: 18.2, lng: 76.0, radius: 500 });
    expect(located.status).toBe(200);
    expect(ids(located).sort()).toEqual([oldName.id, newName.id].sort());
    expect(ids(located)).not.toContain(pune.id);
  });

  it('Osmanabad finds the Dharashiv listing too', async () => {
    const res = await request(app).get('/api/v1/animals').query({ animal: 'Aliasbuffalo', district: 'Osmanabad' });
    expect(ids(res).sort()).toEqual([oldName.id, newName.id].sort());
  });
});
