/**
 * Automatic refunds when lines of an order paid online are cancelled.
 *
 * processRefund() used to have no callers: a seller (or buyer) cancelling a
 * Razorpay-paid order left it CANCELLED with paymentStatus 'paid' and no record
 * that money was owed. Razorpay runs in mock mode here (no keys), so nothing
 * leaves a real account.
 */
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing,
  cleanupTestData, prisma,
} from '../../fixtures/setup.js';
import { ENV } from '../../../src/config/env.js';
import { refundAmountFor } from '../../../src/services/orderRefund.service.js';

const API = '/api/v1/agristore';

let app;
let category;
let kendraA, kendraB, buyer;

beforeAll(async () => {
  // Never let this suite reach the real gateway, whatever the local .env says.
  ENV.RAZORPAY_KEY_ID = '';
  ENV.RAZORPAY_KEY_SECRET = '';

  app = await getApp();
  category = await createTestCategory({ name: `Refund ${Date.now()}` });
  kendraA = await createTestSeller({ name: 'Refund Kendra A', district: 'Pune', taluka: 'Junnar' });
  kendraB = await createTestSeller({ name: 'Refund Kendra B', district: 'Pune', taluka: 'Junnar' });
  buyer   = await createTestUser({ name: 'Refund Buyer', district: 'Pune' });
}, 60_000);

afterAll(async () => {
  await cleanupTestData();
});

/**
 * A two-seller order, then turned into an online-paid one the way
 * /orders/confirm leaves it (paymentMethod + paymentStatus 'paid' + paymentRef).
 */
async function paidTwoSellerOrder({ paid = true } = {}) {
  const product = await createTestCatalogProduct(category.id, { name: `Refund Seed ${Date.now()}-${Math.random()}` });
  const variantId = product.variants[0].id;
  const a = await createTestListing(kendraA.user.id, variantId, { sellingPrice: 100, stockQty: 20, district: 'Pune' });
  const b = await createTestListing(kendraB.user.id, variantId, { sellingPrice: 120, stockQty: 20, district: 'Pune' });
  await prisma.cartItem.deleteMany({ where: { userId: buyer.user.id } });
  await request(app).post(`${API}/cart`).set(buyer.headers).send({ listingId: a.id, quantity: 2 });
  await request(app).post(`${API}/cart`).set(buyer.headers).send({ listingId: b.id, quantity: 1 });
  const res = await request(app).post(`${API}/orders`).set(buyer.headers).send({
    paymentMethod: 'cod',
    deliveryAddress: { name: 'Buyer', phone: '9999999999', flat: '1', street: 'Main', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  });
  expect(res.status).toBe(201);
  const orderId = res.body.data.id;
  if (paid) {
    await prisma.order.update({
      where: { id: orderId },
      data: { paymentMethod: 'upi', paymentStatus: 'paid', paymentRef: `pay_test_${Date.now()}_${Math.round(Math.random() * 1e6)}` },
    });
  }
  return orderId;
}

const orderRow = (id) => prisma.order.findUnique({ where: { id } });
const setStatus = (kendra, orderId, status) => request(app)
  .put(`${API}/seller/orders/${orderId}/status`).set(kendra.headers).send({ status });

describe('refundAmountFor', () => {
  const order = (over = {}) => ({
    totalAmount: '449.00', subtotal: '400.00', deliveryFee: '49.00', taxAmount: '0.00', discountAmount: '0.00', ...over,
  });
  const line = (id, status, totalPrice, taxAmount = '0.00') => ({ id, status, totalPrice, taxAmount });

  test('a partial cancel refunds that line only; the delivery fee stays', () => {
    const items = [line('a', 'PENDING', '200.00'), line('b', 'PENDING', '200.00')];
    const r = refundAmountFor(order(), items, ['a']);
    expect(r.amount.toFixed(2)).toBe('200.00');
    expect(r.fullyCancelled).toBe(false);
  });

  test('the cancel that leaves nothing live refunds the rest, delivery fee included', () => {
    const items = [line('a', 'CANCELLED', '200.00'), line('b', 'PENDING', '200.00')];
    const r = refundAmountFor(order(), items, ['b']);
    expect(r.amount.toFixed(2)).toBe('249.00');
    expect(r.fullyCancelled).toBe(true);
  });

  test('tax added on top of the price is refunded with its line', () => {
    const o = order({ totalAmount: '485.00', taxAmount: '36.00' });   // 400 + 49 + 36
    const items = [line('a', 'PENDING', '200.00', '18.00'), line('b', 'PENDING', '200.00', '18.00')];
    expect(refundAmountFor(o, items, ['a']).amount.toFixed(2)).toBe('218.00');
  });

  test('tax already inside the price is not added again', () => {
    const o = order({ taxAmount: '36.00' });   // total 449 = 400 + 49: tax inside prices
    const items = [line('a', 'PENDING', '200.00', '18.00'), line('b', 'PENDING', '200.00', '18.00')];
    expect(refundAmountFor(o, items, ['a']).amount.toFixed(2)).toBe('200.00');
  });

  test('never refunds past what was paid', () => {
    const items = [line('a', 'CANCELLED', '449.00'), line('b', 'PENDING', '200.00')];
    expect(refundAmountFor(order(), items, ['b']).amount.toFixed(2)).toBe('0.00');
  });
});

describe('cancelling a paid order refunds the buyer', () => {
  test('seller cancels their half → partially_refunded; buyer cancels the rest → refunded', async () => {
    const orderId = await paidTwoSellerOrder();

    const sellerCancel = await setStatus(kendraA, orderId, 'CANCELLED');
    expect(sellerCancel.status).toBe(200);
    expect((await orderRow(orderId)).paymentStatus).toBe('partially_refunded');

    const buyerCancel = await request(app).put(`${API}/orders/${orderId}/cancel`).set(buyer.headers);
    expect(buyerCancel.status).toBe(200);
    expect(buyerCancel.body.data.refundAmount).toBeDefined();
    expect((await orderRow(orderId)).paymentStatus).toBe('refunded');
  });

  test('the refunds add up to exactly what was paid', async () => {
    const orderId = await paidTwoSellerOrder();
    const paid = Number((await orderRow(orderId)).totalAmount);

    const logs = [];
    await setStatus(kendraA, orderId, 'CANCELLED');
    const rest = await request(app).put(`${API}/orders/${orderId}/cancel`).set(buyer.headers);
    logs.push(Number(rest.body.data.refundAmount));

    const aLines = await prisma.orderItem.findMany({ where: { orderId, sellerId: kendraA.user.id } });
    const firstRefund = aLines.reduce((s, i) => s + Number(i.totalPrice), 0);
    expect(firstRefund + logs[0]).toBeCloseTo(paid, 2);
  });

  test('a repeated seller cancel does not refund twice', async () => {
    const orderId = await paidTwoSellerOrder();
    await setStatus(kendraA, orderId, 'CANCELLED');
    const again = await setStatus(kendraA, orderId, 'CANCELLED');
    expect(again.status).toBe(200);
    expect(again.body.data.unchanged).toBe(true);
    expect((await orderRow(orderId)).paymentStatus).toBe('partially_refunded');
  });

  test('a cash-on-delivery order is not refunded', async () => {
    const orderId = await paidTwoSellerOrder({ paid: false });
    await request(app).put(`${API}/orders/${orderId}/cancel`).set(buyer.headers);
    const row = await orderRow(orderId);
    expect(row.status).toBe('CANCELLED');
    expect(row.paymentStatus).toBe('pending');
  });
});
