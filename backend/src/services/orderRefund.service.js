/**
 * Automatic refunds when order lines paid online are cancelled.
 *
 * Nothing refunded before: processRefund() existed and had no callers, so a
 * seller (or buyer) cancelling a Razorpay-paid order left the order CANCELLED
 * with paymentStatus 'paid' — the buyer's money gone, and no record anywhere
 * that it was owed.
 *
 * Two halves, split around the cancel transaction:
 *
 *   planRefund()   INSIDE the transaction that cancels the lines. Works out the
 *                  amount and sets paymentStatus = 'refund_pending'. Committed
 *                  with the cancel, so a crash before the gateway call still
 *                  leaves a visible, filterable marker for an admin.
 *   settleRefund() AFTER commit. Calls Razorpay; on success moves the order to
 *                  'refunded' (nothing left live) or 'partially_refunded'. On
 *                  failure the order stays 'refund_pending' and the failure is
 *                  logged and audited — never retried blindly, because a
 *                  timed-out refund may still have gone through.
 *
 * A refund cannot run twice for the same lines: it rides on the status
 * transition, and the cancel routes only move a line PENDING/CONFIRMED →
 * CANCELLED once (Serializable, with a no-op on repeat).
 */
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { D, sumD, round2, toMinorUnits } from '../utils/money.js';
import { processRefund } from './payment.service.js';
import { auditLog } from './audit.service.js';

/** paymentStatus values under which money is (still) held for the buyer. */
const HELD = new Set(['paid', 'partially_refunded', 'refund_pending']);

export function isRefundable(order) {
  return Boolean(order)
    && order.paymentMethod !== 'cod'
    && Boolean(order.paymentRef)
    && HELD.has(order.paymentStatus);
}

/**
 * What cancelling `cancellingIds` should return to the buyer.
 *
 * A line refunds its goods total, plus its tax when tax was ADDED on top of the
 * price (shop setting; the order does not record it, so it is read off the
 * order's own arithmetic: total = subtotal + delivery + addedTax − discount).
 * The cancel that leaves nothing live refunds whatever is left of the total,
 * which is what returns the delivery fee.
 *
 * @param {object} order   with totalAmount, subtotal, deliveryFee, taxAmount, discountAmount
 * @param {object[]} items EVERY line on the order, statuses as they were BEFORE this cancel
 * @param {string[]} cancellingIds  the lines this cancel moves to CANCELLED
 * @returns {{ amount: import('decimal.js').Decimal, fullyCancelled: boolean }}
 */
export function refundAmountFor(order, items, cancellingIds) {
  const cancelling = new Set(cancellingIds);
  const total = D(order.totalAmount);
  const taxAdded = round2(total.minus(D(order.subtotal)).minus(D(order.deliveryFee)).plus(D(order.discountAmount)));
  const addsTax = D(order.taxAmount).gt(0) && taxAdded.gt(0);
  const lineRefund = (i) => D(i.totalPrice).plus(addsTax ? D(i.taxAmount) : 0);

  const earlier = items.filter((i) => i.status === 'CANCELLED' && !cancelling.has(i.id));
  const now = items.filter((i) => cancelling.has(i.id));
  const stillLive = items.filter((i) => i.status !== 'CANCELLED' && !cancelling.has(i.id));

  // What earlier cancels already returned; never refund past the total.
  const remaining = maxZero(total.minus(sumD(earlier, lineRefund)));
  const fullyCancelled = stillLive.length === 0;
  const wanted = fullyCancelled ? remaining : sumD(now, lineRefund);
  const amount = round2(wanted.gt(remaining) ? remaining : wanted);
  return { amount: maxZero(amount), fullyCancelled };
}

function maxZero(v) {
  return v.lt(0) ? D(0) : v;
}

/**
 * Inside the cancel transaction: decide the refund and mark it pending.
 * Returns the plan settleRefund() needs, or null when nothing is owed.
 */
export async function planRefund(tx, order, items, cancellingIds) {
  if (!isRefundable(order) || !cancellingIds.length) return null;
  const { amount, fullyCancelled } = refundAmountFor(order, items, cancellingIds);
  if (!amount.gt(0)) return null;

  await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'refund_pending' } });
  return {
    orderId: order.id,
    paymentRef: order.paymentRef,
    amount: amount.toFixed(2),
    amountPaise: toMinorUnits(amount),
    fullyCancelled,
    // An earlier refund on this order that is still unresolved: a success here
    // must not paint over it by moving the order to 'partially_refunded'.
    earlierPending: order.paymentStatus === 'refund_pending',
  };
}

/**
 * After commit: send the refund to Razorpay and record the outcome. Never throws
 * — the cancel has already succeeded and the seller/buyer has been told so.
 */
export async function settleRefund(plan, { actorId = null, reason = 'order_cancelled', requestId = null } = {}) {
  if (!plan) return null;
  try {
    const refund = await processRefund(plan.paymentRef, plan.amountPaise);
    const next = plan.fullyCancelled
      ? 'refunded'
      : (plan.earlierPending ? 'refund_pending' : 'partially_refunded');
    // Only from 'refund_pending': an admin who resolved it by hand in the
    // meantime is not overwritten.
    await prisma.order.updateMany({
      where: { id: plan.orderId, paymentStatus: 'refund_pending' },
      data: { paymentStatus: next },
    });
    await auditLog({
      userId: actorId, action: 'ORDER_REFUND', entity: 'Order', entityId: plan.orderId,
      after: { paymentStatus: next }, requestId,
      metadata: { reason, amount: plan.amount, refundId: refund?.id ?? null, mock: Boolean(refund?.mock) },
    }).catch(() => {});
    return { ok: true, refundId: refund?.id ?? null, paymentStatus: next };
  } catch (err) {
    logger.error('[Refund] Razorpay refund FAILED for order %s (₹%s) — left refund_pending for an admin: %s',
      plan.orderId, plan.amount, err?.message);
    await auditLog({
      userId: actorId, action: 'ORDER_REFUND_FAILED', entity: 'Order', entityId: plan.orderId,
      after: { paymentStatus: 'refund_pending' }, requestId,
      metadata: { reason, amount: plan.amount, error: String(err?.message || err).slice(0, 300) },
    }).catch(() => {});
    return { ok: false };
  }
}
