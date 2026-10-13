/**
 * Delivery code and "could not deliver" — no React, no React Native.
 *
 * Every decision the order screen makes about ending a delivery lives here, so
 * it can be tested without a renderer: what to ask the seller for, what to send,
 * and what a refusal means. Contract: docs/SELLER_DELIVERY_DESIGN.md §8.3–8.4.
 *
 * THE CODE. When a seller marks an order out for delivery the server creates a
 * 4-digit code and shows it to the FARMER only. At the door the farmer says it
 * and the seller types it in. The seller is never sent the code; this app only
 * learns `{ hasCode, codeRequired, lockedUntil }` on `row.order.delivery`.
 *
 * AN OLDER BACKEND sends no `delivery` at all. That absence is the switch for
 * everything below: with no `delivery`, every question here answers "as before"
 * — one tap marks delivered, and a shipped order offers nothing but that.
 */
import { FAILED_REASONS, canMove, canSellerCancel } from './sellerOrders';

export { FAILED_REASONS };

/** Why an order was delivered without the code — the route's `noCodeReason` values. */
export const NO_CODE_REASONS = ['FARMER_PHONE_OFF', 'RECEIVED_BY_OTHER', 'HANDED_AT_SHOP', 'OTHER'];

export const CODE_LENGTH = 4;

/**
 * `row.order.delivery` in a shape that is safe to read, or null when the
 * backend did not send it (older backend).
 */
export function deliveryInfo(row) {
  const d = row?.order?.delivery;
  if (!d || typeof d !== 'object') return null;
  const lockedUntil = typeof d.lockedUntil === 'string' && Number.isFinite(Date.parse(d.lockedUntil))
    ? d.lockedUntil
    : null;
  return { hasCode: d.hasCode === true, codeRequired: d.codeRequired === true, lockedUntil };
}

/**
 * What the seller must be asked before moving a card from `from` to `to`:
 *
 *   'confirm'      the yes/no dialog, as the screen has always shown
 *   'code'         the 4-digit delivery code (with "deliver without code")
 *   'noCodeReason' why there is no code
 *   'failedReason' why the goods could not be delivered
 *
 * Marking DELIVERED:
 *   - no `delivery` (older backend)        → confirm
 *   - a code exists                        → code, whether or not it is demanded:
 *     while `shop.delivery.codeRequired` is off the server would accept a bare
 *     "delivered", but the farmer is holding a code and the proof is worth one
 *     question at the door
 *   - no code, and one is demanded         → noCodeReason. No code was ever
 *     issued — the order never went "out for delivery" through an app that
 *     creates one (handed over at the shop) — so there is nothing to type, and
 *     the server wants to know why
 *   - no code, none demanded               → confirm
 *
 * Marking CANCELLED from SHIPPED is "could not deliver" and needs its reason.
 */
export function statusPrompt(from, to, delivery) {
  if (to === 'DELIVERED' && delivery) {
    if (delivery.hasCode) return 'code';
    if (delivery.codeRequired) return 'noCodeReason';
  }
  if (to === 'CANCELLED' && from === 'SHIPPED' && delivery) return 'failedReason';
  return 'confirm';
}

/**
 * Which way out the card offers besides the next step:
 *
 *   'cancel'       "Cancel order" — before the goods leave, exactly as before
 *   'undelivered'  "Could not deliver" — goods are out, and came back
 *   null           neither
 *
 * 'undelivered' needs a backend that sent `delivery`: an older one refuses to
 * cancel a shipped order whatever is sent with it, and a button that can only
 * fail is worse than no button.
 */
export function cancelAction(status, delivery) {
  if (canSellerCancel(status)) return 'cancel';
  if (delivery && canMove(status, 'CANCELLED', { failedReason: FAILED_REASONS[0] })) return 'undelivered';
  return null;
}

/**
 * The reasons for "deliver without code", likeliest first.
 *
 * With a code issued the usual story is at the door: the farmer's phone is off,
 * or someone else took the goods. With no code the order never went out for
 * delivery, so "handed over at my shop" leads. Nothing is pre-selected — the
 * answer is recorded against the seller and has to be chosen.
 */
export function noCodeReasonOptions(hasCode) {
  return hasCode
    ? ['FARMER_PHONE_OFF', 'RECEIVED_BY_OTHER', 'HANDED_AT_SHOP', 'OTHER']
    : ['HANDED_AT_SHOP', 'RECEIVED_BY_OTHER', 'FARMER_PHONE_OFF', 'OTHER'];
}

/** What a code field keeps of what was typed or pasted: digits, four at most. */
export function cleanDeliveryCode(value) {
  return (value == null ? '' : String(value)).replace(/\D/g, '').slice(0, CODE_LENGTH);
}

export function isCompleteCode(code) {
  return typeof code === 'string' && /^\d{4}$/.test(code);
}

/**
 * The PUT body for a status change.
 *
 * Only fields the route reads for THIS status are sent, and never both a code
 * and a no-code reason: the server takes a `noCodeReason` only when no
 * `deliveryCode` came with it, so sending both would turn "deliver without
 * code" into a code attempt — and a wrong one counts towards the lock.
 * Anything malformed is dropped rather than sent to earn a 400.
 */
export function buildStatusPayload(status, sent) {
  const body = { status };
  if (status === 'DELIVERED') {
    if (isCompleteCode(sent?.deliveryCode)) body.deliveryCode = sent.deliveryCode;
    else if (NO_CODE_REASONS.includes(sent?.noCodeReason)) body.noCodeReason = sent.noCodeReason;
  }
  if (status === 'CANCELLED' && FAILED_REASONS.includes(sent?.failedReason)) {
    body.failedReason = sent.failedReason;
  }
  return body;
}

const REFUSAL_CODES = [
  'DELIVERY_CODE_REQUIRED', 'DELIVERY_CODE_WRONG', 'DELIVERY_CODE_LOCKED', 'FAILED_REASON_REQUIRED',
];

/**
 * A delivery refusal read off a failed request, or null for anything else.
 *
 * `{ code, attemptsLeft, lockedUntil }` — the machine code is at
 * `error.details.code` of the house envelope. `attemptsLeft` and `lockedUntil`
 * are read wherever they appear: the fifth wrong try both uses the last attempt
 * and starts the lock, and the screen should show whichever the server sent.
 */
export function deliveryRefusal(error) {
  if (error?.response?.status !== 409) return null;
  const details = error.response.data?.error?.details;
  const code = details?.code;
  if (!REFUSAL_CODES.includes(code)) return null;
  const attempts = Number(details.attemptsLeft);
  return {
    code,
    attemptsLeft: details.attemptsLeft != null && Number.isFinite(attempts) ? Math.max(0, attempts) : null,
    lockedUntil: typeof details.lockedUntil === 'string' && Number.isFinite(Date.parse(details.lockedUntil))
      ? details.lockedUntil
      : null,
  };
}

/**
 * True when the server refused because the order is no longer where this
 * screen thinks it is ("already shipped and cannot be marked cancelled"). The
 * card is showing a stale status, so the list should be read again.
 */
export function isStaleStatusRefusal(error) {
  return error?.response?.status === 409
    && Array.isArray(error.response.data?.error?.details?.from);
}

/** When the code lock ends, in ms, or null when it is not locked (any more). */
export function lockEndsAt(lockedUntil, now) {
  const ms = typeof lockedUntil === 'string' ? Date.parse(lockedUntil) : NaN;
  return Number.isFinite(ms) && ms > now ? ms : null;
}

/**
 * "3:45 PM" on the phone's own clock.
 *
 * Built by hand rather than with toLocaleTimeString: that depends on the ICU
 * data the JS engine was built with, and a lock time that prints differently on
 * two phones — or as a 24-hour time some sellers will misread — is not worth it
 * for one line.
 */
export function clockTime(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * What to tell the seller about a refusal from deliveryRefusal(), in their
 * language. null when there is nothing to say (no refusal).
 *
 * Written here rather than shown from the server's `message`: that one is
 * English only, and these are the sentences a seller reads on a doorstep.
 */
export function refusalText(refusal, t, now = Date.now()) {
  if (!refusal) return null;
  switch (refusal.code) {
    case 'DELIVERY_CODE_WRONG': {
      const n = refusal.attemptsLeft;
      if (n == null) return t('sellerOrders.codeWrong', 'Wrong code. Check it with the farmer and try again.');
      if (n <= 0) return t('sellerOrders.codeWrongNoneLeft', 'Wrong code. No tries are left for now.');
      if (n === 1) return t('sellerOrders.codeWrongOneLeft', 'Wrong code. 1 try left.');
      return t('sellerOrders.codeWrongTriesLeft', { n, defaultValue: 'Wrong code. {{n}} tries left.' });
    }
    case 'DELIVERY_CODE_LOCKED':
      return lockedText(refusal.lockedUntil, t, now);
    case 'DELIVERY_CODE_REQUIRED':
      return t('sellerOrders.codeRequired', 'This order needs the delivery code, or the reason there is no code.');
    case 'FAILED_REASON_REQUIRED':
      return t('sellerOrders.failedReasonRequired', 'This order is out for delivery. Choose why it could not be delivered.');
    default:
      return null;
  }
}

/** The lock, with the time it ends when that is known and still ahead. */
export function lockedText(lockedUntil, t, now = Date.now()) {
  const until = lockEndsAt(lockedUntil, now);
  return until
    ? t('sellerOrders.codeLockedUntil', {
        time: clockTime(until),
        defaultValue: 'Too many wrong codes. You can try the code again after {{time}}.',
      })
    : t('sellerOrders.codeLocked', 'Too many wrong codes. Try the code again later.');
}

/**
 * `rows` with `patch` merged into the `delivery` of every line of `orderId`.
 *
 * Only where a `delivery` already exists — on an older backend there is none to
 * patch and inventing one would switch the code flow on against a server that
 * cannot answer it. Untouched rows keep their identity, so memoised cards do
 * not re-render.
 */
export function patchDelivery(rows, orderId, patch) {
  return rows.map((row) => {
    const delivery = row?.order?.id === orderId ? row.order.delivery : null;
    if (!delivery || typeof delivery !== 'object') return row;
    return { ...row, order: { ...row.order, delivery: { ...delivery, ...patch } } };
  });
}

/**
 * What the server changed besides the status when a move SUCCEEDED, mirrored
 * onto `rows`: marking an order out for delivery creates its code, so the next
 * tap on "delivered" must ask for it without waiting for a refresh.
 */
export function afterMoveSucceeded(rows, orderId, to) {
  return to === 'SHIPPED' ? patchDelivery(rows, orderId, { hasCode: true }) : rows;
}
