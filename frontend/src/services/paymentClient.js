/**
 * Payment endpoints — purpose-agnostic.
 *
 * KrushiSarva takes money for three different things (shop orders, rent
 * bookings, AI credit packs) through one gateway and one WebView checkout. The
 * shop's client (screens/AgriStore/shopClient.js) got there first and is
 * hard-wired to `/agristore/*`, so rent and credits would each have had to grow
 * their own copy of initiate → confirm → status. This is that layer, once.
 *
 * ── Thin on purpose ──────────────────────────────────────────────────────────
 * Same split shopClient.js uses: this file is URLs and response shapes only.
 * The rules about HOW to call — sequencing, the dismissal status check, bounded
 * polling, double-tap protection — live in components/payments/usePaymentFlow.js.
 *
 * ── What is NEVER sent from here ─────────────────────────────────────────────
 * An amount. Every initiate body below is built by PICKING named fields, not by
 * spreading the caller's object, so a screen cannot accidentally (or a tampered
 * build deliberately) put a price on the wire. The server prices the booking
 * from the listing and the pack from the pack id, mints a gateway order that
 * carries that amount, and re-verifies the HMAC on confirm with a secret key
 * that never leaves it. CLAUDE.md §51: the client is not trusted for money.
 *
 * ── Envelope ─────────────────────────────────────────────────────────────────
 * Every route answers the app's standard `{ success, data }`, so every function
 * here returns `data?.data` — identical unwrapping to shopClient.js.
 */
import api from '@krushisarva/shared/services/api';

/**
 * Re-exported so payment screens have ONE import site, the way shopClient
 * re-exports shopUtils.
 *
 * `classifyError` lives under screens/AgriStore/ for historical reasons — it is
 * not shop-specific (it reads axios errors and the shared API client's
 * `userMessage`), and duplicating the taxonomy for payments would mean two
 * places to keep in step on the one path where getting an error wrong charges a
 * farmer twice. Imported, not copied; not modified.
 */
export { classifyError, SHOP_ERRORS as PAYMENT_ERRORS, SHOP_ACTIONS as PAYMENT_ACTIONS } from '../screens/AgriStore/shopUtils';

// ── Config ────────────────────────────────────────────────────────────────────
/**
 * What the server can actually collect with, right now.
 *
 * Fails CLOSED: any error resolves to "online payment is off". Better to hide a
 * Pay button than to open a checkout sheet that cannot complete — the farmer
 * who gets halfway through a UPI approval on a sheet the server cannot honour
 * is the expensive failure, not the one who sees one fewer button.
 *
 * The flag is `onlineEnabled` because that is what the server has always called
 * it (payments.routes.js, and /agristore/payment-config before it). Naming it
 * anything else here would read as false whenever the server said true — a
 * silently disabled Pay button, which is exactly the failure this function is
 * written to fail-closed AGAINST rather than cause.
 *
 * @returns {Promise<{onlineEnabled: boolean, keyId: string|null, methods: string[]}>}
 */
export async function fetchPaymentConfig(signal) {
  const OFF = { onlineEnabled: false, keyId: null, methods: [] };
  try {
    const { data } = await api.get('/payments/config', { signal });
    const cfg = data?.data;
    if (!cfg) return OFF;
    return {
      // Extra fields the server sends (currency, minAmount, notices…) pass
      // through untouched; the three the app switches on are normalised.
      ...cfg,
      onlineEnabled: cfg.onlineEnabled === true,
      keyId: cfg.keyId || null,
      methods: Array.isArray(cfg.methods) ? cfg.methods : [],
    };
  } catch {
    return OFF;
  }
}

// ── Rent bookings ─────────────────────────────────────────────────────────────
/**
 * Raise a gateway order for a rent booking.
 *
 * The body carries WHAT is being booked, never what it costs: the server prices
 * the range off the listing. `hours` / `workerCount` are omitted rather than
 * sent as undefined so a labour field never lands on a machinery booking.
 *
 * @param {{listingId: string, type: 'machinery'|'labour', startDate: string,
 *          endDate: string, hours?: number, workerCount?: number}} body
 * @returns {Promise<{razorpayOrderId, amount, amountInPaise, currency, receipt,
 *                    mock, quote}|null>}
 */
export async function initiateRentBooking({
  listingId, type, startDate, endDate, hours, workerCount,
} = {}) {
  const { data } = await api.post('/rent/bookings/initiate', {
    listingId,
    type,
    startDate,
    endDate,
    ...(hours != null ? { hours } : {}),
    ...(workerCount != null ? { workerCount } : {}),
  });
  return data?.data || null;
}

/**
 * Turn a verified payment into a booking.
 *
 * Nothing sent here is trusted — it is a CLAIM the server re-verifies against
 * the secret key. A 409 means the slot went to someone else between paying and
 * confirming; the server refunds and says so in the error body, which is why
 * the flow hook reads the conflict detail instead of showing "payment failed"
 * to someone whose money has already moved.
 *
 * @returns {Promise<{booking, paymentStatus: 'PAID'}|null>}
 */
export async function confirmRentBooking({
  razorpayOrderId, razorpayPaymentId, razorpaySignature,
} = {}) {
  const { data } = await api.post('/rent/bookings/confirm', {
    razorpayOrderId, razorpayPaymentId, razorpaySignature,
  });
  return data?.data || null;
}

/**
 * Ask whether an interrupted rent payment actually went through.
 *
 * The most important call in the module, together with its credits twin:
 * without it a farmer whose connection dropped after approving a UPI mandate
 * sees a failure and pays again.
 *
 * @returns {Promise<{status: string, paid: boolean, amount: number}|null>}
 */
export async function fetchRentPaymentStatus(providerOrderId, signal) {
  const { data } = await api.get(
    `/rent/bookings/payment-status/${encodeURIComponent(providerOrderId)}`,
    { signal },
  );
  return data?.data || null;
}

// ── AI credit packs ───────────────────────────────────────────────────────────
/**
 * The packs the server is willing to sell, with server-set prices.
 *
 * Returns an array whichever shape the route answers with (a bare list or
 * `{ packs: [...] }`), and an EMPTY array rather than null on an unexpected
 * body — a screen that maps over this should render "no packs", not crash.
 */
export async function fetchCreditPacks(signal) {
  const { data } = await api.get('/ai/credits/packs', { signal });
  const payload = data?.data;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.packs)) return payload.packs;
  return [];
}

/**
 * Raise a gateway order for a credit pack.
 *
 * `{ packId }` and nothing else — deliberately destructured rather than spread.
 * The price of a pack is the server's to know; a body that could carry an
 * amount is a body someone will eventually set to ₹1 for the ₹500 pack.
 *
 * @returns {Promise<{razorpayOrderId, amount, amountInPaise, currency, receipt,
 *                    mock, pack}|null>}
 */
export async function initiateCreditPurchase({ packId } = {}) {
  const { data } = await api.post('/ai/credits/purchase/initiate', { packId });
  return data?.data || null;
}

/**
 * Credit the pack against a verified payment.
 *
 * `alreadyProcessed: true` is a SUCCESS, not a duplicate error: it means the
 * webhook beat this call to it and the credits are already on the balance. The
 * farmer must be shown their new balance, not an apology.
 *
 * @returns {Promise<{credited: number, balance: number, alreadyProcessed: boolean}|null>}
 */
export async function confirmCreditPurchase({
  razorpayOrderId, razorpayPaymentId, razorpaySignature,
} = {}) {
  const { data } = await api.post('/ai/credits/purchase/confirm', {
    razorpayOrderId, razorpayPaymentId, razorpaySignature,
  });
  return data?.data || null;
}

/**
 * Ask whether an interrupted credit purchase actually went through.
 * @returns {Promise<{status: string, paid: boolean, amount: number}|null>}
 */
export async function fetchCreditPurchaseStatus(providerOrderId, signal) {
  const { data } = await api.get(
    `/ai/credits/purchase/status/${encodeURIComponent(providerOrderId)}`,
    { signal },
  );
  return data?.data || null;
}
