/**
 * Rent booking + payment — the rent-specific parts, with no React, no axios and
 * no react-native in them.
 *
 * The SEQUENCING (initiate → sheet → confirm → status recovery, the bounded
 * poll, the double-tap ref) is not here: it lives in
 * `components/payments/usePaymentFlow`, shared with Shop checkout and credit
 * packs. What is here is what only rent knows — what a booking request body may
 * contain, which way to book when the gateway is unavailable, what a payment
 * outcome should be SAID to a farmer, and how to read a payment state off a
 * booking row. All of it pure, so it runs under the project's plain-node Jest
 * config (frontend/jest.config.js) with no renderer.
 *
 * ── The three rules this module enforces ────────────────────────────────────
 *
 * 1. THE CLIENT NEVER SENDS A PRICE.  `POST /rent/bookings/initiate` prices the
 *    booking from the listing and the date range. A total in the body is at
 *    best ignored and at worst a way to book a ₹40,000 harvester for ₹1, so
 *    neither builder here can emit one. (claude.md §51: never trust client
 *    totals.)
 *
 * 2. A GATEWAY OUTAGE IS NOT A BOOKING OUTAGE.  `shouldPayOnline` is the one
 *    switch, and it fails closed to the free `POST /rent/bookings` this app has
 *    always used. A farmer must never be unable to book a tractor because
 *    Razorpay is down.
 *
 * 3. NEVER PROMISE A REFUND THE SERVER DID NOT PROMISE.  A 409 on confirm means
 *    the slot went while the farmer was paying; whether the money is coming
 *    back is the server's statement to make. `refunded` and the server's own
 *    `message` decide the sentence, and when both are absent the farmer is told
 *    the truth — that a person is looking at it — not a 5–7 day promise this
 *    app invented.
 */
import { PAYMENT_FAILURE } from '../../../components/payments/usePaymentFlow';

// ── Request builders ──────────────────────────────────────────────────────────

/**
 * Keys that would mean "the client decided the price".
 *
 * Exported so the test asserts against the same list the builders are written
 * to avoid, rather than a hand-copied one that can drift out of step with it.
 */
export const PRICE_KEY_PATTERN = /amount|total|price|payable|paise|cost|fee|rate/i;

const posInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/**
 * Arguments for `initiateRentBooking` (POST /rent/bookings/initiate).
 *
 * `hours` and `workerCount` are quantities, not money — the server multiplies
 * its OWN rate by them. Omitted rather than sent as null, because the route
 * validates them as optional integers and a stray null is a 400.
 */
export function buildInitiateArgs({ listingId, type, startDate, endDate, hours, workerCount }) {
  const args = {
    listingId,
    type: type === 'labour' ? 'labour' : 'machinery',
    startDate,
    endDate,
  };
  const h = posInt(hours);
  if (h != null) args.hours = h;
  const w = posInt(workerCount);
  if (w != null) args.workerCount = w;
  return args;
}

/**
 * Body for the LEGACY free booking, `POST /rent/bookings`.
 *
 * Kept alive on purpose — see rule 2. The one thing that changed is that
 * `totalAmount` is no longer sent: the route has derived both the day count and
 * the price from the listing since the pricing fix (rent.routes.js — "the range
 * is the only thing both sides can verify, so it is the only thing that decides
 * the price"), so the field was a client-supplied number the server already
 * threw away. `days` stays, because it is a day count rather than a price and a
 * server older than that fix still reads it.
 */
export function buildLegacyBody({ listingId, type, startDate, endDate, days, hours, workerCount, notes }) {
  const body = type === 'labour'
    ? { labourListingId: listingId }
    : { machineryListingId: listingId };
  body.startDate = startDate;
  body.endDate   = endDate;
  const d = posInt(days);
  if (d != null) body.days = d;
  const h = posInt(hours);
  if (h != null) body.hours = h;
  const w = posInt(workerCount);
  if (w != null) body.workerCount = w;
  const n = typeof notes === 'string' ? notes.trim() : '';
  body.notes = n || null;
  return body;
}

// ── Which way to book ─────────────────────────────────────────────────────────

/**
 * Should this booking go through the gateway, or through the free legacy route?
 *
 * Fails closed in every direction: config still loading (`null`), the call
 * failed (fetchPaymentConfig already resolves to `onlineEnabled: false`), the
 * flag is off, or there is no publishable key to open a sheet with — all of
 * them book for free rather than stranding the farmer.
 */
export function shouldPayOnline(config) {
  return !!(config && config.onlineEnabled === true && config.keyId);
}

/**
 * A simulated intent cannot drive the real checkout script.
 *
 * `mock: true` comes back when the server has no live gateway credentials. Its
 * order id is not one Razorpay's checkout.js will recognise, so opening the
 * sheet with it produces an opaque gateway error. Treated as "not really on":
 * the caller books through the legacy route instead and nobody is asked for
 * money that cannot be collected.
 */
export function isMockIntent(intent) {
  return intent?.mock === true;
}

// ── Notices ───────────────────────────────────────────────────────────────────
//
// A notice is WHAT to say, never how: key + English fallback, resolved through
// t() by the screen. translations.js is owned elsewhere this round, so every
// key here ships with the sentence it should show until the key lands.

const notice = (kind, extra) => ({
  kind,
  titleKey: 'rent.payUnknownTitle',
  titleFallback: 'We could not confirm your payment',
  bodyKey: 'rent.payUnknownMsg',
  bodyFallback: 'Please open My Bookings in a few minutes before trying again, so you are not charged twice.',
  /** Interpolation vars for {{amount}}-style bodies, or null. */
  vars: null,
  /** The server's own sentence, when it sent one. */
  serverMessage: null,
  /** Show `serverMessage` in place of the body when there is one. */
  preferServerMessage: false,
  /** True when money has moved. NOTHING that says "try again" may set this. */
  moneyTaken: false,
  /** May the farmer safely start another payment for these dates? */
  mayRetry: false,
  ...extra,
});

/**
 * The honest answer when the server could not tell us what happened.
 *
 * Deliberately does not say "no money was taken" and does not say "you paid".
 * `usePaymentFlow` only reaches this after four bounded, jittered attempts, so
 * by the time a farmer sees it we really do not know.
 */
export function unknownNotice(report) {
  return notice('UNKNOWN', {
    preferServerMessage: true,
    serverMessage: serverSentence(report?.message),
  });
}

function serverSentence(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function positiveAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Turn a `usePaymentFlow` failure into the sentence to show.
 *
 * The hook hands back a machine-readable reason; this is the only place that
 * decides the words, so "no money was taken" appears exactly three times and
 * each one is on a branch where the server positively said so.
 *
 * @param {{code: string, moneyTaken?: boolean, refunded?: boolean,
 *          noConnection?: boolean, serverMessage?: string|null,
 *          gatewayCode?: string|null, report?: object|null,
 *          error?: object|null}} failure
 */
export function paymentFailureNotice(failure) {
  if (!failure) return unknownNotice(null);
  const server = serverSentence(failure.serverMessage);
  const amount = positiveAmount(failure.report?.amount);

  switch (failure.code) {
    // Could not even raise the gateway order. Nothing was opened, nothing
    // charged. A 409 here is the CHEAP conflict — the slot went while the form
    // was open and no money has moved at all.
    case PAYMENT_FAILURE.INITIATE: {
      if (failure.error?.status === 409) {
        return notice('SLOT_GONE', {
          mayRetry: true,
          titleKey: 'rent.slotTakenTitle', titleFallback: 'Those dates just went',
          bodyKey: 'rent.slotTakenMsg',
          bodyFallback: 'Those dates were just booked by someone else. Please pick another range.',
          serverMessage: server,
        });
      }
      return notice('INITIATE', {
        mayRetry: true,
        titleKey: 'rent.bookingFailed', titleFallback: 'Booking failed',
        bodyKey: 'rent.bookingFailedMsg',
        bodyFallback: 'We could not start the payment. No money was taken — please try again.',
        serverMessage: server,
        preferServerMessage: !!server,
      });
    }

    // checkout.js never loaded. That is no connectivity, NOT a failed payment,
    // and the two need different words and a different next step.
    case PAYMENT_FAILURE.SCRIPT_LOAD:
      return notice('NO_NETWORK', {
        mayRetry: true,
        titleKey: 'rent.payFailedTitle', titleFallback: 'Payment failed',
        bodyKey: 'rent.payNoNetworkMsg',
        bodyFallback: 'Could not open the payment page. Check your internet connection and try again.',
      });

    // The gateway itself reported the payment failed. Nothing was captured.
    case PAYMENT_FAILURE.GATEWAY:
      return notice('GATEWAY', {
        mayRetry: true,
        titleKey: 'rent.payFailedTitle', titleFallback: 'Payment failed',
        bodyKey: 'rent.payFailedMsg',
        bodyFallback: 'No money was taken. Please try again.',
        serverMessage: server,
        preferServerMessage: !!server,
      });

    // The server checked and is certain nothing was paid. This is the ONLY
    // "safe to pay again" branch that is reached without the farmer having seen
    // the gateway refuse — and the hook only produces it after a re-check,
    // because a UPI collect the farmer just approved still reads `created` at
    // the instant the sheet closes.
    case PAYMENT_FAILURE.NOT_PAID:
      return notice('NOT_PAID', {
        mayRetry: true,
        titleKey: 'rent.payNotTakenTitle', titleFallback: 'Payment not completed',
        bodyKey: 'rent.payNotTakenMsg',
        bodyFallback: 'No money was taken. Your dates are still free — you can try again.',
      });

    // Paid, and the booking did not happen. Either the slot went while they
    // were paying (the 409 on confirm) or the status endpoint reported a
    // refund. Rule 3 lives here.
    case PAYMENT_FAILURE.REFUNDED:
      return slotTakenNotice({
        refunded: failure.refunded,
        message: server,
        amount,
      });

    default:
      return unknownNotice(failure.report);
  }
}

/**
 * What to say to a farmer whose money moved but whose booking did not happen.
 *
 * `refunded === true`   the refund is raised — the 5–7 day sentence is honest
 * `refunded === false`  the refund could not be raised — a person is on it
 * absent/undefined      we do not know — promise nothing, and say why
 *
 * The server's own `message` outranks all three when it sent one: a newer
 * server knows more about the state of that money than this table does. Hence
 * `preferServerMessage`.
 */
export function slotTakenNotice({ refunded, message, amount } = {}) {
  const amt = positiveAmount(amount);
  let bodyKey, bodyFallback, vars = null;

  if (refunded === true) {
    if (amt) {
      bodyKey = 'rent.slotTakenRefundedAmountMsg';
      bodyFallback = 'Those dates were booked by someone else while you were paying. {{amount}} is being refunded — it reaches the account you paid from in 5–7 working days.';
      vars = { amount: amt };
    } else {
      bodyKey = 'rent.slotTakenRefundedMsg';
      bodyFallback = 'Those dates were booked by someone else while you were paying. Your payment is being refunded — it reaches the account you paid from in 5–7 working days.';
    }
  } else if (refunded === false) {
    bodyKey = 'rent.slotTakenRefundArrangingMsg';
    bodyFallback = 'Those dates were booked by someone else while you were paying. Our team is arranging your refund — please do not pay again.';
  } else {
    bodyKey = 'rent.slotTakenRefundUnknownMsg';
    bodyFallback = 'Those dates were booked by someone else while you were paying. Our team is checking your payment — please do not pay again until you hear from us.';
  }

  return notice('SLOT_TAKEN', {
    moneyTaken: true,
    // Other dates may be picked. This PAYMENT must never be repeated, which is
    // why every sentence above ends in "do not pay again" unless the refund is
    // already on its way.
    mayRetry: true,
    titleKey: 'rent.slotTakenTitle', titleFallback: 'Those dates just went',
    bodyKey, bodyFallback, vars,
    serverMessage: serverSentence(message),
    preferServerMessage: true,
  });
}

// ── Reading a booking row ─────────────────────────────────────────────────────

/**
 * The four states a booking's payment is shown in.
 *
 * The important asymmetry: a state this build does not recognise becomes
 * PENDING, never UNPAID. "Unpaid" invites the farmer to pay, and an
 * unrecognised state is exactly the case where we do not know whether they
 * already have.
 */
export const PAY_STATE = {
  UNPAID:   'UNPAID',
  PENDING:  'PENDING',
  PAID:     'PAID',
  REFUNDED: 'REFUNDED',
};

const PAY_STATE_ALIAS = {
  UNPAID: PAY_STATE.UNPAID,
  NONE: PAY_STATE.UNPAID,
  FREE: PAY_STATE.UNPAID,
  NOT_REQUIRED: PAY_STATE.UNPAID,
  FAILED: PAY_STATE.UNPAID,
  CANCELLED: PAY_STATE.UNPAID,
  CANCELED: PAY_STATE.UNPAID,
  EXPIRED: PAY_STATE.UNPAID,
  VOID: PAY_STATE.UNPAID,

  PENDING: PAY_STATE.PENDING,
  CREATED: PAY_STATE.PENDING,
  INITIATED: PAY_STATE.PENDING,
  PROCESSING: PAY_STATE.PENDING,
  CONFIRMING: PAY_STATE.PENDING,
  ATTEMPTED: PAY_STATE.PENDING,

  PAID: PAY_STATE.PAID,
  CAPTURED: PAY_STATE.PAID,
  SUCCESS: PAY_STATE.PAID,
  SUCCEEDED: PAY_STATE.PAID,
  COMPLETED: PAY_STATE.PAID,
  PARTIALLY_REFUNDED: PAY_STATE.PAID,

  REFUNDED: PAY_STATE.REFUNDED,
  REFUNDING: PAY_STATE.REFUNDED,
  REFUND_PENDING: PAY_STATE.REFUNDED,
  REFUND_INITIATED: PAY_STATE.REFUNDED,
};

/** Normalise whatever the server called it into one of the four PAY_STATEs. */
export function normalisePayState(raw) {
  if (raw == null || raw === '') return PAY_STATE.UNPAID;
  const key = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return PAY_STATE_ALIAS[key] || PAY_STATE.PENDING;
}

/**
 * The payment state to badge a booking row with.
 *
 * A booking made through the legacy free path carries no payment at all, and
 * that is not a fault to flag — it is UNPAID and always was.
 */
export function bookingPayState(booking) {
  return normalisePayState(booking?.paymentStatus ?? booking?.payment?.status ?? null);
}

/**
 * The gateway order id to ask `GET /rent/bookings/payment-status/:id` about.
 *
 * Accepts every spelling a booking row might carry it under. The field name is
 * the backend's to choose, and a wrong guess here would silently remove the
 * only way a farmer can find out whether an interrupted payment landed.
 */
export function bookingOrderId(booking) {
  const v = booking?.providerOrderId
    ?? booking?.razorpayOrderId
    ?? booking?.paymentOrderId
    ?? booking?.paymentRef
    ?? booking?.payment?.providerOrderId
    ?? booking?.payment?.razorpayOrderId
    ?? null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Is there anything worth re-checking for this booking?
 *
 * Only a PENDING payment with an order id to ask about. A PAID or REFUNDED row
 * is settled, and an UNPAID one never started a payment — offering "check
 * status" on either is a button that can only ever say "nothing changed".
 */
export function canRecheckPayment(booking) {
  return bookingPayState(booking) === PAY_STATE.PENDING && !!bookingOrderId(booking);
}

/**
 * Fold a `GET /rent/bookings/payment-status/:id` report back into a booking row.
 *
 * Returns the fields to merge, so the list updates in place without a full
 * reload — on a village connection a refetch of every booking to learn one
 * row's payment state is the wrong trade.
 */
export function paymentStatusPatch(report) {
  if (!report) return null;
  const state = report.paid === true
    ? PAY_STATE.PAID
    : normalisePayState(report.status);
  const patch = { paymentStatus: state };
  if (report.booking && typeof report.booking === 'object') {
    Object.assign(patch, report.booking, { paymentStatus: state });
  }
  return patch;
}

/**
 * How a PENDING booking can be re-checked, given what its row actually carries.
 *
 * `canRecheckPayment` above answers the narrow question — is there a gateway
 * order id to ask `GET /rent/bookings/payment-status/:id` about. In practice a
 * booking row very often has no such id: the `bookings` table stores
 * `paymentIntentId`, `paymentStatus` and `paidAmount`, and the provider's order
 * id lives on the payment intent, not on the booking. Without a second answer
 * here, a farmer whose payment was interrupted would be shown a PENDING badge
 * and no way at all to find out what happened to their money — which is the
 * exact failure this whole round of work exists to remove.
 *
 * So: ask the payment-status endpoint when we can, and otherwise re-read the
 * booking itself (`GET /rent/bookings/:id`), which the webhook and the
 * reconciler both write `paymentStatus` onto. Both are ONE request, made on a
 * tap or on screen focus — never a loop (claude.md §42, §46).
 */
export const RECHECK = {
  /** Ask GET /rent/bookings/payment-status/:providerOrderId. */
  ORDER:   'ORDER',
  /** No order id on the row — re-read GET /rent/bookings/:id instead. */
  BOOKING: 'BOOKING',
  /** Settled, or nothing was ever paid. Offering a check would be noise. */
  NONE:    'NONE',
};

export function recheckStrategy(booking) {
  if (!booking) return RECHECK.NONE;
  if (bookingPayState(booking) !== PAY_STATE.PENDING) return RECHECK.NONE;
  return bookingOrderId(booking) ? RECHECK.ORDER : RECHECK.BOOKING;
}

/**
 * How to badge a payment state: which `rent.*`/`payments.*` key, and the tone.
 *
 * Colour is NOT decided here — `COLORS` is a react-native-adjacent import and
 * this module stays pure so it runs under the plain-node Jest config. The
 * screen maps `tone` onto its palette.
 */
export function payStateBadge(state) {
  switch (state) {
    case PAY_STATE.PAID:
      return { tone: 'good',    icon: 'checkmark-circle-outline',
               labelKey: 'rent.payStatePaid',     labelFallback: 'Paid' };
    case PAY_STATE.PENDING:
      return { tone: 'warn',    icon: 'hourglass-outline',
               labelKey: 'rent.payStatePending',  labelFallback: 'Payment pending' };
    case PAY_STATE.REFUNDED:
      return { tone: 'info',    icon: 'return-down-back-outline',
               labelKey: 'rent.payStateRefunded', labelFallback: 'Refunded' };
    default:
      return { tone: 'neutral', icon: 'cash-outline',
               labelKey: 'rent.payStateUnpaid',   labelFallback: 'Pay on handover' };
  }
}

// ── Saying a notice out loud ──────────────────────────────────────────────────

/**
 * Resolve a notice into the two strings an Alert needs.
 *
 * `t` is passed in rather than imported so this stays pure and testable: the
 * rule being pinned is WHICH sentence wins, not how i18n works. The server's
 * own message outranks the local fallback wherever `preferServerMessage` is
 * set — a newer server knows more about the state of that money than a table
 * compiled into an APK from three months ago.
 *
 * @param {object} notice   from paymentFailureNotice / unknownNotice / slotTakenNotice
 * @param {function} t      (key, fallbackOrVars) => string
 * @param {function} [money] number → display string, e.g. `inr`
 */
export function noticeText(notice, t, money) {
  if (!notice) return { title: '', body: '' };
  const title = t(notice.titleKey, notice.titleFallback);

  if (notice.preferServerMessage && notice.serverMessage) {
    return { title, body: notice.serverMessage };
  }

  const amount = notice.vars?.amount;
  if (amount != null && typeof money === 'function') {
    return {
      title,
      body: t(notice.bodyKey, { amount: money(amount), defaultValue: notice.bodyFallback }),
    };
  }
  return { title, body: t(notice.bodyKey, notice.bodyFallback) };
}
