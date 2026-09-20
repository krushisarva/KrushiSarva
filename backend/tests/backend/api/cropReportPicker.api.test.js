/**
 * API tests for the seller app's crop-report product picker.
 *
 * The picker let a Kendra tick an out-of-stock or paused offer, and the reply
 * route then dropped it without a word. It also only ever loaded the newest 50
 * offers. These tests pin the server half of the fix:
 *   - the reply keeps exactly what the picker lets a seller tick: an APPROVED
 *     product with this seller's ACTIVE, in-stock listing — nothing else;
 *   - GET /agristore/seller/products?search= reaches any of the seller's offers
 *     (not just page 1), with `total` counting the filtered set, and never
 *     another seller's.
 */
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing,
  createTestCropReport, createTestCropShare,
  cleanupTestData,
} from '../../fixtures/setup.js';

const BASE = '/api/v1/crop-reports';
const SHOP = '/api/v1/agristore';

let app;
let category;
let farmer;
let kendra;
let rival;

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory();
  farmer = await createTestUser({ name: 'Picker Farmer', district: 'Pune' });
  kendra = await createTestSeller({ name: 'Picker Agro', businessType: 'krushi_kendra', district: 'Pune' });
  rival = await createTestSeller({ name: 'Rival Picker Agro', businessType: 'krushi_kendra', district: 'Pune' });
});

afterAll(async () => {
  await cleanupTestData();
});

async function offer(seller, name, listing = {}, product = {}) {
  const p = await createTestCatalogProduct(category.id, { name, ...product });
  await createTestListing(seller.user.id, p.variants[0].id, listing);
  return p;
}

describe('POST /seller/inbox/:shareId/reply — only recommendable offers are kept', () => {
  test('keeps an approved, ACTIVE, in-stock offer and drops out-of-stock, paused and unapproved ones', async () => {
    const live = await offer(kendra, 'Picker Live Offer', { stockQty: 5 });
    const soldOut = await offer(kendra, 'Picker Sold Out', { stockQty: 0, status: 'OUT_OF_STOCK' });
    const zeroButActive = await offer(kendra, 'Picker Zero Active', { stockQty: 0, status: 'ACTIVE' });
    const paused = await offer(kendra, 'Picker Paused', { stockQty: 8, status: 'INACTIVE' });
    const pending = await offer(kendra, 'Picker Pending QC', { stockQty: 8 }, { status: 'PENDING_QC' });

    const report = await createTestCropReport(farmer.user.id);
    const share = await createTestCropShare(report.id, farmer.user.id, kendra.user.id);
    const res = await request(app)
      .post(`${BASE}/seller/inbox/${share.id}/reply`)
      .set(kendra.headers)
      .send({
        reply: 'Spray Mancozeb 2.5 g/L.',
        recommendedProductIds: [live.id, soldOut.id, zeroButActive.id, paused.id, pending.id],
        available: true,
      });

    expect(res.status).toBe(200);
    // The response is what the seller app reseeds its form from.
    expect(res.body.data).toMatchObject({
      recommendedProductIds: [live.id],
      available: true,
      sellerReply: 'Spray Mancozeb 2.5 g/L.',
      status: 'REPLIED',
    });
  });

  test('a product with one sold-out pack and one in-stock pack is kept', async () => {
    const p = await createTestCatalogProduct(category.id, {
      name: 'Picker Two Packs',
      variants: [
        { unit: 'packet', attributes: { packSize: '250g' }, isDefault: true },
        { unit: 'packet', attributes: { packSize: '1kg' }, isDefault: false },
      ],
    });
    await createTestListing(kendra.user.id, p.variants[0].id, { stockQty: 0, status: 'OUT_OF_STOCK' });
    await createTestListing(kendra.user.id, p.variants[1].id, { stockQty: 4 });

    const report = await createTestCropReport(farmer.user.id);
    const share = await createTestCropShare(report.id, farmer.user.id, kendra.user.id);
    const res = await request(app)
      .post(`${BASE}/seller/inbox/${share.id}/reply`)
      .set(kendra.headers)
      .send({ reply: 'Use this one.', recommendedProductIds: [p.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.recommendedProductIds).toEqual([p.id]);
  });
});

describe('GET /agristore/seller/products?search=', () => {
  test('finds an offer that is not on the first page, and total counts only matches', async () => {
    const needle = await offer(kendra, 'Zzpicker Needle Fungicide');
    // Newer offers push the needle off page 1 of an unfiltered read.
    for (let i = 0; i < 3; i += 1) await offer(kendra, `Picker Filler ${i}`);

    const page1 = await request(app).get(`${SHOP}/seller/products?page=1&limit=2`).set(kendra.headers);
    expect(page1.status).toBe(200);
    expect(page1.body.data.map((r) => r.id)).not.toContain(needle.id);

    const hit = await request(app)
      .get(`${SHOP}/seller/products`)
      .query({ page: 1, limit: 2, search: 'zzpicker needle' })
      .set(kendra.headers);
    expect(hit.status).toBe(200);
    expect(hit.body.data.map((r) => r.id)).toEqual([needle.id]);
    expect(hit.body.meta.total).toBe(1);
  });

  test('matches the brand too, and never returns another seller\'s offer', async () => {
    const mine = await offer(kendra, 'Picker Brand Mine', {}, { brand: 'Qqbrandpick' });
    await offer(rival, 'Picker Brand Theirs', {}, { brand: 'Qqbrandpick' });

    const res = await request(app)
      .get(`${SHOP}/seller/products`)
      .query({ search: 'qqbrandpick' })
      .set(kendra.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => r.id)).toEqual([mine.id]);
  });

  test('LIKE wildcards in the term do not match everything', async () => {
    const res = await request(app)
      .get(`${SHOP}/seller/products`)
      .query({ search: '%%zz_nothing_like_this%%' })
      .set(kendra.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });
});
