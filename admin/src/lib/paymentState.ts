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

/**
 * `PaymentPurpose` — what the money was for. Must match the Prisma enum and the
 * route's `purpose` validator.
 *
 * One payment core serves every product area (PAY-001), so `status` alone no
 * longer says what a row IS: a REFUND_INITIATED shop order and a
 * REFUND_INITIATED rent booking are worked by different people, with different
 * questions to answer. The column exists so the queue can be split by the thing
 * that actually decides who picks the row up.
 */
export const PAYMENT_PURPOSES = [
  'SHOP_ORDER', 'RENT_BOOKING', 'AI_CREDITS', 'ANIMAL_TOKEN',
] as const;

export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

const PURPOSE_LABEL: Record<string, string> = {
  SHOP_ORDER: 'AgriStore order',
  RENT_BOOKING: 'Rent booking',
  AI_CREDITS: 'AI credits',
  ANIMAL_TOKEN: 'AnimalTrade token',
};

/**
 * A purpose this build has never heard of shows its raw value rather than
 * degrading to something friendly-looking. A backend that has grown a purpose
 * the admin app has not should be visible, not smoothed over — the alternative
 * is a row nobody can explain.
 */
export function purposeLabel(purpose?: string | null): string {
  if (!purpose) return 'AgriStore order'; // pre-PAY-001 rows carry the default
  return PURPOSE_LABEL[purpose] ?? purpose;
}

export type Tone = 'green' | 'red' | 'amber' | 'blue' | 'slate' | 'violet';

/**
 * How hard a row pulls at an operator — the thing the queue is sorted by in a
 * human's head, and the only reason to mark a row out from its neighbours.
 *
 *   'act'   — money is out of the buyer's account and only a person can put it
 *             back or finish the purchase. Nothing in the platform will move
 *             this row on its own.
 *   'watch' — the platform is still working on it (or this build does not know
 *             the status): correct today, wrong if it is still here tomorrow.
 *   'rest'  — settled, or no money ever left the buyer. Nothing owed.
 *
 * It travels on MoneyState rather than being re-derived by each screen so the
 * badge and the row it sits in can never disagree about how urgent a row is.
 */
export type Attention = 'act' | 'watch' | 'rest';

export interface MoneyState { label: string; tone: Tone; attention: Attention }

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
  if (isAutoRefundFailed(i)) return { label: 'Auto-refund failed — refund by hand', tone: 'red', attention: 'act' };
  switch (i.status) {
    case 'REFUND_INITIATED': return { label: 'Refund under way', tone: 'amber', attention: 'watch' };
    case 'REFUNDED': return { label: 'Refunded', tone: 'violet', attention: 'rest' };
    // PAID with no order is the whole point of this queue: money taken, nothing bought.
    case 'PAID': return i.orderId
      ? { label: 'Paid', tone: 'green', attention: 'rest' }
      : { label: 'Paid — no order', tone: 'red', attention: 'act' };
    case 'ORDER_CREATED': return { label: 'Order placed', tone: 'green', attention: 'rest' };
    case 'FAILED': return { label: 'Payment failed — no money taken', tone: 'slate', attention: 'rest' };
    case 'CANCELLED': return { label: 'Cancelled — no money taken', tone: 'slate', attention: 'rest' };
    case 'EXPIRED': return { label: 'Abandoned — no money taken', tone: 'slate', attention: 'rest' };
    case 'CREATED':
    case 'PENDING': return { label: 'Awaiting payment', tone: 'slate', attention: 'watch' };
    // A status added to the backend enum after this build shipped. Saying
    // "no money taken" about it would be a guess about somebody's money, and
    // 'rest' would hide it — so it is worth a look without claiming to be urgent.
    default: return {
      label: `Unrecognised state — check Razorpay (${gatewayStatusLabel(i.status)})`,
      tone: 'amber',
      attention: 'watch',
    };
  }
}

/**
 * The operator's next step, for the two states where a row is somebody's job.
 *
 * Both sentences restate behaviour this repository already documents — the
 * automatic refund walks a captured-with-no-order intent REFUND_INITIATED →
 * REFUNDED, and writes the AUTO-REFUND FAILED prefix when the gateway call is
 * refused (backend shopPayment.service.js `refundUnorderedPayment`). Nothing
 * here is advice invented for the screen: every other state returns null rather
 * than guess at what an operator should do about somebody’s money.
 */
export function moneyAdvice(i: IntentLike): string | null {
  if (isAutoRefundFailed(i)) {
    return 'The gateway refused the automatic refund. Refund this payment by hand in the Razorpay dashboard, using the gateway payment id below.';
  }
  if (i.status === 'PAID' && !i.orderId) {
    return 'Captured with nothing bought. The automatic refund takes rows like this to Refunded on its own — one that is still sitting here has not been picked up.';
  }
  return null;
}

// ── The triage queues ─────────────────────────────────────────────────────────

/**
 * The two views worth a one-click chip, and the only two where an operator is
 * the thing standing between a farmer and their money.
 *
 * They live here rather than in the page because their meaning is the backend's:
 * `params` are the query the admin route understands (shopCompliance.routes.js
 * `orphanedWhere` / `refundFailedWhere`), and `summaryKey` names the count
 * GET /admin/payment-intents/summary returns for exactly that query. A label
 * invented in the page could drift from the rows it actually shows.
 */
export interface QueueView {
  /** The `view` value the page holds in state. */
  value: 'orphaned' | 'refundFailed';
  /** Chip text — short enough to sit in a button. */
  label: string;
  /** The full sentence, for the chip's title. */
  description: string;
  /** What an empty queue means — the good news, said plainly. */
  emptyLabel: string;
  tone: Tone;
  /** Query params for GET /admin/payment-intents. */
  params: Record<string, boolean>;
  /** Field on the summary payload carrying this view's count. */
  summaryKey: 'orphaned' | 'refundFailed';
}

export const QUEUE_VIEWS: readonly QueueView[] = [
  {
    value: 'refundFailed',
    label: 'Refund by hand',
    description: 'Auto-refund FAILED — the money is still with the buyer’s bank and only a human can return it, in the Razorpay dashboard.',
    tone: 'red',
    emptyLabel: 'No automatic refund has failed. Nothing is waiting on a hand refund.',
    params: { refundFailed: true },
    summaryKey: 'refundFailed',
  },
  {
    value: 'orphaned',
    label: 'Paid, no order',
    description: 'Money taken with nothing bought — captured payments with no order behind them, plus the auto-refunds that failed.',
    tone: 'amber',
    emptyLabel: 'Every captured payment has an order behind it, and no automatic refund has failed.',
    params: { orphaned: true },
    summaryKey: 'orphaned',
  },
];

// ── Queue counts ──────────────────────────────────────────────────────────────

/**
 * A count from GET /admin/payment-intents/summary. Capped server-side so the
 * query cost stays bounded as payment_intents grows: `capped` means the true
 * number is higher than `count`, and the only honest thing to print is "500+".
 */
export interface QueueCount { count: number; capped: boolean }

export interface IntentSummary {
  /** The server-side cap `capped` refers to. */
  cap: number;
  orphaned: QueueCount;
  refundFailed: QueueCount;
  /**
   * The orphan queue split by product area — who picks these rows up.
   * `null` when the queue was too large to break down cheaply; the panel then
   * shows no split rather than a partial one.
   */
  byPurpose: Record<string, number> | null;
  generatedAt: string;
}

/** A capped count as text. Never prints a number it cannot stand behind. */
export function formatQueueCount(c: QueueCount | undefined, cap: number): string {
  if (!c) return '';
  return c.capped ? `${cap}+` : String(c.count);
}
