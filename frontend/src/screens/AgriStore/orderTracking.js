/**
 * Order tracking — the timeline a farmer reads to answer "where is my order?".
 *
 * My Orders said WHAT state an order was in (a badge) and when it should arrive.
 * It never showed the road: that the shop accepted it at 4 pm, that it left the
 * shop this morning, that it was tried and came back. A farmer checking on an
 * order wants that story, in order, with times — the way every shopping app
 * they have used tells it.
 *
 *   ✓ Order placed              12 Oct, 2:32 pm
 *   ✓ Confirmed by the shop     12 Oct, 4:10 pm
 *   ● Out for delivery          13 Oct, 9:05 am        ← where it is now
 *   ○ Delivered                 Arriving by 15 Oct
 *
 * ── One timeline per SHOP ───────────────────────────────────────────────────
 * Each shop delivers its own part, so an order from two shops is two
 * deliveries that move independently — one can be at the door while the other
 * has not been packed. One merged timeline could only ever show the slower of
 * the two, and would hide the delivery that is actually arriving.
 *
 * ── Where the facts come from ───────────────────────────────────────────────
 * Nothing is guessed. The state of each shop's delivery is the server's
 * (`order.deliveries[].status`), and the times are the ones stamped on the
 * order lines when they moved (`confirmedAt`, `shippedAt`, `deliveredAt`,
 * `cancelledAt`). Where a time was never recorded — an order from before those
 * columns existed, or a shop that handed the goods over at the counter and
 * skipped a step — the step is shown as done with NO time, never with an
 * invented one.
 *
 * ── The ways it ends ────────────────────────────────────────────────────────
 *   delivered          every step done
 *   cancelled          the steps that really happened, then "Cancelled"
 *   could not deliver  …then "Could not be delivered" and the reason the shop
 *                      gave (the goods went out and came back)
 *   paid online        …then where the refund is, for the part that was
 *                      cancelled. A cash order has nothing to refund and says
 *                      nothing about one.
 *
 * Pure functions only — no React, no react-native — so the plain-node Jest
 * config tests all of it.
 */
import { humanOrderStatus, orderEta, orderRefundLabel } from './shopUtils';

/** The road an order travels, in order. */
const FLOW = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED'];

/** Statuses under which something is still on its way. */
const LIVE = new Set(['PENDING', 'CONFIRMED', 'SHIPPED']);

const isEntry = (d) => Boolean(d) && typeof d === 'object' && !Array.isArray(d);

/**
 * Is anything on this order still on its way?
 *
 * The cheap question, for a CLOSED card: it decides whether the card offers
 * "Track order" or "View details", and a list of ten closed cards must not
 * build ten timelines to find out. Always the same answer as
 * `orderTracking(order).live` (the tests hold the two together).
 */
export function isOrderLive(order) {
  // Refunded by an admin: closed, whatever the lines were left at.
  if (order?.status === 'REFUNDED') return false;
  const sent = Array.isArray(order?.deliveries) ? order.deliveries.filter(isEntry) : [];
  if (sent.length) return sent.some((d) => LIVE.has(d.status));
  const items = Array.isArray(order?.items) ? order.items.filter(Boolean) : [];
  if (items.length && items.every((i) => i.sellerId)) return items.some((i) => LIVE.has(i.status));
  const own = typeof order?.status === 'string' && order.status.trim() ? order.status : null;
  return LIVE.has(own || statusFromLines(items));
}

const STEP = {
  PENDING: { id: 'placed', key: 'orders.trackPlaced', fallback: 'Order placed' },
  CONFIRMED: { id: 'confirmed', key: 'orders.trackConfirmed', fallback: 'Confirmed by the shop' },
  SHIPPED: { id: 'shipped', key: 'orders.statusOutForDelivery', fallback: 'Out for delivery' },
  DELIVERED: { id: 'delivered', key: 'orders.statusDelivered', fallback: 'Delivered' },
};

/** What the farmer is told while a step is the current one. */
const WAITING_NOTE = {
  PENDING: { key: 'orders.trackWaitingShop', fallback: 'Waiting for the shop to confirm your order.' },
  CONFIRMED: { key: 'orders.trackPreparing', fallback: 'The shop is getting your order ready.' },
};

const FAILED_NOTE = {
  REFUSED: { key: 'orders.trackFailedRefused', fallback: 'The order was refused at the door.' },
  UNREACHABLE: { key: 'orders.trackFailedUnreachable', fallback: 'The shop could not reach you.' },
  ADDRESS_NOT_FOUND: { key: 'orders.trackFailedAddress', fallback: 'The shop could not find the address.' },
};

const toDate = (value) => {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const earliest = (dates) => dates.reduce((a, d) => (d && (!a || d < a) ? d : a), null);
const latest = (dates) => dates.reduce((a, d) => (d && (!a || d > a) ? d : a), null);

/**
 * "12 Oct, 2:32 pm" — the day and the time a step happened, in the phone's own
 * zone. Null for a time that was never recorded.
 *
 * The engine's formatter first (it knows the phone's zone and 12-hour clock);
 * a hand-built form only if the engine throws or answers with nothing, so a
 * step that DID happen is never left without its time.
 */
export function formatTrackTime(value) {
  const d = toDate(value);
  if (!d) return null;
  try {
    const text = d.toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    if (typeof text === 'string' && text.trim()) return text;
  } catch { /* fall through to the hand-built form */ }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const h = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${h % 12 || 12}:${minutes} ${h < 12 ? 'am' : 'pm'}`;
}

/** One shop's status from its own lines: the least advanced live one, or CANCELLED. */
function statusFromLines(lines) {
  let least = null;
  for (const line of lines) {
    const rank = FLOW.indexOf(line?.status);
    if (rank === -1) continue;
    if (least === null || rank < FLOW.indexOf(least)) least = line.status;
  }
  if (least) return least;
  return lines.some((l) => l?.status === 'CANCELLED') ? 'CANCELLED' : null;
}

/**
 * The deliveries of an order, each with the lines it carries.
 *
 * The server's `deliveries` when it sends them. An older server sends none, so
 * the lines are grouped by their shop instead; and for an order whose lines
 * name no shop at all, the whole order is one delivery read off `order.status`.
 */
function shipmentsOf(order) {
  const items = Array.isArray(order?.items) ? order.items.filter(Boolean) : [];
  const sent = Array.isArray(order?.deliveries) ? order.deliveries.filter(isEntry) : [];

  if (sent.length) {
    return sent.map((d) => {
      const lines = items.filter((i) => i.sellerId && i.sellerId === d.sellerId);
      return {
        sellerId: typeof d.sellerId === 'string' ? d.sellerId : null,
        name: typeof d.sellerName === 'string' && d.sellerName.trim() ? d.sellerName.trim() : null,
        status: typeof d.status === 'string' && d.status.trim() ? d.status : statusFromLines(lines),
        failedReason: typeof d.failedReason === 'string' ? d.failedReason : null,
        lines,
      };
    });
  }

  const bySeller = new Map();
  for (const item of items) {
    if (!item.sellerId) continue;
    if (!bySeller.has(item.sellerId)) bySeller.set(item.sellerId, []);
    bySeller.get(item.sellerId).push(item);
  }
  if (bySeller.size && [...bySeller.values()].reduce((n, l) => n + l.length, 0) === items.length) {
    return [...bySeller.entries()].map(([sellerId, lines]) => ({
      sellerId,
      name: lines.find((l) => typeof l.sellerName === 'string' && l.sellerName.trim())?.sellerName.trim() || null,
      status: statusFromLines(lines),
      failedReason: null,
      lines,
    }));
  }

  // No shop on the lines (a very old order): the order is one delivery. Its
  // status is the order's — except REFUNDED, which says where the money went
  // and not how far the goods got; the lines still know that.
  const ownStatus = typeof order?.status === 'string' && order.status.trim() ? order.status : null;
  const fromLines = statusFromLines(items);
  return [{
    sellerId: null, name: null, failedReason: null, lines: items,
    status: (ownStatus === 'REFUNDED' ? fromLines : null) || ownStatus || fromLines,
  }];
}

/**
 * The refund step for a delivery that was cancelled, or for a refunded order.
 * Null when the order says nothing about a refund (a cash order never does,
 * unless an admin marked it refunded).
 *
 * Only a refund still on its way is "current" (the clock). One that has been
 * made — in full, or for the part that was cancelled — is done.
 */
function refundStep(order) {
  const label = orderRefundLabel(order?.paymentStatus, order?.paymentMethod);
  if (!label) return null;
  return {
    id: 'refund',
    state: label.done ? 'done' : 'current',
    title: { key: label.key, fallback: label.fallback },
    at: null,
    time: null,
    note: null,
    tone: label.done ? 'good' : 'wait',
  };
}

/**
 * The last step of an order an admin refunded. The payment status normally
 * says how ('refunded'); where it does not, the step still says the one thing
 * that is certain — the order's own status.
 */
function refundedStep(order) {
  return refundStep(order) || {
    id: 'refund', state: 'done', title: { key: 'orders.statusRefunded', fallback: 'Refunded' },
    at: null, time: null, note: null, tone: 'good',
  };
}

function stepsFor(order, shipment, now) {
  const { status, lines, failedReason } = shipment;
  const live = lines.filter((l) => l.status !== 'CANCELLED');
  const cancelled = lines.filter((l) => l.status === 'CANCELLED');
  const from = status === 'CANCELLED' ? cancelled : live;

  const at = {
    PENDING: toDate(order?.createdAt),
    CONFIRMED: earliest(from.map((l) => toDate(l.confirmedAt))),
    SHIPPED: earliest(from.map((l) => toDate(l.shippedAt))),
    DELIVERED: latest(from.map((l) => toDate(l.deliveredAt))),
  };
  const step = (code, state, note = null, tone = null) => ({
    id: STEP[code].id,
    state,
    title: { key: STEP[code].key, fallback: STEP[code].fallback },
    at: at[code],
    time: formatTrackTime(at[code]),
    note,
    tone,
  });

  // ── Ended without arriving ────────────────────────────────────────────────
  if (status === 'CANCELLED') {
    const cancelledAt = latest(cancelled.map((l) => toDate(l.cancelledAt)));
    const wentOut = Boolean(at.SHIPPED) || Boolean(FAILED_NOTE[failedReason]);
    const wasConfirmed = Boolean(at.CONFIRMED) || wentOut;
    const steps = [step('PENDING', 'done')];
    // Only the steps that really happened. A cancel before the shop accepted
    // must not show "Confirmed by the shop" on the way to "Cancelled".
    if (wasConfirmed) steps.push(step('CONFIRMED', 'done'));
    if (wentOut) steps.push(step('SHIPPED', 'done'));

    const failed = FAILED_NOTE[failedReason];
    steps.push({
      id: failed ? 'failed' : 'cancelled',
      state: 'failed',
      title: failed
        ? { key: 'orders.trackFailed', fallback: 'Could not be delivered' }
        : { key: 'orders.statusCancelled', fallback: 'Cancelled' },
      at: cancelledAt,
      time: formatTrackTime(cancelledAt),
      note: failed ? { key: failed.key, fallback: failed.fallback } : null,
      tone: 'bad',
    });

    const refund = refundStep(order);
    if (refund) steps.push(refund);
    return steps;
  }

  // ── A status this build does not know ─────────────────────────────────────
  const rank = FLOW.indexOf(status);
  if (rank === -1) {
    const steps = [step('PENDING', 'done')];
    // A refunded order with no lines to read the delivery from.
    if (status === 'REFUNDED') return [...steps, refundedStep(order)];
    const words = humanOrderStatus(status);
    if (words) {
      steps.push({ id: 'status', state: 'current', title: { key: null, fallback: words }, at: null, time: null, note: null, tone: null });
    }
    return steps;
  }

  // ── On its way, or arrived ────────────────────────────────────────────────
  // What the "Delivered" step says while it is still ahead: the promised day,
  // or plainly that the day has passed. Not on a refunded order: an admin can
  // refund one whose lines were never moved on, and "Arriving by" beside
  // "Refunded" is a promise nobody is keeping.
  const refunded = order?.status === 'REFUNDED';
  const eta = status === 'DELIVERED' || refunded ? null : orderEta({ ...order, status }, now);
  const etaNote = eta
    ? { key: eta.key, fallback: eta.fallback, vars: { date: eta.dateText } }
    : null;

  const steps = FLOW.map((code, i) => {
    if (i < rank) return step(code, 'done');
    if (i === rank) {
      // The step the order is AT. Delivered is an ending, not a place to wait.
      if (code === 'DELIVERED') return step(code, 'done', null, 'good');
      const waiting = WAITING_NOTE[code];
      return step(code, 'current', waiting ? { key: waiting.key, fallback: waiting.fallback } : null);
    }
    if (code === 'DELIVERED') return step(code, 'upcoming', etaNote, eta?.late ? 'late' : null);
    return step(code, 'upcoming');
  });

  // An admin refund leaves the lines as they were.
  if (refunded) steps.push(refundedStep(order));
  return steps;
}

/**
 * The tracking view of an order.
 *
 * @param {object} order   a row from GET /agristore/orders
 * @param {{now?: number|Date}} [opts]  `now` is injectable for tests
 * @returns {{
 *   single: boolean,
 *   live: boolean,
 *   shipments: Array<{
 *     key: string, sellerId: string|null, name: string|null, ordinal: number,
 *     status: string|null, partCancelled: boolean,
 *     steps: Array<{
 *       id: string,
 *       state: 'done'|'current'|'upcoming'|'failed',
 *       title: {key: string|null, fallback: string},
 *       at: Date|null, time: string|null,
 *       note: {key: string, fallback: string, vars?: object}|null,
 *       tone: 'good'|'bad'|'late'|'wait'|null }> }> }}
 *   `live` is true while something is still on its way — the screen then offers
 *   "Track order" rather than "View details".
 */
export function orderTracking(order, opts) {
  const now = opts?.now ?? Date.now();
  if (!order || typeof order !== 'object') return { single: true, live: false, shipments: [] };

  const shipments = shipmentsOf(order)
    .filter((s) => s.status || s.lines.length)
    .map((s, i) => {
      const liveLines = s.lines.filter((l) => l.status !== 'CANCELLED');
      return {
        // Index first: the server's order is stable, and a repeated shop id (it
        // should never happen) must not produce two rows with one React key.
        key: `${i}:${s.sellerId || ''}`,
        sellerId: s.sellerId,
        name: s.name,
        ordinal: i + 1,
        status: s.status,
        // Some of this shop's lines were cancelled while the rest carry on.
        partCancelled: s.status !== 'CANCELLED' && liveLines.length > 0 && liveLines.length < s.lines.length,
        steps: stepsFor(order, s, now),
      };
    });

  return {
    single: shipments.length <= 1,
    // A refunded order is closed, whatever its lines were left at (isOrderLive).
    live: order.status !== 'REFUNDED' && shipments.some((s) => LIVE.has(s.status)),
    shipments,
  };
}
