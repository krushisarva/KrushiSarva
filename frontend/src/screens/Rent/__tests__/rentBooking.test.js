/**
 * Rent booking + payment — the four things that cost a farmer real money if
 * they are wrong.
 *
 *   1. No request body ever carries an amount.
 *   2. Closing the payment sheet is NOT a failure — it asks the server.
 *   3. A double tap raises ONE gateway order.
 *   4. Payments off / unreachable → the free booking path still works.
 *
 * `useRentBooking` is driven through react-test-renderer, the same way
 * shared/hooks/__tests__/usePincodeLocation.test.js drives its hooks: this
 * package's Jest config is node + a plain babel transform, and the hook itself
 * imports nothing from react-native, so no renderer preset is needed.
 */
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';

jest.mock('../../../services/paymentClient', () => ({
  __esModule: true,
  fetchPaymentConfig:     jest.fn(),
  initiateRentBooking:    jest.fn(),
  confirmRentBooking:     jest.fn(),
  fetchRentPaymentStatus: jest.fn(),
}));
jest.mock('@krushisarva/shared/services/api', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));

import api from '@krushisarva/shared/services/api';
import {
  fetchPaymentConfig, initiateRentBooking, confirmRentBooking, fetchRentPaymentStatus,
} from '../../../services/paymentClient';
import useRentBooking from '../components/useRentBooking';
import {
  buildInitiateArgs, buildLegacyBody, shouldPayOnline, PRICE_KEY_PATTERN,
  PAY_STATE, RECHECK, bookingPayState, recheckStrategy, paymentStatusPatch, noticeText,
} from '../components/rentBookingFlow';

global.IS_REACT_ACT_ENVIRONMENT = true;

// react-test-renderer 19 logs a deprecation on every create(); it is still the
// lightest way to drive a hook under this node-only config.
const realConsoleError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((msg, ...rest) => {
    if (String(msg).includes('react-test-renderer is deprecated')) return;
    realConsoleError(msg, ...rest);
  });
});
afterAll(() => console.error.mockRestore());

const REQUEST = {
  listingId: 'listing-1',
  startDate: '2026-10-01',
  endDate:   '2026-10-03',
  days:      3,
  notes:     ' bring a trailer ',
};

/** Mount the hook and hand back a live handle to its return value. */
function mount(props = {}) {
  const ref = { current: null };
  function Probe(p) { ref.current = useRentBooking(p); return null; }
  let tree;
  act(() => { tree = TestRenderer.create(<Probe type="machinery" {...props} />); });
  return { hook: ref, unmount: () => act(() => tree.unmount()) };
}

/** Let promises settle (the config fetch, an awaited request). */
const settle = () => act(async () => {});

/** Drive the bounded status poll to completion under fake timers. */
async function drainPoll(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { jest.advanceTimersByTime(8000); });
  }
}

beforeEach(() => {
  jest.useRealTimers();
  fetchPaymentConfig.mockReset();
  initiateRentBooking.mockReset();
  confirmRentBooking.mockReset();
  fetchRentPaymentStatus.mockReset();
  api.post.mockReset();
  api.get.mockReset();
  fetchPaymentConfig.mockResolvedValue({ onlineEnabled: false, keyId: null, methods: [] });
  api.post.mockResolvedValue({ data: { data: { id: 'booking-1', status: 'PENDING', totalAmount: 3000 } } });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. No request body carries an amount
// ─────────────────────────────────────────────────────────────────────────────
describe('the client never sends a price', () => {
  const priced = {
    ...REQUEST,
    // Everything a screen might be tempted to pass along.
    totalAmount: 3000, amount: 3000, payable: 1500, price: 1000,
    amountInPaise: 300000, ratePerDay: 1000, fee: 20, cost: 9,
  };

  it('buildInitiateArgs emits only what is being booked', () => {
    const args = buildInitiateArgs({ ...priced, type: 'machinery' });
    expect(Object.keys(args).sort()).toEqual(['endDate', 'listingId', 'startDate', 'type']);
    for (const k of Object.keys(args)) expect(k).not.toMatch(PRICE_KEY_PATTERN);
  });

  it('buildInitiateArgs keeps quantities, which are not money', () => {
    const args = buildInitiateArgs({ ...priced, type: 'labour', hours: 6, workerCount: 4 });
    expect(args).toMatchObject({ type: 'labour', hours: 6, workerCount: 4 });
    for (const k of Object.keys(args)) expect(k).not.toMatch(PRICE_KEY_PATTERN);
  });

  it('buildLegacyBody emits no price either', () => {
    const body = buildLegacyBody({ ...priced, type: 'machinery' });
    expect(body.machineryListingId).toBe('listing-1');
    expect(body).not.toHaveProperty('totalAmount');
    for (const k of Object.keys(body)) expect(k).not.toMatch(PRICE_KEY_PATTERN);
  });

  it('the legacy request actually put on the wire carries no price', async () => {
    const { hook, unmount } = mount({ onBooked: jest.fn(), onNotice: jest.fn() });
    await settle();
    await act(async () => { await hook.current.book(priced); });

    expect(api.post).toHaveBeenCalledTimes(1);
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe('/rent/bookings');
    for (const k of Object.keys(body)) expect(k).not.toMatch(PRICE_KEY_PATTERN);
    unmount();
  });

  it('the initiate request actually put on the wire carries no price', async () => {
    fetchPaymentConfig.mockResolvedValue({ onlineEnabled: true, keyId: 'rzp_test_1', methods: ['upi'] });
    initiateRentBooking.mockResolvedValue({
      razorpayOrderId: 'order_A', amount: 1500, amountInPaise: 150000,
      quote: { days: 3, total: 3000, advancePct: 50, payable: 1500 },
    });

    const { hook, unmount } = mount({ onBooked: jest.fn(), onNotice: jest.fn() });
    await settle();
    await act(async () => { await hook.current.book(priced); });

    expect(initiateRentBooking).toHaveBeenCalledTimes(1);
    const sent = initiateRentBooking.mock.calls[0][0];
    for (const k of Object.keys(sent)) expect(k).not.toMatch(PRICE_KEY_PATTERN);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Dismissal is not failure
// ─────────────────────────────────────────────────────────────────────────────
describe('closing the payment sheet', () => {
  async function openSheet() {
    fetchPaymentConfig.mockResolvedValue({ onlineEnabled: true, keyId: 'rzp_test_1', methods: ['upi'] });
    initiateRentBooking.mockResolvedValue({
      razorpayOrderId: 'order_A', amount: 1500, amountInPaise: 150000,
      quote: { days: 3, total: 3000, advancePct: 50, payable: 1500 },
    });
    const onBooked = jest.fn();
    const onNotice = jest.fn();
    const { hook, unmount } = mount({ onBooked, onNotice });
    await settle();
    await act(async () => { await hook.current.book(REQUEST); });
    expect(hook.current.checkoutProps.visible).toBe(true);
    return { hook, onBooked, onNotice, unmount };
  }

  it('asks the server instead of reporting a failure', async () => {
    const { hook, onBooked, onNotice, unmount } = await openSheet();
    // The farmer approved a UPI collect and then the app was backgrounded.
    fetchRentPaymentStatus.mockResolvedValue({
      status: 'PAID', paid: true, amount: 1500, booking: { id: 'booking-9', status: 'CONFIRMED' },
    });

    await act(async () => { await hook.current.checkoutProps.onDismiss(); });

    expect(fetchRentPaymentStatus).toHaveBeenCalled();
    expect(fetchRentPaymentStatus.mock.calls[0][0]).toBe('order_A');
    // The whole point: a booking, not "payment failed".
    expect(onNotice).not.toHaveBeenCalled();
    expect(onBooked).toHaveBeenCalledTimes(1);
    expect(onBooked.mock.calls[0][0]).toMatchObject({ paid: true });
    unmount();
  });

  it('does not believe a single "nothing was paid" answer', async () => {
    const { hook, onBooked, onNotice, unmount } = await openSheet();
    // Razorpay still reads `created` for a collect request the farmer has just
    // approved. One answer must not become "no money was taken".
    fetchRentPaymentStatus.mockResolvedValue({ status: 'created', paid: false });

    jest.useFakeTimers();
    act(() => { hook.current.checkoutProps.onDismiss(); });
    await drainPoll();

    expect(fetchRentPaymentStatus.mock.calls.length).toBeGreaterThan(1);
    expect(onBooked).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledTimes(1);
    const notice = onNotice.mock.calls[0][0];
    expect(notice.kind).toBe('NOT_PAID');
    expect(notice.moneyTaken).toBe(false);
    unmount();
  });

  it('never claims a refund the server did not mention', async () => {
    const { hook, onNotice, unmount } = await openSheet();
    fetchRentPaymentStatus.mockResolvedValue({ status: 'REFUNDED', paid: false, amount: 1500 });

    await act(async () => { await hook.current.checkoutProps.onDismiss(); });

    const notice = onNotice.mock.calls[0][0];
    expect(notice.kind).toBe('SLOT_TAKEN');
    expect(notice.moneyTaken).toBe(true);
    // `refunded` was never asserted by the server on this path, so the wording
    // must be the "we are checking" one, not the 5–7 working days promise.
    expect(notice.bodyFallback).not.toMatch(/5–7/);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. One tractor, one gateway order
// ─────────────────────────────────────────────────────────────────────────────
describe('double tap', () => {
  it('raises exactly one gateway order', async () => {
    fetchPaymentConfig.mockResolvedValue({ onlineEnabled: true, keyId: 'rzp_test_1', methods: ['upi'] });
    let release;
    initiateRentBooking.mockImplementation(() => new Promise((res) => { release = res; }));

    const { hook, unmount } = mount({ onBooked: jest.fn(), onNotice: jest.fn() });
    await settle();

    let second;
    await act(async () => {
      hook.current.book(REQUEST);            // first press — deliberately not awaited
      second = await hook.current.book(REQUEST); // the impatient second press
    });

    expect(second).toEqual({ skipped: true });
    expect(initiateRentBooking).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ razorpayOrderId: 'order_A', amount: 1500, amountInPaise: 150000 });
    });
    // Still one, now that the sheet is open: the guard covers the whole
    // initiate → sheet → confirm window, not just the request.
    await act(async () => { await hook.current.book(REQUEST); });
    expect(initiateRentBooking).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not fire two legacy bookings either', async () => {
    let release;
    api.post.mockImplementation(() => new Promise((res) => { release = res; }));

    const { hook, unmount } = mount({ onBooked: jest.fn(), onNotice: jest.fn() });
    await settle();

    await act(async () => {
      hook.current.book(REQUEST);
      await hook.current.book(REQUEST);
    });
    expect(api.post).toHaveBeenCalledTimes(1);

    await act(async () => { release({ data: { data: { id: 'booking-1' } } }); });
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A gateway outage is not a booking outage
// ─────────────────────────────────────────────────────────────────────────────
describe('when online payment is off', () => {
  it('books free rather than asking for money the server cannot take', async () => {
    const onBooked = jest.fn();
    const { hook, unmount } = mount({ onBooked, onNotice: jest.fn() });
    await settle();
    expect(hook.current.payOnline).toBe(false);

    await act(async () => { await hook.current.book(REQUEST); });

    expect(initiateRentBooking).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith('/rent/bookings', expect.objectContaining({
      machineryListingId: 'listing-1',
      startDate: '2026-10-01',
      endDate: '2026-10-03',
    }));
    expect(onBooked).toHaveBeenCalledTimes(1);
    expect(onBooked.mock.calls[0][0]).toMatchObject({ paid: false });
    unmount();
  });

  it('treats a failed config call as off, not as a reason to stop booking', async () => {
    // fetchPaymentConfig already resolves to "off" on any error — this pins the
    // hook's side of that contract.
    fetchPaymentConfig.mockResolvedValue({ onlineEnabled: false, keyId: null, methods: [] });
    const onBooked = jest.fn();
    const { hook, unmount } = mount({ onBooked, onNotice: jest.fn() });
    await settle();
    await act(async () => { await hook.current.book(REQUEST); });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(onBooked).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('falls back to free when the server can only simulate a payment', async () => {
    fetchPaymentConfig.mockResolvedValue({ onlineEnabled: true, keyId: 'rzp_test_1', methods: ['upi'] });
    // `mock: true` — no live gateway credentials. Its order id would make the
    // real checkout script throw, so no sheet may be opened with it.
    initiateRentBooking.mockResolvedValue({ razorpayOrderId: 'order_mock', mock: true, amount: 1500 });

    const onBooked = jest.fn();
    const onNotice = jest.fn();
    const { hook, unmount } = mount({ onBooked, onNotice });
    await settle();
    await act(async () => { await hook.current.book(REQUEST); });
    await settle();

    expect(hook.current.checkoutProps.visible).toBe(false);
    expect(api.post).toHaveBeenCalledWith('/rent/bookings', expect.any(Object));
    expect(onNotice).not.toHaveBeenCalled();
    expect(onBooked).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('shouldPayOnline fails closed in every direction', () => {
    expect(shouldPayOnline(null)).toBe(false);
    expect(shouldPayOnline({ onlineEnabled: false, keyId: 'k' })).toBe(false);
    expect(shouldPayOnline({ onlineEnabled: true, keyId: null })).toBe(false);
    // The old flag name must never be read as a yes.
    expect(shouldPayOnline({ razorpayEnabled: true, keyId: 'k' })).toBe(false);
    expect(shouldPayOnline({ onlineEnabled: true, keyId: 'k' })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The bookings list
// ─────────────────────────────────────────────────────────────────────────────
describe('reading a booking row', () => {
  it('badges a free booking as unpaid, not as broken', () => {
    expect(bookingPayState({ id: 'b', paymentStatus: 'UNPAID' })).toBe(PAY_STATE.UNPAID);
    expect(bookingPayState({ id: 'b' })).toBe(PAY_STATE.UNPAID);
  });

  it('treats an unrecognised state as pending, never as unpaid', () => {
    // "Unpaid" invites the farmer to pay. An unknown state is exactly when we
    // do not know whether they already have.
    expect(bookingPayState({ paymentStatus: 'SOMETHING_NEW' })).toBe(PAY_STATE.PENDING);
    expect(bookingPayState({ paymentStatus: 'REFUND_INITIATED' })).toBe(PAY_STATE.REFUNDED);
  });

  it('offers a recheck only where one could tell us something', () => {
    expect(recheckStrategy({ paymentStatus: 'PAID' })).toBe(RECHECK.NONE);
    expect(recheckStrategy({ paymentStatus: 'UNPAID' })).toBe(RECHECK.NONE);
    // Pending with a gateway order id → ask the payment-status endpoint.
    expect(recheckStrategy({ paymentStatus: 'PENDING', providerOrderId: 'order_A' })).toBe(RECHECK.ORDER);
    // Pending with no order id on the row → re-read the booking itself, rather
    // than leaving the farmer with no way to find out at all.
    expect(recheckStrategy({ paymentStatus: 'PENDING' })).toBe(RECHECK.BOOKING);
  });

  it('folds a status report back into the row without losing the booking', () => {
    const patch = paymentStatusPatch({ paid: true, status: 'captured', booking: { status: 'CONFIRMED' } });
    expect(patch).toMatchObject({ paymentStatus: PAY_STATE.PAID, status: 'CONFIRMED' });
    expect(paymentStatusPatch(null)).toBeNull();
  });
});

describe('what the farmer is told', () => {
  const t = (key, fallbackOrVars) => {
    if (fallbackOrVars && typeof fallbackOrVars === 'object') {
      return String(fallbackOrVars.defaultValue ?? key)
        .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(fallbackOrVars[k] ?? ''));
    }
    return fallbackOrVars ?? key;
  };

  it('prefers the server sentence when the notice says to', () => {
    const { body } = noticeText({
      titleKey: 'x', titleFallback: 'T',
      bodyKey: 'y', bodyFallback: 'local words',
      serverMessage: 'the server knows more', preferServerMessage: true,
    }, t);
    expect(body).toBe('the server knows more');
  });

  it('interpolates an amount through the app formatter', () => {
    const { body } = noticeText({
      titleKey: 'x', titleFallback: 'T',
      bodyKey: 'y', bodyFallback: '{{amount}} is being refunded.',
      vars: { amount: 1500 },
    }, t, (n) => `₹${n}`);
    expect(body).toBe('₹1500 is being refunded.');
  });
});
