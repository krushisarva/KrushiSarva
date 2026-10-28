/**
 * What a seller needs to know about the MONEY on an order they are delivering.
 *
 * The seller's order card printed the payment METHOD in capitals — "COD", "UPI",
 * "ONLINE" — and nothing else. It did not say whether an online order had
 * actually been paid, and for a cash order it did not say how much to take at
 * the door: the only figure on the card is one LINE's total, which leaves out
 * the delivery charge and the seller's other lines on the same order. A seller
 * standing at a farmer's gate was left to work the amount out, or to collect
 * cash for an order that had already been paid for.
 *
 * This puts one object on each row's `order`:
 *
 *   order.payment = {
 *     method:       'cod' | 'online',
 *     status:       'TO_COLLECT' | 'PAID' | 'REFUND_PENDING' | 'REFUNDED' | 'NOTHING_DUE',
 *     amountDue:    '609.00' | null,   // rupees TO COLLECT, for the seller's WHOLE delivery
 *     amount:       '609.00' | null,   // what that delivery comes to — also when it is PAID
 *     parts:        [{ kind: 'items', amount: '540.00' }, { kind: 'delivery', amount: '69.00' }] | null,
 *                                      // what `amount` is made of; kinds: items, tax,
 *                                      // delivery, codFee, discount (taken off)
 *     lines:        2,                 // how many of their live lines it covers
 *     unpaidOnline: false,             // TO_COLLECT because an online payment never arrived
 *   }
 *
 * `amountDue` is the instruction ("take this much"); it is null on a paid order
 * so that nothing reading it can ask a farmer for money twice. `amount` and
 * `parts` are information, shown beside "Paid online" as well.
 *
 * ── This is a DISPLAY, not a record ─────────────────────────────────────────
 * Nothing is written. In particular the `codAmountDue` / `codCollected*` columns
 * on order_deliveries are not touched: recording that cash was collected is
 * phase 5 of docs/SELLER_DELIVERY_DESIGN.md and waits for the owner's decisions
 * D3 and D4. The amount below is worked out fresh from the order on every read,
 * so it can never disagree with a stored copy.
 *
 * ── The amount ──────────────────────────────────────────────────────────────
 * It is the seller's SHARE of what the buyer was quoted, from the price
 * breakdown frozen on the order — never a sum the app could redo differently:
 *
 *   the seller's live lines        goods, plus tax where tax was added on top
 *   + their shipment's delivery    the fee quoted for THEIR delivery (pricingSnapshot)
 *   − nothing for cancelled lines  a line they cancelled is not paid for
 *
 * When the order has ONE seller the amount is simply the order total less the
 * lines that were cancelled — so with nothing cancelled it is, to the paisa,
 * the total the farmer was shown at checkout.
 *
 * Tax "added on top" is read off the order's own arithmetic exactly as
 * orderRefund.service.js does, so what a seller collects in cash and what a
 * paid-online buyer is refunded for the same line are the same number.
 *
 * ── Where it answers "I cannot say" (amountDue: null) ───────────────────────
 * An order from several sellers that has no per-seller breakdown (placed before
 * the snapshot was recorded), or that carries an order-level discount no rule
 * says how to split. The app then tells the seller it is a cash order and to
 * confirm the amount, rather than printing a figure nobody can stand behind.
 *
 * ── One rule the owner may want to change ───────────────────────────────────
 * The cash-on-delivery fee (`shop.delivery.codFee`, 0 unless turned on) is
 * charged once per ORDER. With one seller they collect it. With several it is
 * put on the first shipment that still has something to deliver, so that what
 * the sellers collect adds up to what the farmer was quoted — but never onto a
 * shipment that has ALREADY been delivered without it (codFeeCarrier below): a
 * seller's amount must not change after they have been paid at the door. Who
 * finally keeps that fee is part of D4 and is not decided here.
 *
 * ── orders.paymentStatus is read defensively ────────────────────────────────
 * More than one writer sets it, and not all of them agree on what it means:
 *   - orderRefund.service.js   'refund_pending' → 'refunded' / 'partially_refunded'
 *   - the Razorpay refund webhook (shopPayment.service.js)  'refund_initiated',
 *     then 'refunded' — for ANY refund, including the partial one made when just
 *     one seller's lines are cancelled
 *   - an admin (admin/orders.routes.js)  any value, with the lines left as they are
 * So "refunded" on the order does NOT mean this seller's lines were refunded,
 * and a value this file has never heard of may appear. Two rules follow:
 *   1. What happened to THIS seller's lines decides between "paid" and
 *      "refunded" — the order-level word alone never does.
 *   2. An online order is only ever created once its payment is confirmed, so a
 *      seller is told to collect on one only when the status says plainly that
 *      the money did not come ('pending', 'failed'). Any other value is treated
 *      as paid: asking a farmer for cash they have already paid online is the
 *      one mistake this object must never make.
 */
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { D, sumD, round2 } from '../utils/money.js';

/** On a CASH order: values under which money has been received (only an admin sets these). */
const CASH_PAID = new Set(['paid', 'partially_refunded', 'refund_pending', 'refund_initiated']);

/** On an ONLINE order: the only values that say the buyer's money has NOT come in. */
const ONLINE_UNPAID = new Set(['', 'pending', 'failed']);

/** A refund for cancelled lines is on its way ('refund_initiated' is the gateway's own word for it). */
const REFUND_UNDERWAY = new Set(['refund_pending', 'refund_initiated']);

/** A refund for cancelled lines has been made. */
const REFUND_DONE = new Set(['partially_refunded', 'refunded']);

const methodOf = (order) => (String(order?.paymentMethod ?? '').trim().toLowerCase() === 'cod' ? 'cod' : 'online');

const maxZero = (v) => (v.lt(0) ? D(0) : v);

const timeOf = (value) => {
  if (value == null || value === '') return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * Which seller the cash-on-delivery fee is on, or null when nobody can take it.
 *
 * It belongs to the first shipment — in the order the buyer was quoted — that
 * still has something to deliver. Two things make that less simple than it reads:
 *
 *   - A shipment that has been DELIVERED keeps the fee if it was first in line
 *     when it was handed over (it was told to take it, and did).
 *   - A shipment delivered while one AHEAD of it was still live was told an
 *     amount without the fee. If the one ahead is cancelled afterwards, the fee
 *     must not appear on the delivered card after the fact — the cash has
 *     already changed hands. It passes to the next shipment still to be
 *     delivered, or to nobody.
 *
 * "Afterwards" is read off the line timestamps. Where one was never recorded
 * the shipment is taken to have been first in line, which is the plain rule.
 *
 * @param {object[]} shipments  pricingSnapshot.shipments, in quoted order
 * @param {object[]} items      every line: sellerId, status, deliveredAt, cancelledAt
 * @returns {string|null} sellerId
 */
export function codFeeCarrier(shipments, items) {
  // The latest moment a shipment AHEAD of the one being looked at was cancelled.
  let cancelledAheadAt = null;
  for (const shipment of shipments) {
    const lines = items.filter((i) => i.sellerId === shipment.sellerId);
    const live = lines.filter((i) => i.status !== 'CANCELLED');
    if (!live.length) {
      for (const line of lines) {
        const at = timeOf(line.cancelledAt);
        if (at != null && (cancelledAheadAt == null || at > cancelledAheadAt)) cancelledAheadAt = at;
      }
      continue;
    }
    // Still to be delivered: the fee can be taken at the door.
    if (live.some((i) => i.status !== 'DELIVERED')) return shipment.sellerId;

    // Delivered. It carried the fee only if everything ahead of it had already
    // been cancelled by then.
    const deliveredAt = live.reduce((latest, i) => {
      const at = timeOf(i.deliveredAt);
      return at != null && (latest == null || at > latest) ? at : latest;
    }, null);
    if (cancelledAheadAt == null || deliveredAt == null || cancelledAheadAt <= deliveredAt) return shipment.sellerId;
  }
  return null;
}

/**
 * How much THIS seller's delivery of the order comes to.
 *
 * @param {object} order   totalAmount, subtotal, deliveryFee, taxAmount, discountAmount, pricingSnapshot
 * @param {object[]} items EVERY line of the order: sellerId, status, totalPrice, taxAmount,
 *                         and deliveredAt / cancelledAt (read only to place the cash-on-delivery fee)
 * @param {string} sellerId
 * @returns {{ amount: import('decimal.js').Decimal|null, lines: number,
 *             parts: Array<{kind: string, amount: import('decimal.js').Decimal}>|null }}
 *   `amount` is null when it cannot be worked out; `lines` is the seller's live
 *   lines; `parts` is what the amount is made of (see amountParts), or null.
 */
export function sellerShareOf(order, items, sellerId) {
  const all = (Array.isArray(items) ? items : []).filter(Boolean);
  const mine = all.filter((i) => i.sellerId === sellerId);
  const live = mine.filter((i) => i.status !== 'CANCELLED');
  if (!live.length) return { amount: D(0), lines: 0, parts: null };

  const total = D(order?.totalAmount);
  // Tax added on top of the price, read off the order's own arithmetic — the
  // same reading orderRefund.service.js takes, so a cash line and a refunded
  // line are worth the same.
  const taxAdded = round2(total.minus(D(order?.subtotal)).minus(D(order?.deliveryFee)).plus(D(order?.discountAmount)));
  const addsTax = D(order?.taxAmount).gt(0) && taxAdded.gt(0);
  const lineValue = (i) => D(i.totalPrice).plus(addsTax ? D(i.taxAmount) : 0);

  const goods = sumD(live, (i) => D(i.totalPrice));
  const tax = addsTax ? sumD(live, (i) => D(i.taxAmount)) : D(0);
  const snapshot = order?.pricingSnapshot;
  const codFee = methodOf(order) === 'cod' ? D(snapshot?.codFee) : D(0);

  const sellers = new Set(all.map((i) => i.sellerId ?? null));
  if (sellers.size === 1) {
    // One seller: everything the buyer was quoted, less what was cancelled.
    const cancelled = mine.filter((i) => i.status === 'CANCELLED');
    const amount = maxZero(round2(total.minus(sumD(cancelled, lineValue))));
    // The order's delivery figure already has the cash-on-delivery fee in it
    // (shopPricing.service.js): taken back out here so it is named on its own.
    const fee = D(order?.deliveryFee);
    const cod = codFee.gt(0) && codFee.lte(fee) ? codFee : D(0);
    return {
      amount,
      lines: live.length,
      parts: amountParts({ items: goods, tax, delivery: fee.minus(cod), codFee: cod, discount: D(order?.discountAmount) }, amount),
    };
  }

  const shipments = Array.isArray(snapshot?.shipments) ? snapshot.shipments.filter(Boolean) : [];
  const own = shipments.find((s) => s.sellerId === sellerId);
  // No frozen breakdown for this seller, or a discount nothing says how to
  // split: an honest "cannot say" beats a figure worked out by guessing.
  if (!own || D(order?.discountAmount).gt(0)) return { amount: null, lines: live.length, parts: null };

  const carriesCodFee = codFee.gt(0) && codFeeCarrier(shipments, all) === sellerId;
  const delivery = D(own.deliveryFee);
  const cod = carriesCodFee ? codFee : D(0);
  const amount = maxZero(round2(goods.plus(tax).plus(delivery).plus(cod)));
  return {
    amount,
    lines: live.length,
    parts: amountParts({ items: goods, tax, delivery, codFee: cod, discount: D(0) }, amount),
  };
}

/**
 * What an amount is made of, for the seller to read: their goods, tax where it
 * was added on top, the delivery charge, the cash-on-delivery fee, and — taken
 * off — a discount.
 *
 *   [{ kind: 'items', amount }, { kind: 'delivery', amount }, …]
 *
 * `items` always comes first; a part worth nothing is left out. The seller's
 * card prints one LINE's total beside the amount to collect, and the two differ
 * by exactly these — without them "Amount ₹540 / Collect ₹609" reads as a
 * mistake.
 *
 * Returned ONLY when the parts add up to the amount to the paisa. An order
 * whose total holds something this file does not know about (or an old one
 * whose figures do not reconcile) gets null: the amount is still right, and a
 * breakdown that does not add up would only cast doubt on it.
 */
function amountParts({ items, tax, delivery, codFee, discount }, amount) {
  const order = [['items', items], ['tax', tax], ['delivery', delivery], ['codFee', codFee], ['discount', discount]];
  if (order.some(([, value]) => value.lt(0))) return null;
  const sum = items.plus(tax).plus(delivery).plus(codFee).minus(discount);
  if (!round2(sum).eq(round2(amount))) return null;
  return order
    .filter(([kind, value]) => kind === 'items' || value.gt(0))
    .map(([kind, value]) => ({ kind, amount: round2(value) }));
}

/**
 * The payment object for one seller on one order. Pure: everything it says is
 * read off the rows it is given.
 *
 *   the whole order REFUNDED (an admin)       REFUNDED       the money went back
 *   none of the seller's lines is live        REFUND_PENDING a refund is on its way
 *                                             REFUNDED       it has been made
 *                                             NOTHING_DUE    cash, or never paid
 *   live lines, online, paid                  PAID           do not collect
 *   live lines, online, plainly never paid    TO_COLLECT     with `unpaidOnline`
 *   live lines, cash, marked paid             PAID           do not collect twice
 *   live lines, cash, marked refunded         REFUNDED       an admin's doing
 *   live lines, cash                          TO_COLLECT     amountDue at the door
 *
 * See "orders.paymentStatus is read defensively" at the top of this file for
 * why the order-level word is not simply taken at face value.
 */
export function sellerPaymentFor(order, items, sellerId) {
  const method = methodOf(order);
  const { amount, lines, parts } = sellerShareOf(order, items, sellerId);
  const paymentStatus = String(order?.paymentStatus ?? '').trim().toLowerCase();
  const base = { method, status: 'NOTHING_DUE', amountDue: null, amount: null, parts: null, lines, unpaidOnline: false };
  // What the seller's delivery comes to and what that is made of — said for a
  // delivery that is paid for as much as for one still to be collected. Never
  // for a refund: how much went back is the refund's own arithmetic, not this.
  const worth = {
    amount: amount ? amount.toFixed(2) : null,
    parts: amount && parts ? parts.map((p) => ({ kind: p.kind, amount: p.amount.toFixed(2) })) : null,
  };
  const paid = { ...base, ...worth, status: 'PAID' };
  const toCollect = { ...base, ...worth, status: 'TO_COLLECT', amountDue: worth.amount, unpaidOnline: method !== 'cod' };

  // An admin refunded the order: the lines stay as they were, the money is back.
  if (order?.status === 'REFUNDED') return { ...base, status: 'REFUNDED' };

  if (lines === 0) {
    // Nothing of this seller's is being delivered, so the only question left is
    // where the buyer's money for it is.
    if (REFUND_UNDERWAY.has(paymentStatus)) return { ...base, status: 'REFUND_PENDING' };
    if (REFUND_DONE.has(paymentStatus)) return { ...base, status: 'REFUNDED' };
    return base;
  }

  if (method === 'cod') {
    // Nothing automatic moves a cash order off 'pending': these are an admin's.
    if (paymentStatus === 'refunded') return { ...base, status: 'REFUNDED' };
    if (CASH_PAID.has(paymentStatus)) return paid;
    return toCollect;
  }

  // Online, with lines still being delivered. A refund recorded on the ORDER
  // ('refunded', 'partially_refunded', 'refund_initiated'…) is for lines that
  // were cancelled — another seller's, or another of this seller's — not for
  // these, which are paid for.
  return ONLINE_UNPAID.has(paymentStatus) ? toCollect : paid;
}

/**
 * Put `payment` on each row's `order` (GET /agristore/seller/orders).
 *
 * One query for the whole page: the page's orders with their money columns and
 * EVERY line's (seller, status, value) — the other sellers' lines are needed to
 * know whether this seller is the only one, and are read for nothing else. The
 * object attached is built field by field in sellerPaymentFor(), so no other
 * seller's amounts and none of the order's payment references can ride along.
 *
 * A failure here must not take the seller's order list down with it: the rows
 * are returned without `payment`, which the app reads as "an older server" and
 * falls back to naming the method.
 *
 * @param {Array<object>} rows  order lines, each with `orderId` and `order`
 * @param {string} sellerId     the caller — never a value from the request
 */
export async function attachSellerPaymentState(rows, sellerId) {
  const list = (rows || []).filter((r) => r?.order);
  const orderIds = [...new Set(list.map((r) => r.orderId).filter(Boolean))];
  if (!orderIds.length || !sellerId) return rows;

  let orders;
  try {
    orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: {
        id: true, status: true, paymentMethod: true, paymentStatus: true,
        totalAmount: true, subtotal: true, deliveryFee: true, taxAmount: true, discountAmount: true,
        pricingSnapshot: true,
        items: {
          select: {
            id: true, sellerId: true, status: true, totalPrice: true, taxAmount: true,
            deliveredAt: true, cancelledAt: true,
          },
        },
      },
    });
  } catch (err) {
    logger.warn('[Payment] payment state unavailable for the seller list: %s', err?.message);
    return rows;
  }

  const byId = new Map(orders.map((o) => [o.id, o]));
  const computed = new Map();
  for (const row of list) {
    const order = byId.get(row.orderId);
    if (!order) continue;
    if (!computed.has(order.id)) computed.set(order.id, sellerPaymentFor(order, order.items, sellerId));
    row.order.payment = computed.get(order.id);
  }
  return rows;
}
