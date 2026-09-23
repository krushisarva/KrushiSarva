/**
 * The settle latch in RazorpayCheckout.
 *
 * Razorpay fires `ondismiss` after a successful `handler` too, so the component
 * latches once an order settles and ignores that trailing dismissal. The latch
 * used to be a boolean, which was correct for exactly one payment attempt and
 * wrong for every attempt after it: the component is reused, so a farmer whose
 * first booking failed and who tried again got a NEW gateway order on a latch
 * that was still true — and that second attempt's `dismissed` was swallowed.
 *
 * Swallowing a dismissal is the worst outcome this file can produce. It is the
 * signal that makes the app ask the server "did the money actually move?", and
 * without it a farmer who paid and backgrounded the app is told nothing
 * happened, and pays again.
 *
 * The first test below fails against the boolean latch and passes against the
 * order-keyed one, so it pins the fix rather than merely describing it.
 */
import { routeCheckoutMessage } from '../checkoutMessage';

const ORDER_A = 'order_AAA111';
const ORDER_B = 'order_BBB222';

describe('routeCheckoutMessage — the settle latch is per order, not per mount', () => {
  test('a second attempt hears its own dismissal after a first attempt settled', () => {
    // Attempt 1 failed and latched.
    const first = routeCheckoutMessage({ type: 'failed', code: 'BAD_CARD' }, {
      orderId: ORDER_A, settledFor: null,
    });
    expect(first.action).toBe('failure');
    expect(first.settle).toBe(ORDER_A);

    // Attempt 2: a new gateway order on the same mounted component. The latch
    // still holds ORDER_A, and this dismissal MUST get through.
    const second = routeCheckoutMessage({ type: 'dismissed' }, {
      orderId: ORDER_B, settledFor: ORDER_A,
    });
    expect(second.action).toBe('dismiss');
  });

  test('the trailing dismissal of a settled order is still ignored', () => {
    const decision = routeCheckoutMessage({ type: 'dismissed' }, {
      orderId: ORDER_A, settledFor: ORDER_A,
    });
    expect(decision.action).toBe('ignore');
  });

  test('a dismissal never settles — the caller must stay free to hear a later success', () => {
    const decision = routeCheckoutMessage({ type: 'dismissed' }, {
      orderId: ORDER_A, settledFor: null,
    });
    expect(decision.action).toBe('dismiss');
    expect(decision.settle).toBeUndefined();

    // …and that later success is delivered, not dropped.
    const late = routeCheckoutMessage({ type: 'success', razorpay_payment_id: 'pay_1' }, {
      orderId: ORDER_A, settledFor: null,
    });
    expect(late.action).toBe('success');
  });

  test('a success is delivered even on an already-settled order', () => {
    // Razorpay can fire `handler` after `ondismiss`. Dropping it loses a real
    // payment, so success is the one message the latch does not gate.
    const decision = routeCheckoutMessage({ type: 'success', razorpay_payment_id: 'pay_1' }, {
      orderId: ORDER_A, settledFor: ORDER_A,
    });
    expect(decision.action).toBe('success');
    expect(decision.payload.razorpay_payment_id).toBe('pay_1');
  });
});

describe('routeCheckoutMessage — outcomes stay distinguishable', () => {
  test('a gateway failure carries its code and reason', () => {
    const decision = routeCheckoutMessage(
      { type: 'failed', code: 'PAYMENT_DECLINED', reason: 'insufficient funds' },
      { orderId: ORDER_A, settledFor: null },
    );
    expect(decision).toEqual({
      action: 'failure',
      settle: ORDER_A,
      payload: { code: 'PAYMENT_DECLINED', reason: 'insufficient funds' },
    });
  });

  test('a script load error is its own code, not a payment failure', () => {
    // "No connectivity" and "your payment failed" are different things to tell
    // a farmer, and only one of them is true here.
    const decision = routeCheckoutMessage({ type: 'script_error' }, {
      orderId: ORDER_A, settledFor: null,
    });
    expect(decision.payload).toEqual({ code: 'SCRIPT_LOAD', reason: null });
  });

  test('an unknown message type is ignored rather than guessed at', () => {
    expect(routeCheckoutMessage({ type: 'telemetry' }, {
      orderId: ORDER_A, settledFor: null,
    })).toEqual({ action: 'ignore' });
  });
});
