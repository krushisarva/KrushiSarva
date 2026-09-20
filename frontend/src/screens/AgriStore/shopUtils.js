/**
 * Shop data layer — the network rules the Shop screens were missing.
 *
 * ── What this fixes ──────────────────────────────────────────────────────────
 * AgriStoreHome fetched products like this:
 *
 *     async function fetchProducts() {
 *       setLoading(true);
 *       try { ... setProducts(items) }
 *       catch { setProducts([]) }        // ← every network blip empties the shop
 *       finally { setLoading(false) }
 *     }
 *
 * Three separate problems, all of which bite hardest on exactly the connection
 * a farmer has:
 *
 *   1. NO REQUEST CANCELLATION AND NO SEQUENCING. Type "urea", then "urea 50".
 *      On a slow link the first response can land after the second, and the
 *      older results silently replace the newer ones. There was nothing to stop
 *      it — no abort, no request id.
 *   2. AN ERROR WIPED THE SCREEN. `catch { setProducts([]) }` turns a dropped
 *      packet into the "coming soon, no products" empty state. CartScreen had
 *      the same shape and showed an EMPTY CART on a network error, which is a
 *      considerably worse thing to show someone.
 *   3. NO CACHE. Reopening the Shop out of signal showed nothing at all, even
 *      though the same 20 products had been on screen a minute earlier.
 *
 * ── What it does instead ─────────────────────────────────────────────────────
 * Every fetch carries a monotonic sequence number; a response older than the
 * newest one issued is dropped, not rendered. In-flight requests are aborted
 * when superseded. Failures return a TYPED error the UI can act on, and keep
 * whatever was already on screen. Successful catalogue reads are persisted to
 * AsyncStorage with a timestamp, so the next cold open paints instantly and says
 * how old it is.
 *
 * No new dependencies: AsyncStorage and axios' AbortController support are
 * already in the app.
 *
 * ── Why this file has no `api` import ────────────────────────────────────────
 * Everything here is pure logic or AsyncStorage: the sequencing rule, the error
 * taxonomy, the image transform, the money formatting. Keeping the axios client
 * out means all of it is unit-testable under the project's lightweight node Jest
 * config, without standing up a React Native runtime for a function that
 * rewrites a URL string. The network calls live in shopClient.js, which
 * re-exports everything below so screens have one import site.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Typed errors ──────────────────────────────────────────────────────────────
/**
 * Structured error codes. The screen switches on the CODE and offers the right
 * recovery action; the message is only ever the safe, user-facing text the API
 * client already produced. Raw server strings never reach the UI.
 */
export const SHOP_ERRORS = {
  OFFLINE: 'OFFLINE',
  TIMEOUT: 'TIMEOUT',
  SERVER: 'SERVER',
  MAINTENANCE: 'MAINTENANCE',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH: 'AUTH',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION: 'VALIDATION',
  UNKNOWN: 'UNKNOWN',
};

/** Recovery actions a screen can render for an error. */
export const SHOP_ACTIONS = {
  RETRY: 'RETRY',
  SIGN_IN: 'SIGN_IN',
  CHANGE_LOCATION: 'CHANGE_LOCATION',
  CLEAR_FILTERS: 'CLEAR_FILTERS',
  UPDATE_CART: 'UPDATE_CART',
  CHECK_PAYMENT: 'CHECK_PAYMENT',
  CONTACT_SUPPORT: 'CONTACT_SUPPORT',
};

const ACTION_FOR = {
  [SHOP_ERRORS.OFFLINE]: SHOP_ACTIONS.RETRY,
  [SHOP_ERRORS.TIMEOUT]: SHOP_ACTIONS.RETRY,
  [SHOP_ERRORS.SERVER]: SHOP_ACTIONS.RETRY,
  [SHOP_ERRORS.MAINTENANCE]: SHOP_ACTIONS.RETRY,
  [SHOP_ERRORS.RATE_LIMITED]: SHOP_ACTIONS.RETRY,
  [SHOP_ERRORS.AUTH]: SHOP_ACTIONS.SIGN_IN,
  [SHOP_ERRORS.NOT_FOUND]: SHOP_ACTIONS.RETRY,
  [SHOP_ERRORS.CONFLICT]: SHOP_ACTIONS.UPDATE_CART,
  [SHOP_ERRORS.VALIDATION]: SHOP_ACTIONS.RETRY,
  [SHOP_ERRORS.UNKNOWN]: SHOP_ACTIONS.RETRY,
};

/**
 * Classify an axios error into something the UI can act on.
 *
 * The previous behaviour everywhere in Shop was a bare `catch {}` — the farmer
 * got "no products" whether the server was down, their signal had dropped, or
 * their session had expired, and the correct next step is different in all three.
 */
export function classifyError(err) {
  // A superseded request is not an error and must never be rendered as one.
  if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return null;

  const status = err?.response?.status;
  let code = SHOP_ERRORS.UNKNOWN;

  if (err?.message === 'Network Error') code = SHOP_ERRORS.OFFLINE;
  else if (err?.code === 'ECONNABORTED') code = SHOP_ERRORS.TIMEOUT;
  else if (status === 401) code = SHOP_ERRORS.AUTH;
  else if (status === 404) code = SHOP_ERRORS.NOT_FOUND;
  else if (status === 409) code = SHOP_ERRORS.CONFLICT;
  else if (status === 400 || status === 422) code = SHOP_ERRORS.VALIDATION;
  else if (status === 429) code = SHOP_ERRORS.RATE_LIMITED;
  else if (status === 503) code = SHOP_ERRORS.MAINTENANCE;
  else if (status >= 500) code = SHOP_ERRORS.SERVER;

  return {
    code,
    action: ACTION_FOR[code] || SHOP_ACTIONS.RETRY,
    // `userMessage` is set by the shared API client's interceptor and is already
    // sanitised — no stack traces, no SQL, no upstream payloads.
    message: err?.userMessage || 'Something went wrong. Please try again.',
    // Structured detail the backend attaches to quote / compliance refusals, so
    // the cart screen can point at the exact line that is blocked.
    issues: err?.response?.data?.error?.details?.issues || null,
    reason: err?.response?.data?.error?.details?.reason || null,
    // /orders/confirm refusals where THE MONEY MOVED but no order was made. The
    // sanitised `message` for a 409 is the generic "A conflict occurred. Please
    // refresh and try again." — the last thing to say to someone who has just
    // paid. These two flags let the screen say what happened to the money.
    paymentCaptured: err?.response?.data?.error?.details?.paymentCaptured === true,
    refundStarted: err?.response?.data?.error?.details?.refundStarted === true,
    // For a support ticket. The API attaches it to every error envelope.
    requestId: err?.response?.data?.error?.requestId || null,
    status: status || null,
  };
}

// ── Sequenced, cancellable requests ───────────────────────────────────────────
/**
 * A request lane.
 *
 * One lane per logical stream (the product grid is one lane, the offers sheet is
 * another). Issuing a request on a lane aborts whatever that lane had in flight
 * and stamps the new request with the next sequence number. A response is only
 * delivered if its sequence is still the newest — which is what makes a slow
 * "urea" response unable to overwrite a fast "urea 50" one.
 */
export function createRequestLane() {
  let seq = 0;
  let controller = null;

  return {
    /**
     * @param {(signal: AbortSignal) => Promise<any>} run
     * @returns {Promise<{stale: boolean, data?: any, error?: object|null}>}
     */
    async send(run) {
      // Abort the previous request on this lane: it is superseded, and letting it
      // finish burns bandwidth on a connection that has very little.
      controller?.abort();
      controller = new AbortController();

      const mySeq = ++seq;
      const myController = controller;

      try {
        const data = await run(myController.signal);
        // A response that is no longer the newest is DROPPED, never rendered.
        if (mySeq !== seq) return { stale: true };
        return { stale: false, data };
      } catch (err) {
        if (mySeq !== seq) return { stale: true };
        const error = classifyError(err);
        if (!error) return { stale: true }; // deliberately cancelled
        return { stale: false, error };
      }
    },
    cancel() { controller?.abort(); controller = null; },
  };
}

// ── Offline cache ─────────────────────────────────────────────────────────────
const CACHE_PREFIX = '@shop_cache:';
/** Cached catalogue is shown immediately and refreshed; this bounds how stale. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Read a cached payload with its age.
 *
 * Returns `{ data, cachedAt, ageMs }` so the screen can SAY how old it is.
 * Showing month-old prices as if they were live is worse than showing nothing;
 * showing five-minute-old prices labelled "updated 5 minutes ago" is better than
 * a spinner on a connection that is not going to come back.
 *
 * NOTE: catalogue data only. Nothing user-specific (cart, orders, addresses) is
 * cached here — a shared device would leak one farmer's cart to the next.
 */
export async function readCache(key) {
  try {
    const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const ageMs = Date.now() - (parsed.cachedAt || 0);
    if (ageMs > CACHE_MAX_AGE_MS) return null;
    return { data: parsed.data, cachedAt: parsed.cachedAt, ageMs };
  } catch {
    return null; // a corrupt cache entry is a cache miss, never a crash
  }
}

export async function writeCache(key, data) {
  try {
    await AsyncStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ cachedAt: Date.now(), data }));
  } catch { /* a full disk must not break the shop */ }
}

/** Human-readable cache age, for the "showing saved results" banner. */
export function formatCacheAge(ageMs, t) {
  const mins = Math.round(ageMs / 60000);
  if (mins < 1) return t('shop.cacheJustNow', 'Updated just now');
  if (mins < 60) return t('shop.cacheMinutes', { count: mins, defaultValue: `Updated ${mins} min ago` });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('shop.cacheHours', { count: hours, defaultValue: `Updated ${hours} h ago` });
  return t('shop.cacheOld', 'Saved earlier');
}

// ── Images ────────────────────────────────────────────────────────────────────
/**
 * Turn a full-resolution catalogue image into a card-sized thumbnail.
 *
 * Product cards were rendering `item.images[0]` — the original upload — into a
 * 130px-tall box. On a 20-product grid that is twenty full-resolution downloads
 * and twenty full-resolution decodes for images displayed at a fraction of their
 * size, which is both the slowest part of the screen and the largest share of a
 * farmer's data bill.
 *
 * Images are already on Cloudinary, which resizes on the fly from the URL, so
 * this needs no new dependency and no re-upload: inserting a transformation
 * segment after `/upload/` is the whole change. `f_auto` picks WebP/AVIF where
 * the client supports it, `q_auto` sets quality by content.
 *
 * Any non-Cloudinary URL is returned untouched.
 */
export function thumbUrl(url, width = 320) {
  if (typeof url !== 'string' || !url) return url;
  if (!url.includes('/upload/')) return url;
  // Never transform twice — an already-transformed URL has a segment here.
  if (/\/upload\/[a-z]_[^/]+\//.test(url)) return url;
  return url.replace('/upload/', `/upload/f_auto,q_auto,c_limit,w_${Math.round(width)}/`);
}

/** Detail-screen gallery: bigger, still not the raw original. */
export const detailImageUrl = (url) => thumbUrl(url, 900);

// ── Retry with backoff ────────────────────────────────────────────────────────
/**
 * Retry a SAFE (idempotent) read with exponential backoff and jitter.
 *
 * Bounded at `attempts` — never unlimited. Jitter matters more than usual here:
 * when a village tower comes back, every phone on it retries at the same instant,
 * and a fixed backoff turns recovery into a synchronised stampede.
 *
 * Deliberately NOT used for order or payment creation. Those carry an
 * Idempotency-Key and are retried by the user, not silently by the client.
 */
export async function retryRead(fn, { attempts = 3, baseMs = 400 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const info = classifyError(err);
      if (!info) throw err;                       // cancelled — do not retry
      // Retrying a 401/404/409/422 just repeats the same answer more slowly.
      const retryable = [SHOP_ERRORS.OFFLINE, SHOP_ERRORS.TIMEOUT, SHOP_ERRORS.SERVER, SHOP_ERRORS.MAINTENANCE];
      if (!retryable.includes(info.code) || i === attempts - 1) throw err;
      lastError = err;
      const delay = baseMs * 2 ** i + Math.random() * baseMs;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ── Recent searches ───────────────────────────────────────────────────────────
const RECENT_KEY = '@shop_recent_searches';
const RECENT_MAX = 8;

export async function readRecentSearches() {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

export async function pushRecentSearch(term) {
  const clean = String(term || '').trim();
  if (clean.length < 2) return;
  try {
    const current = await readRecentSearches();
    const next = [clean, ...current.filter((s) => s.toLowerCase() !== clean.toLowerCase())].slice(0, RECENT_MAX);
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* non-essential */ }
}

export async function clearRecentSearches() {
  try { await AsyncStorage.removeItem(RECENT_KEY); } catch { /* non-essential */ }
}

// ── Money formatting ──────────────────────────────────────────────────────────
/**
 * Format rupees for an Indian audience.
 *
 * The screens were calling `price.toLocaleString()` with no locale, which gives
 * the device's grouping (1,234,567) rather than the Indian one (12,34,567) that
 * every farmer reads prices in.
 */
export function inr(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '₹0';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/**
 * Discount percentage — computed from MRP and price, never taken from the server
 * as a display string and never invented.
 *
 * Returns 0 unless there is a genuine, positive difference, so a listing with no
 * MRP shows no "% off" badge at all rather than a fabricated one.
 */
export function discountPct(mrp, price) {
  const m = Number(mrp); const p = Number(price);
  if (!Number.isFinite(m) || !Number.isFinite(p) || m <= 0 || p <= 0 || m <= p) return 0;
  return Math.round(((m - p) / m) * 100);
}

// ── What happened to the money ────────────────────────────────────────────────
/**
 * Every state `GET /agristore/orders/payment-status/:providerOrderId` answers
 * with, and the sentence to show for each one.
 *
 * The server's `intentPublicStatus()` (backend/src/services/shopPayment.service.js)
 * returns exactly nine `state` values:
 *
 *   ORDER_CREATED  the payment became an order — `orderId` is set
 *   CONFIRMING     captured, the order is being created. DO NOT PAY AGAIN
 *   PENDING        no payment seen yet, or one still being confirmed
 *   REFUNDING      a refund has been started. `refundPending: false` means the
 *                  GATEWAY CALL ITSELF FAILED, so no 5–7 day promise may be made
 *   REFUNDED       the gateway accepted the refund
 *   FAILED         the gateway reported a failure — nothing was captured
 *   CANCELLED      the intent was cancelled — nothing was captured
 *   EXPIRED        no payment attempt inside the window — nothing was captured
 *   UNKNOWN        there is no intent at all
 *
 * REFUNDING and REFUNDED are newer than this app's first build, and both used
 * to fall through to PENDING — which this screen renders as "No money was taken.
 * You can try again", said to a farmer whose money HAS been taken and is on its
 * way back. That is the failure this table exists to prevent.
 *
 * `moneyTaken` is the load-bearing field: nothing that offers "try again" may
 * ever be shown for a state where it is true.
 *
 * Kept out of the screens (and free of `t`) so the whole table is unit-testable
 * under the project's plain-node Jest config.
 */
const PAYMENT_NOTICES = {
  ORDER_CREATED: {
    ordered: true, moneyTaken: true, mayRetry: false,
    titleKey: 'checkout.paymentDoneTitle', titleFallback: 'Payment successful',
    bodyKey: 'checkout.paymentDoneMsg',
    bodyFallback: 'Your order has been placed. You can see it under My Orders.',
  },
  CONFIRMING: {
    moneyTaken: true, mayRetry: false,
    titleKey: 'checkout.paymentConfirmingTitle', titleFallback: 'Payment is being confirmed',
    bodyKey: 'checkout.paymentConfirmingMsg',
    bodyFallback: 'Your payment has gone through and we are creating your order. Do not pay again — check My Orders in a few minutes.',
  },
  // NOT "no money was taken": the server says PENDING both for an untouched
  // payment sheet and for one whose outcome it has not established yet, and it
  // cannot tell the two apart. Telling the farmer to pay again on the second is
  // how they are charged twice.
  PENDING: {
    moneyTaken: false, mayRetry: false,
    titleKey: 'checkout.paymentPendingTitle', titleFallback: 'We are still checking your payment',
    bodyKey: 'checkout.paymentPendingMsg',
    bodyFallback: 'Do not pay again. Open My Orders in a few minutes — if no money was taken, you can order again from your cart.',
  },
  REFUNDED: {
    moneyTaken: true, mayRetry: true, refund: 'done',
    titleKey: 'checkout.refundDoneTitle', titleFallback: 'Your payment was refunded',
    bodyKey: 'checkout.refundDoneMsg',
    bodyFallback: 'Your payment has been refunded — it reaches the account you paid from in 5–7 working days.',
    amountBodyKey: 'checkout.refundDoneAmountMsg',
    amountBodyFallback: '{{amount}} has been refunded — it reaches the account you paid from in 5–7 working days.',
  },
  FAILED: {
    moneyTaken: false, mayRetry: true,
    titleKey: 'checkout.paymentFailed', titleFallback: 'Payment failed',
    bodyKey: 'checkout.paymentFailedMsg',
    bodyFallback: 'No money was taken. Please try again or choose Cash on Delivery.',
  },
  CANCELLED: {
    moneyTaken: false, mayRetry: true,
    titleKey: 'checkout.paymentCancelled', titleFallback: 'Payment cancelled',
    bodyKey: 'checkout.paymentCancelledMsg',
    bodyFallback: 'No money was taken. You can try again or choose Cash on Delivery.',
  },
  EXPIRED: {
    moneyTaken: false, mayRetry: true,
    titleKey: 'checkout.paymentExpiredTitle', titleFallback: 'Payment session expired',
    bodyKey: 'checkout.paymentExpiredMsg',
    bodyFallback: 'No money was taken. Please review your cart and try again.',
  },
};

/** The two REFUNDING answers — they differ by whether a date may be promised. */
const REFUND_ON_WAY = {
  moneyTaken: true, mayRetry: false, refund: 'onWay',
  titleKey: 'checkout.refundOnWayTitle', titleFallback: 'Your payment is being refunded',
  bodyKey: 'checkout.refundOnWayMsg',
  bodyFallback: 'Your payment is being refunded — it reaches the account you paid from in 5–7 working days.',
  amountBodyKey: 'checkout.refundOnWayAmountMsg',
  amountBodyFallback: '{{amount}} is being refunded — it reaches the account you paid from in 5–7 working days.',
};
const REFUND_ARRANGING = {
  moneyTaken: true, mayRetry: false, refund: 'arranging',
  titleKey: 'checkout.refundArrangingTitle', titleFallback: 'Refund being arranged',
  bodyKey: 'checkout.refundArrangingMsg',
  bodyFallback: 'Our team is arranging your refund — please do not pay again.',
  amountBodyKey: 'checkout.refundArrangingAmountMsg',
  amountBodyFallback: 'Our team is arranging your {{amount}} refund — please do not pay again.',
};

/**
 * The safe answer for a state this build has never heard of.
 *
 * A future server state must not reach the farmer as a blank alert or as the raw
 * word "REFUND_INITIATED". It degrades to "we could not confirm" — which is the
 * only thing that is certainly true — and prefers the server's own sentence when
 * it sent one, because a newer server knows more about its own state than this
 * table does.
 */
/**
 * Raw `PaymentIntentStatus` values the public mapping renames. Accepted so an
 * older server, an admin tool or a replayed payload cannot land on "unknown".
 */
const RAW_STATUS_ALIAS = { PAID: 'CONFIRMING', CREATED: 'PENDING' };

const PAYMENT_UNKNOWN = {
  moneyTaken: false, mayRetry: false, preferServerMessage: true,
  titleKey: 'checkout.paymentUnknownTitle', titleFallback: 'We could not confirm your payment',
  bodyKey: 'checkout.paymentUnknownMsg',
  bodyFallback: 'Please check My Orders before trying again, so you are not charged twice.',
};

/**
 * Map a payment-status payload to the notice to show. Never returns null.
 *
 * @param {object|null} status the `data` of GET /orders/payment-status
 * @returns {{state: string, titleKey: string, titleFallback: string,
 *            bodyKey: string, bodyFallback: string, amount: number|null,
 *            moneyTaken: boolean, mayRetry: boolean, ordered: boolean,
 *            refund: string|null, serverMessage: string|null,
 *            preferServerMessage: boolean, known: boolean}}
 */
export function paymentStatusNotice(status) {
  const raw = status?.state;
  const state = typeof raw === 'string' ? raw : 'UNKNOWN';

  let base;
  // REFUND_INITIATED is accepted alongside REFUNDING: it is the raw intent
  // status, and an older server (or an admin tool) can still send it. Reading it
  // as "no money was taken" is exactly the bug this guards.
  if (state === 'REFUNDING' || state === 'REFUND_INITIATED') {
    base = status?.refundPending === false ? REFUND_ARRANGING : REFUND_ON_WAY;
  } else {
    // 'PAID' and 'CREATED' are the raw intent statuses behind CONFIRMING and
    // PENDING, accepted for the same reason as REFUND_INITIATED above.
    base = PAYMENT_NOTICES[RAW_STATUS_ALIAS[state] || state];
  }
  const known = Boolean(base);
  if (!known) base = PAYMENT_UNKNOWN;

  // The intent's amount, which for a refunding/refunded intent IS the amount
  // going back. The server sends it as a decimal string alongside the state.
  const amountNum = Number(status?.amount);
  const amount = Number.isFinite(amountNum) && amountNum > 0 ? amountNum : null;
  const serverMessage =
    typeof status?.message === 'string' && status.message.trim() ? status.message.trim() : null;

  return {
    state,
    known,
    ordered: base.ordered === true,
    moneyTaken: base.moneyTaken === true,
    mayRetry: base.mayRetry === true,
    refund: base.refund || null,
    preferServerMessage: base.preferServerMessage === true,
    serverMessage,
    titleKey: base.titleKey,
    titleFallback: base.titleFallback,
    // The amount-bearing wording is only used when there IS an amount to name;
    // a refund sentence with a blank ₹ in it is worse than one without a figure.
    bodyKey: amount && base.amountBodyKey ? base.amountBodyKey : base.bodyKey,
    bodyFallback: amount && base.amountBodyKey ? base.amountBodyFallback : base.bodyFallback,
    amount,
  };
}

/**
 * What to tell a farmer whose `POST /orders/confirm` failed AFTER they paid.
 *
 * Confirm only ever runs on a signature-verified payment, so a refusal here
 * always means THE MONEY MOVED AND NO ORDER EXISTS. The server has four ways to
 * refuse with 409, and `shared/services/api.js` flattens all of them to the same
 * sanitised sentence — "A conflict occurred. Please refresh and try again." —
 * which is the last thing to say to someone who has just been charged:
 *
 *   1. the re-quote no longer passes    details: { issues, paymentCaptured,
 *                                                  refundStarted }
 *   2. the cart changed while paying    details: { code: 'CART_CHANGED',
 *                                                  paymentCaptured, refundStarted }
 *   3. the payment was already refunded (bindIntentToOrderTx, PAYMENT_REFUNDED)
 *   4. too many serialization retries   (withSerializableRetry, SERIALIZATION_CONFLICT)
 *
 * (3) and (4) reach the client through `sendServerError`, which forwards neither
 * `details` nor `err.code` — so they are INDISTINGUISHABLE from each other in
 * the error envelope alone. That is why the caller re-asks
 * `GET /orders/payment-status` and passes the answer in as `status`: the intent
 * state is authoritative for all four, and carries the ₹ amount as well.
 *
 * @param {object|null} info   the classifyError() result
 * @param {object|null} status the payment-status payload, when it could be read
 */
export function confirmFailureNotice(info, status) {
  const title = { titleKey: 'checkout.paymentTakenTitle', titleFallback: 'Payment received' };
  // The server's own words for the blocked lines ("Only 3 left of Urea 50kg").
  // English, but specific — appended, never substituted for the refund sentence.
  const detail = info?.issues?.length ? info.issues.map((i) => i.message).filter(Boolean).join('\n') : null;

  // 1. The authoritative answer, when we could get it.
  if (status) {
    const notice = paymentStatusNotice(status);
    if (notice.state === 'ORDER_CREATED' || status.orderId) {
      return { ...title, ordered: true, order: status.order || null, detail: null, notice };
    }
    if (notice.refund) {
      return {
        ...title,
        leadKey: 'checkout.paymentNotOrderedMsg',
        leadFallback: 'Your payment went through, but your order could not be completed.',
        bodyKey: notice.bodyKey, bodyFallback: notice.bodyFallback, amount: notice.amount,
        detail, notice,
      };
    }
    // Captured but not yet refunding (CONFIRMING/PENDING) — the reconciler owns
    // it from here. Do not promise a date no refund has been raised for.
    if (notice.moneyTaken || !notice.known) {
      return {
        ...title,
        leadKey: 'checkout.paymentNotOrderedMsg',
        leadFallback: 'Your payment went through, but your order could not be completed.',
        bodyKey: 'checkout.refundArrangingMsg',
        bodyFallback: 'Our team is arranging your refund — please do not pay again.',
        amount: notice.amount, detail, notice,
      };
    }
    // FAILED / CANCELLED / EXPIRED: the gateway says nothing was captured, so
    // this is a plain failure and retrying is safe.
    return {
      titleKey: notice.titleKey, titleFallback: notice.titleFallback,
      bodyKey: notice.bodyKey, bodyFallback: notice.bodyFallback,
      mayRetry: true, detail, notice,
    };
  }

  // 2. No authoritative answer. Fall back to what the 409 itself carried.
  const conflict = info?.status === 409;
  if (info?.paymentCaptured || conflict) {
    return {
      ...title,
      leadKey: 'checkout.paymentNotOrderedMsg',
      leadFallback: 'Your payment went through, but your order could not be completed.',
      // `refundStarted` is only ever sent on the two refusals that raise the
      // refund themselves. Absent it — reasons (3) and (4) — "being arranged" is
      // the honest half-answer: the money is owed and no date can be promised.
      ...(info?.refundStarted
        ? {
          bodyKey: 'checkout.refundOnWayMsg',
          bodyFallback: 'Your payment is being refunded — it reaches the account you paid from in 5–7 working days.',
        }
        : {
          bodyKey: 'checkout.refundArrangingMsg',
          bodyFallback: 'Our team is arranging your refund — please do not pay again.',
        }),
      amount: null, detail, notice: null,
    };
  }

  // 3. Not a conflict at all — a timeout, an offline phone, a 5xx. The money may
  // or may not have moved, so the one thing not to say is "try again".
  return {
    ...title,
    bodyKey: 'checkout.paymentTakenMsg',
    bodyFallback: 'Your payment went through but we could not finish the order. Our team will contact you — please do not pay again.',
    amount: null, detail, notice: null,
  };
}

/**
 * The refund line for an order's `paymentStatus`.
 *
 * orders.paymentStatus carries the refund state a cancel produced
 * ('refund_pending' → 'refunded' / 'partially_refunded'). My Orders rendered
 * none of it, so a cancelled online-paid order looked identical to a cancelled
 * cash order — no statement anywhere that the money was coming back.
 *
 * Returns null for 'pending' and 'paid', and for anything unknown: nothing to
 * say about a refund is better than a wrong label, and an unrecognised value
 * must never reach the screen as raw text. Cash-on-delivery orders never reach a
 * refund status, so they cannot claim a refund through this.
 */
export function orderRefundLabel(paymentStatus) {
  switch (paymentStatus) {
    case 'refund_pending':
      return { key: 'orders.refundPending', fallback: 'Refund on the way — 5–7 working days', done: false };
    case 'partially_refunded':
      return { key: 'orders.partiallyRefunded', fallback: 'Part of your payment was refunded', done: false };
    case 'refunded':
      return { key: 'orders.refunded', fallback: 'Refunded to the account you paid from', done: true };
    default:
      return null;
  }
}

/**
 * A readable label for an order status this build does not know.
 *
 * The badge used to render `status` verbatim, so a value added to the OrderStatus
 * enum after this APK shipped would show a farmer the literal word
 * "RETURN_REQUESTED". Title-casing is not a translation, but it is a phrase
 * rather than a constant, and it cannot be WRONG the way a guessed label can.
 */
export function humanOrderStatus(code) {
  if (typeof code !== 'string' || !code.trim()) return null;
  const words = code.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ── Cancelling an order ───────────────────────────────────────────────────────
/** paymentStatus values under which the buyer's money is still held. */
const MONEY_HELD = new Set(['paid', 'partially_refunded', 'refund_pending']);

/** Rupees → integer paise, so the preview sums the way the server's Decimal does. */
const paise = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/**
 * Can the buyer still cancel this order?
 *
 * Mirrors `PUT /agristore/orders/:id/cancel` exactly: PENDING order, and no line
 * the seller has already moved on. Offering a button the server answers 400 to
 * is worse than not offering it.
 */
export function canCancelOrder(order) {
  if (order?.status !== 'PENDING') return false;
  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return true; // the server is the authority; the list payload may be trimmed
  if (items.some((i) => i?.status !== 'PENDING' && i?.status !== 'CANCELLED')) return false;
  return items.some((i) => i?.status === 'PENDING');
}

/**
 * EXACTLY what cancelling this order returns to the buyer.
 *
 * The confirmation dialog used to name no figure at all, and naming the order
 * total instead would be wrong whenever a seller has already cancelled (and been
 * refunded for) part of the order — the buyer would be promised money that has
 * already been sent.
 *
 * This is `refundAmountFor()` from backend/src/services/orderRefund.service.js,
 * for the buyer-cancel case (every still-open line goes at once, so the cancel is
 * always "fully cancelled" and the refund is the whole remaining total — which is
 * what returns the delivery fee):
 *
 *   refund = orderTotal − Σ(lines a previous cancel already refunded)
 *
 * where a line refunds its `totalPrice`, plus its `taxAmount` when tax was ADDED
 * on top of the prices rather than included in them. Summed in integer paise so
 * it agrees with the server's Decimal arithmetic to the last rupee.
 *
 * Returns `amount: null` — never a guess — when the payload has no items to work
 * from, so the dialog can say a refund is coming without naming a figure.
 */
export function cancelRefundPreview(order) {
  const cod = order?.paymentMethod === 'cod';
  const refundable = Boolean(order)
    && !cod
    && Boolean(order.paymentRef)
    && MONEY_HELD.has(order.paymentStatus);

  if (!refundable) return { refundable: false, cod, amount: null };

  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return { refundable: true, cod, amount: null };

  // Tax ADDED on top (a shop setting the order does not record) is read back off
  // the order's own arithmetic, exactly as the server does:
  //   total = subtotal + delivery + addedTax − discount
  const addedTax = paise(order.totalAmount) - paise(order.subtotal)
    - paise(order.deliveryFee) + paise(order.discountAmount);
  const addsTax = paise(order.taxAmount) > 0 && addedTax > 0;
  const linePaise = (i) => paise(i?.totalPrice) + (addsTax ? paise(i?.taxAmount) : 0);

  const alreadyRefunded = items
    .filter((i) => i?.status === 'CANCELLED')
    .reduce((sum, i) => sum + linePaise(i), 0);

  const remaining = Math.max(0, paise(order.totalAmount) - alreadyRefunded);
  return { refundable: remaining > 0, cod, amount: remaining / 100 };
}
