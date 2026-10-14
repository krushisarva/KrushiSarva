/**
 * What the seller is told about the MONEY on an order — no React, no React
 * Native, so the plain-node Jest config tests all of it.
 *
 * GET /agristore/seller/orders puts `payment` on each row's `order`
 * (backend/src/services/sellerPayment.service.js):
 *
 *   { method: 'cod'|'online',
 *     status: 'TO_COLLECT'|'PAID'|'REFUND_PENDING'|'REFUNDED'|'NOTHING_DUE',
 *     amountDue: '609.00'|null, lines: 2, unpaidOnline: false }
 *
 * The card used to print the bare method in capitals — "COD", "UPI" — which
 * answers neither question a seller has at a farmer's gate: has this been paid,
 * and if not, how much do I take?
 *
 * ── Two things decide the words: the server's answer and THIS seller's status ─
 * The amount and whether money has been received come from the server; the app
 * never adds anything up. But the row's status can run ahead of the payment
 * object: the seller marks an order delivered or cancels it, the card changes
 * at once, and the payment object on it is still the one that was read before.
 * So a cancelled row never says "collect", and a delivered one stops giving an
 * instruction and states the amount that was due — whatever the stale object
 * says.
 *
 * Nothing here says cash WAS collected. The app does not record that yet
 * (docs/SELLER_DELIVERY_DESIGN.md, phase 5), so it does not claim it.
 *
 * ── An older server ─────────────────────────────────────────────────────────
 * sends no `payment`. The method and paymentStatus it does send are enough to
 * say "cash on delivery" or "paid online" — without an amount, because the one
 * figure on the row is a single line's total, and that is not what is owed.
 *
 * The order's paymentStatus is read the way the server reads it
 * (sellerPayment.service.js, "read defensively"): a refund recorded on the
 * ORDER is for lines that were cancelled, so it means "refunded" only on a row
 * that is itself cancelled; and an online order is called unpaid only when the
 * status says so in plain words. Asking a farmer for cash they have already paid
 * online is the one mistake this file must never make.
 */

/** On an ONLINE order: the only paymentStatus values that say the money has NOT come in. */
const ONLINE_UNPAID = new Set(['', 'pending', 'failed']);

/** On a CASH order: values under which money has been received (only an admin sets these). */
const CASH_PAID = new Set(['paid', 'partially_refunded', 'refund_pending', 'refund_initiated']);

/** A refund for cancelled lines is on its way ('refund_initiated' is the gateway's own word). */
const REFUND_UNDERWAY = new Set(['refund_pending', 'refund_initiated']);

/** A refund for cancelled lines has been made. */
const REFUND_DONE = new Set(['partially_refunded', 'refunded']);

const STATUSES = new Set(['TO_COLLECT', 'PAID', 'REFUND_PENDING', 'REFUNDED', 'NOTHING_DUE']);

/** A rupee amount from the server as a number, or null. Never NaN, never negative. */
function amountOf(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** What an amount can be made of — the kinds the server names (sellerPayment.service.js). */
const PART_KINDS = ['items', 'tax', 'delivery', 'codFee', 'discount'];

/**
 * The server's breakdown of an amount, kept only if every part can be read and
 * the parts ADD UP to `amount` (a discount is taken off). One part this build
 * does not know, or a sum that is a paisa out, and the breakdown is dropped: a
 * breakdown that does not add up would only cast doubt on a figure that is
 * right. A single part is dropped too — it says nothing the amount has not.
 */
function partsOf(value, amount) {
  if (!Array.isArray(value) || amount == null) return null;
  const parts = [];
  let sum = 0;
  for (const part of value) {
    const worth = amountOf(part?.amount);
    if (!part || !PART_KINDS.includes(part.kind) || worth == null) return null;
    sum += part.kind === 'discount' ? -worth : worth;
    if (worth > 0) parts.push({ kind: part.kind, amount: worth });
  }
  if (Math.abs(sum - amount) > 0.005) return null;
  return parts.length >= 2 ? parts : null;
}

/**
 * The payment facts for a row, from the server's object or — on an older
 * server — from the bare method and status. Null when the row says nothing
 * usable about payment at all.
 *
 * @returns {{method: 'cod'|'online', status: string, amount: number|null,
 *            worth: number|null, parts: Array<{kind: string, amount: number}>|null,
 *            lines: number, unpaidOnline: boolean, exact: boolean,
 *            refund: 'underway'|'done'|null}|null}
 *   `amount` is cash TO COLLECT and nothing else — null on a paid order.
 *   `worth` is what the seller's delivery comes to, paid or not, and `parts`
 *   what that is made of; both are information, never an instruction.
 *   `exact` is false for the older-server fallback, which knows no amount.
 *   `refund` is set only by that fallback: what the ORDER says about a refund,
 *   for paymentNotice() to apply to a row that is itself cancelled.
 */
export function paymentInfo(row) {
  const order = row?.order;
  if (!order || typeof order !== 'object') return null;

  const sent = order.payment;
  if (sent && typeof sent === 'object' && STATUSES.has(sent.status)) {
    const lines = Number(sent.lines);
    const collect = sent.status === 'TO_COLLECT';
    const amount = collect ? amountOf(sent.amountDue) : null;
    // An older server (same object, before `amount` was added) sends only
    // amountDue; a paid order then simply has no figure to show.
    const worth = collect ? amount : (sent.status === 'PAID' ? amountOf(sent.amount) : null);
    return {
      method: sent.method === 'cod' ? 'cod' : 'online',
      status: sent.status,
      amount,
      worth,
      parts: partsOf(sent.parts, worth),
      lines: Number.isInteger(lines) && lines > 0 ? lines : 0,
      unpaidOnline: sent.unpaidOnline === true,
      exact: true,
      refund: null,
    };
  }

  // Older server: only the method and the order's payment status.
  const method = typeof order.paymentMethod === 'string' ? order.paymentMethod.trim().toLowerCase() : '';
  if (!method) return null;
  const paymentStatus = typeof order.paymentStatus === 'string' ? order.paymentStatus.trim().toLowerCase() : '';
  const cod = method === 'cod';
  const base = {
    method: cod ? 'cod' : 'online', amount: null, worth: null, parts: null, lines: 0, unpaidOnline: false, exact: false,
    refund: REFUND_DONE.has(paymentStatus) ? 'done' : (REFUND_UNDERWAY.has(paymentStatus) ? 'underway' : null),
  };

  if (cod) {
    if (paymentStatus === 'refunded') return { ...base, status: 'REFUNDED' };
    if (CASH_PAID.has(paymentStatus)) return { ...base, status: 'PAID' };
    return { ...base, status: 'TO_COLLECT' };
  }
  // Online: paid unless the status says plainly that it was not. A refund on the
  // order belongs to cancelled lines — this row is told about it only if it is
  // one of them (paymentNotice).
  if (ONLINE_UNPAID.has(paymentStatus)) return { ...base, status: 'TO_COLLECT', unpaidOnline: true };
  return { ...base, status: 'PAID' };
}

const text = (key, fallback) => ({ key, fallback });

const PAID_HINT = text('sellerOrders.payPaidHint', 'Do not collect cash.');
const NO_AMOUNT_HINT = text('sellerOrders.payNoAmountHint',
  'The amount could not be worked out here. Confirm the total with the buyer before you deliver.');

/**
 * What the card prints, or null to print nothing.
 *
 *   tone    'collect' | 'paid' | 'refund' | 'warn' | 'quiet'   — never the only
 *           signal: each has its own icon and its own words
 *   title   { key, fallback }   may contain {{amount}}
 *   hint    { key, fallback } | null   may contain {{count}}
 *   amount  number | null       for {{amount}}; the screen formats it
 *   count   number              for {{count}}
 *   parts   [{ kind, amount }] | null   what the amount is made of — goods,
 *           delivery charge… — for the line under the hint (paymentText)
 *
 * @param {object} row            one seller order row
 * @param {string|null} sellerStatus  utils/sellerOrders.js sellerStatusOf(row)
 */
export function paymentNotice(row, sellerStatus) {
  const info = paymentInfo(row);
  if (!info) return null;

  const refunded = { tone: 'refund', icon: 'return-up-back-outline', amount: null, count: 0, parts: null,
    title: text('sellerOrders.payRefunded', 'Refunded to the buyer'),
    hint: text('sellerOrders.payRefundedHint', 'The payment for this order has been returned to the buyer.') };
  const refunding = { tone: 'refund', icon: 'time-outline', amount: null, count: 0, parts: null,
    title: text('sellerOrders.payRefundPending', 'The buyer is being refunded'),
    hint: text('sellerOrders.payRefundPendingHint',
      'This order was paid online and then cancelled. The money is going back to the buyer.') };
  const nothing = { tone: 'quiet', icon: 'remove-circle-outline', amount: null, count: 0, parts: null,
    title: text('sellerOrders.payNothingDue', 'Nothing to collect'),
    hint: text('sellerOrders.payNothingDueHint', 'This order was cancelled.') };

  // An admin refund leaves the lines as they were; the money has gone back.
  if (sellerStatus === 'REFUNDED' || info.status === 'REFUNDED') return refunded;

  // The seller's part is off — possibly cancelled on this phone a second ago,
  // with the payment object still the one read before that.
  if (sellerStatus === 'CANCELLED') {
    if (info.refund === 'done') return refunded;
    // Paid online and now cancelled: the money is on its way back. A cash order
    // has nothing to send back, whatever it was marked.
    if (info.status === 'REFUND_PENDING' || (info.status === 'PAID' && info.method !== 'cod')) return refunding;
    return nothing;
  }

  if (info.status === 'REFUND_PENDING') return refunding;
  if (info.status === 'NOTHING_DUE') return nothing;

  if (info.status === 'PAID') {
    // How much was paid is said when the server gives it — the seller wants to
    // know what the order is worth. It is never an amount to take: the hint
    // right under it says so.
    const named = info.worth != null;
    const cash = info.method === 'cod';
    return {
      tone: 'paid', icon: 'checkmark-circle', amount: info.worth, count: 0, parts: info.parts,
      title: named
        ? (cash
          ? text('sellerOrders.payPaidAmount', 'Already paid: {{amount}}')
          : text('sellerOrders.payPaidOnlineAmount', 'Paid online: {{amount}}'))
        : (cash
          ? text('sellerOrders.payPaid', 'Already paid')
          : text('sellerOrders.payPaidOnline', 'Paid online')),
      hint: PAID_HINT,
    };
  }

  // TO_COLLECT from here on.
  const delivered = sellerStatus === 'DELIVERED';
  const many = info.lines > 1;

  // Delivered, with nothing that can be stated as "cash on delivery: ₹X" — no
  // figure, or an online order that was never paid (it was not a cash order,
  // so it is not described as one). Just the fact: an instruction to collect
  // has no place on an order that has already been handed over.
  if (delivered && (info.amount == null || info.unpaidOnline)) {
    return {
      tone: 'quiet', icon: 'cash-outline', amount: null, count: 0, parts: null,
      title: info.unpaidOnline
        ? text('sellerOrders.payUnpaidOnlineNoAmount', 'Not paid online')
        : text('sellerOrders.payCashNoAmount', 'Cash on delivery'),
      hint: null,
    };
  }

  if (info.amount == null) {
    return {
      tone: info.unpaidOnline ? 'warn' : 'collect',
      icon: info.unpaidOnline ? 'alert-circle' : 'cash-outline',
      amount: null, count: 0, parts: null,
      title: info.unpaidOnline
        ? text('sellerOrders.payUnpaidOnlineNoAmount', 'Not paid online')
        : text('sellerOrders.payCashNoAmount', 'Cash on delivery'),
      // An older server could not have known the amount; a current one tried
      // and could not work it out, which the seller should hear about.
      hint: info.exact
        ? NO_AMOUNT_HINT
        : (info.unpaidOnline
          ? text('sellerOrders.payUnpaidOnlineHint', 'The buyer chose to pay online, but no payment was received.')
          : text('sellerOrders.payCashOldHint', 'Collect the payment when you deliver.')),
    };
  }

  if (delivered) {
    // No instruction once it is delivered, and no claim that the cash came in.
    return {
      tone: 'quiet', icon: 'cash-outline', amount: info.amount, count: info.lines, parts: info.parts,
      title: text('sellerOrders.payCashDelivered', 'Cash on delivery: {{amount}}'),
      hint: text('sellerOrders.payCashDeliveredHint', 'This was the amount to collect at delivery.'),
    };
  }

  if (info.unpaidOnline) {
    return {
      tone: 'warn', icon: 'alert-circle', amount: info.amount, count: info.lines, parts: info.parts,
      title: text('sellerOrders.payUnpaidOnline', 'Not paid online. Collect {{amount}} on delivery'),
      hint: text('sellerOrders.payUnpaidOnlineHint', 'The buyer chose to pay online, but no payment was received.'),
    };
  }

  return {
    tone: 'collect', icon: 'cash-outline', amount: info.amount, count: info.lines, parts: info.parts,
    title: text('sellerOrders.payCollect', 'Collect {{amount}} in cash'),
    // Two cards of one order show the SAME amount. Said outright, so it is
    // collected once and not once per card.
    // The card's own "Amount" is ONE line's goods; this is more than that by
    // the delivery charge (and the seller's other lines), which is why it says so.
    hint: many
      ? text('sellerOrders.payCollectHintMany',
        'This is the full amount for all {{count}} of your items in this order, including any delivery charge. Collect it once.')
      : text('sellerOrders.payCollectHint', 'This is the full amount for this order, including any delivery charge.'),
  };
}

/** How each part of an amount is named. Lower case after the first: they are joined into one line. */
const PART_TEXT = {
  items: text('sellerOrders.payPartItems', 'Items {{amount}}'),
  tax: text('sellerOrders.payPartTax', 'tax {{amount}}'),
  delivery: text('sellerOrders.payPartDelivery', 'delivery {{amount}}'),
  codFee: text('sellerOrders.payPartCodFee', 'cash handling fee {{amount}}'),
  discount: text('sellerOrders.payPartDiscount', 'discount {{amount}}'),
};

/**
 * The notice as finished strings.
 *
 *   title   "Collect ₹609 in cash" · "Paid online: ₹1,418"
 *   hint    the instruction or explanation under it, or null
 *   detail  "Items ₹540 + delivery ₹69" — what the amount is made of, or null.
 *           The card's own "Amount" is ONE line's goods; this line is why the
 *           figure above differs from it. A discount is joined with a minus.
 *
 * @param {object|null} notice   from paymentNotice()
 * @param {Function} t           the app's translate function
 * @param {Function} formatAmount  rupees → "₹609"
 * @returns {{title: string, hint: string|null, detail: string|null}|null}
 */
export function paymentText(notice, t, formatAmount) {
  if (!notice) return null;
  const vars = {
    amount: notice.amount != null ? formatAmount(notice.amount) : '',
    count: notice.count,
  };
  const say = (part) => (part ? t(part.key, { ...vars, defaultValue: part.fallback }) : null);
  const detail = Array.isArray(notice.parts) && notice.parts.length
    ? notice.parts.map((part, i) => {
      const words = t(PART_TEXT[part.kind].key, { amount: formatAmount(part.amount), defaultValue: PART_TEXT[part.kind].fallback });
      if (i === 0) return words;
      return `${part.kind === 'discount' ? ' − ' : ' + '}${words}`;
    }).join('')
    : null;
  return { title: say(notice.title), hint: say(notice.hint), detail };
}

/**
 * The reminder shown at the moment of hand-over ("Mark as delivered"): one
 * sentence or two, or null when there is nothing to say about money.
 *
 * Only for a delivery that is about to happen — a cancelled or already
 * delivered order needs no reminder at the door.
 */
export function handoverReminder(row, sellerStatus, t, formatAmount) {
  if (sellerStatus === 'DELIVERED' || sellerStatus === 'CANCELLED' || sellerStatus === 'REFUNDED') return null;
  const notice = paymentNotice(row, sellerStatus);
  if (!notice || notice.tone === 'quiet' || notice.tone === 'refund') return null;
  const said = paymentText(notice, t, formatAmount);
  // On the card the title is a heading and carries no full stop; here it is the
  // first of two sentences. It takes the hint's own end mark, so Hindi closes
  // with a danda rather than a Latin stop followed by one.
  const stop = /।\s*$/.test(said.hint || '') ? '।' : '.';
  const sentence = (s) => (s && !/[.!?।]$/.test(s.trim()) ? `${s.trim()}${stop}` : s);
  return {
    tone: notice.tone,
    icon: notice.icon,
    text: [sentence(said.title), said.hint].filter(Boolean).join(' '),
  };
}
