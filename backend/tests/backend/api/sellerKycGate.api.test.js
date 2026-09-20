/**
 * Selling requires verified KYC (bug #26).
 *
 * A FARMER could self-promote to SELLER (sellerConsent) and list goods at once,
 * with KYC still PENDING; nothing on the AgriStore write path read kycStatus,
 * and an admin KYC reject left the seller's offers on sale. The gate:
 *   - creating an offer, or putting a paused one back on sale, needs VERIFIED
 *     (ADMIN exempt) — 403 { code: KYC_REQUIRED };
 *   - offers already live are left alone (production data), and can still be
 *     edited, restocked and paused;
 *   - admin KYC reject pulls the seller's live offers in the same transaction.
 *
 * The gate is only fair if a new seller can reach review, so the onboarding path
 * is tested end to end: BusinessProfile submit → admin queue → verify → sell.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { Writable } from 'stream';
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, authHeader, cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const { cloudinary } = await import('../../../src/config/cloudinary.js');
const { ENV } = await import('../../../src/config/env.js');

const API = '/api/v1/agristore';
const KYC_MESSAGE = 'Your KYC must be verified before you can sell. Complete it in Business Profile.';

let app; let admin; let category;

beforeAll(async () => {
  app = await getApp();
  // adminScopes = [] is SUPER_ADMIN, which covers KYC_REVIEWER and CONTENT_MODERATOR.
  admin = await createTestUser({ role: 'ADMIN', name: 'KYC Gate Admin' });
  category = await createTestCategory({ name: `KYC Gate Seeds ${Date.now()}` });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

const newProduct = (overrides = {}) => createTestCatalogProduct(category.id, {
  name: `KYC Gate Seed ${Date.now()}-${Math.round(Math.random() * 1e6)}`,
  ...overrides,
});

const offerBody = (variantId) => ({ variantId, sellingPrice: 120, stockQty: 5, district: 'Pune', state: 'Maharashtra' });

function expectKycRequired(res) {
  expect(res.status).toBe(403);
  expect(res.body.error.message).toBe(KYC_MESSAGE);
  expect(res.body.error.details).toEqual({ code: 'KYC_REQUIRED' });
}

const statusOf = async (listingId) =>
  (await prisma.sellerListing.findUnique({ where: { id: listingId }, select: { status: true } })).status;

async function offerIdsOf(productId) {
  const res = await request(app).get(`${API}/products/${productId}/offers`);
  expect(res.status).toBe(200);
  return res.body.data.variants.flatMap((g) => g.offers.map((o) => o.listingId));
}

/** userIds in the admin KYC queue for `status` (the SPA opens on SUBMITTED). */
async function queueIds(status) {
  const res = await request(app).get(`/api/v1/admin/kyc?status=${status}&limit=100`).set(admin.headers);
  expect(res.status).toBe(200);
  return res.body.data.items.map((i) => i.userId);
}

// ═══════════════════════════════════════════════════════════════════════════════
describe('creating an offer requires verified KYC', () => {
  test.each(['PENDING', 'SUBMITTED', 'REJECTED'])('POST /listings — a %s seller is refused', async (kycStatus) => {
    const seller = await createTestSeller({ kycStatus });
    const product = await newProduct();

    const res = await request(app).post(`${API}/listings`).set(seller.headers).send(offerBody(product.variants[0].id));

    expectKycRequired(res);
    expect(await prisma.sellerListing.count({ where: { sellerId: seller.user.id } })).toBe(0);
  });

  test('POST /listings — a VERIFIED seller can sell', async () => {
    const seller = await createTestSeller({ kycStatus: 'VERIFIED' });
    const product = await newProduct();

    const res = await request(app).post(`${API}/listings`).set(seller.headers).send(offerBody(product.variants[0].id));

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('ACTIVE');
  });

  test('POST /listings — the VERIFIED_FARMER role is not a KYC decision', async () => {
    const farmer = await createTestUser({ role: 'VERIFIED_FARMER', kycStatus: 'PENDING' });
    const product = await newProduct();

    const res = await request(app).post(`${API}/listings`).set(farmer.headers).send(offerBody(product.variants[0].id));

    expectKycRequired(res);
  });

  test('POST /listings — an ADMIN is exempt', async () => {
    const product = await newProduct();

    const res = await request(app).post(`${API}/listings`).set(admin.headers).send(offerBody(product.variants[0].id));

    expect(res.status).toBe(201);
  });

  test('POST /catalog/products — refused before an orphan entry reaches the QC queue', async () => {
    const seller = await createTestSeller({ kycStatus: 'PENDING' });
    const name = `KYC Orphan ${Date.now()}`;

    const res = await request(app).post(`${API}/catalog/products`).set(seller.headers)
      .send({ name, categoryId: category.id });

    expectKycRequired(res);
    expect(await prisma.product.count({ where: { name } })).toBe(0);
  });

  test('legacy POST /seller/products — refused, nothing created', async () => {
    const seller = await createTestSeller({ kycStatus: 'SUBMITTED' });
    const name = `KYC Legacy ${Date.now()}`;

    const res = await request(app).post(`${API}/seller/products`).set(seller.headers)
      .send({ name, categoryId: category.id, price: 99, stock: 3, unit: 'kg' });

    expectKycRequired(res);
    expect(await prisma.product.count({ where: { name } })).toBe(0);
    expect(await prisma.sellerListing.count({ where: { sellerId: seller.user.id } })).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('existing offers of an unverified seller', () => {
  test('PATCH /listings/:id — a paused offer cannot go back on sale', async () => {
    const seller = await createTestSeller({ kycStatus: 'SUBMITTED' });
    const product = await newProduct();
    const listing = await createTestListing(seller.user.id, product.variants[0].id, { status: 'INACTIVE' });

    const res = await request(app).patch(`${API}/listings/${listing.id}`).set(seller.headers).send({ status: 'ACTIVE' });

    expectKycRequired(res);
    expect(await statusOf(listing.id)).toBe('INACTIVE');

    // Editing it while it stays paused is fine.
    const edit = await request(app).patch(`${API}/listings/${listing.id}`).set(seller.headers).send({ sellingPrice: 111, stockQty: 7 });
    expect(edit.status).toBe(200);
    expect(edit.body.data.status).toBe('INACTIVE');
  });

  test('a live offer is not pulled, and can still be edited, restocked and paused', async () => {
    const seller = await createTestSeller({ kycStatus: 'PENDING' });
    const product = await newProduct();
    const live = await createTestListing(seller.user.id, product.variants[0].id);

    const edit = await request(app).patch(`${API}/listings/${live.id}`).set(seller.headers).send({ sellingPrice: 95, stockQty: 20 });
    expect(edit.status).toBe(200);
    expect(edit.body.data.status).toBe('ACTIVE');

    await prisma.sellerListing.update({ where: { id: live.id }, data: { stockQty: 0, status: 'OUT_OF_STOCK' } });
    const restock = await request(app).patch(`${API}/listings/${live.id}`).set(seller.headers).send({ stockQty: 4 });
    expect(restock.status).toBe(200);
    expect(restock.body.data.status).toBe('ACTIVE');

    const pause = await request(app).patch(`${API}/listings/${live.id}`).set(seller.headers).send({ status: 'INACTIVE' });
    expect(pause.status).toBe(200);
    expect(pause.body.data.status).toBe('INACTIVE');
  });

  test('legacy PUT /seller/products/:id — resume refused, pause allowed', async () => {
    const seller = await createTestSeller({ kycStatus: 'REJECTED' });
    const product = await newProduct();
    const listing = await createTestListing(seller.user.id, product.variants[0].id, { status: 'INACTIVE' });

    const resume = await request(app).put(`${API}/seller/products/${product.id}`).set(seller.headers).send({ isActive: true });
    expectKycRequired(resume);
    expect(await statusOf(listing.id)).toBe('INACTIVE');

    await prisma.sellerListing.update({ where: { id: listing.id }, data: { status: 'ACTIVE' } });
    const pause = await request(app).put(`${API}/seller/products/${product.id}`).set(seller.headers).send({ isActive: false });
    expect(pause.status).toBe(200);
    expect(await statusOf(listing.id)).toBe('INACTIVE');
  });

  test('admin catalogue QC approval releases only verified sellers\' drafts', async () => {
    const product = await newProduct({ status: 'PENDING_QC' });
    const variantId = product.variants[0].id;
    const verified = await createTestSeller({ kycStatus: 'VERIFIED' });
    const unverified = await createTestSeller({ kycStatus: 'SUBMITTED' });
    const verifiedDraft = await createTestListing(verified.user.id, variantId, { status: 'INACTIVE' });
    const unverifiedDraft = await createTestListing(unverified.user.id, variantId, { status: 'INACTIVE' });

    const res = await request(app).post(`/api/v1/admin/products/qc/${product.id}/approve`).set(admin.headers).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.offersActivated).toBe(1);
    expect(await statusOf(verifiedDraft.id)).toBe('ACTIVE');
    expect(await statusOf(unverifiedDraft.id)).toBe('INACTIVE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('new seller: BusinessProfile submit → admin queue → verify → sell; reject → pulled', () => {
  // The body BusinessProfileScreen sends on a first save
  // (seller-app/src/utils/businessProfile.js, buildBusinessProfilePayload).
  const firstSave = {
    sellerConsent: true,
    businessType: 'krushi_kendra',
    district: 'Pune', taluka: 'Haveli', village: 'Wagholi', state: 'Maharashtra',
    gstOptOut: true, gstNumber: '',
    bankHolderName: 'Ramesh Patil', bankName: 'State Bank of India',
    bankIfsc: 'SBIN0012345', bankAccountNumber: '123456789012',
    aadharNumber: '234567890124', panNumber: 'ABCDE1234F',
  };

  test('the whole lifecycle', async () => {
    const farmer = await createTestUser();
    expect(farmer.user.kycStatus).toBe('PENDING');

    // 1. First BusinessProfile save: promoted to SELLER and submitted for review.
    const saved = await request(app).put('/api/v1/users/me').set(farmer.headers).send(firstSave);
    expect(saved.status).toBe(200);
    expect(saved.body.data.role).toBe('SELLER');
    expect(saved.body.data.kycStatus).toBe('SUBMITTED');
    const seller = authHeader(saved.body.data.tokens.accessToken);

    // 2. It is in the queue the admin KYC page opens on (SUBMITTED).
    expect(await queueIds('SUBMITTED')).toContain(farmer.user.id);

    // 3. Not verified yet — cannot sell.
    const product = await newProduct();
    expectKycRequired(await request(app).post(`${API}/listings`).set(seller).send(offerBody(product.variants[0].id)));

    // 4. Admin verifies → the seller can sell.
    const verify = await request(app).post(`/api/v1/admin/kyc/${farmer.user.id}/verify`).set(admin.headers).send({});
    expect(verify.status).toBe(200);
    const created = await request(app).post(`${API}/listings`).set(seller).send(offerBody(product.variants[0].id));
    expect(created.status).toBe(201);
    const listingId = created.body.data.id;
    expect(await offerIdsOf(product.id)).toContain(listingId);

    // 5. Admin rejects → the live offer comes down at once, and no new ones.
    const reject = await request(app).post(`/api/v1/admin/kyc/${farmer.user.id}/reject`)
      .set(admin.headers).send({ reason: 'PAN does not match the bank account name' });
    expect(reject.status).toBe(200);
    expect(reject.body.data).toMatchObject({ kycStatus: 'REJECTED', listingsDeactivated: 1 });
    expect(await statusOf(listingId)).toBe('INACTIVE');
    expect(await offerIdsOf(product.id)).not.toContain(listingId);
    expect(await queueIds('SUBMITTED')).not.toContain(farmer.user.id);

    const again = await request(app).post(`${API}/listings`).set(seller).send(offerBody((await newProduct()).variants[0].id));
    expectKycRequired(again);
    // Reactivation is not automatic, and not possible while REJECTED.
    expectKycRequired(await request(app).patch(`${API}/listings/${listingId}`).set(seller).send({ status: 'ACTIVE' }));

    // The role stays, so the seller can correct their details and resubmit.
    const fixed = await request(app).put('/api/v1/users/me').set(seller).send({ panNumber: 'PQRST6789K' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.kycStatus).toBe('SUBMITTED');
    expect(await queueIds('SUBMITTED')).toContain(farmer.user.id);

    const audits = await prisma.auditLog.findMany({ where: { userId: farmer.user.id, action: 'KYC_SUBMIT' } });
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].metadata)).toEqual({ idFields: ['aadharNumber', 'panNumber'] });
  });

  test('reject pulls ACTIVE and OUT_OF_STOCK offers, and leaves paused and blocked ones', async () => {
    const seller = await createTestSeller({ kycStatus: 'SUBMITTED' });
    await prisma.sellerProfile.create({ data: { userId: seller.user.id } });
    const rows = {};
    for (const status of ['ACTIVE', 'OUT_OF_STOCK', 'INACTIVE', 'BLOCKED']) {
      rows[status] = await createTestListing(seller.user.id, (await newProduct()).variants[0].id, { status });
    }

    const res = await request(app).post(`/api/v1/admin/kyc/${seller.user.id}/reject`)
      .set(admin.headers).send({ reason: 'Blurred Aadhaar' });

    expect(res.status).toBe(200);
    expect(res.body.data.listingsDeactivated).toBe(2);
    expect(await statusOf(rows.ACTIVE.id)).toBe('INACTIVE');
    expect(await statusOf(rows.OUT_OF_STOCK.id)).toBe('INACTIVE');
    expect(await statusOf(rows.INACTIVE.id)).toBe('INACTIVE');
    expect(await statusOf(rows.BLOCKED.id)).toBe('BLOCKED');

    const audit = await prisma.auditLog.findFirst({ where: { entityId: seller.user.id, action: 'ADMIN_KYC_REJECT' } });
    expect(JSON.parse(audit.metadata)).toMatchObject({ listingsDeactivated: 2 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('reaching the admin queue', () => {
  test('bank details alone do not submit a PENDING account (no identity number yet)', async () => {
    const seller = await createTestSeller({ kycStatus: 'PENDING' });

    const res = await request(app).put('/api/v1/users/me').set(seller.headers)
      .send({ bankHolderName: 'Ramesh Patil', bankIfsc: 'SBIN0012345', bankAccountNumber: '123456789012' });

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe('PENDING');
  });

  test('blank fields from a first save do not submit it either', async () => {
    const seller = await createTestSeller({ kycStatus: 'PENDING' });

    const res = await request(app).put('/api/v1/users/me').set(seller.headers)
      .send({ village: 'Wagholi', bankHolderName: '', bankName: '', bankIfsc: '' });

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe('PENDING');
  });

  test('PUT /me/seller-profile — a first Aadhaar submits the account', async () => {
    const seller = await createTestSeller({ kycStatus: 'PENDING' });

    const res = await request(app).put('/api/v1/users/me/seller-profile').set(seller.headers)
      .send({ aadharNumber: '234567890124' });

    expect(res.status).toBe(200);
    const after = await prisma.user.findUnique({ where: { id: seller.user.id }, select: { kycStatus: true } });
    expect(after.kycStatus).toBe('SUBMITTED');
  });

  describe('POST /me/kyc-documents', () => {
    let restore;
    beforeAll(() => {
      // Never upload to the real Cloudinary account from a test.
      const original = { name: ENV.CLOUDINARY_CLOUD_NAME, uploadStream: cloudinary.uploader.upload_stream };
      ENV.CLOUDINARY_CLOUD_NAME = ENV.CLOUDINARY_CLOUD_NAME || 'test-cloud';
      cloudinary.uploader.upload_stream = (opts, cb) => {
        const sink = new Writable({ write(_chunk, _enc, next) { next(); } });
        sink.on('finish', () => cb(null, { public_id: `${opts.folder}/doc-${Date.now()}` }));
        return sink;
      };
      restore = () => {
        ENV.CLOUDINARY_CLOUD_NAME = original.name;
        cloudinary.uploader.upload_stream = original.uploadStream;
      };
    });
    afterAll(() => restore());

    const upload = (headers) => request(app).post('/api/v1/users/me/kyc-documents').set(headers)
      .attach('images', Buffer.from('fake-jpeg'), { filename: 'aadhaar.jpg', contentType: 'image/jpeg' });

    test('moves a PENDING account to SUBMITTED (was PENDING — outside the queue)', async () => {
      const seller = await createTestSeller({ kycStatus: 'PENDING' });

      const res = await upload(seller.headers);

      expect(res.status).toBe(201);
      expect(await queueIds('SUBMITTED')).toContain(seller.user.id);
    });

    test('new documents take a VERIFIED seller back to review, clearing the old approval', async () => {
      const seller = await createTestSeller({ kycStatus: 'VERIFIED' });
      await prisma.sellerProfile.create({ data: { userId: seller.user.id, kycVerifiedAt: new Date() } });

      const res = await upload(seller.headers);

      expect(res.status).toBe(201);
      const after = await prisma.user.findUnique({
        where: { id: seller.user.id }, select: { kycStatus: true, sellerProfile: { select: { kycVerifiedAt: true } } },
      });
      expect(after.kycStatus).toBe('SUBMITTED');
      expect(after.sellerProfile.kycVerifiedAt).toBeNull();
    });
  });
});
