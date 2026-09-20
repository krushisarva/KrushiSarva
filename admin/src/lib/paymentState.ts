/**
 * Payment-intent state — where the money actually stands.
 *
 * `PaymentIntent.status` (Prisma enum `PaymentIntentStatus`) is what
 * GET /admin/payment-intents returns. It does NOT on its own say whether money
 * is with the buyer: REFUND_INITIATED means both "the refund is on its way" and
 * "the gateway refused the refund and a human must do it by hand" — the two are
 * told apart only by the AUTO-REFUND FAILED prefix on `failureReason`
 * (backend shopPayment.service.js `refundUnorderedPayment`).
 *
 * How each DB status reaches the buyer, via backend `intentPublicStatus`
 * (shopPayment.service.js) — the farmer-facing states of the same row:
 *
 *   DB status         → public state   → what the buyer is told
 *   CREATED           → PENDING        → "still confirming your payment"
 *   PENDING           → PENDING        → "still confirming your payment"
 *   PAID              → CONFIRMING     → "gone through, we are creating your order"
 *   ORDER_CREATED     → ORDER_CREATED  → (terminal, order exists)
 *   REFUND_INITIATED  → REFUNDING      → refund under way, OR (AUTO-REFUND FAILED)
 *                                        "our team is arranging your refund"
 *   REFUNDED          → REFUNDED       → refunded, 5–7 working days
 *   FAILED            → FAILED         → (terminal)
 *   CANCELLED         → CANCELLED      → (terminal)
 *   EXPIRED           → EXPIRED        → (terminal)
 *   (no intent row)   → UNKNOWN        → nothing to show
 *
 * `intentPublicStatus` is farmer-facing and is NOT exposed on the admin
 * endpoint, so this module maps the DB status the admin API does send. Every
 * value of the enum is handled explicitly; a status this build has never heard
 * of degrades to a visible "unrecognised" badge rather than silently reading as
 * "no money taken".
 */

/** Prefix backend shopPayment.service.js writes when the gateway refund call failed. */
export const AUTO_REFUND_FAILED = 'AUTO-REFUND FAILED';

/** `PaymentIntentStatus` — must match the Prisma enum and the route's `status` validator. */
export const INTENT_STATUSES = [
  'CREATED', 'PENDING', 'PAID', 'ORDER_CREATED', 'REFUND_INITIATED', 'REFUNDED', 'FAILED', 'CANCELLED', 'EXPIRED',
] as const;

export type Tone = 'green' | 'red' | 'amber' | 'blue' | 'slate' | 'violet';

export interface MoneyState { label: string; tone: Tone }

/** The fields `moneyState` reads — a subset of the payment-intent row. */
export interface IntentLike {
  status: string;
  orderId?: string | null;
  failureReason?: string | null;
}

/**
 * True only for the rows a human has to finish by hand. Deliberately gated on
 * REFUND_INITIATED, exactly as the backend's `refundFailed=true` filter is: a
 * row refunded by hand afterwards keeps its stale AUTO-REFUND FAILED reason, and
 * without the status check it would sit in the queue as red for ever.
 */
export function isAutoRefundFailed(i: IntentLike): boolean {
  return i.status === 'REFUND_INITIATED' && String(i.failureReason || '').startsWith(AUTO_REFUND_FAILED);
}

/** A PaymentIntentStatus rendered for a human — never a raw enum, never blank. */
export function gatewayStatusLabel(status?: string | null): string {
  const s = String(status ?? '').trim();
  if (!s) return 'Unknown';
  return s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

/** Where the money stands for one intent. Pure. */
export function moneyState(i: IntentLike): MoneyState {
  if (isAutoRefundFailed(i)) return { label: 'Auto-refund failed — refund by hand', tone: 'red' };
  switch (i.status) {
    case 'REFUND_INITIATED': return { label: 'Refund under way', tone: 'amber' };
    case 'REFUNDED': return { label: 'Refunded', tone: 'violet' };
    // PAID with no order is the whole point of this queue: money taken, nothing bought.
    case 'PAID': return i.orderId ? { label: 'Paid', tone: 'green' } : { label: 'Paid — no order', tone: 'red' };
    case 'ORDER_CREATED': return { label: 'Order placed', tone: 'green' };
    case 'FAILED': return { label: 'Payment failed — no money taken', tone: 'slate' };
    case 'CANCELLED': return { label: 'Cancelled — no money taken', tone: 'slate' };
    case 'EXPIRED': return { label: 'Abandoned — no money taken', tone: 'slate' };
    case 'CREATED':
    case 'PENDING': return { label: 'Awaiting payment', tone: 'slate' };
    // A status added to the backend enum after this build shipped. Saying
    // "no money taken" about it would be a guess about somebody's money.
    default: return { label: `Unrecognised state — check Razorpay (${gatewayStatusLabel(i.status)})`, tone: 'amber' };
  }
}
