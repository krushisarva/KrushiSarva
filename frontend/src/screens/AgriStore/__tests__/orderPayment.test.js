/**
 * The words beside an order's total (shopUtils.orderPaymentLabel).
 *
 * My Orders used to print "Paid" above every total — including a cash order
 * that had not been paid for. Whatever is printed beside money has to be true
 * for every kind of order, so the rule is pinned here.
 */
import { orderPaymentLabel } from '../shopUtils';

describe('cash on delivery', () => {
  test('says the METHOD, never "paid" — true before the goods arrive and after', () => {
    for (const status of ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']) {
      const label = orderPaymentLabel({ status, paymentMethod: 'cod', paymentStatus: 'pending' });
      expect(label).toEqual({ key: 'checkout.cod', fallback: 'Cash on Delivery' });
    }
  });

  test('however the method is cased or padded', () => {
    expect(orderPaymentLabel({ paymentMethod: ' COD ' }).key).toBe('checkout.cod');
  });
});

describe('paid through the gateway', () => {
  test('"Paid online" once the money has actually moved', () => {
    expect(orderPaymentLabel({ paymentMethod: 'upi', paymentStatus: 'paid' }))
      .toEqual({ key: 'orders.paidOnline', fallback: 'Paid online' });
    expect(orderPaymentLabel({ paymentMethod: 'card', paymentStatus: 'paid' }).key).toBe('orders.paidOnline');
  });

  test('still "Paid online" while a refund is on its way or done — it WAS paid; the refund line says the rest', () => {
    for (const paymentStatus of ['refund_pending', 'partially_refunded', 'refunded']) {
      expect(orderPaymentLabel({ paymentMethod: 'upi', paymentStatus }).key).toBe('orders.paidOnline');
    }
  });

  test('says nothing when the money has not been confirmed — never a guess about money', () => {
    expect(orderPaymentLabel({ paymentMethod: 'upi', paymentStatus: 'pending' })).toBeNull();
    expect(orderPaymentLabel({ paymentMethod: 'upi', paymentStatus: 'failed' })).toBeNull();
    expect(orderPaymentLabel({ paymentMethod: 'upi' })).toBeNull();
  });
});

describe('an order that does not say how it is paid', () => {
  test('nothing is printed', () => {
    expect(orderPaymentLabel({ paymentStatus: 'paid' })).toBeNull();
    expect(orderPaymentLabel({ paymentMethod: '' })).toBeNull();
    expect(orderPaymentLabel({ paymentMethod: 42 })).toBeNull();
    expect(orderPaymentLabel(null)).toBeNull();
    expect(orderPaymentLabel(undefined)).toBeNull();
  });
});
