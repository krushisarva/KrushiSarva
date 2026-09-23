/**
 * The payment flow, once, for every purpose.
 *
 * Shop checkout worked out — painfully, and over several rounds of farmers
 * being charged twice — what has to happen around the Razorpay sheet:
 *
 *     idle → initiating → checkout → confirming → done | failed | unknown
 *
 * Rent bookings and AI credit packs need exactly that, against different URLs.
 * Rather than let each screen re-derive it (and get the dismissal rule wrong,
 * which is the one that costs a farmer real money), the purpose-specific
 * `initiate` / `confirm` / `status` functions are passed IN and the sequencing
 * lives here.
 *
 * ── The rule this file exists to enforce ─────────────────────────────────────
 * DISMISSAL IS NOT FAILURE. When the sheet closes without firing the success
 * handler, this hook does NOT conclude anything — it ASKS THE SERVER. A farmer
 * who approves a UPI collect request and then gets backgrounded by their bank
 * app has very possibly paid; telling them it failed is how they pay twice.
 * The same applies when `confirm` itself errors: the money has already moved by
 * then, so the error is a question for the server, not an answer.
 *
 * ── Why the poll is bounded ──────────────────────────────────────────────────
 * CLAUDE.md §46: backoff with jitter, never an unbounded loop. Four attempts
 * over ~10s, each cancellable. If the server still cannot say, the outcome is
 * `unknown` — an honest "we could not confirm, check before paying again" —
 * never an optimistic "failed".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Imported from shopUtils, not from paymentClient, so this hook pulls in no
// axios: the sequencing is plain logic and stays testable under the project's
// lightweight node Jest config. Same split shopUtils/shopClient already uses.
import { classifyError } from '../../screens/AgriStore/shopUtils';

/** The states a payment can be in. Exported so screens switch on constants. */
export const PAYMENT_STATE = {
  IDLE: 'idle',
  INITIATING: 'initiating',
  CHECKOUT: 'checkout',
  CONFIRMING: 'confirming',
  DONE: 'done',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
};

/** Why `failed` happened. The screen says a different sentence for each. */
export const PAYMENT_FAILURE = {
  /** Could not raise the gateway order. Nothing was ever opened. */
  INITIATE: 'INITIATE',
  /** The gateway itself reported the payment failed. No money was taken. */
  GATEWAY: 'GATEWAY',
  /** checkout.js could not load — no connectivity, NOT a failed payment. */
  SCRIPT_LOAD: 'SCRIPT_LOAD',
  /** The server confirms nothing was paid. Safe to try again. */
  NOT_PAID: 'NOT_PAID',
  /** Paid, but the thing being bought was gone. The money is coming back. */
  REFUNDED: 'REFUNDED',
};

/** What a status report means. */
export const PAYMENT_OUTCOME = {
  PAID: 'PAID',
  UNPAID: 'UNPAID',
  REFUNDED: 'REFUNDED',
  PENDING: 'PENDING',
};

// Status strings, upper-cased, across the three purposes' status endpoints.
const PAID_STATES = new Set([
  'PAID', 'CAPTURED', 'SUCCESS', 'SUCCEEDED', 'COMPLETED',
  'CREDITED', 'BOOKED', 'CONFIRMED', 'ORDER_CREATED',
]);
const REFUND_STATES = new Set([
  'REFUNDED', 'REFUNDING', 'REFUND_PENDING', 'REFUND_INITIATED', 'PARTIALLY_REFUNDED',
]);
const UNPAID_STATES = new Set([
  'FAILED', 'EXPIRED', 'CANCELLED', 'CANCELED', 'VOID', 'VOIDED',
  // Razorpay's own `created`: the order exists and NOTHING was attempted
  // against it. `attempted` is deliberately absent — an attempt may still be
  // in flight, and that is the case this whole file is built around.
  'CREATED',
]);

/**
 * Read a status report into one of four outcomes.
 *
 * Pure, and exported, because the mapping is the part worth pinning in a test:
 * anything not positively recognised is PENDING, which polls again and
 * ultimately lands on `unknown` — never on "no money was taken", which is the
 * one sentence that must never be said wrongly.
 */
export function classifyPaymentStatus(report) {
  if (!report) return PAYMENT_OUTCOME.PENDING;
  if (report.paid === true) return PAYMENT_OUTCOME.PAID;

  const s = String(report.status ?? report.state ?? '').toUpperCase();
  if (PAID_STATES.has(s)) return PAYMENT_OUTCOME.PAID;
  if (REFUND_STATES.has(s)) return PAYMENT_OUTCOME.REFUNDED;
  if (UNPAID_STATES.has(s)) return PAYMENT_OUTCOME.UNPAID;
  return PAYMENT_OUTCOME.PENDING;
}

/**
 * The 409 a confirm can answer with: the slot/pack was taken between paying and
 * confirming, and the server has already refunded.
 *
 * The shape is read from BOTH places the API can carry it — the success-ish
 * `data` body and the error envelope's `details` — because a farmer who has
 * just been charged must not be shown the flattened "A conflict occurred.
 * Please refresh and try again." that the generic classifier produces.
 */
export function readConflictDetail(err) {
  if (err?.response?.status !== 409) return null;
  const body = err?.response?.data;
  const d = body?.data ?? body?.error?.details ?? null;
  if (!d) return { refunded: false, message: null };
  return {
    refunded: d.refunded === true || d.refundStarted === true,
    // The sentence lives at `error.message` in the house error envelope, while
    // `details` carries only the flags — so both are read. Preferring the
    // server's own wording is the point: it is the only party that knows
    // whether a refund was actually raised, and the app's fallback table has to
    // hedge ("our team is checking") where the server can simply say what it
    // did. Read `details.message` first anyway, for any caller that puts it in
    // the success-ish `data` body.
    message: typeof d.message === 'string' ? d.message
      : typeof body?.error?.message === 'string' ? body.error.message
        : null,
  };
}

/** Backoff with jitter (§46). First check is immediate; four attempts, ~10s. */
const POLL_DELAYS_MS = [0, 1500, 3000, 6000];

function jittered(ms) {
  if (!ms) return 0;
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/** A sleep that gives up the moment the flow is abandoned. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (!ms || signal?.aborted) return resolve();
    const id = setTimeout(done, ms);
    function done() {
      clearTimeout(id);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/**
 * @param {object} opts
 * @param {(body: object, signal?: AbortSignal) => Promise<object>} opts.initiate
 *        Raises the gateway order. Called with whatever `start()` was given.
 * @param {(body: {razorpayOrderId, razorpayPaymentId, razorpaySignature},
 *          signal?: AbortSignal) => Promise<object>} opts.confirm
 * @param {(providerOrderId: string, signal?: AbortSignal) => Promise<object>} opts.status
 *        The truth about an interrupted payment. Required — without it the
 *        dismissal path cannot ask, and this hook will not guess.
 * @param {(result: object, intent: object) => void} [opts.onDone]
 * @param {(failure: object) => void} [opts.onFailed]
 * @param {(report: object|null) => void} [opts.onUnknown]
 * @param {number[]} [opts.pollDelaysMs]  Override the backoff schedule (tests).
 */
export default function usePaymentFlow({
  initiate,
  confirm,
  status,
  onDone,
  onFailed,
  onUnknown,
  pollDelaysMs = POLL_DELAYS_MS,
} = {}) {
  const [state, setState] = useState(PAYMENT_STATE.IDLE);
  const [intent, setIntent] = useState(null);
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);
  const [report, setReport] = useState(null);
  /** 'confirm' | 'dismiss' | null — which sentence to show while verifying. */
  const [verifyReason, setVerifyReason] = useState(null);

  // A ref, not the `state`: setState lags a fast double tap by a render, so both
  // presses read `idle` and both fire — two gateway orders for one booking, and
  // a farmer looking at two charges. Same reason MachineryDetail.js:347 guards
  // its booking with a ref.
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const abortRef = useRef(null);
  // The gateway order id survives in a ref as well as state: the dismissal
  // handler needs it after the modal has already been closed.
  const orderIdRef = useRef(null);

  // Callbacks in refs so a screen passing inline arrows does not re-arm the
  // flow on every render.
  const cbRef = useRef({ onDone, onFailed, onUnknown });
  cbRef.current = { onDone, onFailed, onUnknown };
  const fnRef = useRef({ initiate, confirm, status });
  fnRef.current = { initiate, confirm, status };

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      // Unmount mid-flight: abort the request and stop every pending setState.
      // Nothing below writes state without checking `aliveRef` first.
      aliveRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const signal = useCallback(() => {
    if (!abortRef.current) abortRef.current = new AbortController();
    return abortRef.current.signal;
  }, []);

  /** Every terminal transition goes through here, so nothing settles twice. */
  const settle = useCallback((next, payload = {}) => {
    busyRef.current = false;
    if (!aliveRef.current) return;
    setVerifyReason(null);
    if (next === PAYMENT_STATE.DONE) {
      setResult(payload.result ?? null);
      setState(PAYMENT_STATE.DONE);
      cbRef.current.onDone?.(payload.result ?? null, payload.intent ?? null);
      return;
    }
    if (next === PAYMENT_STATE.FAILED) {
      setFailure(payload.failure ?? null);
      setState(PAYMENT_STATE.FAILED);
      cbRef.current.onFailed?.(payload.failure ?? null);
      return;
    }
    setState(PAYMENT_STATE.UNKNOWN);
    cbRef.current.onUnknown?.(payload.report ?? null);
  }, []);

  /**
   * Ask the server what happened, up to four times with backoff.
   *
   * An UNPAID answer on the FIRST attempt is deliberately not believed: at the
   * instant the sheet closes, a UPI collect the farmer has just approved still
   * reads `created` server-side. One re-check (~1.5s) is the difference between
   * "no money was taken" and the truth.
   */
  const resolveFromServer = useCallback(async (providerOrderId) => {
    const ask = fnRef.current.status;
    if (!providerOrderId || typeof ask !== 'function') {
      settle(PAYMENT_STATE.UNKNOWN, { report: null });
      return;
    }

    const sig = signal();
    let last = null;

    for (let attempt = 0; attempt < pollDelaysMs.length; attempt += 1) {
      await sleep(jittered(pollDelaysMs[attempt]), sig);
      if (!aliveRef.current || sig.aborted) return;

      try {
        last = await ask(providerOrderId, sig);
      } catch (err) {
        // A cancelled request is not an answer; a real error just means this
        // attempt learned nothing, so fall through to the next one.
        if (!classifyError(err)) return;
        last = null;
      }
      if (!aliveRef.current || sig.aborted) return;
      if (last) setReport(last);

      const outcome = classifyPaymentStatus(last);
      if (outcome === PAYMENT_OUTCOME.PAID) {
        settle(PAYMENT_STATE.DONE, { result: last, intent });
        return;
      }
      if (outcome === PAYMENT_OUTCOME.REFUNDED) {
        settle(PAYMENT_STATE.FAILED, {
          failure: { code: PAYMENT_FAILURE.REFUNDED, moneyTaken: true, report: last },
        });
        return;
      }
      if (outcome === PAYMENT_OUTCOME.UNPAID && attempt > 0) {
        settle(PAYMENT_STATE.FAILED, {
          failure: { code: PAYMENT_FAILURE.NOT_PAID, moneyTaken: false, report: last },
        });
        return;
      }
      // PENDING — or a first-attempt UNPAID we are not willing to believe yet.
    }

    // The budget is spent and the server still cannot say. Say exactly that.
    settle(PAYMENT_STATE.UNKNOWN, { report: last });
  }, [intent, pollDelaysMs, settle, signal]);

  // ── The three things the sheet can report ───────────────────────────────────
  /** Razorpay verified the payment. Hand the claim to the server to re-verify. */
  const handleSuccess = useCallback(async ({
    razorpayOrderId, razorpayPaymentId, razorpaySignature,
  } = {}) => {
    const providerOrderId = razorpayOrderId || orderIdRef.current;
    if (aliveRef.current) {
      setVerifyReason('confirm');
      setState(PAYMENT_STATE.CONFIRMING);
    }
    try {
      const out = await fnRef.current.confirm?.(
        { razorpayOrderId: providerOrderId, razorpayPaymentId, razorpaySignature },
        signal(),
      );
      if (!aliveRef.current) { busyRef.current = false; return; }
      settle(PAYMENT_STATE.DONE, { result: out, intent });
    } catch (err) {
      const info = classifyError(err);
      if (!info) { busyRef.current = false; return; } // cancelled, not a failure
      if (!aliveRef.current) { busyRef.current = false; return; }

      // The slot/pack went to someone else. The server has already refunded —
      // say that, rather than the classifier's generic 409 text, to someone who
      // has just been charged.
      const conflict = readConflictDetail(err);
      if (conflict) {
        settle(PAYMENT_STATE.FAILED, {
          failure: {
            code: PAYMENT_FAILURE.REFUNDED,
            moneyTaken: true,
            refunded: conflict.refunded,
            serverMessage: conflict.message,
            error: info,
          },
        });
        return;
      }

      // Anything else: THE MONEY HAS ALREADY MOVED. This error is a question,
      // not an answer — ask the server what actually happened to it.
      await resolveFromServer(providerOrderId);
    }
  }, [intent, resolveFromServer, settle, signal]);

  /**
   * The farmer closed the sheet. THE PAYMENT MAY HAVE SUCCEEDED.
   *
   * The one branch that must never assume. Everything it can do is ask.
   */
  const handleDismiss = useCallback(async () => {
    const providerOrderId = orderIdRef.current;
    if (aliveRef.current) {
      setVerifyReason('dismiss');
      setState(PAYMENT_STATE.CONFIRMING);
    }
    await resolveFromServer(providerOrderId);
  }, [resolveFromServer]);

  /** The gateway said it failed, or its script never loaded. */
  const handleFailure = useCallback(({ code, reason } = {}) => {
    const scriptLoad = code === 'SCRIPT_LOAD';
    settle(PAYMENT_STATE.FAILED, {
      failure: {
        // A script that would not load means NO CONNECTIVITY, not a failed
        // payment — a different sentence, and a different next step.
        code: scriptLoad ? PAYMENT_FAILURE.SCRIPT_LOAD : PAYMENT_FAILURE.GATEWAY,
        noConnection: scriptLoad,
        moneyTaken: false,
        gatewayCode: scriptLoad ? null : (code ?? null),
        serverMessage: scriptLoad ? null : (reason ?? null),
      },
    });
  }, [settle]);

  // ── Entry points ────────────────────────────────────────────────────────────
  /**
   * Begin. Idempotent against a double tap by construction.
   * @param {object} body passed straight to the purpose's `initiate`
   */
  const start = useCallback(async (body) => {
    if (busyRef.current) return;      // ← the ref, checked before anything else
    busyRef.current = true;

    setFailure(null);
    setResult(null);
    setReport(null);
    setVerifyReason(null);
    setState(PAYMENT_STATE.INITIATING);

    try {
      const next = await fnRef.current.initiate?.(body, signal());
      if (!aliveRef.current) { busyRef.current = false; return; }

      if (!next?.razorpayOrderId) {
        settle(PAYMENT_STATE.FAILED, {
          failure: {
            code: PAYMENT_FAILURE.INITIATE,
            moneyTaken: false,
            serverMessage: null,
          },
        });
        return;
      }

      orderIdRef.current = next.razorpayOrderId;
      setIntent(next);
      setState(PAYMENT_STATE.CHECKOUT);
      // busyRef stays TRUE: the flow is live behind the modal, and a second
      // start() before it settles would raise a second gateway order.
    } catch (err) {
      const info = classifyError(err);
      if (!info) { busyRef.current = false; return; } // cancelled
      settle(PAYMENT_STATE.FAILED, {
        failure: {
          code: PAYMENT_FAILURE.INITIATE,
          moneyTaken: false,
          serverMessage: info.message,
          error: info,
        },
      });
    }
  }, [settle, signal]);

  /** Back to idle — for a "try again" button after a terminal state. */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    orderIdRef.current = null;
    if (!aliveRef.current) return;
    setState(PAYMENT_STATE.IDLE);
    setIntent(null);
    setResult(null);
    setFailure(null);
    setReport(null);
    setVerifyReason(null);
  }, []);

  /** Spread straight onto <RazorpayCheckout {...checkoutProps} …/>. */
  const checkoutProps = useMemo(() => ({
    visible: state === PAYMENT_STATE.CHECKOUT && !!intent?.razorpayOrderId,
    orderId: intent?.razorpayOrderId ?? null,
    // Display only — the gateway charges what the ORDER says, never this.
    amountPaise: intent?.amountInPaise ?? Math.round(Number(intent?.amount || 0) * 100),
    onSuccess: handleSuccess,
    onDismiss: handleDismiss,
    onFailure: handleFailure,
  }), [state, intent, handleSuccess, handleDismiss, handleFailure]);

  return {
    state,
    /** True whenever work is in flight — drives the disabled Pay button. */
    busy: state === PAYMENT_STATE.INITIATING
      || state === PAYMENT_STATE.CHECKOUT
      || state === PAYMENT_STATE.CONFIRMING,
    /** 'confirm' | 'dismiss' | null, while state is `confirming`. */
    verifyReason,
    intent,
    result,
    failure,
    report,
    checkoutProps,
    start,
    reset,
  };
}
