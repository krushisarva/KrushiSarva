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

/** paymentStatus values that mean the buyer's money DID reach us — even if it has since gone back. */
const MONEY_MOVED = new Set(['paid', 'partially_refunded', 'refund_pending', 'refunded']);

/**
 * How an order is paid for — the words that sit beside its total.
 *
 * My Orders printed the label "Paid" above every total, including a
 * cash-on-delivery order nobody had paid a rupee for yet. A farmer reading
 * "Paid ₹609" and then being asked for ₹609 at the door has been told two
 * different things by the same app.
 *
 *   cash on delivery            → "Cash on Delivery" — the METHOD, which is true
 *                                 before the goods arrive and after
 *   paid through the gateway    → "Paid online" — only when paymentStatus says
 *                                 the money actually moved (a refund in progress
 *                                 still means it was paid; the refund line says
 *                                 the rest)
 *   anything else               → null. Nothing about money beats a guess.
 */
export function orderPaymentLabel(order) {
  const method = typeof order?.paymentMethod === 'string' ? order.paymentMethod.trim().toLowerCase() : '';
  if (method === 'cod') return { key: 'checkout.cod', fallback: 'Cash on Delivery' };
  if (method && MONEY_MOVED.has(order?.paymentStatus)) return { key: 'orders.paidOnline', fallback: 'Paid online' };
  return null;
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

// ── Delivery: the promised date, the shops, the code ──────────────────────────
/**
 * My Orders said nothing about delivery: no date, no shop, no way to reach the
 * person bringing the goods. Everything in this section turns two fields the
 * order response gained (docs/SELLER_DELIVERY_DESIGN.md §8.2) into what the card
 * shows:
 *
 *   expectedBy  ISO time = createdAt + promisedEtaDays days, or null
 *   deliveries  one entry per seller on the order:
 *               { sellerId, sellerName, status, sellerPhone, deliveryCode }
 *
 * EVERY ONE OF THEM IS OPTIONAL. A backend that predates this work sends
 * neither, and a newer one sends null for most of them most of the time (the
 * phone only while the seller is delivering, the code only once the goods have
 * left the shop). So each function here answers "nothing to show" for missing
 * data — null or an empty list — and the card then renders exactly as it did
 * before. Nothing may reach the screen as an empty box, a raw enum or "Invalid
 * Date".
 *
 * Kept free of `t` like the rest of this file: the helpers return a key and its
 * English fallback, and the screen does the lookup.
 */

/** An order — or one shop's part of it — that is still on its way. */
const DELIVERY_LIVE = new Set(['PENDING', 'CONFIRMED', 'SHIPPED']);
/** Finished: nothing more is coming, so no date, no phone and no code. */
const DELIVERY_DONE = new Set(['DELIVERED', 'CANCELLED', 'REFUNDED']);

/**
 * SHIPPED has its own NEW key. The stored status is unchanged; only the wording
 * is — a seller driving the goods over in their own vehicle has not "shipped"
 * anything, and "Out for delivery" is what tells the farmer to stay near their
 * phone. `orders.statusShipped` is left exactly as it was: the seller app and
 * older builds still read it.
 */
const ORDER_STATUS_LABELS = {
  PENDING:   { key: 'orders.statusPending',        fallback: 'Pending' },
  CONFIRMED: { key: 'orders.statusConfirmed',      fallback: 'Confirmed' },
  SHIPPED:   { key: 'orders.statusOutForDelivery', fallback: 'Out for delivery' },
  DELIVERED: { key: 'orders.statusDelivered',      fallback: 'Delivered' },
  CANCELLED: { key: 'orders.statusCancelled',      fallback: 'Cancelled' },
  REFUNDED:  { key: 'orders.statusRefunded',       fallback: 'Refunded' },
};

/**
 * The words for an order status — the order badge and each shop's own status
 * both come through here, so the two can never disagree about what SHIPPED is
 * called.
 *
 * A status this build has never heard of comes back with `key: null` and a
 * title-cased phrase (see humanOrderStatus); a missing one comes back null, so
 * the caller renders nothing rather than an empty pill.
 *
 * @returns {{key: string|null, fallback: string}|null}
 */
export function orderStatusLabel(status) {
  // hasOwnProperty, not a bare lookup: a status of "constructor" must not
  // resolve to Object.prototype's.
  if (typeof status === 'string' && Object.prototype.hasOwnProperty.call(ORDER_STATUS_LABELS, status)) {
    return ORDER_STATUS_LABELS[status];
  }
  const fallback = humanOrderStatus(status);
  return fallback ? { key: null, fallback } : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO string (or a Date) → a real Date, or null. Never an "Invalid Date". */
function toDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  // Strings only. `new Date(null)` is 1 Jan 1970 and `new Date(7)` is seven
  // milliseconds after it — both would print as a confident, wrong promise.
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** "Now" as a Date, from a Date or epoch milliseconds. Falls back to the clock. */
function toNow(now) {
  const d = now instanceof Date ? now : new Date(typeof now === 'number' ? now : NaN);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

/** promisedEtaDays → a usable day count, or null. `Number(null)` is 0, hence the guard. */
function etaDays(value) {
  const n = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The moment the order was promised by.
 *
 * The server's `expectedBy` wins when it is there. A backend that predates the
 * field still sends `createdAt` and `promisedEtaDays`, and the sum is the same
 * instant — so the farmer on an old server gets the same date, not a blank.
 *
 * Null when no promise was recorded (`promisedEtaDays` is null on orders placed
 * before serviceability existed). No date is better than an invented one.
 *
 * @returns {Date|null}
 */
export function orderExpectedBy(order) {
  const fromServer = toDate(order?.expectedBy);
  if (fromServer) return fromServer;

  const created = toDate(order?.createdAt);
  const days = etaDays(order?.promisedEtaDays);
  if (!created || days == null) return null;
  return toDate(new Date(created.getTime() + days * DAY_MS));
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "16 Oct" — day and short month, formatted for India, in the phone's own zone.
 *
 * The same `en-IN` formatter the card footer uses for the order date, so the
 * two dates on one card are always written the same way on a given phone (the
 * engine's month names are not identical across versions — "Sep" on one,
 * "Sept" on another — and a hand-built table would disagree with one of them).
 *
 * The year is added only when it is not this year, so a promise from last
 * December is not read as one for this December.
 *
 * The hand-built form is only the fallback for an engine that throws or answers
 * with nothing: a blank where the date goes would leave "Arriving by" hanging.
 *
 * @returns {string|null}
 */
export function formatOrderDay(date, now = Date.now()) {
  const d = toDate(date);
  if (!d) return null;
  const sameYear = d.getFullYear() === toNow(now).getFullYear();
  try {
    const text = d.toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
    });
    if (typeof text === 'string' && text.trim()) return text;
  } catch { /* fall through to the hand-built form */ }
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}

/** A calendar day in the phone's zone as one comparable number (20261016). */
const localDay = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

/**
 * The "Arriving by 16 Oct" line, or null when there is nothing to promise.
 *
 * Shown only while the order is still on its way. A delivered, cancelled or
 * refunded order has no arrival to wait for, and a status this build does not
 * know gets nothing either — "Arriving by" under a RETURNED badge would be a
 * promise the app cannot stand behind.
 *
 * LATE is decided by the calendar day, not the instant. `expectedBy` is the
 * order time plus N days — 2:32 pm, say — but what the farmer was told is a
 * DAY. At 6 pm on that day the promise is not broken yet; from the next morning
 * it is, and the line says so plainly rather than keep showing a date in the
 * past as though it were still a promise.
 *
 * @param {object} order
 * @param {number|Date} [now] injectable for tests
 * @returns {{late: boolean, date: Date, dateText: string, key: string, fallback: string}|null}
 */
export function orderEta(order, now = Date.now()) {
  if (!DELIVERY_LIVE.has(order?.status)) return null;
  const date = orderExpectedBy(order);
  if (!date) return null;

  const today = toNow(now);
  const late = localDay(today) > localDay(date);
  return {
    late,
    date,
    dateText: formatOrderDay(date, today),
    key: late ? 'orders.expectedLate' : 'orders.arrivingBy',
    fallback: late ? 'Expected by {{date}} — running late' : 'Arriving by {{date}}',
  };
}

/**
 * The delivery code, ready to show and to be read aloud.
 *
 *   spaced  "4 0 7 2"     what the card prints, large
 *   spoken  "4, 0, 7, 2"  the accessibility label
 *
 * The comma matters. A screen reader handed "4072" says "four thousand and
 * seventy-two", and handed "4 0 7 2" some speech engines still join the digits
 * back into one number. A farmer repeating that at the door gives the delivery
 * person something that is not the code. Comma-separated digits are read one at
 * a time by every engine.
 *
 * Accepts a STRING of 4 to 6 digits and nothing else. The server issues exactly
 * four today; the extra room means a longer code later does not blank the box on
 * this build. A number is refused outright — 0407 arrives as 407, and showing a
 * farmer a code with its leading zero missing is worse than showing none (the
 * seller can still deliver without a code and give a reason).
 *
 * @returns {{digits: string[], spaced: string, spoken: string}|null}
 */
export function deliveryCodeView(code) {
  if (typeof code !== 'string') return null;
  const clean = code.trim();
  if (!/^[0-9]{4,6}$/.test(clean)) return null;
  const digits = clean.split('');
  return { digits, spaced: digits.join(' '), spoken: digits.join(', ') };
}

/**
 * A phone number reduced to something the dialler accepts, or null.
 *
 * Digits and one leading '+', the same reduction utils/sanitize.js applies
 * before a `tel:` link — plus a length check, because a Call button on a masked
 * or truncated number ("98******10" → "9810") opens the dialler on nothing
 * useful. 6–15 digits covers a short landline up to a full E.164 number.
 *
 * @returns {string|null}
 */
export function callablePhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const clean = String(value).replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  const count = clean.replace(/\D/g, '').length;
  return count >= 6 && count <= 15 ? clean : null;
}

/** How many product names a shop's block lists before "+N more". */
const DELIVERY_ITEM_NAMES = 2;

/**
 * One block per shop delivering this order.
 *
 * Each block answers what a farmer waiting for goods asks: which shop, where is
 * it up to, how do I ring them, and — once the goods have left the shop — what
 * code do I give at the door.
 *
 * ── What comes back for missing data ─────────────────────────────────────────
 *   no `deliveries` (older backend)        → no blocks; the card is as it was
 *   a finished order                       → no blocks; nothing is coming
 *   no entry still on its way              → no blocks
 *   one shop with no name, phone or code   → no blocks, not an empty row
 *   `sellerName` null                      → `name: null`; the screen says
 *                                            "Shop" / "Shop 2" (see `ordinal`)
 *   `sellerPhone` null or unusable         → `phone: null`, no Call button
 *   `deliveryCode` null or malformed       → `code: null`, no code box
 *
 * ── One shop vs several ──────────────────────────────────────────────────────
 * `compact` is true for an order from a single shop, which is nearly all of
 * them. Its status is already the order badge, and its goods are already the
 * item row, so the block repeats neither (`showStatus` false, `itemNames`
 * empty) — a name and a Call button on one line.
 *
 * With several shops each block carries its own status and the names of the
 * goods that shop is bringing. That is what stops the wrong code being given:
 * two shops mean two different codes, and the farmer has to be able to match
 * the person at the door to a block by more than a shop name they may not
 * remember.
 *
 * The phone and the code are passed through only as far as this view model and
 * the card that renders it. Nothing here logs, caches or persists them.
 *
 * @param {object} order
 * @param {{language?: string}} [opts] 'mr' picks the Marathi product names
 * @returns {{compact: boolean, blocks: Array<{
 *   key: string, sellerId: string|null, ordinal: number, name: string|null,
 *   status: string|null, statusLabel: {key: string|null, fallback: string}|null,
 *   showStatus: boolean, phone: string|null,
 *   code: {digits: string[], spaced: string, spoken: string}|null,
 *   itemNames: string[], moreItems: number }>}}
 */
export function orderDeliveries(order, opts) {
  const language = opts?.language;
  const none = { compact: false, blocks: [] };
  if (!order || DELIVERY_DONE.has(order.status)) return none;

  const entries = Array.isArray(order.deliveries)
    ? order.deliveries.filter((d) => d && typeof d === 'object' && !Array.isArray(d))
    : [];
  // Shown only while something is still on its way. An order whose every shop
  // has delivered or cancelled has no one left to call and no code to give.
  if (!entries.some((d) => DELIVERY_LIVE.has(d.status))) return none;

  const compact = entries.length === 1;
  const items = Array.isArray(order.items) ? order.items.filter(Boolean) : [];
  const nameOf = (it) => (language === 'mr' && it.productNameMr)
    || it.productName || it.product?.name || null;

  const blocks = entries.map((d, i) => {
    const status = typeof d.status === 'string' && d.status.trim() ? d.status : null;
    const statusLabel = orderStatusLabel(status);
    const sellerId = typeof d.sellerId === 'string' && d.sellerId ? d.sellerId : null;
    const name = typeof d.sellerName === 'string' && d.sellerName.trim() ? d.sellerName.trim() : null;

    let itemNames = [];
    let moreItems = 0;
    if (!compact && sellerId) {
      const mine = items.filter((it) => it.sellerId === sellerId);
      // The goods still coming. If the shop cancelled every line, name those
      // instead, so a "Cancelled" block still says what it was for.
      const open = mine.filter((it) => it.status !== 'CANCELLED');
      const names = (open.length ? open : mine)
        .map(nameOf)
        .filter((n) => typeof n === 'string' && n.trim());
      itemNames = names.slice(0, DELIVERY_ITEM_NAMES);
      moreItems = Math.max(names.length - DELIVERY_ITEM_NAMES, 0);
    }

    return {
      // Index first: the server's order is stable, and a repeated sellerId (it
      // should never happen) must not produce two rows with one React key.
      key: `${i}:${sellerId || ''}`,
      sellerId,
      ordinal: i + 1,
      name,
      status,
      statusLabel,
      // With one shop the order badge already says this, unless the two differ.
      showStatus: Boolean(statusLabel) && (!compact || status !== order.status),
      // The server sends the phone only while the shop is delivering. Dropped
      // here too once that shop is done, so a row folded locally (a cancel the
      // farmer just made) cannot leave a Call button behind.
      phone: DELIVERY_DONE.has(status) ? null : callablePhone(d.sellerPhone),
      // A code means something only while the goods are on the road.
      code: status === 'SHIPPED' ? deliveryCodeView(d.deliveryCode) : null,
      itemNames,
      moreItems,
    };
  });

  if (compact) {
    const [only] = blocks;
    if (!only.name && !only.phone && !only.code && !only.showStatus) return none;
  }
  return { compact, blocks };
}

// ── What the delivery charge is made of ───────────────────────────────────────
/**
 * The lines to print under "Delivery charges" — or none.
 *
 * The cart showed one figure. A shop may add its own extra charge for a far
 * village (seller app → Delivery areas), and that used to be folded into the
 * figure unannounced: the farmer saw ₹69 where another shop showed ₹49 and was
 * told nothing about why. The server now sends what the fee is made of
 * (`deliveryBreakdown`, see services/shopPricing.service.js):
 *
 *   base   the standard fee per delivery (0 when free delivery applied)
 *   area   the shop's extra charge for this PIN code
 *   heavy  handling for heavy items
 *   cod    the cash-on-delivery fee
 *
 * `source` is a cart QUOTE, or an order's `pricingSnapshot` — both carry the
 * same two things, the split and each shipment's `freeDeliveryApplied`.
 *
 * ── When it returns nothing ──────────────────────────────────────────────────
 *   - an older backend, or an order placed before the split was recorded;
 *   - a charge that is ONLY the standard fee. That is nearly every cart, the one
 *     row "Delivery charges ₹49" already says all of it, and repeating it as a
 *     sub-line underneath would be noise on the screen people check the price on.
 *
 * So the lines appear exactly when there is something to explain: an extra the
 * farmer did not expect.
 *
 * The standard line is kept even at ₹0 when free delivery applied (`free`), so
 * "Free delivery" and "Delivery charges ₹20" on the same order do not read as a
 * contradiction: delivery IS free, and the ₹20 is the shop's own charge.
 *
 * Amounts are plain numbers for display. Nothing here is added up into a total —
 * the total on screen is always the server's own.
 *
 * @returns {Array<{id: 'base'|'area'|'heavy'|'cod', key: string, fallback: string, amount: number, free: boolean}>}
 */
export function deliveryBreakdownLines(source) {
  const split = source?.deliveryBreakdown;
  if (!split || typeof split !== 'object' || Array.isArray(split)) return [];

  const part = (v) => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const base = part(split.base);
  const area = part(split.area);
  const heavy = part(split.heavy);
  const cod = part(split.cod);
  if (!area && !heavy && !cod) return [];

  const shipments = Array.isArray(source.shipments) ? source.shipments : [];
  const freeApplied = shipments.some((s) => s?.freeDeliveryApplied === true);

  const lines = [];
  if (base > 0) {
    lines.push({ id: 'base', key: 'cart.deliveryStandard', fallback: 'Standard delivery', amount: base, free: false });
  } else if (freeApplied) {
    lines.push({ id: 'base', key: 'cart.deliveryStandard', fallback: 'Standard delivery', amount: 0, free: true });
  }
  if (area) lines.push({ id: 'area', key: 'cart.deliveryArea', fallback: 'Extra charge for your area', amount: area, free: false });
  if (heavy) lines.push({ id: 'heavy', key: 'cart.deliveryHeavy', fallback: 'Heavy item handling', amount: heavy, free: false });
  if (cod) lines.push({ id: 'cod', key: 'cart.deliveryCod', fallback: 'Cash on delivery fee', amount: cod, free: false });
  return lines;
}
