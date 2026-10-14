/**
 * What the seller's order card says about money (utils/orderPayment.js).
 *
 * The amounts come from the server and are pinned there
 * (backend/tests/backend/unit/sellerPayment.test.js). This pins the WORDS: that
 * a paid order is never asked for cash, that a cancelled or delivered card
 * never carries an instruction to collect, and that an older server — which
 * sends no amount — is not made to look as if it had.
 */
import { handoverReminder, paymentInfo, paymentNotice, paymentText } from '../orderPayment';
import { translations } from '@krushisarva/shared/i18n/translations';

const row = (payment, order = {}) => ({ id: 'line-1', status: 'SHIPPED', order: { id: 'o1', payment, ...order } });
const cash = (over = {}) => ({ method: 'cod', status: 'TO_COLLECT', amountDue: '609.00', lines: 1, unpaidOnline: false, ...over });
const paid = (over = {}) => ({ method: 'online', status: 'PAID', amountDue: null, lines: 1, unpaidOnline: false, ...over });

const t = (key, vars) => String(vars?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (m, name) => String(vars?.[name] ?? ''));
const rupees = (n) => `₹${n.toFixed(2)}`;
/** The title and the hint — the two lines every notice has. */
const words = (r, status) => {
  const said = paymentText(paymentNotice(r, status), t, rupees);
  return said && { title: said.title, hint: said.hint };
};
/** The third line: what the amount is made of, or null. */
const detailOf = (r, status) => paymentText(paymentNotice(r, status), t, rupees).detail;
const GOODS_AND_DELIVERY = [{ kind: 'items', amount: '540.00' }, { kind: 'delivery', amount: '69.00' }];

describe('a cash order still to be delivered', () => {
  test('says how much to collect', () => {
    const notice = paymentNotice(row(cash()), 'SHIPPED');
    expect(notice).toMatchObject({ tone: 'collect', amount: 609, count: 1 });
    expect(words(row(cash()), 'SHIPPED')).toEqual({
      title: 'Collect ₹609.00 in cash',
      hint: 'This is the full amount for this order, including any delivery charge.',
    });
  });

  test('the same before the goods have left', () => {
    for (const status of ['PENDING', 'CONFIRMED']) {
      expect(words(row(cash()), status).title).toBe('Collect ₹609.00 in cash');
    }
  });

  test('two cards of one order say the amount is for both, and to collect it once', () => {
    const said = words(row(cash({ amountDue: '1418.00', lines: 2 })), 'SHIPPED');
    expect(said.title).toBe('Collect ₹1418.00 in cash');
    expect(said.hint).toBe('This is the full amount for all 2 of your items in this order, including any delivery charge. Collect it once.');
  });

  test('when the server could not work the amount out, no figure is printed', () => {
    const notice = paymentNotice(row(cash({ amountDue: null })), 'SHIPPED');
    expect(notice.amount).toBeNull();
    expect(words(row(cash({ amountDue: null })), 'SHIPPED')).toEqual({
      title: 'Cash on delivery',
      hint: 'The amount could not be worked out here. Confirm the total with the buyer before you deliver.',
    });
  });

  test('a junk amount is treated as no amount, never printed as NaN or a negative', () => {
    for (const amountDue of ['abc', -5, NaN, '']) {
      expect(paymentNotice(row(cash({ amountDue })), 'SHIPPED').amount).toBeNull();
    }
  });
});

describe('an order that is already paid', () => {
  test('paid online: do not collect', () => {
    expect(paymentNotice(row(paid()), 'SHIPPED')).toMatchObject({ tone: 'paid', amount: null });
    expect(words(row(paid()), 'SHIPPED')).toEqual({ title: 'Paid online', hint: 'Do not collect cash.' });
  });

  test('an amount that somehow came with a paid order is ignored', () => {
    expect(paymentNotice(row(paid({ amountDue: '609.00' })), 'SHIPPED').amount).toBeNull();
  });

  test('a cash order recorded as paid is not collected a second time', () => {
    expect(words(row(paid({ method: 'cod' })), 'SHIPPED')).toEqual({ title: 'Already paid', hint: 'Do not collect cash.' });
  });
});

// The card prints one line's goods as "Amount". The figure in the payment box is
// more than that by the delivery charge (and the seller's other lines), so the
// box says what it is made of — and, on a paid order, how much was paid.
describe('how much, and what it is made of', () => {
  test('paid online: the amount paid is named, and it is still "do not collect"', () => {
    const r = row(paid({ amount: '609.00', parts: GOODS_AND_DELIVERY }));
    expect(words(r, 'SHIPPED')).toEqual({ title: 'Paid online: ₹609.00', hint: 'Do not collect cash.' });
    expect(detailOf(r, 'SHIPPED')).toBe('Items ₹540.00 + delivery ₹69.00');
    expect(paymentNotice(r, 'SHIPPED')).toMatchObject({ tone: 'paid', amount: 609 });
    // Said the same at the door.
    expect(handoverReminder(r, 'SHIPPED', t, rupees).text).toBe('Paid online: ₹609.00. Do not collect cash.');
  });

  test('a cash order marked paid: "Already paid", with the amount', () => {
    expect(words(row(paid({ method: 'cod', amount: '609.00' })), 'SHIPPED').title).toBe('Already paid: ₹609.00');
  });

  test('a server that sends no amount with a paid order: just "Paid online"', () => {
    expect(words(row(paid()), 'SHIPPED')).toEqual({ title: 'Paid online', hint: 'Do not collect cash.' });
    expect(detailOf(row(paid()), 'SHIPPED')).toBeNull();
    // amountDue is NOT the amount paid, and is never shown as one.
    expect(words(row(paid({ amountDue: '609.00' })), 'SHIPPED').title).toBe('Paid online');
  });

  test('cash to collect: the same line under the instruction, before and after delivery', () => {
    const r = row(cash({ amount: '609.00', parts: GOODS_AND_DELIVERY }));
    expect(detailOf(r, 'SHIPPED')).toBe('Items ₹540.00 + delivery ₹69.00');
    expect(detailOf(r, 'DELIVERED')).toBe('Items ₹540.00 + delivery ₹69.00');
  });

  test('tax and the cash handling fee are added; a discount is taken off', () => {
    const parts = [
      { kind: 'items', amount: '1000.00' }, { kind: 'tax', amount: '50.00' }, { kind: 'delivery', amount: '49.00' },
      { kind: 'codFee', amount: '10.00' }, { kind: 'discount', amount: '100.00' },
    ];
    const r = row(cash({ amountDue: '1009.00', amount: '1009.00', parts }));
    expect(detailOf(r, 'SHIPPED'))
      .toBe('Items ₹1000.00 + tax ₹50.00 + delivery ₹49.00 + cash handling fee ₹10.00 − discount ₹100.00');
  });

  test('a part worth nothing is not listed, and one part alone is not a breakdown', () => {
    const free = [{ kind: 'items', amount: '609.00' }, { kind: 'delivery', amount: '0.00' }];
    expect(detailOf(row(cash({ amount: '609.00', parts: free })), 'SHIPPED')).toBeNull();
    expect(detailOf(row(cash({ amount: '609.00', parts: [{ kind: 'items', amount: '609.00' }] })), 'SHIPPED')).toBeNull();
  });

  test('parts that do not add up to the amount are not shown — the amount still is', () => {
    const off = [{ kind: 'items', amount: '540.00' }, { kind: 'delivery', amount: '49.00' }];   // 589, not 609
    const r = row(cash({ amount: '609.00', parts: off }));
    expect(detailOf(r, 'SHIPPED')).toBeNull();
    expect(words(r, 'SHIPPED').title).toBe('Collect ₹609.00 in cash');
  });

  test('a part this build has never heard of, or junk: no breakdown rather than a wrong one', () => {
    const odd = [{ kind: 'items', amount: '540.00' }, { kind: 'packing', amount: '69.00' }];
    expect(detailOf(row(cash({ amount: '609.00', parts: odd })), 'SHIPPED')).toBeNull();
    for (const parts of ['nope', {}, [null, null], [{ kind: 'items' }, { kind: 'delivery', amount: 'x' }], [{ kind: 'items', amount: -5 }]]) {
      expect(detailOf(row(cash({ amount: '609.00', parts })), 'SHIPPED')).toBeNull();
    }
  });

  test('nothing is itemised for money that is going back, or for a cancelled card', () => {
    const r = row(cash({ amount: '609.00', parts: GOODS_AND_DELIVERY }));
    expect(detailOf(r, 'CANCELLED')).toBeNull();
    expect(detailOf(row(paid({ amount: '609.00', parts: GOODS_AND_DELIVERY })), 'CANCELLED')).toBeNull();
    expect(detailOf(row(paid({ status: 'REFUNDED', amount: '609.00', parts: GOODS_AND_DELIVERY })), 'DELIVERED')).toBeNull();
    expect(paymentNotice(row(paid({ status: 'REFUND_PENDING', amount: '609.00' })), 'CANCELLED').amount).toBeNull();
  });

  test('an older server (no payment object) has nothing to itemise', () => {
    const old = { id: 'line-1', status: 'SHIPPED', order: { id: 'o1', paymentMethod: 'online', paymentStatus: 'paid' } };
    expect(paymentText(paymentNotice(old, 'SHIPPED'), t, rupees)).toEqual({ title: 'Paid online', hint: 'Do not collect cash.', detail: null });
  });
});

describe('an online order whose payment never arrived', () => {
  test('is owed, and the seller is told why it is not a normal cash order', () => {
    const r = row(cash({ method: 'online', unpaidOnline: true }));
    expect(paymentNotice(r, 'SHIPPED').tone).toBe('warn');
    expect(words(r, 'SHIPPED')).toEqual({
      title: 'Not paid online. Collect ₹609.00 on delivery',
      hint: 'The buyer chose to pay online, but no payment was received.',
    });
  });
});

describe('the card\'s status runs ahead of the payment object', () => {
  test('delivered: the amount that was due, and no instruction', () => {
    const notice = paymentNotice(row(cash()), 'DELIVERED');
    expect(notice.tone).toBe('quiet');
    expect(words(row(cash()), 'DELIVERED')).toEqual({
      title: 'Cash on delivery: ₹609.00',
      hint: 'This was the amount to collect at delivery.',
    });
  });

  test('cancelled on this phone a second ago, cash order: nothing to collect', () => {
    expect(words(row(cash()), 'CANCELLED').title).toBe('Nothing to collect');
  });

  test('cancelled on this phone a second ago, PAID order: the buyer is being refunded — never "collect"', () => {
    expect(words(row(paid()), 'CANCELLED').title).toBe('The buyer is being refunded');
    expect(paymentNotice(row(paid()), 'CANCELLED').tone).toBe('refund');
  });

  test('…but a CASH order marked paid has nothing to send back: it is not called "paid online"', () => {
    expect(words(row(paid({ method: 'cod' })), 'CANCELLED')).toEqual({
      title: 'Nothing to collect', hint: 'This order was cancelled.',
    });
  });

  test('delivered, online and never paid: not described as a cash order', () => {
    const r = row(cash({ method: 'online', unpaidOnline: true }));
    expect(paymentNotice(r, 'DELIVERED')).toMatchObject({ tone: 'quiet', amount: null });
    expect(words(r, 'DELIVERED')).toEqual({ title: 'Not paid online', hint: null });
  });

  test('an order an admin refunded: refunded, whatever the lines and the object say', () => {
    expect(words(row(paid()), 'REFUNDED').title).toBe('Refunded to the buyer');
    expect(words(row(cash()), 'REFUNDED').title).toBe('Refunded to the buyer');
  });
});

describe('refund states from the server', () => {
  test('refund on its way', () => {
    expect(words(row(paid({ status: 'REFUND_PENDING', lines: 0 })), 'CANCELLED').title).toBe('The buyer is being refunded');
  });

  test('refunded', () => {
    expect(words(row(paid({ status: 'REFUNDED', lines: 0 })), 'CANCELLED').title).toBe('Refunded to the buyer');
    // Even on a row that still looks live.
    expect(words(row(paid({ status: 'REFUNDED' })), 'DELIVERED').title).toBe('Refunded to the buyer');
  });

  test('nothing due', () => {
    expect(words(row(cash({ status: 'NOTHING_DUE', amountDue: null, lines: 0 })), 'CANCELLED')).toEqual({
      title: 'Nothing to collect', hint: 'This order was cancelled.',
    });
  });
});

describe('an older server that sends no payment object', () => {
  const old = (order) => ({ id: 'line-1', status: 'SHIPPED', order: { id: 'o1', ...order } });

  test('cash: says it is cash, with NO amount — the row only holds one line\'s total', () => {
    const r = old({ paymentMethod: 'cod', paymentStatus: 'pending' });
    expect(paymentInfo(r)).toMatchObject({ method: 'cod', status: 'TO_COLLECT', amount: null, exact: false });
    expect(words(r, 'SHIPPED')).toEqual({ title: 'Cash on delivery', hint: 'Collect the payment when you deliver.' });
  });

  test('cash, already delivered: the fact, and no instruction to collect', () => {
    const r = old({ paymentMethod: 'cod', paymentStatus: 'pending' });
    expect(paymentNotice(r, 'DELIVERED')).toMatchObject({ tone: 'quiet', amount: null, hint: null });
    expect(words(r, 'DELIVERED')).toEqual({ title: 'Cash on delivery', hint: null });
  });

  test('paid online', () => {
    for (const paymentMethod of ['online', 'upi', 'card', 'UPI']) {
      expect(words(old({ paymentMethod, paymentStatus: 'paid' }), 'SHIPPED').title).toBe('Paid online');
    }
  });

  test('online but not paid', () => {
    expect(words(old({ paymentMethod: 'upi', paymentStatus: 'pending' }), 'SHIPPED')).toEqual({
      title: 'Not paid online', hint: 'The buyer chose to pay online, but no payment was received.',
    });
  });

  test('refunded', () => {
    expect(words(old({ paymentMethod: 'online', paymentStatus: 'refunded' }), 'CANCELLED').title).toBe('Refunded to the buyer');
  });

  // The Razorpay refund webhook marks the ORDER 'refund_initiated' and then
  // 'refunded' for any refund — including the one for another shop's cancelled
  // lines. This row is live and was paid for.
  test.each(['refunded', 'partially_refunded', 'refund_pending', 'refund_initiated'])(
    'a refund on the order (%s) while THIS row is still being delivered: paid — never "refunded", never "collect"',
    (paymentStatus) => {
      const r = old({ paymentMethod: 'online', paymentStatus });
      for (const status of ['PENDING', 'CONFIRMED', 'SHIPPED']) {
        expect(words(r, status)).toEqual({ title: 'Paid online', hint: 'Do not collect cash.' });
      }
      expect(handoverReminder(r, 'SHIPPED', t, rupees).text).toBe('Paid online. Do not collect cash.');
    },
  );

  test('the same refund on a row that IS cancelled: on its way, then made', () => {
    const said = (paymentStatus) => words(old({ paymentMethod: 'online', paymentStatus }), 'CANCELLED').title;
    expect(said('refund_pending')).toBe('The buyer is being refunded');
    expect(said('refund_initiated')).toBe('The buyer is being refunded');
    // Settled: 'partially_refunded' stays on the order while another shop delivers.
    expect(said('partially_refunded')).toBe('Refunded to the buyer');
    expect(said('refunded')).toBe('Refunded to the buyer');
  });

  test('a word nobody has heard of, on an online order: paid — the seller is never sent to collect', () => {
    for (const paymentStatus of ['refund_queued', 'chargeback', 'SETTLED']) {
      expect(paymentNotice(old({ paymentMethod: 'upi', paymentStatus }), 'SHIPPED')).toMatchObject({ tone: 'paid', amount: null });
    }
  });

  test('cash an admin marked refunded says so; an unknown word on a cash order still collects', () => {
    expect(words(old({ paymentMethod: 'cod', paymentStatus: 'refunded' }), 'DELIVERED').title).toBe('Refunded to the buyer');
    expect(words(old({ paymentMethod: 'cod', paymentStatus: 'chargeback' }), 'SHIPPED').title).toBe('Cash on delivery');
  });

  test('no method at all: nothing is printed', () => {
    expect(paymentNotice(old({}), 'SHIPPED')).toBeNull();
    expect(paymentNotice({ id: 'x' }, 'SHIPPED')).toBeNull();
    expect(paymentNotice(null, 'SHIPPED')).toBeNull();
    expect(paymentText(null, t, rupees)).toBeNull();
  });

  test('a payment object with a status this build does not know falls back to the method', () => {
    const r = row({ method: 'cod', status: 'ESCROW', amountDue: '9.00' }, { paymentMethod: 'cod', paymentStatus: 'pending' });
    expect(paymentInfo(r)).toMatchObject({ status: 'TO_COLLECT', amount: null, exact: false });
  });
});

describe('the reminder at the moment of hand-over', () => {
  test('cash: the amount, in one line', () => {
    expect(handoverReminder(row(cash()), 'SHIPPED', t, rupees)).toEqual({
      tone: 'collect', icon: 'cash-outline',
      text: 'Collect ₹609.00 in cash. This is the full amount for this order, including any delivery charge.',
    });
  });

  test('paid online: do not collect', () => {
    expect(handoverReminder(row(paid()), 'SHIPPED', t, rupees).text).toBe('Paid online. Do not collect cash.');
  });

  test('Hindi closes both sentences with a danda — not a Latin full stop followed by one', () => {
    const inLang = (lang) => (key, vars) => String(translations[lang].sellerOrders[key.split('.')[1]] ?? vars?.defaultValue ?? key)
      .replace(/\{\{(\w+)\}\}/g, (m, name) => String(vars?.[name] ?? ''));
    const hi = translations.hi.sellerOrders;

    const cashSaid = handoverReminder(row(cash()), 'SHIPPED', inLang('hi'), rupees).text;
    expect(cashSaid).toBe(`${hi.payCollect.replace('{{amount}}', '₹609.00')}। ${hi.payCollectHint}`);
    expect(cashSaid).not.toMatch(/\.\s/);
    expect(handoverReminder(row(paid()), 'SHIPPED', inLang('hi'), rupees).text).toBe(`${hi.payPaidOnline}। ${hi.payPaidHint}`);

    // Marathi writes a full stop, and keeps it.
    const mr = translations.mr.sellerOrders;
    expect(handoverReminder(row(paid()), 'SHIPPED', inLang('mr'), rupees).text).toBe(`${mr.payPaidOnline}. ${mr.payPaidHint}`);
  });

  test('a seller handing goods over at the counter (pending → delivered) is reminded too', () => {
    expect(handoverReminder(row(cash()), 'PENDING', t, rupees).text).toContain('Collect ₹609.00 in cash');
  });

  test('nothing to say for an order that is finished, refunded, or says nothing about money', () => {
    expect(handoverReminder(row(cash()), 'DELIVERED', t, rupees)).toBeNull();
    expect(handoverReminder(row(cash()), 'CANCELLED', t, rupees)).toBeNull();
    expect(handoverReminder(row(paid({ status: 'REFUND_PENDING' })), 'SHIPPED', t, rupees)).toBeNull();
    expect(handoverReminder({ id: 'x', order: {} }, 'SHIPPED', t, rupees)).toBeNull();
  });
});
