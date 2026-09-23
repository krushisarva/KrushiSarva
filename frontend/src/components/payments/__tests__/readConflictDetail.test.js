/**
 * The 409 a payment confirm can answer with: the farmer paid, and the thing
 * they paid for went to someone else in between.
 *
 * This is the most expensive message in the app to get wrong. The farmer has
 * been charged, so the difference between "your refund is on its way" and "our
 * team is checking" is the difference between a farmer who waits and a farmer
 * who pays again. Only the server knows which is true, so its sentence is
 * preferred over the app's fallback table whenever it sent one.
 *
 * The backend answers in the house error envelope:
 *     { error: { message: '<the sentence>', details: { refunded, ... } } }
 * — the flags in `details`, the sentence one level up in `error.message`.
 * Reading only `details.message` silently drops it, which is the gap these
 * tests pin.
 */
import { readConflictDetail } from '../usePaymentFlow';

const err409 = (data) => ({ response: { status: 409, data } });

describe('readConflictDetail — the house error envelope', () => {
  test("takes the sentence from error.message, where the server actually puts it", () => {
    const detail = readConflictDetail(err409({
      error: {
        message: 'Those dates were taken while you paid. ₹1,500 is being refunded.',
        details: { refunded: true, paymentCaptured: true, code: 'SLOT_TAKEN' },
      },
    }));
    expect(detail.refunded).toBe(true);
    expect(detail.message).toBe('Those dates were taken while you paid. ₹1,500 is being refunded.');
  });

  test('details.message wins when a caller does put it there', () => {
    const detail = readConflictDetail(err409({
      error: { message: 'outer', details: { refunded: true, message: 'inner' } },
    }));
    expect(detail.message).toBe('inner');
  });

  test('reads the flags out of a success-ish data body too', () => {
    const detail = readConflictDetail(err409({ data: { refunded: true, message: 'from data' } }));
    expect(detail).toEqual({ refunded: true, message: 'from data' });
  });
});

describe('readConflictDetail — never promises a refund the server did not', () => {
  test('refunded stays false when the server did not say it raised one', () => {
    // PRICE_CHANGED with no refund flag: the money may still be held. Reporting
    // `refunded: true` here would put a 5-7 working day promise in front of a
    // farmer nobody has refunded.
    const detail = readConflictDetail(err409({
      error: { message: 'The price changed.', details: { code: 'PRICE_CHANGED' } },
    }));
    expect(detail.refunded).toBe(false);
  });

  test('a truthy-but-not-true refunded value is not treated as a refund', () => {
    const detail = readConflictDetail(err409({ error: { details: { refunded: 'pending' } } }));
    expect(detail.refunded).toBe(false);
  });

  test('refundStarted is accepted as the same statement', () => {
    expect(readConflictDetail(err409({ error: { details: { refundStarted: true } } })).refunded).toBe(true);
  });

  test('a 409 carrying nothing usable says nothing rather than guessing', () => {
    expect(readConflictDetail(err409({}))).toEqual({ refunded: false, message: null });
    expect(readConflictDetail(err409({ error: { message: 'bare' } }))).toEqual({
      refunded: false, message: null,
    });
  });

  test('a non-message message is dropped rather than rendered', () => {
    const detail = readConflictDetail(err409({
      error: { message: { toString: () => 'nope' }, details: { refunded: true } },
    }));
    expect(detail.message).toBeNull();
  });
});

describe('readConflictDetail — only 409 means "taken while you paid"', () => {
  test.each([400, 401, 404, 500, 503])('%i is not a conflict', (status) => {
    expect(readConflictDetail({ response: { status, data: { error: { details: { refunded: true } } } } }))
      .toBeNull();
  });

  test('a request that never reached the server is not a conflict', () => {
    expect(readConflictDetail(new Error('Network Error'))).toBeNull();
    expect(readConflictDetail(undefined)).toBeNull();
  });
});
