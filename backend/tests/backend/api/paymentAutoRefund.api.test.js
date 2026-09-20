/**
 * A captured payment that cannot become an order is refunded automatically —
 * exactly once — instead of "our team will contact you" with nothing behind it.
 *
 * The payment service is replaced before the app loads: refunds are counted, the
 * gateway is never reached, and the reconciler runs (it is a no-op in mock mode).
 */
import { jest } from '@jest/globals';

let seq = 0;
const processRefund = jest.fn(async (paymentId, amount) => ({
  id: `rfnd_test_${++seq}`, payment_id: paymentId, amount, status: 'processed',
}));
const fetchPayment = jest.fn(async (id) => ({ id, status: 'captured' }));
jest.unstable_mockModule('../../../src/services/payment.service.js', () => ({
  createPaymentOrder: jest.fn(async (amount, currency, receipt) => ({
    id: `order_test_${Date.now()}_${++seq}`, amount, currency, receipt, status: 'created', mock: true,
  })),
  fetchPaymentOrder: jest.fn(async (id) => ({ id, mock: true })),
  verifyPaymentSignature: jest.fn(() => true),
  verifyWebhookSignature: jest.fn(() => true),
  fetchPayment,
  fetchOrderPayments: jest.fn(async () => []),
  isMockPayments: () => false,
  processRefund,
}));

const { default: request } = await import('supertest');
const {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData, prisma,
} = await import('../../fixtures/setup.js');
const { reconcilePendingPayments } = await import('../../../src/services/shopPayment.service.js');

const API = '/api/v1/agristore';
const address = {
  type: 'HOME', name: 'Refund Buyer', phone: '9876543210',
  flat: '1A', street: 'Main', city: 'Pune', state: 'Maharashtra', pincode: '411001',
};

let app; let kendra; let category; let admin;

beforeAll(async () => {
  app = await getApp();
  kendra = await createTestSeller({ name: 'AutoRefund Kendra', district: 'Pune' });
  category = await createTestCategory({ name: `AutoRefund ${Date.now()}` });
  admin = await createTestUser({ role: 'ADMIN', name: 'AutoRefund Admin' });
}, 60_000);

beforeEach(async () => {
  processRefund.mockClear();
  await prisma.paymentIntent.deleteMany();
});

afterAll(async () => { await cleanupTestData(); });

/** A buyer part-way through paying: cart filled, /orders/initiate done. */
async function paying({ quantity = 2, price = 200 } = {}) {
  const buyer = await createTestUser({ district: 'Pune' });
  const product = await createTestCatalogProduct(category.id, { name: `AutoRefund Seed ${Date.now()}-${Math.random()}` });
  const listing = await createTestListing(kendra.user.id, product.variants[0].id, { sellingPrice: price, stockQty: 10 });
  await prisma.cartItem.create({
    data: { userId: buyer.user.id, listingId: listing.id, productId: product.id, quantity, unitPriceSnapshot: price },
  });
  const init = await request(app).post(`${API}/orders/initiate`).set(buyer.headers)
    .send({ paymentMethod: 'upi', deliveryAddress: address });
  expect(init.status).toBe(200);
  return { buyer, listing, providerOrderId: init.body.data.razorpayOrderId, paymentId: `pay_${Date.now()}_${++seq}` };
}

const confirm = ({ buyer, providerOrderId, paymentId }) => request(app).post(`${API}/orders/confirm`).set(buyer.headers).send({
  razorpayOrderId: providerOrderId, razorpayPaymentId: paymentId,
  razorpaySignature: 'a'.repeat(64), deliveryAddress: address,
});

const intentOf = (providerOrderId) => prisma.paymentIntent.findUnique({ where: { providerOrderId } });

describe('/orders/confirm when the payment cannot become an order', () => {
  test('a price change mid-payment → the captured amount is refunded, once', async () => {
    const p = await paying({ quantity: 2, price: 200 });
    const intent = await intentOf(p.providerOrderId);
    // Past the seller-side guard (e.g. the edit landed between quote and hold).
    await prisma.sellerListing.update({ where: { id: p.listing.id }, data: { sellingPrice: 250 } });

    const res = await confirm(p);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/We have refunded ₹\d+\.\d{2}/);
    expect(res.body.error.details).toMatchObject({ paymentCaptured: true, refundStarted: true });
    expect(processRefund).toHaveBeenCalledTimes(1);
    expect(processRefund).toHaveBeenCalledWith(p.paymentId, intent.amountPaise);

    const after = await intentOf(p.providerOrderId);
    expect(after.status).toBe('REFUNDED');
    expect(after.providerPaymentId).toBe(p.paymentId);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'PAYMENT_REFUND', entityId: intent.id } });
    expect(audit).not.toBeNull();
    // The hold went back on the shelf.
    expect((await prisma.sellerListing.findUnique({ where: { id: p.listing.id } })).stockQty).toBe(10);

    // A retried confirm, then a late payment.captured webhook: no second refund,
    // and the refunded intent is not dragged back to PAID.
    const retry = await confirm(p);
    expect(retry.status).toBe(409);
    expect(retry.body.error.message).toMatch(/We have refunded/);
    const hook = await request(app).post('/api/v1/shop-webhooks/razorpay')
      .set('Content-Type', 'application/json').set('X-Razorpay-Signature', 'b'.repeat(64))
      .send(JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: p.paymentId, order_id: p.providerOrderId, amount: intent.amountPaise, status: 'captured' } } },
      }));
    expect(hook.status).toBe(200);
    expect((await intentOf(p.providerOrderId)).status).toBe('REFUNDED');
    expect(await reconcilePendingPayments({ olderThanMinutes: 0 })).toMatchObject({ refunded: 0 });
    expect(processRefund).toHaveBeenCalledTimes(1);
    expect(await prisma.order.count({ where: { paymentRef: p.paymentId } })).toBe(0);
  });

  test('a cart changed while paying (fingerprint mismatch) → refunded', async () => {
    const p = await paying({ quantity: 2 });
    await prisma.cartItem.updateMany({ where: { userId: p.buyer.user.id }, data: { quantity: 1 } });

    const res = await confirm(p);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ code: 'CART_CHANGED', refundStarted: true });
    expect(processRefund).toHaveBeenCalledTimes(1);
    expect((await intentOf(p.providerOrderId)).status).toBe('REFUNDED');
  });

  test('a failed gateway refund is marked for an admin, and the payment can no longer become an order', async () => {
    const p = await paying({ quantity: 1, price: 300 });
    await prisma.sellerListing.update({ where: { id: p.listing.id }, data: { sellingPrice: 310 } });
    processRefund.mockRejectedValueOnce(new Error('gateway down'));

    const res = await confirm(p);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Our team will contact you about a refund/);
    expect(res.body.error.details.refundStarted).toBe(false);

    const intent = await intentOf(p.providerOrderId);
    expect(intent.status).toBe('REFUND_INITIATED');
    expect(intent.failureReason).toMatch(/^AUTO-REFUND FAILED: gateway down/);
    expect(await prisma.auditLog.findFirst({ where: { action: 'PAYMENT_REFUND_FAILED', entityId: intent.id } })).not.toBeNull();

    // It sits in the admin queue of paid-with-no-order intents.
    const queue = await request(app).get('/api/v1/admin/payment-intents?orphaned=true').set(admin.headers);
    expect(queue.status).toBe(200);
    expect(queue.body.data.items.map((i) => i.id)).toContain(intent.id);

    // The refund may have gone through despite the error, so the same payment
    // must not also buy the goods — even once the cart is checkoutable again.
    await prisma.sellerListing.update({ where: { id: p.listing.id }, data: { sellingPrice: 300 } });
    const again = await confirm(p);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already been refunded/);
    expect(await prisma.order.count({ where: { paymentRef: p.paymentId } })).toBe(0);
    expect(processRefund).toHaveBeenCalledTimes(1);
    expect((await prisma.sellerListing.findUnique({ where: { id: p.listing.id } })).stockQty).toBe(10);
  });

  test('a normal confirm still creates the order and binds the intent', async () => {
    const p = await paying({ quantity: 1 });
    const res = await confirm(p);
    expect(res.status).toBe(201);
    const intent = await intentOf(p.providerOrderId);
    expect(intent).toMatchObject({ status: 'ORDER_CREATED', orderId: res.body.data.id, providerPaymentId: p.paymentId });
    expect(processRefund).not.toHaveBeenCalled();
  });
});

describe('the reconciler', () => {
  async function orphan(minutesAgo) {
    const buyer = await createTestUser();
    const providerOrderId = `order_orphan_${Date.now()}_${++seq}`;
    await prisma.paymentIntent.create({
      data: {
        userId: buyer.user.id, providerOrderId, providerPaymentId: `pay_orphan_${Date.now()}_${seq}`,
        amount: '449.00', amountPaise: 44900, receipt: `r_${seq}`, status: 'PAID',
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      },
    });
    return providerOrderId;
  }

  test('refunds a captured payment still without an order after the payment window, once', async () => {
    const old = await orphan(45);
    const young = await orphan(15);

    const first = await reconcilePendingPayments({ olderThanMinutes: 10 });
    expect(first).toMatchObject({ refunded: 1, orphanedPaid: 1 });
    expect(processRefund).toHaveBeenCalledTimes(1);
    expect(processRefund).toHaveBeenCalledWith(expect.stringMatching(/^pay_orphan_/), 44900);
    expect((await intentOf(old)).status).toBe('REFUNDED');
    // Too young: the buyer may still be confirming. Left PAID and flagged.
    expect((await intentOf(young)).status).toBe('PAID');

    const second = await reconcilePendingPayments({ olderThanMinutes: 10 });
    expect(second.refunded).toBe(0);
    expect(processRefund).toHaveBeenCalledTimes(1);
  });
});
