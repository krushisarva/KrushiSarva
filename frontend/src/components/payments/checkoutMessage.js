/**
 * What a message from the Razorpay checkout page means — a pure decision.
 *
 * Its own module rather than a function inside RazorpayCheckout.js because that
 * file imports `react-native-webview`, which this jest environment has no stub
 * for. The rule below is the one piece of the checkout that must never silently
 * regress, so it lives where a test can reach it.
 */

/**
 * @param {{type: string, code?: string, reason?: string}} msg
 *   Parsed WebView message. UNTRUSTED — a tampered page can post anything, which
 *   is why nothing here is believed about money: a `success` only ever starts a
 *   server-side signature check, it never concludes one.
 * @param {{orderId: string, settledFor: string|null}} state
 *   `settledFor` is the order id that already produced a terminal outcome, or
 *   null. A BOOLEAN here is the bug this signature exists to prevent: the
 *   component is reused across attempts, so a farmer whose first payment failed
 *   gets a new gateway order on the same mount, and a boolean latch would still
 *   be set — swallowing the second attempt's dismissal, which is the single
 *   signal that makes the app ask the server whether the money actually moved.
 * @returns {{action: 'success'|'failure'|'dismiss'|'ignore', settle?: string, payload?: object}}
 */
export function routeCheckoutMessage(msg, { orderId, settledFor }) {
  // A success is always delivered, even on an order already settled: Razorpay
  // can fire `handler` after `ondismiss`, and dropping that would lose a real
  // payment. Everything else from a settled order is the tail of an event this
  // component has already reported.
  if (settledFor === orderId && msg.type !== 'success') return { action: 'ignore' };

  switch (msg.type) {
    case 'success':
      return { action: 'success', settle: orderId, payload: msg };
    case 'failed':
      return { action: 'failure', settle: orderId, payload: { code: msg.code, reason: msg.reason } };
    case 'script_error':
      // The checkout script never loaded — almost always no connectivity. Its
      // own code, so the app can say "check your connection" rather than
      // "payment failed", which would be a lie.
      return { action: 'failure', settle: orderId, payload: { code: 'SCRIPT_LOAD', reason: null } };
    case 'dismissed':
      // Deliberately does NOT settle: the farmer may have paid, and the caller
      // has to be free to ask the server and then hear a later success.
      return { action: 'dismiss' };
    default:
      return { action: 'ignore' };
  }
}
