/**
 * Shop payments — the AgriStore half of the payment lifecycle.
 *
 * ── Where the line is ────────────────────────────────────────────────────────
 * The purpose-agnostic core — intent state machine, webhook inbox, event-id
 * derivation — lives in paymentIntent.service.js and serves every product area.
 * THIS module is what makes a payment an AgriStore payment: the frozen cart
 * quote, the order it becomes, the stock hold it consumes, and the refund owed
 * when a capture produces no order.
 *
 * The moved names are re-exported from here, so AgriStore call sites did not
 * have to learn a new import when the core was split out.
 *
 * ── The hole this closes ─────────────────────────────────────────────────────
 * The old flow was two calls with nothing between them:
 *
 *   POST /orders/initiate   → create a Razorpay order, return its id, WRITE NOTHING
 *   POST /orders/confirm    → verify the signature, create the Order
 *
 * If the phone lost signal, the app was killed, or the farmer closed the payment
 * sheet after paying — all routine on a village connection — the money was
 * captured and this system had no record that a payment had ever been started.
 * Nothing could reconcile it, because nothing knew. The farmer's only recourse
 * was a support ticket with a bank SMS as evidence.
 *
 * Three pieces fix it (the first two now live in paymentIntent.service.js):
 *
 *   PaymentIntent   written BEFORE the gateway is called, so an interrupted
 *                   payment is a row in a queryable state, not a silence.
 *   Webhook         Razorpay tells us `payment.captured` even when the client
 *                   never comes back. Signature-verified, idempotent by event id.
 *   Reconciler      sweeps intents that never reached a terminal state and ASKS
 *                   the gateway what happened, because the client that would have
 *                   told us is gone.
 *
 * ── The invariant ────────────────────────────────────────────────────────────
 * An order is created from a paid intent EXACTLY ONCE, whichever of the three
 * paths gets there first. That is enforced at the database, not in code:
 * `payment_intents.orderId` and `orders.paymentRef` are both UNIQUE, so the
 * loser of any race gets P2002 and returns the winner's order.
 */
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { D } from '../utils/money.js';
import { fetchPayment, fetchOrderPayments, isMockPayments, processRefund } from './payment.service.js';
import {
  PAYMENT_PURPOSE, TERMINAL, REFUNDING, SETTLED,
  createIntent as createIntentCore, findIntent, markIntentPaid, markIntentFailed,
  receiptFor, claimWebhookEvent, finishWebhookEvent, webhookEventId,
} from './paymentIntent.service.js';
import { releaseReservations } from './stockReservation.service.js';
import { recordEvent, SHOP_EVENTS } from './shopMetrics.service.js';
import { auditLog } from './audit.service.js';

/** Intents older than this that never got paid are treated as abandoned. */
const INTENT_EXPIRY_MINUTES = 30;

/** Prefix of `failureReason` when the automatic refund's gateway call failed. */
export const AUTO_REFUND_FAILED = 'AUTO-REFUND FAILED';

/**
 * Purposes THIS module knows how to settle. The reconciler sweeps only these.
 *
 * Its four outcomes are shop outcomes — find an Order by `paymentRef`, release
 * stock reservations, refund a capture that produced no order. Applied to a
 * rent booking they are wrong in a way that costs a farmer their slot: a
 * payment that is merely slow finds no Order, and the money goes back. So the
 * sweep is opt-in per purpose, and a purpose with no handler is counted and
 * left alone rather than settled by rules written for something else.
 */
const RECONCILED_PURPOSES = [PAYMENT_PURPOSE.SHOP_ORDER];

/**
 * The names below moved to paymentIntent.service.js, which owns the intent
 * state machine and the webhook inbox for EVERY purpose. They are re-exported
 * here so that no call site had to change when they moved — this module stays
 * the door AgriStore knocks on.
 */
export {
  receiptFor, findIntent, markIntentPaid, markIntentFailed,
  claimWebhookEvent, finishWebhookEvent, webhookEventId,
};

/**
 * Record a SHOP_ORDER intent before the gateway call, so a crash after it is
 * recoverable.
 *
 * The cart quote is frozen here and nowhere else: `confirm` rebuilds it and
 * refuses if the payable moved, and `cartHash` catches a cart edited in another
 * tab between initiate and confirm. Everything else is the shared core's.
 */
export async function createIntent({ userId, providerOrderId, amount, receipt, quote }) {
  return createIntentCore({
    userId,
    providerOrderId,
    purpose: PAYMENT_PURPOSE.SHOP_ORDER,
    amount,
    receipt,
    quoteSnapshot: quote ? {
      total: quote.total,
      subtotal: quote.subtotal,
      deliveryFee: quote.deliveryFee,
      taxAmount: quote.taxAmount,
      fingerprint: quote.fingerprint,
      pricedAt: quote.pricedAt,
      shipmentCount: quote.shipmentCount,
    } : null,
    cartHash: quote?.fingerprint || null,
  });
}

/** Bind an intent to the order it produced. UNIQUE orderId makes this the gate. */
export async function attachOrderToIntent({ providerOrderId, orderId }) {
  try {
    return await prisma.paymentIntent.update({
      where: { providerOrderId },
      data: { status: 'ORDER_CREATED', orderId },
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      logger.warn({ providerOrderId, orderId }, '[ShopPayment] intent already bound to an order');
      return null;
    }
    if (err?.code === 'P2025') return null;
    throw err;
  }
}

/**
 * INSIDE /orders/confirm's order transaction: bind the intent to the order
 * being created. Refused once a refund has claimed the intent, and it holds the
 * intent's row lock until commit — so for one payment an order and an automatic
 * refund are mutually exclusive, whichever lands first.
 */
export async function bindIntentToOrderTx(tx, { intentId, orderId }) {
  const { count } = await tx.paymentIntent.updateMany({
    where: { id: intentId, status: { notIn: REFUNDING } },
    data: { status: 'ORDER_CREATED', orderId },
  });
  if (!count) {
    throw Object.assign(
      new Error('This payment has already been refunded, so no order was created. Please review your cart and order again.'),
      { statusCode: 409, expose: true, code: 'PAYMENT_REFUNDED' },
    );
  }
}

/**
 * Give back a captured payment that no order will be made from.
 *
 * Every "your payment went through, but…" path used to end in "our team will
 * contact you" and nothing else — processRefund had no caller on this path, so
 * the money sat captured until a human noticed.
 *
 * Exactly once: the refund rides an atomic transition of the intent to
 * REFUND_INITIATED, allowed only while no order owns it. A retried confirm and
 * the reconciler race for that one transition and the losers refund nothing;
 * bindIntentToOrderTx refuses a refunding intent, so a late confirm cannot turn
 * the same payment into an order as well.
 *
 * A failed gateway call leaves the intent REFUND_INITIATED with failureReason
 * "AUTO-REFUND FAILED: …" — in the admin orphan queue — and is not retried: a
 * timed-out refund may have gone through.
 *
 * Never throws.
 * @returns {Promise<{ ok: boolean, amount?: string, status?: string, reason?: string }>}
 */
export async function refundUnorderedPayment({ providerOrderId, providerPaymentId = null, reason, actorId = null, requestId = null }) {
  try {
    const intent = await prisma.paymentIntent.findUnique({ where: { providerOrderId } });
    const paymentId = providerPaymentId || intent?.providerPaymentId;
    // No intent row means no claim to make it exactly-once: left for a human.
    if (!intent || !paymentId) return { ok: false, reason: 'NO_INTENT' };
    const amount = D(intent.amount).toFixed(2);

    if (await prisma.order.findUnique({ where: { paymentRef: paymentId }, select: { id: true } })) {
      return { ok: false, reason: 'ORDER_EXISTS' };
    }

    const { count } = await prisma.paymentIntent.updateMany({
      where: { id: intent.id, orderId: null, status: { notIn: [...SETTLED, 'CANCELLED'] } },
      data: {
        status: 'REFUND_INITIATED',
        ...(intent.providerPaymentId !== paymentId ? { providerPaymentId: paymentId } : {}),
        failureReason: null,
        reconciledAt: new Date(),
        reconcileNote: `auto-refund: ${reason}`.slice(0, 500),
      },
    });
    if (!count) {
      // Someone else claimed it. Report whether that refund is under way.
      const now = await prisma.paymentIntent.findUnique({
        where: { id: intent.id }, select: { status: true, failureReason: true },
      });
      const started = REFUNDING.includes(now?.status) && !String(now?.failureReason || '').startsWith(AUTO_REFUND_FAILED);
      return { ok: started, amount, status: now?.status, reason: 'ALREADY_CLAIMED' };
    }

    let refund;
    try {
      refund = await processRefund(paymentId, intent.amountPaise);
    } catch (err) {
      const error = String(err?.message || err).slice(0, 300);
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, status: 'REFUND_INITIATED' },
        data: { failureReason: `${AUTO_REFUND_FAILED}: ${error}`.slice(0, 500) },
      }).catch(() => {});
      recordEvent(SHOP_EVENTS.PAYMENT_CAPTURED_NO_ORDER);
      logger.error({ intentId: intent.id, providerOrderId, providerPaymentId: paymentId, amount, error },
        '[ALERT][ShopPayment] automatic refund FAILED — refund by hand');
      await auditLog({
        userId: actorId, action: 'PAYMENT_REFUND_FAILED', entity: 'PaymentIntent', entityId: intent.id,
        after: { status: 'REFUND_INITIATED' }, requestId,
        metadata: { reason, amount, providerOrderId, providerPaymentId: paymentId, error },
      }).catch(() => {});
      return { ok: false, amount, reason: 'GATEWAY_FAILED' };
    }

    const status = refund?.status === 'processed' ? 'REFUNDED' : 'REFUND_INITIATED';
    if (status === 'REFUNDED') {
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, status: 'REFUND_INITIATED' }, data: { status },
      }).catch(() => {});
    }
    logger.warn({ intentId: intent.id, providerOrderId, amount, refundId: refund?.id }, '[ShopPayment] captured payment with no order refunded');
    await auditLog({
      userId: actorId, action: 'PAYMENT_REFUND', entity: 'PaymentIntent', entityId: intent.id,
      after: { status }, requestId,
      metadata: { reason, amount, providerOrderId, refundId: refund?.id ?? null, mock: Boolean(refund?.mock) },
    }).catch(() => {});
    return { ok: true, amount, status };
  } catch (err) {
    logger.error({ err, providerOrderId }, '[ALERT][ShopPayment] automatic refund could not be started');
    return { ok: false, reason: 'ERROR' };
  }
}

// ── Webhook handlers ──────────────────────────────────────────────────────────

/**
 * What an AgriStore payment needs AFTER the shared webhook half has recorded it.
 *
 * Registered against PAYMENT_PURPOSE.SHOP_ORDER by the webhook dispatcher
 * (routes/paymentWebhooks.routes.js). Each hook is best-effort: the money is
 * already recorded on the intent by the time any of them runs, so a failure
 * here loses follow-up work, never the payment itself.
 */
export const shopWebhookHandler = {
  /**
   * The client's confirm may already have created the order while the app was
   * reconnecting. Bind the two together so reconciliation does not later flag a
   * paid intent with no order and refund a payment that produced one.
   */
  async captured({ intent, providerOrderId, providerPaymentId }) {
    if (!providerPaymentId || intent.orderId) return;
    const order = await prisma.order.findUnique({
      where: { paymentRef: providerPaymentId }, select: { id: true },
    });
    if (!order) return;
    await prisma.paymentIntent.update({
      where: { providerOrderId },
      data: { status: 'ORDER_CREATED', orderId: order.id },
    }).catch(() => {});
  },

  /**
   * The payment is not coming, so the units this buyer was holding go back on
   * the shelf NOW rather than sitting out the TTL. On a nearly-sold-out product
   * that is the difference between the next farmer being able to buy it and
   * being told it is gone.
   */
  async failed({ providerOrderId }) {
    await releaseReservations(providerOrderId, 'payment failed').catch(() => {});
  },

  /**
   * Keep the order's own payment state honest — a refunded order that still
   * reads "paid" is what turns a refund into a support ticket.
   */
  async refunded({ providerPaymentId, eventType }) {
    await prisma.order.updateMany({
      where: { paymentRef: providerPaymentId },
      data: { paymentStatus: eventType === 'refund.processed' ? 'refunded' : 'refund_initiated' },
    }).catch(() => {});
  },
};

// ── Reconciliation ────────────────────────────────────────────────────────────

/**
 * Sweep intents stuck outside a terminal state and settle them against the
 * gateway's own record.
 *
 * Four outcomes per intent:
 *   captured, order already exists   → bind and finish
 *   captured, NO order               → PAID + flagged: the farmer's money is with
 *                                      us and they have nothing. Past the expiry
 *                                      window it is REFUNDED automatically
 *                                      (refundUnorderedPayment). Deliberately
 *                                      NOT auto-ordered — the cart is long gone
 *                                      and stock may have sold, so inventing an
 *                                      order would be worse than a refund.
 *   failed                           → FAILED, with the gateway's reason
 *   no payment at all, past expiry   → EXPIRED (abandoned checkout)
 *
 * `orphanedPaid` counts captured payments still needing a human: too young to
 * refund yet, or the automatic refund failed.
 *
 * @returns {Promise<{scanned:number, paid:number, failed:number, expired:number, orphanedPaid:number, refunded:number}>}
 */
export async function reconcilePendingPayments({ olderThanMinutes = 10, limit = 200 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const expiryCutoff = new Date(Date.now() - INTENT_EXPIRY_MINUTES * 60_000);

  const stale = await prisma.paymentIntent.findMany({
    // purpose filter: see RECONCILED_PURPOSES. Every row written before that
    // column existed is SHOP_ORDER by default, so this changes nothing today —
    // it is what stops the next purpose inheriting shop settlement by accident.
    where: {
      purpose: { in: RECONCILED_PURPOSES },
      status: { in: ['CREATED', 'PENDING', 'PAID'] },
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  // `unknown` counts intents the gateway could not answer for this pass. It is
  // not a failure to fix here — it is the signal that reconciliation is blind,
  // which matters because the alternative (guessing) loses money.
  const stats = { scanned: stale.length, paid: 0, failed: 0, expired: 0, orphanedPaid: 0, refunded: 0, unknown: 0 };
  if (!stale.length || isMockPayments()) return stats;

  for (const intent of stale) {
    try {
      // Ask the gateway. This is the whole point — the client is gone.
      //
      // `null` from either fetcher means WE COULD NOT ASK — a timeout, a 5xx, an
      // open circuit breaker — which is not the same as the gateway telling us
      // there is no payment. Conflating the two is how a paid intent got marked
      // EXPIRED and its stock released during a Razorpay outage: no `captured`,
      // no `failed`, straight to the expiry branch below. Skip instead; the
      // intent stays selectable and the next pass asks again.
      const payments = intent.providerPaymentId
        ? await fetchPayment(intent.providerPaymentId).then((p) => (p ? [p] : null))
        : await fetchOrderPayments(intent.providerOrderId);

      if (payments === null) {
        stats.unknown += 1;
        logger.error({
          intentId: intent.id,
          providerOrderId: intent.providerOrderId,
        }, '[ALERT][ShopPayment] RECONCILE: gateway unreachable — intent left untouched');
        continue;
      }

      const captured = payments.find((p) => p?.status === 'captured' || p?.status === 'authorized');

      if (captured) {
        const existingOrder = await prisma.order.findUnique({
          where: { paymentRef: captured.id },
          select: { id: true },
        });

        if (existingOrder) {
          await prisma.paymentIntent.update({
            where: { id: intent.id },
            data: {
              status: 'ORDER_CREATED',
              providerPaymentId: captured.id,
              orderId: existingOrder.id,
              reconciledAt: new Date(),
              reconcileNote: 'order already existed',
            },
          }).catch(() => {});
          stats.paid += 1;
        } else if (intent.createdAt < expiryCutoff) {
          // Past any payment window and still no order: the money goes back.
          // The refund claims the intent atomically, so a later pass, a retried
          // confirm or the webhook cannot refund it again — and a confirm that
          // arrives after this is refused rather than creating an order.
          await releaseReservations(intent.providerOrderId, 'captured payment with no order').catch(() => {});
          const refund = await refundUnorderedPayment({
            providerOrderId: intent.providerOrderId,
            providerPaymentId: captured.id,
            reason: 'captured payment with no order (reconciled)',
          });
          if (refund.ok) stats.refunded += 1;
          else stats.orphanedPaid += 1;
        } else {
          await prisma.paymentIntent.update({
            where: { id: intent.id },
            data: {
              status: 'PAID',
              providerPaymentId: captured.id,
              reconciledAt: new Date(),
              reconcileNote: `PAID WITH NO ORDER — refunded automatically if still without one after ${INTENT_EXPIRY_MINUTES} min`,
            },
          }).catch(() => {});
          stats.orphanedPaid += 1;
          recordEvent(SHOP_EVENTS.PAYMENT_CAPTURED_NO_ORDER);
          // The payment landed but no order exists, so nothing will ever consume
          // the hold. Release it — the buyer is owed a refund, not the rest of
          // the marketplace an out-of-stock listing.
          await releaseReservations(intent.providerOrderId, 'captured payment with no order').catch(() => {});
          // Loud on purpose: this is money held against nothing.
          logger.error({
            intentId: intent.id,
            providerOrderId: intent.providerOrderId,
            providerPaymentId: captured.id,
            amount: String(intent.amount),
          }, '[ShopPayment] RECONCILE: captured payment with no order');
        }
        continue;
      }

      const failedPayment = payments.find((p) => p?.status === 'failed');
      if (failedPayment) {
        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data: {
            status: 'FAILED',
            providerPaymentId: failedPayment.id,
            failureReason: String(failedPayment.error_description || 'payment failed').slice(0, 500),
            reconciledAt: new Date(),
          },
        }).catch(() => {});
        stats.failed += 1;
        await releaseReservations(intent.providerOrderId, 'payment failed (reconciled)').catch(() => {});
        continue;
      }

      if (intent.createdAt < expiryCutoff) {
        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { status: 'EXPIRED', reconciledAt: new Date(), reconcileNote: 'no payment attempt within window' },
        }).catch(() => {});
        stats.expired += 1;
        // An abandoned payment sheet produces no signal at all — no webhook, no
        // client call. This is the only thing that puts those units back.
        await releaseReservations(intent.providerOrderId, 'payment abandoned (reconciled)').catch(() => {});
      }
    } catch (err) {
      logger.warn({ err, intentId: intent.id }, '[ShopPayment] reconcile failed for intent');
    }
  }

  return stats;
}

/**
 * What the app should show while a payment's fate is unknown.
 *
 * "Payment is being confirmed" is a distinct state from "payment failed", and
 * showing the second when the first is true is how a farmer pays twice.
 *
 * A refund is its own answer. REFUND_INITIATED used to fall through to PENDING,
 * which the app renders as "No money was taken. You can try again" — said to a
 * farmer whose money HAS been taken and is on its way back. REFUNDING and
 * REFUNDED are additive states: an older build does not know them and keeps its
 * existing fallback, so nothing breaks, while a current build can say the truth.
 */
export function intentPublicStatus(intent) {
  if (!intent) return { state: 'UNKNOWN' };
  if (intent.status === 'REFUND_INITIATED') {
    // The gateway call may have failed (failureReason "AUTO-REFUND FAILED: …").
    // The money is still owed either way, but promising 5–7 working days for a
    // refund no provider has accepted yet would be the wrong promise.
    const handOff = String(intent.failureReason || '').startsWith(AUTO_REFUND_FAILED);
    return {
      state: 'REFUNDING',
      orderId: intent.orderId || null,
      refundPending: !handOff,
      message: handOff
        ? 'Your payment could not become an order. Our team is arranging your refund — please do not pay again.'
        : 'Your payment is being refunded — it reaches the account you paid from in 5–7 working days.',
    };
  }
  if (intent.status === 'REFUNDED') {
    return {
      state: 'REFUNDED',
      orderId: intent.orderId || null,
      // `reason` is kept for builds that read it on a terminal state.
      reason: intent.failureReason || null,
      message: 'Your payment has been refunded — it reaches the account you paid from in 5–7 working days.',
    };
  }
  if (TERMINAL.has(intent.status)) {
    return {
      state: intent.status,
      orderId: intent.orderId || null,
      reason: intent.failureReason || null,
    };
  }
  return {
    state: intent.status === 'PAID' ? 'CONFIRMING' : 'PENDING',
    orderId: intent.orderId || null,
    message: intent.status === 'PAID'
      ? 'Your payment has gone through and we are creating your order. Do not pay again.'
      : 'We are still confirming your payment. Do not pay again — check My Orders in a few minutes.',
  };
}
