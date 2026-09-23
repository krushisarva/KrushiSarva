/**
 * Razorpay checkout, on web.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * `react-native-webview` ships android / ios / macos / windows and NO web
 * implementation — no `.web.js`, no `browser` field, no iframe fallback. On
 * Expo web the `<WebView>` in RazorpayCheckout.js therefore renders nothing,
 * `onLoadEnd` never fires, and the caller's "opening secure payment…" overlay
 * spins forever. Not a connectivity problem and not fixable from inside that
 * file: there is no WebView to load anything into.
 *
 * Metro resolves `.web.js` ahead of `.js`, and all four screens import this
 * module without an extension, so they pick this up on web and the native file
 * on a device with no change at either call site.
 *
 * ── Why this is simpler than the native path ─────────────────────────────────
 * Razorpay Standard Checkout IS a web integration. The native file has to build
 * an HTML page and bridge its results back over `postMessage` precisely because
 * a phone has no page to put it on. Here there is one, so checkout.js loads
 * into it and calls our callbacks directly. No HTML string, no bridge, no
 * parsing.
 *
 * ── The security boundary is unchanged ───────────────────────────────────────
 * Nothing this component reports is trusted. A success hands back (order_id,
 * payment_id, signature) which the app forwards to the server, which re-verifies
 * the HMAC with the SECRET key, re-prices, and only then writes the booking or
 * grants the credits. The amount lives on the gateway order, never here.
 *
 * ── The one rule that matters for the farmer ─────────────────────────────────
 * DISMISSAL IS NOT FAILURE, exactly as on device. The settle latch is imported
 * from ./checkoutMessage rather than re-written, so a rule this expensive to get
 * wrong has one implementation and one set of tests across both platforms.
 */
import { useEffect, useRef } from 'react';
import { routeCheckoutMessage } from './checkoutMessage';

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/**
 * How long to wait for checkout.js before calling it unreachable.
 *
 * A hanging request fires neither `load` nor `error` — a stalled transfer, a
 * captive portal, a DNS block — so without a deadline the farmer watches a
 * spinner indefinitely. On a screen about money that is worse than an error,
 * because it is indistinguishable from a payment quietly going through. Matches
 * the native page's watchdog.
 */
const SCRIPT_TIMEOUT_MS = 20000;

/** Load checkout.js once per document; later calls reuse the same promise. */
let scriptPromise = null;

function loadCheckoutScript() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('no document'));
  }
  if (window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${CHECKOUT_SRC}"]`);
    const el = existing || document.createElement('script');
    let done = false;

    const settle = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // A failed load must not be cached as "in progress" forever: the farmer
      // may simply be on a better connection when they tap Pay again.
      if (fn === reject) scriptPromise = null;
      fn(arg);
    };
    const timer = setTimeout(() => settle(reject, new Error('timeout')), SCRIPT_TIMEOUT_MS);

    el.addEventListener('load', () => settle(resolve));
    el.addEventListener('error', () => settle(reject, new Error('load error')));

    if (!existing) {
      el.src = CHECKOUT_SRC;
      el.async = true;
      document.head.appendChild(el);
    } else if (window.Razorpay) {
      settle(resolve);
    }
  });
  return scriptPromise;
}

/**
 * Same props as the native component — see RazorpayCheckout.js.
 *
 * Renders nothing: Razorpay draws its own modal over the page. The caller's
 * overlay is dismissed by the first callback, the same way the native path's is
 * dismissed by the first bridged message.
 */
export default function RazorpayCheckout({
  visible, keyId, orderId, amountPaise, buyerName, buyerPhone, description,
  onSuccess, onDismiss, onFailure,
}) {
  // The settle latch, keyed on the order it settled — see ./checkoutMessage.
  // A boolean would swallow a SECOND attempt's dismissal, which is the one
  // event that makes the app ask the server whether the money actually moved.
  const settledFor = useRef(null);
  const rzpRef = useRef(null);
  // React 18 StrictMode runs effects twice in development. Without this, one
  // tap would open two checkout sheets against the same gateway order.
  const openedFor = useRef(null);

  // Callbacks are read through a ref so re-renders never re-open the sheet:
  // parents pass inline arrows, and listing them as deps would reopen checkout
  // on every render.
  const handlers = useRef({ onSuccess, onDismiss, onFailure });
  handlers.current = { onSuccess, onDismiss, onFailure };

  useEffect(() => {
    if (!visible) return undefined;
    if (openedFor.current === orderId) return undefined;
    openedFor.current = orderId;

    let cancelled = false;

    // One funnel for every outcome, so the latch rule cannot drift between
    // them — the same shape the native file gets from its message handler.
    const report = (msg) => {
      if (cancelled) return;
      const decision = routeCheckoutMessage(msg, { orderId, settledFor: settledFor.current });
      if (decision.settle !== undefined) settledFor.current = decision.settle;
      const h = handlers.current;
      if (decision.action === 'success') h.onSuccess?.(decision.payload);
      else if (decision.action === 'failure') h.onFailure?.(decision.payload);
      else if (decision.action === 'dismiss') h.onDismiss?.();
    };

    // Nothing to open. Say so rather than returning quietly: the caller is
    // sitting in its `checkout` state waiting to hear an outcome, and a silent
    // return leaves a farmer watching a spinner with no way forward. Reported
    // as a failure, not a script error, because "check your connection" would
    // be a lie — the server did not hand us a publishable key. No money moved.
    if (!orderId || !keyId) {
      report({ type: 'failed', code: 'CONFIG', reason: orderId ? 'no key' : 'no order' });
      return () => { cancelled = true; };
    }

    loadCheckoutScript()
      .then(() => {
        if (cancelled) return;
        const rzp = new window.Razorpay({
          key: keyId,
          order_id: orderId,
          amount: Number(amountPaise) || 0,
          currency: 'INR',
          name: 'KrushiSarva',
          description: description || '',
          prefill: { name: buyerName || '', contact: buyerPhone || '' },
          theme: { color: '#176B43' },
          retry: { enabled: false },
          handler: (r) => report({
            type: 'success',
            razorpayPaymentId: r.razorpay_payment_id,
            razorpayOrderId: r.razorpay_order_id,
            razorpaySignature: r.razorpay_signature,
          }),
          modal: {
            escape: false,
            ondismiss: () => report({ type: 'dismissed' }),
          },
        });
        rzp.on('payment.failed', (r) => report({
          type: 'failed',
          code: r?.error?.code ?? null,
          reason: r?.error?.description ?? null,
        }));
        rzpRef.current = rzp;
        rzp.open();
      })
      .catch(() => {
        // Its own outcome, never "payment failed" — the app says "check your
        // connection", which is what actually happened. No money moved.
        report({ type: 'script_error' });
      });

    return () => {
      cancelled = true;
      try { rzpRef.current?.close?.(); } catch { /* already gone */ }
      rzpRef.current = null;
    };
  }, [visible, orderId, keyId, amountPaise, buyerName, buyerPhone, description]);

  // Let a closed-then-reopened sheet open again for the same order: the caller
  // does this after a status check comes back unpaid.
  useEffect(() => {
    if (!visible) openedFor.current = null;
  }, [visible]);

  return null;
}
