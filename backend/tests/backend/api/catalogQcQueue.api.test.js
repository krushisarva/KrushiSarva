/**
 * Admin Catalog QC queue — what the reviewer is shown before they decide.
 *
 * Approving a pending product does two things at once: it publishes the
 * catalogue entry, and it puts the proposing seller's waiting offer on sale at
 * whatever price they typed. The queue used to return only the catalogue half,
 * so the admin panel's review screen could not show the price being approved.
 *
 *   - a PENDING_QC product carries its waiting offer(s) under each pack size
 *   - any other status does NOT: an approved product can have an offer from
 *     every Kendra, which is not something a list response should carry
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData,
} from '../../fixtures/setup.js';

const QUEUE = '/api/v1/admin/products/qc/queue';

let app; let admin; let category; let seller;

beforeAll(async () => {
  app = await getApp();
  // adminScopes = [] is SUPER_ADMIN, which covers CONTENT_MODERATOR.
  admin = await createTestUser({ role: 'ADMIN', name: 'QC Queue Admin' });
  seller = await createTestSeller({ kycStatus: 'VERIFIED', district: 'Pune' });
  category = await createTestCategory({ name: `QC Queue Tools ${Date.now()}` });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

const newProduct = (overrides = {}) => createTestCatalogProduct(category.id, {
  name: `QC Queue Khurpi ${Date.now()}-${Math.round(Math.random() * 1e6)}`,
  createdBySellerId: seller.user.id,
  ...overrides,
});

async function queueRow(productId, status) {
  const res = await request(app)
    .get(`${QUEUE}?limit=100${status ? `&status=${status}` : ''}`)
    .set(admin.headers);
  expect(res.status).toBe(200);
  return res.body.data.items.find((p) => p.id === productId);
}

describe('GET /admin/products/qc/queue', () => {
  test('a pending product comes with the offer that goes on sale when it is approved', async () => {
    const product = await newProduct({
      status: 'PENDING_QC',
      description: 'Forged steel khurpi.',
      highlights: ['Forged steel blade'],
      specifications: { Length: '28 cm' },
    });
    const draft = await createTestListing(seller.user.id, product.variants[0].id, {
      status: 'INACTIVE', sellingPrice: 149, mrp: 199, stockQty: 50, minOrderQty: 2,
      dispatchSlaDays: 3, sellScope: 'district', district: 'Pune', state: 'Maharashtra',
      images: ['https://example.test/stock.jpg'],
    });

    const row = await queueRow(product.id);

    expect(row).toBeDefined();
    // The catalogue half the review screen prints in full.
    expect(row).toMatchObject({
      description: 'Forged steel khurpi.',
      highlights: ['Forged steel blade'],
      specifications: { Length: '28 cm' },
    });
    expect(row.proposedBy).toMatchObject({ id: seller.user.id, kycStatus: 'VERIFIED' });

    // The offer half.
    expect(row.variants).toHaveLength(1);
    expect(row.variants[0].listings).toHaveLength(1);
    const offer = row.variants[0].listings[0];
    expect(offer).toMatchObject({
      id: draft.id, sellerId: seller.user.id,
      stockQty: 50, minOrderQty: 2, dispatchSlaDays: 3,
      sellScope: 'district', district: 'Pune', state: 'Maharashtra',
      images: ['https://example.test/stock.jpg'], status: 'INACTIVE',
    });
    expect(Number(offer.sellingPrice)).toBe(149);
    expect(Number(offer.mrp)).toBe(199);
  });

  test('a pending product nobody has priced yet has an empty offer list, not a missing one', async () => {
    const product = await newProduct({ status: 'PENDING_QC' });
    const row = await queueRow(product.id);
    expect(row.variants[0].listings).toEqual([]);
    expect(row.variants[0]._count.listings).toBe(0);
  });

  test('other statuses do not carry offers — only the count', async () => {
    const product = await newProduct({ status: 'APPROVED' });
    await createTestListing(seller.user.id, product.variants[0].id, { status: 'ACTIVE' });

    const row = await queueRow(product.id, 'APPROVED');

    expect(row).toBeDefined();
    expect(row.variants[0]).not.toHaveProperty('listings');
    expect(row.variants[0]._count.listings).toBe(1);
  });

  test('a seller cannot read the queue', async () => {
    const res = await request(app).get(QUEUE).set(seller.headers);
    expect(res.status).toBe(403);
  });
});
