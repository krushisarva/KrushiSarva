/**
 * Rent payments — the booking half of the payment lifecycle. PAY-002.
 *
 * ── Where the line is ────────────────────────────────────────────────────────
 * The purpose-agnostic core — intent state machine, webhook inbox, event-id
 * derivation, the exactly-once refund claim — lives in paymentIntent.service.js
 * and shopPayment.service.js and serves every product area. THIS module is what
 * makes a payment a RENT payment: the frozen day-rate quote, the slot it holds,
 * and the Booking it becomes.
 *
 * Nothing here verifies a signature or handles a webhook envelope. Those exist
 * once, in payment.service.js and routes/paymentWebhooks.routes.js. A second
 * copy of either is a defect, not a feature.
 *
 * ── The hole this closes ─────────────────────────────────────────────────────
 * Rent bookings were created with no money involved at all. The app showed a
 * total, the server computed the same total, stored it on `Booking.totalAmount`
 * — and then nothing ever collected it. A platform that quotes a price it never
 * charges is not a marketplace; it is a noticeboard with extra steps.
 *
 * ── What is different from a shop order ──────────────────────────────────────
 * A cart holds STOCK, which is fungible: the shop reserves units at /initiate
 * and releases them if the payment dies. A booking holds a SLOT, which is not —
 * a tractor for 3–5 March is one indivisible thing, and there is no partial
 * fulfilment. So rent does the opposite: it reserves NOTHING at initiate, and
 * the availability check that matters is the one inside the confirm
 * transaction, under Serializable isolation, in the same transaction that
 * creates the Booking.
 *
 * That leaves exactly one bad case: the farmer pays, and while they were paying
 * somebody else took the slot. There is no way to make that impossible — the
 * money moves at the gateway, outside any database transaction. What IS made
 * impossible is KEEPING the money: the conflict path refunds through
 * `refundUnorderedPayment`, the same exactly-once claim the shop uses, and the
 * farmer is told the truth rather than "our team will contact you".
 *
 * ── Why rent reconciles separately ───────────────────────────────────────────
 * See `reconcileRentPayments` at the bottom. Short version: the shop reconciler
 * asks "is there an Order with this paymentRef?" and refunds when the answer is
 * no. For a rent payment the answer is ALWAYS no — there is no Order, there is
 * a Booking — so running rent through it would refund every successful booking.
 */
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { D, toMinorUnits } from '../utils/money.js';
import { getSetting } from './settings.service.js';
import { fetchPayment, fetchOrderPayments, isMockPayments } from './payment.service.js';
import { PAYMENT_PURPOSE } from './paymentIntent.service.js';
import { refundUnorderedPayment } from './shopPayment.service.js';

/** `PaymentIntent.refType` for every rent payment. Paired with the booking id. */
export const RENT_REF_TYPE = 'booking';

/** Statuses that occupy a slot. Identical to the legacy POST /rent/bookings. */
const OCCUPYING_STATUSES = ['PENDING', 'CONFIRMED', 'ACTIVE'];

/**
 * Razorpay refuses an order below ₹1, and does so with a generic 400 that
 * surfaces to the farmer as "payment initiation failed". Caught here instead,
 * where the message can say what is actually wrong.
 */
const MIN_PAYABLE_PAISE = 100;

/** How long a rent intent may sit unpaid before it is treated as abandoned. */
const INTENT_EXPIRY_MINUTES = 30;

/** Thrown for every refusal this module makes; `statusCode` reaches the client. */
function fail(message, statusCode, extra = {}) {
  return Object.assign(new Error(message), { statusCode, expose: true, ...extra });
}

/**
 * The advance percentage to collect at booking time.
 *
 * Defaults to 100 — the whole amount — and that default is a product decision,
 * not a placeholder. Collecting a partial advance means the rest is owed later,
 * which needs a collection policy, a dunning path and a rule for what happens
 * when the balance never arrives. None of those exist, so taking 30% today
 * would quietly create an unbilled receivable per booking.
 *
 * Clamped rather than trusted: a bad admin edit must not be able to charge more
 * than the booking is worth, or zero.
 */
export async function advancePct() {
  let pct = 100;
  try { pct = Number(await getSetting('rent.advancePct')); } catch { pct = 100; }
  if (!Number.isFinite(pct)) return 100;
  return Math.min(100, Math.max(1, pct));
}

/**
 * Price a booking. THE SERVER IS THE ONLY AUTHORITY — nothing here reads an
 * amount from the request.
 *
 * The arithmetic is lifted verbatim from POST /rent/bookings (rent.routes.js,
 * the `serverAmount` assignments) and is deliberately NOT improved:
 *
 *   machinery   pricePerDay × days
 *   labour      pricePerDay × days × workerCount
 *
 * `hours` is stored on the booking and has never been a factor in either. It
 * stays that way here. Charging for hours now would mean the paid path and the
 * legacy unpaid path quote different prices for the same booking, and the app
 * already displays the figure above — the amount taken at the gateway must be
 * the amount the farmer was shown, not a better one.
 *
 * `days` is derived from the date range and never taken from the client, for
 * the reason the legacy endpoint records: a request for 1–30 January with
 * `days: 1` blocked the machine for a month and charged for a day.
 *
 * @param {import('@prisma/client').PrismaClient|object} db  client or transaction
 * @returns {Promise<{listing, ownerId, days, rate, total, advancePct, payable, payablePaise}>}
 */
export async function quoteRentBooking(db, {
  userId, listingId, type, start, end, days, workerCount, pct,
}) {
  const wc = workerCount != null ? parseInt(workerCount, 10) : 1;

  const listing = type === 'machinery'
    ? await db.machineryListing.findUnique({ where: { id: listingId } })
    : await db.labourListing.findUnique({ where: { id: listingId } });

  const label = type === 'machinery' ? 'Machinery' : 'Labour';
  if (!listing || listing.status !== 'ACTIVE') {
    throw fail(`${label} listing not available`, 400);
  }

  // Owners cannot book their own listing — the same rule the legacy endpoint
  // enforces, checked here so the refusal happens BEFORE a gateway order is
  // raised rather than after the farmer has paid.
  const ownerId = type === 'machinery' ? listing.ownerId : listing.providerId;
  if (ownerId === userId) {
    throw fail('You cannot book your own listing', 403);
  }

  const rate = D(listing.pricePerDay).toDecimalPlaces(2);
  const total = type === 'machinery'
    ? rate.times(days).toDecimalPlaces(2)
    : rate.times(days).times(wc).toDecimalPlaces(2);

  const payable = total.times(pct).div(100).toDecimalPlaces(2);
  const payablePaise = toMinorUnits(payable);

  if (payablePaise < MIN_PAYABLE_PAISE) {
    throw fail('This booking is below the minimum amount that can be paid online.', 400);
  }

  return {
    listing,
    ownerId,
    days,
    rate: rate.toFixed(2),
    total: total.toFixed(2),
    advancePct: pct,
    payable: payable.toFixed(2),
    payablePaise,
  };
}

/**
 * Is any part of [start, end] already taken on this listing?
 *
 * The three OR branches are the legacy endpoint's, unchanged: a booking that
 * starts inside the window, one that ends inside it, or one that spans it
 * entirely. Run inside the Serializable confirm transaction, this read is what
 * Postgres tracks to abort a concurrent double-booking.
 *
 * @returns {Promise<object|null>} the conflicting booking, or null
 */
export function findSlotConflict(db, { type, listingId, start, end }) {
  return db.booking.findFirst({
    where: {
      [type === 'machinery' ? 'machineryListingId' : 'labourListingId']: listingId,
      status: { in: OCCUPYING_STATUSES },
      OR: [
        { startDate: { gte: start, lte: end } },
        { endDate: { gte: start, lte: end } },
        { startDate: { lte: start }, endDate: { gte: end } },
      ],
    },
    select: { id: true },
  });
}

/**
 * INSIDE the confirm transaction: bind the intent to the booking being created.
 *
 * The exact analogue of `bindIntentToOrderTx`, and load-bearing for the same
 * reason. It refuses once a refund has claimed the intent, and it holds the
 * intent's row lock until commit — so for one payment, a booking and an
 * automatic refund are mutually exclusive, whichever lands first. Without it a
 * confirm that arrived just after the reconciler started a refund would create
 * a booking the farmer has been refunded for.
 */
export async function bindIntentToBookingTx(tx, { intentId, bookingId }) {
  const { count } = await tx.paymentIntent.updateMany({
    where: { id: intentId, status: { notIn: ['REFUND_INITIATED', 'REFUNDED'] } },
    data: { status: 'ORDER_CREATED', refType: RENT_REF_TYPE, refId: bookingId },
  });
  if (!count) {
    throw fail(
      'This payment has already been refunded, so no booking was made. Please choose your dates again.',
      409,
      { code: 'PAYMENT_REFUNDED' },
    );
  }
}

/**
 * Give back a captured payment that no booking will be made from.
 *
 * Delegates to the shop's `refundUnorderedPayment` rather than reimplementing
 * it — that function is already purpose-agnostic in every way that matters
 * here: it claims the intent atomically (so a retried confirm, the webhook and
 * the reconciler cannot each issue a refund), calls processRefund through the
 * breaker, writes the audit row, and never throws. Its one shop-shaped step is
 * a lookup for an Order with this paymentRef, which for a rent payment is
 * always absent and therefore a no-op.
 *
 * @returns {Promise<{ ok: boolean, amount?: string, reason?: string }>}
 */
export function refundRentPayment(args) {
  return refundUnorderedPayment(args);
}

/** What the farmer is told about money we could not turn into a booking. */
export function refundNotice(refund) {
  return refund?.ok
    ? `We have refunded ₹${refund.amount} to the account you paid from — it usually arrives in 5–7 working days.`
    : 'Our team is arranging your refund — please do not pay again.';
}

// ── Webhook handlers ─────────────────────────────────────────────────────────

/**
 * What a rent payment needs AFTER the shared webhook half has recorded it.
 *
 * Registered against PAYMENT_PURPOSE.RENT_BOOKING by the webhook dispatcher
 * (routes/paymentWebhooks.routes.js). Every hook is best-effort and idempotent:
 * the money is already recorded on the intent by the time any of them runs, so
 * a failure here loses follow-up work, never the payment.
 *
 * Note what `captured` deliberately does NOT do: create a booking. A webhook
 * has no way to know the slot is still free, and creating one from a payment
 * would race the confirm that is very likely in flight. The confirm creates the
 * booking; `reconcileRentPayments` is the backstop for a confirm that never
 * arrives.
 */
export const rentWebhookHandler = {
  /**
   * The client's confirm may already have created the booking while the app was
   * reconnecting — in which case it also bound the intent inside the same
   * transaction, so there is normally nothing to repair. This is the belt to
   * that braces: if a booking somehow points at this intent while the intent
   * does not point back, close the loop, or reconciliation would later read a
   * paid intent with no booking and refund a farmer who has one.
   */
  async captured({ intent }) {
    if (!intent || intent.refId) return;
    const booking = await prisma.booking.findUnique({
      where: { paymentIntentId: intent.id }, select: { id: true },
    }).catch(() => null);
    if (!booking) return;
    await prisma.paymentIntent.updateMany({
      where: { id: intent.id, status: { notIn: ['REFUND_INITIATED', 'REFUNDED'] } },
      data: { status: 'ORDER_CREATED', refType: RENT_REF_TYPE, refId: booking.id },
    }).catch(() => {});
    logger.info({ intentId: intent.id }, '[RentPayment] late capture bound to its booking');
  },

  /**
   * Nothing is held for a rent payment, so there is nothing to release — which
   * is precisely why this handler must still EXIST. A purpose with no `failed`
   * hook is reported by the dispatcher as an unhandled purpose, at ERROR, with
   * an alert. A failed rent payment is ordinary, not an incident.
   */
  async failed({ intent }) {
    logger.info({ intentId: intent?.id }, '[RentPayment] payment failed — no booking was created, nothing to release');
  },

  /**
   * Keep the booking's own payment state honest. A refunded booking that still
   * reads "PAID" is what turns a refund into a support ticket.
   *
   * updateMany + a match on the intent id: idempotent by construction, so a
   * redelivered refund event writes the same row to the same value.
   */
  async refunded({ intent, eventType }) {
    if (!intent) return;
    await prisma.booking.updateMany({
      where: { paymentIntentId: intent.id },
      data: { paymentStatus: eventType === 'refund.processed' ? 'REFUNDED' : 'REFUND_INITIATED' },
    }).catch(() => {});
  },
};

// ── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Sweep rent intents stuck outside a terminal state and settle them against the
 * gateway's own record.
 *
 * ── WHY THIS IS A SEPARATE PASS, AND NOT A BRANCH IN THE SHOP RECONCILER ─────
 * `reconcilePendingPayments` is not merely scoped to shop purposes; its BODY is
 * shop logic at every step:
 *
 *     find an Order by `paymentRef`      → a rent payment never has one
 *     releaseReservations(orderId)       → rent reserves no stock, ever
 *     no order + 30 min → auto-refund    → would refund every paid booking
 *
 * The first and third compose into the exact failure this must not have: a
 * farmer pays, gets their booking, and eleven minutes later the sweep finds no
 * `Order` row, concludes the money bought nothing, and sends it back. Nothing
 * would log an error, because by shop rules that is correct behaviour.
 *
 * Branching inside would mean threading a purpose-specific fulfilment lookup, a
 * purpose-specific release step and purpose-specific notes through a function
 * that runs on the live checkout recovery path — three injection points, each
 * a chance to change shop behaviour by accident, to avoid duplicating about
 * forty lines. The two passes also genuinely disagree about what to do, not
 * just how: the shop refunds an orphaned capture because the cart is gone and
 * stock may have sold; rent CANNOT refund on that rule, because the booking
 * usually exists and the intent simply has not been bound yet.
 *
 * So: separate pass, shop reconciler untouched, `RECONCILED_PURPOSES` still
 * `[SHOP_ORDER]` — and the test that pins that (paymentPurposeScope.api.test.js)
 * still passes unchanged.
 *
 * Four outcomes per intent:
 *   captured, booking already exists  → bind and finish (NEVER refunded)
 *   captured, NO booking, past expiry → refunded; the slot was never held
 *   failed                            → FAILED, with the gateway's reason
 *   no payment at all, past expiry     → EXPIRED (abandoned)
 *
 * @returns {Promise<{scanned:number, bound:number, failed:number, expired:number, orphanedPaid:number, refunded:number, unknown:number}>}
 */
export async function reconcileRentPayments({ olderThanMinutes = 10, limit = 200 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const expiryCutoff = new Date(Date.now() - INTENT_EXPIRY_MINUTES * 60_000);

  const stale = await prisma.paymentIntent.findMany({
    where: {
      purpose: PAYMENT_PURPOSE.RENT_BOOKING,
      status: { in: ['CREATED', 'PENDING', 'PAID'] },
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  const stats = { scanned: stale.length, bound: 0, failed: 0, expired: 0, orphanedPaid: 0, refunded: 0, unknown: 0 };
  if (!stale.length || isMockPayments()) return stats;

  for (const intent of stale) {
    try {
      // Ask the gateway. This is the whole point — the client is gone.
      //
      // `null` means WE COULD NOT ASK (timeout, 5xx, open breaker), which is not
      // the same as the gateway saying there is no payment. Conflating the two
      // during an outage would expire paid intents. Skip; the next pass asks
      // again.
      const payments = intent.providerPaymentId
        ? await fetchPayment(intent.providerPaymentId).then((p) => (p ? [p] : null))
        : await fetchOrderPayments(intent.providerOrderId);

      if (payments === null) {
        stats.unknown += 1;
        logger.error({ intentId: intent.id }, '[ALERT][RentPayment] RECONCILE: gateway unreachable — intent left untouched');
        continue;
      }

      const captured = payments.find((p) => p?.status === 'captured' || p?.status === 'authorized');

      if (captured) {
        // THE CHECK THAT MAKES THIS SAFE. A booking exists for this payment →
        // the farmer got what they paid for, and no rule below may take the
        // money back. Looked up by `paymentIntentId`, which is UNIQUE, so this
        // cannot match a different farmer's booking.
        const booking = await prisma.booking.findUnique({
          where: { paymentIntentId: intent.id },
          select: { id: true },
        });

        if (booking) {
          await prisma.paymentIntent.update({
            where: { id: intent.id },
            data: {
              status: 'ORDER_CREATED',
              providerPaymentId: captured.id,
              refType: RENT_REF_TYPE,
              refId: booking.id,
              reconciledAt: new Date(),
              reconcileNote: 'booking already existed',
            },
          }).catch(() => {});
          await prisma.booking.updateMany({
            where: { id: booking.id, paymentStatus: { not: 'PAID' } },
            data: { paymentStatus: 'PAID' },
          }).catch(() => {});
          stats.bound += 1;
        } else if (intent.createdAt < expiryCutoff) {
          // Paid, past the window, and still no booking: the confirm never
          // arrived and the slot was never taken for this farmer. Unlike a
          // shop order there is nothing to release and nothing to invent — a
          // booking created now could collide with one made in the meantime.
          // The money goes back. The refund claims the intent atomically, so a
          // late confirm is refused rather than producing an unpaid booking.
          const refund = await refundRentPayment({
            providerOrderId: intent.providerOrderId,
            providerPaymentId: captured.id,
            reason: 'captured payment with no booking (reconciled)',
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
              reconcileNote: `PAID WITH NO BOOKING — refunded automatically if still without one after ${INTENT_EXPIRY_MINUTES} min`,
            },
          }).catch(() => {});
          stats.orphanedPaid += 1;
          logger.error({ intentId: intent.id, amount: String(intent.amount) },
            '[RentPayment] RECONCILE: captured payment with no booking');
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
        continue;
      }

      if (intent.createdAt < expiryCutoff) {
        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { status: 'EXPIRED', reconciledAt: new Date(), reconcileNote: 'no payment attempt within window' },
        }).catch(() => {});
        stats.expired += 1;
      }
    } catch (err) {
      logger.warn({ err, intentId: intent.id }, '[RentPayment] reconcile failed for intent');
    }
  }

  return stats;
}
