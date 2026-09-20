/**
 * API tests for the catalog duplicate gate and search when the match is a
 * product still AWAITING REVIEW (PENDING_QC).
 *
 * The bug: the gate matched every seller's unreviewed products, but POST
 * /listings only lets the seller who proposed one attach an offer to it. Seller
 * B proposing "Urea" after seller A was told "already in the catalogue — use the
 * existing product", and using it failed with "not available to sell yet": B
 * could neither create nor attach. Now another seller's unreviewed product does
 * not block (both proposals go to review; the admin merges them), and nothing
 * goes on sale before it is reviewed.
 *
 * Also: the 409's candidate list comes back in the gate's own order, so the
 * product it names is the one the seller sees first.
 *
 * Run with:
 *   node --experimental-vm-modules node_modules/jest/bin/jest.js --testTimeout=60000
 */
import request from 'supertest';
import {
  getApp, createTestSeller, createTestCategory, createTestCatalogProduct,
  cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const API = '/api/v1/agristore';

let app;
let category;
let kendraA;
let kendraB;

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory({ name: `Pending Dedup ${Date.now()}` });
  kendraA = await createTestSeller({ name: 'Shivneri Agro', district: 'Pune', taluka: 'Junnar' });
  kendraB = await createTestSeller({ name: 'Jai Kisan Agro', district: 'Pune', taluka: 'Junnar' });
}, 60_000);

afterAll(async () => {
  await cleanupTestData();
});

const stamp = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

const propose = (seller, body) => request(app).post(`${API}/catalog/products`).set(seller.headers)
  .send({ categoryId: category.id, ...body });

const offer = (seller, variantId) => request(app).post(`${API}/listings`).set(seller.headers)
  .send({ variantId, sellingPrice: 266, stockQty: 40, district: 'Pune' });

// ═══════════════════════════════════════════════════════════════════════════════
describe('Another seller\'s product awaiting review does not block a create', () => {
  test('same product (exact key): B gets its own proposal, in review, and can put an offer on it', async () => {
    const body = { name: `Urea Neem Coated ${stamp()}`, brand: 'IFFCO', variants: [{ unit: 'bag' }] };
    const a = await propose(kendraA, body);
    expect(a.status).toBe(201);
    expect(a.body.data.status).toBe('PENDING_QC');

    // B cannot sell A's unreviewed product — that rule stays.
    const onA = await offer(kendraB, a.body.data.variants[0].id);
    expect(onA.status).toBe(400);

    // …so the gate must not send B there. B's proposal goes to review too.
    const b = await propose(kendraB, body);
    expect(b.status).toBe(201);
    expect(b.body.data.id).not.toBe(a.body.data.id);
    expect(b.body.data.status).toBe('PENDING_QC');

    // And B's offer is accepted, held INACTIVE until the product is approved.
    const onB = await offer(kendraB, b.body.data.variants[0].id);
    expect(onB.status).toBe(201);
    expect(onB.body.data.status).toBe('INACTIVE');
  });

  test('near-identical name (fuzzy) from another seller in review does not block either', async () => {
    const base = `Dhanuka Targa Super Herbicide ${stamp()}`;
    const a = await propose(kendraA, { name: base, brand: 'Dhanuka' });
    expect(a.status).toBe(201);

    const b = await propose(kendraB, { name: `${base}!!`, brand: 'Dhanuka' });
    expect(b.status).toBe(201);
  });

  test('the seller\'s OWN product in review still blocks, and names a product they can attach to', async () => {
    const body = { name: `DAP 18-46 ${stamp()}`, brand: 'Coromandel', variants: [{ unit: 'bag' }] };
    const first = await propose(kendraA, body);
    expect(first.status).toBe(201);

    const again = await propose(kendraA, body);
    expect(again.status).toBe(409);
    expect(again.body.error.details.productId).toBe(first.body.data.id);

    const attach = await offer(kendraA, first.body.data.variants[0].id);
    expect(attach.status).toBe(201);
    expect(attach.body.data.status).toBe('INACTIVE');
  });

  test('once approved, the product blocks everyone and is attachable', async () => {
    const body = { name: `Potash MOP ${stamp()}`, brand: 'IPL', variants: [{ unit: 'bag' }] };
    const a = await propose(kendraA, body);
    await prisma.product.update({ where: { id: a.body.data.id }, data: { status: 'APPROVED' } });

    const b = await propose(kendraB, body);
    expect(b.status).toBe(409);
    expect(b.body.error.details.productId).toBe(a.body.data.id);
    expect((await offer(kendraB, a.body.data.variants[0].id)).status).toBe(201);
  });

  test('a barcode on another seller\'s product in review: 409 with no product to attach to', async () => {
    const gtin = `892${Date.now()}`.slice(0, 13);
    const a = await propose(kendraA, {
      name: `Bayer Confidor ${stamp()}`, brand: 'Bayer', variants: [{ unit: 'ml', gtin }],
    });
    expect(a.status).toBe(201);

    // The unique barcode means B cannot create it either — but B is told it is
    // in review instead of being offered a product that refuses the offer.
    const b = await propose(kendraB, {
      name: `Something Else ${stamp()}`, brand: 'Syngenta', variants: [{ unit: 'ml', gtin }],
    });
    expect(b.status).toBe(409);
    expect(b.body.error.details).toMatchObject({ reason: 'gtin', productId: null, inReview: true, candidates: [] });

    // A (the proposer) still gets the product back.
    const own = await propose(kendraA, {
      name: `Something Else ${stamp()}`, brand: 'Syngenta', variants: [{ unit: 'ml', gtin }],
    });
    expect(own.status).toBe(409);
    expect(own.body.error.details.productId).toBe(a.body.data.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('Catalog search hides other sellers\' products awaiting review', () => {
  test('by name and by barcode: the proposer sees it, another seller does not', async () => {
    const name = `Mahadhan Smartek ${stamp()}`;
    const gtin = `893${Date.now()}`.slice(0, 13);
    const a = await propose(kendraA, { name, brand: 'Mahadhan', variants: [{ unit: 'bag', gtin }] });
    expect(a.status).toBe(201);

    const ids = (res) => res.body.data.results.map((p) => p.id);
    const byName = (seller) => request(app).get(`${API}/catalog/search?q=${encodeURIComponent(name)}`).set(seller.headers);
    const byGtin = (seller) => request(app).get(`${API}/catalog/search?gtin=${gtin}`).set(seller.headers);

    expect(ids(await byName(kendraA))).toContain(a.body.data.id);
    expect(ids(await byName(kendraB))).not.toContain(a.body.data.id);
    expect(ids(await byGtin(kendraA))).toEqual([a.body.data.id]);
    expect(ids(await byGtin(kendraB))).not.toContain(a.body.data.id);

    await prisma.product.update({ where: { id: a.body.data.id }, data: { status: 'APPROVED' } });
    expect(ids(await byName(kendraB))).toContain(a.body.data.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('409 candidates come back in the gate\'s order', () => {
  test('the product the gate names is candidates[0], and packs are oldest first', async () => {
    const cat = await createTestCategory({ name: `Candidate Order ${Date.now()}` });
    const base = `Contaf Plus Fungicide ${stamp()}`;
    // The LESS similar one is inserted first, so a lookup that returns rows in
    // table order puts it first.
    const lessSimilar = await createTestCatalogProduct(cat.id, {
      name: `${base} 500ml`,
      variants: [{ unit: 'ml', attributes: { packSize: '500ml' } }],
    });
    const exactName = await createTestCatalogProduct(cat.id, {
      name: base,
      variants: [
        { unit: 'kg', attributes: { packSize: '1kg' }, isDefault: true },
        { unit: 'bag', attributes: { packSize: '25kg' } },
      ],
    });

    // A brand makes the dedup key differ (the rows are unbranded), so the fuzzy
    // step decides — and an unstated brand does not rule a candidate out.
    const res = await request(app).post(`${API}/catalog/products`).set(kendraB.headers)
      .send({ name: base, categoryId: cat.id, brand: 'Tata Rallis' });
    expect(res.status).toBe(409);
    const { reason, productId, candidates } = res.body.error.details;
    expect(reason).toBe('fuzzy_name');
    expect(productId).toBe(exactName.id);
    expect(candidates.map((c) => c.id)).toEqual([exactName.id, lessSimilar.id]);

    const stored = await prisma.productVariant.findMany({
      where: { productId: exactName.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(candidates[0].variants.map((v) => v.id)).toEqual(stored.map((v) => v.id));
  });
});
