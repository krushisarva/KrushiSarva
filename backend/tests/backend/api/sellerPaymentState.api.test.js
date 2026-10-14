/**
 * GET /agristore/seller/orders — `order.payment` on each of the seller's rows.
 *
 * The amounts and the states themselves are pinned in
 * tests/backend/unit/sellerPayment.test.js. This checks the wiring: that the
 * route attaches the object, that it is worked out from the WHOLE order (the
 * other seller's lines included) while showing each seller only their own
 * figure, and that nothing else about the order's money rides along with it.
 *
 * Orders are inserted directly, as the review tests do: what is under test is
 * the read, not how such an order comes to exist.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData, prisma,
} from '../../fixtures/setup.js';
import { shopWebhookHandler } from '../../../src/services/shopPayment.service.js';

const API = '/api/v1/agristore';

let app; let category; let kendra; let rival; let buyer; let productA; let productB;

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory({ name: `Seller Payment Tools ${Date.now()}` });
  kendra = await createTestSeller({ name: 'Payment Kendra', district: 'Pune' });
  rival = await createTestSeller({ name: 'Payment Rival', district: 'Pune' });
  buyer = await createTestUser({ name: 'Paying Buyer', district: 'Pune' });
  productA = await createTestCatalogProduct(category.id, { name: `Payment Khurpi ${Date.now()}` });
  productB = await createTestCatalogProduct(category.id, { name: `Payment Sprayer ${Date.now()}` });
  await createTestListing(kendra.user.id, productA.variants[0].id, { stockQty: 50 });
  await createTestListing(rival.user.id, productB.variants[0].id, { stockQty: 50 });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

/**
 * An order with one line per `{ seller, product, price, status }`, ₹49 delivery
 * per seller, and the price breakdown frozen on it as checkout does.
 */
async function orderWith(lines, over = {}) {
  const sellers = [...new Set(lines.map((l) => l.seller.user.id))];
  const goods = lines.reduce((s, l) => s + l.price, 0);
  const delivery = 49 * sellers.length;
  return prisma.order.create({
    data: {
      userId: buyer.user.id,
      totalAmount: goods + delivery, subtotal: goods, deliveryFee: delivery,
      deliveryAddress: { name: 'Paying Buyer', phone: '9800000001', city: 'Pune', pincode: '413102' },
      paymentMethod: 'cod', paymentStatus: 'pending', status: 'PENDING',
      pricingSnapshot: {
        version: 1, codFee: '0.00',
        shipments: sellers.map((id) => ({
          sellerId: id,
          goodsSubtotal: lines.filter((l) => l.seller.user.id === id).reduce((s, l) => s + l.price, 0).toFixed(2),
          deliveryFee: '49.00',
        })),
      },
      ...over,
      items: {
        create: lines.map((l) => ({
          productId: l.product.id, sellerId: l.seller.user.id, quantity: 1,
          unitPrice: l.price, totalPrice: l.price, status: l.status || 'PENDING',
          ...(l.times || {}),
        })),
      },
    },
    include: { items: true },
  });
}

async function rowsFor(who, orderId) {
  const res = await request(app).get(`${API}/seller/orders?limit=50`).set(who.headers);
  expect(res.status).toBe(200);
  return res.body.data.filter((r) => r.order.id === orderId);
}

describe('GET /seller/orders — order.payment', () => {
  test('a cash order tells the seller how much to collect: goods plus the delivery charge', async () => {
    const order = await orderWith([{ seller: kendra, product: productA, price: 540 }]);

    const [row] = await rowsFor(kendra, order.id);

    expect(row.order.payment).toEqual({
      method: 'cod', status: 'TO_COLLECT', amountDue: '589.00', lines: 1, unpaidOnline: false,
      // What it comes to, and what that is made of: the card shows one line's
      // total (540) beside the amount to collect (589), and this is the gap.
      amount: '589.00', parts: [{ kind: 'items', amount: '540.00' }, { kind: 'delivery', amount: '49.00' }],
    });
    // The line's own amount is still just the line.
    expect(Number(row.totalPrice)).toBe(540);
  });

  test('an order paid online says so, and offers no amount to collect', async () => {
    const order = await orderWith(
      [{ seller: kendra, product: productA, price: 540 }],
      { paymentMethod: 'online', paymentStatus: 'paid', paymentRef: `pay_test_${Date.now()}` },
    );

    const [row] = await rowsFor(kendra, order.id);

    expect(row.order.payment).toEqual({
      // Nothing is DUE; what was paid for is given as information.
      method: 'online', status: 'PAID', amountDue: null, lines: 1, unpaidOnline: false,
      amount: '589.00', parts: [{ kind: 'items', amount: '540.00' }, { kind: 'delivery', amount: '49.00' }],
    });
  });

  test('two lines on one order carry the SAME single amount on both rows', async () => {
    const order = await orderWith([
      { seller: kendra, product: productA, price: 540 },
      { seller: kendra, product: productB, price: 200 },
    ]);

    const rows = await rowsFor(kendra, order.id);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.order.payment).toMatchObject({ status: 'TO_COLLECT', amountDue: '789.00', lines: 2 });
    }
  });

  test('two sellers each see their own share, and together it is the order total', async () => {
    const order = await orderWith([
      { seller: kendra, product: productA, price: 2190 },
      { seller: rival, product: productB, price: 899 },
    ]);

    const [mine] = await rowsFor(kendra, order.id);
    const [theirs] = await rowsFor(rival, order.id);

    expect(mine.order.payment.amountDue).toBe('2239.00');
    expect(theirs.order.payment.amountDue).toBe('948.00');
    expect(Number(mine.order.payment.amountDue) + Number(theirs.order.payment.amountDue))
      .toBe(Number(order.totalAmount));

    // Each seller is shown their own line only, and nothing that would let them
    // work out the other's: no order total, no price breakdown, no payment ref.
    expect(await rowsFor(kendra, order.id)).toHaveLength(1);
    for (const key of ['totalAmount', 'subtotal', 'deliveryFee', 'pricingSnapshot', 'paymentRef', 'items']) {
      expect(mine.order).not.toHaveProperty(key);
    }
    // No VALUE anywhere in the row is the rival's goods (899) or their share
    // (948). Compared value by value: a substring search over the JSON also
    // "finds" 948 inside an id or a timestamp.
    const leaves = (v) => (v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [v]);
    expect(leaves(mine).filter((v) => v !== null && v !== '' && [899, 948].includes(Number(v)))).toEqual([]);
  });

  test('a cancelled line is not collected for', async () => {
    const order = await orderWith([
      { seller: kendra, product: productA, price: 540 },
      { seller: kendra, product: productB, price: 200, status: 'CANCELLED' },
    ]);

    const rows = await rowsFor(kendra, order.id);

    expect(rows.find((r) => r.status === 'PENDING').order.payment)
      .toMatchObject({ status: 'TO_COLLECT', amountDue: '589.00', lines: 1 });
  });

  test('a cash order the seller cancelled has nothing to collect', async () => {
    const order = await orderWith([{ seller: kendra, product: productA, price: 540 }]);
    const cancel = await request(app).put(`${API}/seller/orders/${order.id}/status`)
      .set(kendra.headers).send({ status: 'CANCELLED' });
    expect(cancel.status).toBe(200);

    const [row] = await rowsFor(kendra, order.id);

    expect(row.status).toBe('CANCELLED');
    expect(row.order.payment).toMatchObject({ method: 'cod', status: 'NOTHING_DUE', amountDue: null, lines: 0 });
  });

  test('an "online" order that was never paid is still owed, and flagged', async () => {
    const order = await orderWith(
      [{ seller: kendra, product: productA, price: 540 }],
      { paymentMethod: 'upi', paymentStatus: 'pending' },
    );

    const [row] = await rowsFor(kendra, order.id);

    expect(row.order.payment).toMatchObject({ method: 'online', status: 'TO_COLLECT', amountDue: '589.00', unpaidOnline: true });
  });

  // The Razorpay refund webhook overwrites orders.paymentStatus for ANY refund on
  // the payment — 'refund_initiated', then 'refunded' — including the partial one
  // made when just one seller's lines are cancelled. The handler itself is run
  // here, so this reads exactly what production would have written.
  test('a refund for another seller\'s cancelled lines never sends this seller to collect', async () => {
    const paymentRef = `pay_test_refund_${Date.now()}`;
    const order = await orderWith(
      [
        { seller: kendra, product: productA, price: 2190, status: 'CONFIRMED' },
        { seller: rival, product: productB, price: 899, status: 'CANCELLED' },
      ],
      { paymentMethod: 'online', paymentStatus: 'refund_pending', paymentRef, status: 'CONFIRMED' },
    );
    const seen = async () => ({
      mine: (await rowsFor(kendra, order.id))[0].order.payment,
      theirs: (await rowsFor(rival, order.id))[0].order.payment,
    });
    const paid = {
      method: 'online', status: 'PAID', amountDue: null, lines: 1, unpaidOnline: false,
      amount: '2239.00', parts: [{ kind: 'items', amount: '2190.00' }, { kind: 'delivery', amount: '49.00' }],
    };
    const gone = { amountDue: null, amount: null, parts: null, lines: 0, unpaidOnline: false };

    expect(await seen()).toMatchObject({ mine: paid, theirs: { status: 'REFUND_PENDING', lines: 0 } });

    await shopWebhookHandler.refunded({ providerPaymentId: paymentRef, eventType: 'refund.created' });
    expect((await prisma.order.findUnique({ where: { id: order.id } })).paymentStatus).toBe('refund_initiated');
    // Still paid for — not "Not paid online. Collect ₹2,239".
    expect(await seen()).toEqual({
      mine: paid,
      theirs: { method: 'online', status: 'REFUND_PENDING', ...gone },
    });

    await shopWebhookHandler.refunded({ providerPaymentId: paymentRef, eventType: 'refund.processed' });
    expect((await prisma.order.findUnique({ where: { id: order.id } })).paymentStatus).toBe('refunded');
    // The order now reads 'refunded', but it is the rival's part that went back.
    expect(await seen()).toEqual({
      mine: paid,
      theirs: { method: 'online', status: 'REFUNDED', ...gone },
    });
  });

  test('the cash-on-delivery fee does not land on a seller after they have delivered', async () => {
    // Quoted first: kendra. The rival delivered (and was paid ₹948) while kendra's
    // part was still to come; kendra cancelled afterwards.
    const withFee = (lines) => orderWith(lines, {
      totalAmount: 2190 + 899 + 98 + 10,
      pricingSnapshot: {
        version: 1, codFee: '10.00',
        shipments: [
          { sellerId: kendra.user.id, goodsSubtotal: '2190.00', deliveryFee: '49.00' },
          { sellerId: rival.user.id, goodsSubtotal: '899.00', deliveryFee: '49.00' },
        ],
      },
    });
    const at = (hour) => new Date(Date.UTC(2026, 9, 12, hour));

    const late = await withFee([
      { seller: kendra, product: productA, price: 2190, status: 'CANCELLED', times: { cancelledAt: at(14) } },
      { seller: rival, product: productB, price: 899, status: 'DELIVERED', times: { deliveredAt: at(10) } },
    ]);
    expect((await rowsFor(rival, late.id))[0].order.payment).toMatchObject({ status: 'TO_COLLECT', amountDue: '948.00' });

    // Cancelled BEFORE the rival delivered: the rival was told ₹958 at the door.
    const early = await withFee([
      { seller: kendra, product: productA, price: 2190, status: 'CANCELLED', times: { cancelledAt: at(8) } },
      { seller: rival, product: productB, price: 899, status: 'DELIVERED', times: { deliveredAt: at(10) } },
    ]);
    expect((await rowsFor(rival, early.id))[0].order.payment).toMatchObject({ status: 'TO_COLLECT', amountDue: '958.00' });
  });

  test('working it out writes nothing: the phase-5 cash columns stay empty', async () => {
    const order = await orderWith([{ seller: kendra, product: productA, price: 540 }]);
    await rowsFor(kendra, order.id);

    const deliveries = await prisma.orderDelivery.findMany({ where: { orderId: order.id } });
    expect(deliveries.every((d) => d.codAmountDue === null && d.codCollectedAmount === null)).toBe(true);
    expect((await prisma.order.findUnique({ where: { id: order.id } })).paymentStatus).toBe('pending');
  });
});
