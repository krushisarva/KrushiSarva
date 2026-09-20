/**
 * The seller dashboard and Orders screen.
 *
 * GET /agristore/seller/stats — the dashboard's ledger (bug #20). Revenue summed
 * every order item the seller had ever had, so a cancelled order (and a refunded
 * one) still counted as money earned. "Listings" counted `products.sellerId`, a
 * column the catalog split deprecated: a seller who attached offers to existing
 * catalog products saw 0, and two pack sizes of one product could never count
 * as two.
 *
 * GET /agristore/seller/orders — the fields the app's cards read (bugs #18/#19):
 * each row's own line status, which is not the order rollup on a two-seller
 * order, and the unit sold.
 *
 * Each stats test uses its own seller: the stats are cached per seller in
 * Redis, so a shared seller would read an earlier test's figures.
 */
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestProduct, createTestCatalogProduct, createTestListing,
  cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const API = '/api/v1/agristore';

let app; let buyer; let category;

beforeAll(async () => {
  app = await getApp();
  buyer = await createTestUser({ name: 'Stats Buyer' });
  category = await createTestCategory({ name: `Stats ${Date.now()}` });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

const product = () => createTestCatalogProduct(category.id, {
  name: `Stats Seed ${Date.now()}-${Math.round(Math.random() * 1e6)}`,
});

/** An order written straight to the DB, one item per `lines` entry. */
function order(lines, { status = 'PENDING', deliveryFee = 49 } = {}) {
  const subtotal = lines.reduce((s, l) => s + l.totalPrice, 0);
  return prisma.order.create({
    data: {
      userId: buyer.user.id,
      status,
      subtotal,
      deliveryFee,
      totalAmount: subtotal + deliveryFee,
      deliveryAddress: { name: 'Buyer', city: 'Pune', pincode: '411001' },
      items: {
        create: lines.map((l) => ({
          productId: l.productId,
          sellerId: l.sellerId,
          quantity: l.quantity,
          unitPrice: l.totalPrice / l.quantity,
          totalPrice: l.totalPrice,
          status: l.status || 'PENDING',
        })),
      },
    },
  });
}

const statsOf = async (seller) => {
  const res = await request(app).get(`${API}/seller/stats`).set(seller.headers);
  expect(res.status).toBe(200);
  return res.body.data;
};

describe('GET /seller/stats — revenue', () => {
  test('counts only this seller\'s live lines: no cancelled line, no refunded order, no other seller, no delivery fee', async () => {
    const me = await createTestSeller({ name: 'Stats Kendra' });
    const rival = await createTestSeller({ name: 'Stats Rival' });
    const p = await product();
    const mine = (totalPrice, quantity, status) => ({ productId: p.id, sellerId: me.user.id, totalPrice, quantity, status });

    // Shared order: my PENDING line + another seller's line + a ₹49 delivery fee.
    await order([mine(200, 2), { productId: p.id, sellerId: rival.user.id, totalPrice: 120, quantity: 1 }]);
    // Delivered — counts.
    await order([mine(300, 3, 'DELIVERED')], { status: 'DELIVERED' });
    // My line cancelled next to my live line on the same order — only the live one counts.
    await order([mine(500, 5, 'CANCELLED'), mine(150, 1, 'CONFIRMED')], { status: 'CONFIRMED' });
    // A whole cancelled order.
    await order([mine(700, 7, 'CANCELLED')], { status: 'CANCELLED' });
    // Refunded by admin: the order is REFUNDED, its lines keep their last status.
    await order([mine(1000, 10, 'DELIVERED')], { status: 'REFUNDED' });

    const stats = await statsOf(me);
    expect(Number(stats.totalRevenue)).toBe(650);   // 200 + 300 + 150
    expect(stats.totalSold).toBe(6);                  // 2 + 3 + 1
  });

  test('a seller with nothing sold, or only cancelled lines, shows zero', async () => {
    const me = await createTestSeller();
    const p = await product();
    await order([{ productId: p.id, sellerId: me.user.id, totalPrice: 400, quantity: 4, status: 'CANCELLED' }], { status: 'CANCELLED' });

    const stats = await statsOf(me);
    expect(Number(stats.totalRevenue)).toBe(0);
    expect(stats.totalSold).toBe(0);
  });
});

describe('GET /seller/stats — listings', () => {
  test('counts this seller\'s offers, each pack size separately, and the live ones as active', async () => {
    const me = await createTestSeller();
    const rival = await createTestSeller();

    // One product in two pack sizes, both offered by me.
    const twoSizes = await createTestCatalogProduct(category.id, {
      name: `Stats Two Sizes ${Date.now()}`,
      variants: [
        { unit: 'packet', attributes: { packSize: '450g' }, isDefault: true, sku: 'S-450' },
        { unit: 'packet', attributes: { packSize: '1kg' }, sku: 'S-1K' },
      ],
    });
    const [small, large] = twoSizes.variants;
    await createTestListing(me.user.id, small.id);
    await createTestListing(me.user.id, large.id);
    await createTestListing(rival.user.id, small.id);                      // not mine
    await createTestListing(me.user.id, (await product()).variants[0].id, { status: 'INACTIVE' });
    await createTestListing(me.user.id, (await product()).variants[0].id, { stockQty: 0, status: 'OUT_OF_STOCK' });
    // A pre-split fused product row with my sellerId and no offer: not a listing.
    await createTestProduct(me.user.id, category.id);

    const stats = await statsOf(me);
    expect(stats.totalProducts).toBe(4);
    expect(stats.activeProducts).toBe(2);

    // Same figure as the My Products list the seller taps through to.
    const list = await request(app).get(`${API}/seller/products?limit=50`).set(me.headers);
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(stats.totalProducts);
    expect(list.body.data.filter((r) => r.isActive)).toHaveLength(stats.activeProducts);
  });
});

describe('GET /seller/orders — what the seller\'s order cards read', () => {
  test('a row carries this seller\'s own line status and unit, not the rollup another seller moved', async () => {
    const kendraA = await createTestSeller({ name: 'Cards Kendra A', district: 'Pune', taluka: 'Junnar' });
    const kendraB = await createTestSeller({ name: 'Cards Kendra B', district: 'Pune', taluka: 'Junnar' });
    const shopper = await createTestUser({ name: 'Cards Buyer', district: 'Pune' });
    const p = await createTestCatalogProduct(category.id, {
      name: `Cards Seed ${Date.now()}`,
      variants: [{ unit: 'bag', attributes: { packSize: '50kg' }, isDefault: true }],
    });
    const variantId = p.variants[0].id;
    const a = await createTestListing(kendraA.user.id, variantId, { sellingPrice: 100, stockQty: 20 });
    const b = await createTestListing(kendraB.user.id, variantId, { sellingPrice: 120, stockQty: 20 });
    await request(app).post(`${API}/cart`).set(shopper.headers).send({ listingId: a.id, quantity: 2 });
    await request(app).post(`${API}/cart`).set(shopper.headers).send({ listingId: b.id, quantity: 1 });
    const placed = await request(app).post(`${API}/orders`).set(shopper.headers).send({
      paymentMethod: 'cod',
      deliveryAddress: { name: 'Buyer', phone: '9999999999', flat: '1', street: 'Main', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    });
    expect(placed.status).toBe(201);
    const orderId = placed.body.data.id;

    // Kendra B ships their half; the order rolls up to SHIPPED.
    const shipped = await request(app).put(`${API}/seller/orders/${orderId}/status`)
      .set(kendraB.headers).send({ status: 'SHIPPED' });
    expect(shipped.status).toBe(200);
    expect(shipped.body.data.orderStatus).toBe('SHIPPED');

    const res = await request(app).get(`${API}/seller/orders`).set(kendraA.headers);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.order.id === orderId);
    expect(row.order.status).toBe('SHIPPED');   // the rollup — NOT Kendra A's state
    expect(row.status).toBe('PENDING');         // what A's card shows and acts on
    expect(row.unit).toBe('bag');
    expect(row.variant.unit).toBe('bag');

    // And the action the card offers for PENDING is one the server accepts:
    // A can still cancel their untouched line although the order reads SHIPPED.
    const cancel = await request(app).put(`${API}/seller/orders/${orderId}/status`)
      .set(kendraA.headers).send({ status: 'CANCELLED' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.itemsUpdated).toBe(1);
  });

  test('pages through one multi-line order without repeating or skipping a line', async () => {
    const me = await createTestSeller({ name: 'Paging Kendra' });
    const p = await product();
    const lines = [1, 2, 3, 4, 5, 6].map((n) => ({
      productId: p.id, sellerId: me.user.id, quantity: n, totalPrice: 100 * n,
    }));
    // ONE order, six lines: they all share the order's createdAt, which is the
    // only key this list sorted by.
    await order(lines);

    // The total order the route promises, resolved by the DB itself so the id
    // comparison uses the same collation the route's ORDER BY does.
    const expected = await prisma.orderItem.findMany({
      where: { sellerId: me.user.id },
      orderBy: [{ order: { createdAt: 'desc' } }, { id: 'desc' }],
      select: { id: true },
    });
    expect(expected).toHaveLength(6);

    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await request(app).get(`${API}/seller/orders?page=${page}&limit=2`).set(me.headers);
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(6);
      expect(res.body.data).toHaveLength(2);
      seen.push(...res.body.data.map((r) => r.id));
    }

    // Every line exactly once — no line repeated on two pages, none missing.
    expect(new Set(seen).size).toBe(6);
    // Which holds only because the sort is TOTAL. On the tied createdAt alone,
    // each page's query is free to order the six ties differently, and a line at
    // a page boundary then shows up twice or not at all.
    expect(seen).toEqual(expected.map((r) => r.id));
  });
});
