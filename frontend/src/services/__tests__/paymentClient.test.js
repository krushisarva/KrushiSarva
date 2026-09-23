/**
 * The payment client is the only place three different paid flows agree on what
 * goes on the wire, so these tests pin the four things that would cost real
 * money if they drifted:
 *
 *   1. the `{ success, data }` envelope is unwrapped — a screen that reads the
 *      wrapper instead of the payload opens a checkout with no order id;
 *   2. the abort signal reaches axios — without it a screen that unmounts
 *      mid-request leaks the request and then writes state into a dead tree;
 *   3. a credit purchase sends `{ packId }` and NOTHING else — a body that can
 *      carry an amount is a body someone will set to ₹1 for the ₹500 pack
 *      (CLAUDE.md §51: the client is never trusted for money);
 *   4. a non-2xx is CLASSIFIED, not thrown raw — the shop learned this the hard
 *      way: a bare catch turns "your session expired" and "you have no signal"
 *      into the same useless sentence.
 */
import { jest } from '@jest/globals';

jest.mock('@krushisarva/shared/services/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

const api = require('@krushisarva/shared/services/api').default;
const {
  fetchPaymentConfig,
  initiateRentBooking,
  confirmRentBooking,
  fetchRentPaymentStatus,
  fetchCreditPacks,
  initiateCreditPurchase,
  confirmCreditPurchase,
  fetchCreditPurchaseStatus,
  classifyError,
  PAYMENT_ERRORS,
} = require('../paymentClient');

/** The standard success envelope every route answers with. */
const envelope = (data) => ({ data: { success: true, data } });

/** Stands in for an AbortSignal — identity is all these tests check. */
const signal = { aborted: false };

/** An axios error as the shared API client's interceptor leaves it. */
function httpError(status, body) {
  const err = new Error(`HTTP ${status}`);
  err.response = { status, data: body };
  err.userMessage = 'Something went wrong. Please try again.';
  return err;
}

beforeEach(() => jest.clearAllMocks());

// ── 1. The envelope ───────────────────────────────────────────────────────────
describe('the { success, data } envelope is unwrapped', () => {
  test('rent initiate returns the payload, not the wrapper', async () => {
    api.post.mockResolvedValue(envelope({
      razorpayOrderId: 'order_R1', amount: 1200, amountInPaise: 120000,
      currency: 'INR', receipt: 'rcpt_1', mock: false, quote: { days: 2 },
    }));

    const out = await initiateRentBooking({
      listingId: 'L1', type: 'machinery', startDate: '2026-10-01', endDate: '2026-10-02',
    });

    expect(out.razorpayOrderId).toBe('order_R1');
    expect(out.amountInPaise).toBe(120000);
    // purposeExtra passes through untouched — the rent screen shows the quote.
    expect(out.quote).toEqual({ days: 2 });
    expect(out.success).toBeUndefined();
  });

  test('rent confirm returns { booking, paymentStatus }', async () => {
    api.post.mockResolvedValue(envelope({ booking: { id: 'B1' }, paymentStatus: 'PAID' }));
    const out = await confirmRentBooking({
      razorpayOrderId: 'order_R1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig',
    });
    expect(out).toEqual({ booking: { id: 'B1' }, paymentStatus: 'PAID' });
  });

  test('credit confirm returns { credited, balance, alreadyProcessed }', async () => {
    api.post.mockResolvedValue(envelope({ credited: 100, balance: 340, alreadyProcessed: false }));
    const out = await confirmCreditPurchase({
      razorpayOrderId: 'order_C1', razorpayPaymentId: 'pay_2', razorpaySignature: 'sig',
    });
    expect(out).toEqual({ credited: 100, balance: 340, alreadyProcessed: false });
  });

  test('a status read returns { status, paid, amount }', async () => {
    api.get.mockResolvedValue(envelope({ status: 'PAID', paid: true, amount: 1200 }));
    await expect(fetchRentPaymentStatus('order_R1')).resolves.toEqual({
      status: 'PAID', paid: true, amount: 1200,
    });
  });

  test('an empty envelope becomes null, never undefined-dot-something', async () => {
    api.post.mockResolvedValue({ data: { success: true } });
    await expect(initiateCreditPurchase({ packId: 'p1' })).resolves.toBeNull();
  });

  test('packs normalise to an array from either shape', async () => {
    api.get.mockResolvedValueOnce(envelope([{ id: 'p1' }]));
    await expect(fetchCreditPacks()).resolves.toEqual([{ id: 'p1' }]);

    api.get.mockResolvedValueOnce(envelope({ packs: [{ id: 'p2' }] }));
    await expect(fetchCreditPacks()).resolves.toEqual([{ id: 'p2' }]);

    // An unexpected body renders "no packs"; it must not crash a .map().
    api.get.mockResolvedValueOnce(envelope(null));
    await expect(fetchCreditPacks()).resolves.toEqual([]);
  });
});

// ── 2. Cancellation ───────────────────────────────────────────────────────────
describe('the abort signal is passed through', () => {
  test.each([
    ['rent payment status', () => fetchRentPaymentStatus('order_R1', signal)],
    ['credit purchase status', () => fetchCreditPurchaseStatus('order_C1', signal)],
    ['credit packs', () => fetchCreditPacks(signal)],
  ])('%s forwards it to axios', async (_name, call) => {
    api.get.mockResolvedValue(envelope({}));
    await call();
    expect(api.get).toHaveBeenCalledWith(expect.any(String), { signal });
  });

  test('payment config forwards it too', async () => {
    api.get.mockResolvedValue(envelope({ onlineEnabled: true, keyId: 'rzp_test', methods: ['upi'] }));
    await fetchPaymentConfig(signal);
    expect(api.get).toHaveBeenCalledWith('/payments/config', { signal });
  });

  test('a provider order id is URL-encoded into the path', async () => {
    api.get.mockResolvedValue(envelope({}));
    await fetchRentPaymentStatus('order/../../admin');
    expect(api.get.mock.calls[0][0]).toBe(
      '/rent/bookings/payment-status/order%2F..%2F..%2Fadmin',
    );
  });
});

// ── 3. No client-supplied amount ──────────────────────────────────────────────
describe('a price never leaves the client', () => {
  test('credit purchase sends { packId } and nothing else', async () => {
    api.post.mockResolvedValue(envelope({ razorpayOrderId: 'order_C1' }));

    // A caller that tries to help itself to a price — the whole point of
    // destructuring rather than spreading.
    await initiateCreditPurchase({
      packId: 'pack_500',
      amount: 1,
      amountInPaise: 100,
      price: 1,
      currency: 'INR',
    });

    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe('/ai/credits/purchase/initiate');
    expect(body).toEqual({ packId: 'pack_500' });
    expect(Object.keys(body)).toEqual(['packId']);
  });

  test('rent initiate sends only what is being booked, never what it costs', async () => {
    api.post.mockResolvedValue(envelope({ razorpayOrderId: 'order_R1' }));

    await initiateRentBooking({
      listingId: 'L1',
      type: 'labour',
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      workerCount: 4,
      totalAmount: 1,        // ← must not reach the wire
      pricePerDay: 1,
    });

    const body = api.post.mock.calls[0][1];
    expect(body).toEqual({
      listingId: 'L1', type: 'labour',
      startDate: '2026-10-01', endDate: '2026-10-03',
      workerCount: 4,
    });
    expect(Object.keys(body)).not.toContain('totalAmount');
    expect(Object.keys(body)).not.toContain('pricePerDay');
  });

  test('an absent optional field is omitted, not sent as undefined', async () => {
    api.post.mockResolvedValue(envelope({ razorpayOrderId: 'order_R1' }));
    await initiateRentBooking({
      listingId: 'L1', type: 'machinery', startDate: '2026-10-01', endDate: '2026-10-02',
    });
    const body = api.post.mock.calls[0][1];
    expect('hours' in body).toBe(false);
    expect('workerCount' in body).toBe(false);
  });

  test('confirm sends exactly the three gateway fields', async () => {
    api.post.mockResolvedValue(envelope({ booking: {}, paymentStatus: 'PAID' }));
    await confirmRentBooking({
      razorpayOrderId: 'order_R1',
      razorpayPaymentId: 'pay_1',
      razorpaySignature: 'sig',
      expectedTotal: 1,
    });
    expect(api.post.mock.calls[0][1]).toEqual({
      razorpayOrderId: 'order_R1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig',
    });
  });
});

// ── 4. Errors are classified ──────────────────────────────────────────────────
describe('a non-2xx is classified rather than thrown raw', () => {
  test('a 409 on confirm classifies as CONFLICT with the refund detail intact', async () => {
    const err = httpError(409, {
      success: false,
      error: { message: 'Slot taken', details: { refunded: true }, requestId: 'req_9' },
    });
    api.post.mockRejectedValue(err);

    const raised = await confirmRentBooking({
      razorpayOrderId: 'order_R1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig',
    }).catch((e) => e);

    const info = classifyError(raised);
    expect(info.code).toBe(PAYMENT_ERRORS.CONFLICT);
    // The sanitised message is what reaches the farmer — never the raw body.
    expect(info.message).toBe('Something went wrong. Please try again.');
    expect(info.requestId).toBe('req_9');
    expect(info.status).toBe(409);
  });

  test('an expired session classifies as AUTH, not as a failed payment', async () => {
    api.post.mockRejectedValue(httpError(401, {}));
    const raised = await initiateCreditPurchase({ packId: 'p1' }).catch((e) => e);
    expect(classifyError(raised).code).toBe(PAYMENT_ERRORS.AUTH);
  });

  test('no signal classifies as OFFLINE, which is a different next step', async () => {
    const offline = new Error('Network Error');
    api.get.mockRejectedValue(offline);
    const raised = await fetchRentPaymentStatus('order_R1').catch((e) => e);
    expect(classifyError(raised).code).toBe(PAYMENT_ERRORS.OFFLINE);
  });

  test('a cancelled request classifies as null — not an error to render', async () => {
    const cancelled = new Error('canceled');
    cancelled.code = 'ERR_CANCELED';
    api.get.mockRejectedValue(cancelled);
    const raised = await fetchCreditPurchaseStatus('order_C1').catch((e) => e);
    expect(classifyError(raised)).toBeNull();
  });
});

// ── Config fails closed ───────────────────────────────────────────────────────
describe('payment config fails closed', () => {
  test('a reachable server is believed', async () => {
    api.get.mockResolvedValue(envelope({
      onlineEnabled: true, keyId: 'rzp_test_1', methods: ['upi', 'card'], currency: 'INR',
    }));
    const cfg = await fetchPaymentConfig();
    expect(cfg).toEqual(expect.objectContaining({
      onlineEnabled: true, keyId: 'rzp_test_1', methods: ['upi', 'card'], currency: 'INR',
    }));
  });

  test('an error resolves to payment OFF rather than rejecting', async () => {
    api.get.mockRejectedValue(httpError(500, {}));
    await expect(fetchPaymentConfig()).resolves.toEqual({
      onlineEnabled: false, keyId: null, methods: [],
    });
  });

  test('a truthy-but-not-true flag is not treated as enabled', async () => {
    api.get.mockResolvedValue(envelope({ onlineEnabled: 'yes', keyId: '', methods: null }));
    const cfg = await fetchPaymentConfig();
    expect(cfg.onlineEnabled).toBe(false);
    expect(cfg.keyId).toBeNull();
    expect(cfg.methods).toEqual([]);
  });
});
