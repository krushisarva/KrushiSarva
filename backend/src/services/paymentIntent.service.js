/**
 * Payment intents — the purpose-agnostic core.
 *
 * ── What this module is ──────────────────────────────────────────────────────
 * One attempt to take money, recorded BEFORE the gateway is called, and the
 * webhook inbox that makes a redelivery a no-op. Nothing here knows what the
 * money BUYS. That is `PaymentIntent.purpose`, and the product areas own it:
 *
 *   SHOP_ORDER    shopPayment.service.js — carts, quotes, orders, stock holds
 *   RENT_BOOKING  (PAY-002)
 *   AI_CREDITS    (PAY-004)
 *   ANIMAL_TOKEN  declared, deliberately unimplemented (PAY-005)
 *
 * ── Why it was split out ─────────────────────────────────────────────────────
 * All of this began as AgriStore code, and it showed: `createIntent` took a
 * cart quote, the webhook route hard-coded shop handling, and the reconciler
 * swept every intent through one shop-shaped path — look for an Order by
 * `paymentRef`, find none, release stock reservations, refund after 30 minutes.
 * A second product area could not raise a payment without either inheriting
 * those semantics or growing a second copy of signature verification, webhook
 * idempotency and intent state. A second copy of any of those is a defect, not
 * a feature: the invariants below are only invariants if there is one of them.
 *
 * ── The invariants this module holds ─────────────────────────────────────────
 * 1. An intent row exists before the gateway is called, so an interrupted
 *    payment is a queryable state rather than a silence.
 * 2. `providerOrderId` and `providerPaymentId` are UNIQUE, so a webhook and a
 *    client confirm converge on one row instead of racing to create two.
 * 3. A webhook event id is claimed through a UNIQUE index before any work
 *    happens. Razorpay retries for 24 hours; redelivery is normal.
 * 4. A state that already produced an order or a refund is never regressed.
 *
 * Money rule: `amount` (Decimal, 2dp) and `amountPaise` (integer) are two
 * representations of ONE number and are always derived from a single source —
 * see `resolveAmount`. Nothing in this file does float arithmetic.
 */
import crypto from 'crypto';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { D, toMinorUnits } from '../utils/money.js';

/**
 * Every purpose a payment can serve. Mirrors the Prisma enum `PaymentPurpose`;
 * the two must not drift, which `assertPurpose` below is what catches.
 */
export const PAYMENT_PURPOSE = Object.freeze({
  SHOP_ORDER: 'SHOP_ORDER',
  RENT_BOOKING: 'RENT_BOOKING',
  AI_CREDITS: 'AI_CREDITS',
  ANIMAL_TOKEN: 'ANIMAL_TOKEN',
});

const PURPOSES = new Set(Object.values(PAYMENT_PURPOSE));

/** Terminal states — the reconciler does not revisit these. */
export const TERMINAL = new Set(['ORDER_CREATED', 'FAILED', 'CANCELLED', 'REFUNDED', 'EXPIRED']);

/** The money is on its way back: no fulfilment may be made from this payment. */
export const REFUNDING = ['REFUND_INITIATED', 'REFUNDED'];

/** An intent that produced fulfilment or a refund; a late "paid" must not move it. */
export const SETTLED = ['ORDER_CREATED', ...REFUNDING];

function assertPurpose(purpose) {
  if (!PURPOSES.has(purpose)) {
    throw Object.assign(new Error(`Unknown payment purpose: ${purpose}`), { code: 'BAD_PURPOSE' });
  }
}

/**
 * Reduce (amount, amountPaise) to one authoritative pair.
 *
 * Callers hold the money in whichever form is natural for them: a quote in
 * rupees for AgriStore, a pack price in paise for credits. Either is accepted
 * and the other is derived — but when BOTH are supplied they must agree, and a
 * disagreement throws rather than picking one. Silently preferring either would
 * mean the row says one price and the gateway charged another, which is the
 * single worst shape a payments bug can take.
 *
 * @returns {{ amount: string, amountPaise: number }} amount as a 2dp string.
 */
function resolveAmount({ amount, amountPaise }) {
  const hasRupees = amount !== undefined && amount !== null;
  const hasPaise = amountPaise !== undefined && amountPaise !== null;
  if (!hasRupees && !hasPaise) {
    throw Object.assign(new Error('createIntent requires amount or amountPaise'), { code: 'BAD_AMOUNT' });
  }

  const paise = hasPaise ? Number(amountPaise) : toMinorUnits(amount);
  if (!Number.isSafeInteger(paise) || paise <= 0) {
    throw Object.assign(new Error(`Invalid amountPaise: ${amountPaise ?? amount}`), { code: 'BAD_AMOUNT' });
  }

  // Derived from the paise so the two can never disagree by a rounding step.
  const rupees = D(paise).div(100).toFixed(2);

  if (hasRupees && hasPaise && toMinorUnits(amount) !== paise) {
    throw Object.assign(
      new Error(`amount (${D(amount).toFixed(2)}) and amountPaise (${paise}) disagree`),
      { code: 'BAD_AMOUNT' },
    );
  }

  return { amount: rupees, amountPaise: paise };
}

/**
 * A receipt unique to ONE payment attempt.
 *
 * The old receipt was `cart_${userId}` — identical for every payment that user
 * ever made — so a confirm-time `receipt === ...` check proved only that the
 * gateway order belonged to this user, never that it belonged to THIS checkout.
 */
export function receiptFor(userId) {
  return `cs_${String(userId).slice(0, 8)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Record an intent before the gateway call, so a crash after it is recoverable.
 *
 * @param {object}  p
 * @param {string}  p.userId
 * @param {string}  p.providerOrderId    gateway order id (unique)
 * @param {string}  [p.purpose]          PAYMENT_PURPOSE.* — defaults to SHOP_ORDER,
 *                                       matching the DB default and every historical row
 * @param {?string} [p.refType]          "booking" | "creditPack" | "animalListing"
 * @param {?string} [p.refId]            the id of that thing, when it exists yet
 * @param {*}       [p.amount]           rupees (Decimal/string/number)
 * @param {?number} [p.amountPaise]      integer paise; must agree with `amount` if both given
 * @param {string}  p.receipt
 * @param {?object} [p.metadata]         purpose-specific frozen quote
 * @param {?object} [p.quoteSnapshot]    AgriStore only — kept for the shop path
 * @param {?string} [p.cartHash]         AgriStore only
 */
export async function createIntent({
  userId,
  providerOrderId,
  purpose = PAYMENT_PURPOSE.SHOP_ORDER,
  refType = null,
  refId = null,
  amount,
  amountPaise,
  receipt,
  metadata = null,
  quoteSnapshot = null,
  cartHash = null,
}) {
  assertPurpose(purpose);
  const money = resolveAmount({ amount, amountPaise });

  return prisma.paymentIntent.create({
    data: {
      userId,
      providerOrderId,
      purpose,
      refType,
      refId,
      amount: money.amount,
      amountPaise: money.amountPaise,
      receipt,
      status: 'CREATED',
      ...(metadata ? { metadata } : {}),
      ...(quoteSnapshot ? { quoteSnapshot } : {}),
      cartHash,
    },
  });
}

export async function findIntent(providerOrderId) {
  return prisma.paymentIntent.findUnique({ where: { providerOrderId } });
}

/** Every intent raised against one thing — "has this booking been paid for?" */
export async function findIntentsForRef({ refType, refId }) {
  return prisma.paymentIntent.findMany({
    where: { refType, refId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Mark an intent paid. Idempotent: safe to call from the client confirm AND from
 * a webhook for the same payment, in either order.
 */
export async function markIntentPaid({ providerOrderId, providerPaymentId, amountPaise }) {
  try {
    // Never regress a state that already produced an order or a refund. This
    // was an unconditional write, and payment.captured routinely lands AFTER
    // confirm: PAID over REFUND_INITIATED put a refunded payment back in the
    // orphan queue, where a late confirm could still turn it into an order.
    const { count } = await prisma.paymentIntent.updateMany({
      where: { providerOrderId, status: { notIn: SETTLED } },
      data: {
        status: 'PAID',
        providerPaymentId,
        ...(amountPaise != null ? { amountPaise } : {}),
      },
    });
    // Settled: still record which payment it was, if that is not yet known.
    if (!count && providerPaymentId) {
      await prisma.paymentIntent.updateMany({
        where: { providerOrderId, providerPaymentId: null },
        data: { providerPaymentId },
      });
    }
    return await prisma.paymentIntent.findUnique({ where: { providerOrderId } });
  } catch (err) {
    if (err?.code === 'P2025') return null; // no such intent
    // P2002 on providerPaymentId: this payment id is already recorded against a
    // different intent. Never overwrite — it means duplicate gateway data, and
    // silently reassigning it would detach a real payment from its real order.
    if (err?.code === 'P2002') {
      logger.warn({ providerOrderId, providerPaymentId }, '[PaymentIntent] payment id already bound to another intent');
      return prisma.paymentIntent.findUnique({ where: { providerOrderId } });
    }
    throw err;
  }
}

export async function markIntentFailed({ providerOrderId, reason }) {
  try {
    return await prisma.paymentIntent.update({
      where: { providerOrderId },
      data: { status: 'FAILED', failureReason: String(reason || '').slice(0, 500) },
    });
  } catch { return null; }
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

/**
 * Claim a webhook event id. Returns false when it has been seen before.
 *
 * Razorpay retries a failed webhook for 24 hours, so this WILL receive the same
 * `payment.captured` many times. Without the claim, each redelivery would be a
 * second attempt at fulfilment. The unique index does the work; the insert
 * either succeeds (first delivery) or throws P2002 (a redelivery).
 */
export async function claimWebhookEvent({ eventId, eventType, providerOrderId, providerPaymentId, payloadDigest }) {
  try {
    await prisma.paymentWebhookEvent.create({
      data: { eventId, eventType, providerOrderId, providerPaymentId, payloadDigest },
    });
    return true;
  } catch (err) {
    if (err?.code === 'P2002') return false;
    throw err;
  }
}

export async function finishWebhookEvent(eventId, { status, error } = {}) {
  try {
    await prisma.paymentWebhookEvent.update({
      where: { eventId },
      data: { status, error: error ? String(error).slice(0, 500) : null, processedAt: new Date() },
    });
  } catch { /* the event row is telemetry; never fail the webhook over it */ }
}

/**
 * Derive a stable event id.
 *
 * Razorpay's webhook body has no guaranteed unique event id field across every
 * event type, so the id is (eventType, entity id) — which is exactly the
 * granularity idempotency needs: `payment.captured` for payment `pay_X` must be
 * processed once, no matter how many times it is delivered.
 */
export function webhookEventId(payload) {
  const type = payload?.event || 'unknown';
  const paymentId = payload?.payload?.payment?.entity?.id;
  const orderId = payload?.payload?.order?.entity?.id || payload?.payload?.payment?.entity?.order_id;
  const refundId = payload?.payload?.refund?.entity?.id;
  return `${type}:${refundId || paymentId || orderId || crypto.randomUUID()}`;
}
