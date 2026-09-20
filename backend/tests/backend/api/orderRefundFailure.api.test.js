/**
 * A refund the gateway rejects must not lose track of the money: the cancel
 * still succeeds, and the order stays 'refund_pending' — the queue an admin
 * works from. The payment service is replaced before the app loads, so the
 * failing refund never touches the network.
 */
import { jest } from '@jest/globals';

const processRefund = jest.fn(async () => { throw new Error('gateway down'); });
jest.unstable_mockModule('../../../src/services/payment.service.js', () => ({
  createPaymentOrder: jest.fn(),
  fetchPaymentOrder: jest.fn(),
  verifyPaymentSignature: jest.fn(() => true),
  verifyWebhookSignature: jest.fn(() => true),
  fetchPayment: jest.fn(),
  fetchOrderPayments: jest.fn(async () => []),
  isMockPayments: () => true,
  processRefund,
}));

const { default: request } = await import('supertest');
const {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData, prisma,
} = await import('../../fixtures/setup.js');

const API = '/api/v1/agristore';
let app, category, kendra, buyer;

beforeAll(async () => {
  app = await getApp();
  category = await createTestCategory({ name: `RefundFail ${Date.now()}` });
  kendra = await createTestSeller({ name: 'RefundFail Kendra', district: 'Pune', taluka: 'Junnar' });
  buyer  = await createTestUser({ name: 'RefundFail Buyer', district: 'Pune' });
}, 60_000);

afterAll(async () => {
  await cleanupTestData();
});

test('a gateway failure leaves the order refund_pending, and the cancel still succeeds', async () => {
  const product = await createTestCatalogProduct(category.id, { name: `RefundFail Seed ${Date.now()}` });
  const listing = await createTestListing(kendra.user.id, product.variants[0].id, { sellingPrice: 100, stockQty: 10, district: 'Pune' });
  await prisma.cartItem.deleteMany({ where: { userId: buyer.user.id } });
  await request(app).post(`${API}/cart`).set(buyer.headers).send({ listingId: listing.id, quantity: 2 });
  const created = await request(app).post(`${API}/orders`).set(buyer.headers).send({
    paymentMethod: 'cod',
    deliveryAddress: { name: 'Buyer', phone: '9999999999', flat: '1', street: 'Main', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  });
  expect(created.status).toBe(201);
  const orderId = created.body.data.id;
  await prisma.order.update({
    where: { id: orderId },
    data: { paymentMethod: 'upi', paymentStatus: 'paid', paymentRef: `pay_fail_${Date.now()}` },
  });

  const res = await request(app).put(`${API}/orders/${orderId}/cancel`).set(buyer.headers);
  expect(res.status).toBe(200);
  expect(res.body.data.paymentStatus).toBe('refund_pending');
  expect(processRefund).toHaveBeenCalledTimes(1);

  const row = await prisma.order.findUnique({ where: { id: orderId } });
  expect(row.status).toBe('CANCELLED');
  expect(row.paymentStatus).toBe('refund_pending');
  // Stock still came back: the refund failing does not undo the cancel.
  expect((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty).toBe(10);
});
