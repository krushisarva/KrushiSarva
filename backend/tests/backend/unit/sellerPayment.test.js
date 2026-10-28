/**
 * What a seller is told about the money on an order
 * (services/sellerPayment.service.js) — the pure half.
 *
 * This decides how much cash a seller asks a farmer for at the door, so every
 * rule is pinned: the single-seller amount is the order total to the paisa,
 * several sellers' amounts add up to that total, a cancelled line is never
 * collected for, an order already paid is never collected for, and where the
 * amount cannot be known the answer is "cannot say", not a guess.
 */
import { describe, test, expect } from '@jest/globals';
import { sellerShareOf, sellerPaymentFor, codFeeCarrier } from '../../../src/services/sellerPayment.service.js';

const A = 'seller-a';
const B = 'seller-b';

const line = (sellerId, totalPrice, over = {}) => ({
  id: `line-${Math.round(Math.random() * 1e9)}`, sellerId, status: 'PENDING',
  totalPrice: String(totalPrice), taxAmount: '0', ...over,
});

/** A one-seller cash order: ₹540 of goods + ₹69 delivery = ₹609. */
const single = (over = {}) => ({
  status: 'PENDING', paymentMethod: 'cod', paymentStatus: 'pending',
  totalAmount: '609.00', subtotal: '540.00', deliveryFee: '69.00', taxAmount: '0', discountAmount: '0',
  pricingSnapshot: { codFee: '0.00', shipments: [{ sellerId: A, goodsSubtotal: '540.00', deliveryFee: '69.00' }] },
  ...over,
});

/** Two sellers, cash: A ₹2,190 + ₹49, B ₹899 + ₹49 → ₹3,187. */
const double = (over = {}) => ({
  status: 'PENDING', paymentMethod: 'cod', paymentStatus: 'pending',
  totalAmount: '3187.00', subtotal: '3089.00', deliveryFee: '98.00', taxAmount: '0', discountAmount: '0',
  pricingSnapshot: {
    codFee: '0.00',
    shipments: [
      { sellerId: A, goodsSubtotal: '2190.00', deliveryFee: '49.00' },
      { sellerId: B, goodsSubtotal: '899.00', deliveryFee: '49.00' },
    ],
  },
  ...over,
});

const due = (order, items, sellerId) => {
  const { amount } = sellerShareOf(order, items, sellerId);
  return amount === null ? null : amount.toFixed(2);
};

describe('one seller on the order', () => {
  test('the amount is the order total the farmer was shown, to the paisa', () => {
    expect(due(single(), [line(A, 540)], A)).toBe('609.00');
  });

  test('two lines from the one seller are ONE amount, not one each', () => {
    const order = single({ totalAmount: '1418.00', subtotal: '1349.00' });
    const items = [line(A, 1200), line(A, 149)];
    expect(sellerShareOf(order, items, A)).toMatchObject({ lines: 2 });
    expect(due(order, items, A)).toBe('1418.00');
  });

  test('a cancelled line is not collected for; the delivery charge still is', () => {
    const order = single({ totalAmount: '1418.00', subtotal: '1349.00' });
    const items = [line(A, 1200), line(A, 149, { status: 'CANCELLED' })];
    expect(due(order, items, A)).toBe('1269.00');            // 1200 + 69
    expect(sellerShareOf(order, items, A).lines).toBe(1);
  });

  test('everything cancelled: nothing is due', () => {
    expect(due(single(), [line(A, 540, { status: 'CANCELLED' })], A)).toBe('0.00');
    expect(sellerShareOf(single(), [line(A, 540, { status: 'CANCELLED' })], A).lines).toBe(0);
  });

  test('an old order with no price breakdown still works: it has only one seller', () => {
    expect(due(single({ pricingSnapshot: null }), [line(A, 540)], A)).toBe('609.00');
  });

  test('tax added on top of the price is part of what is collected', () => {
    // 1000 goods + 49 delivery + 50 tax added = 1099
    const order = single({ totalAmount: '1099.00', subtotal: '1000.00', deliveryFee: '49.00', taxAmount: '50.00' });
    const items = [line(A, 600, { taxAmount: '30.00' }), line(A, 400, { taxAmount: '20.00' })];
    expect(due(order, items, A)).toBe('1099.00');
    // …and a cancelled line takes its own tax with it.
    items[1].status = 'CANCELLED';
    expect(due(order, items, A)).toBe('679.00');             // 600 + 30 + 49
  });

  test('tax already inside the price is not added twice', () => {
    // total = 1000 + 49: the 50 of tax is inside the 1000
    const order = single({ totalAmount: '1049.00', subtotal: '1000.00', deliveryFee: '49.00', taxAmount: '50.00' });
    const items = [line(A, 600, { taxAmount: '30.00' }), line(A, 400, { taxAmount: '20.00', status: 'CANCELLED' })];
    expect(due(order, items, A)).toBe('649.00');             // 600 + 49
  });

  test('the cash-on-delivery fee is collected by the only seller', () => {
    const order = single({ totalAmount: '619.00', deliveryFee: '79.00', pricingSnapshot: { codFee: '10.00', shipments: [{ sellerId: A, deliveryFee: '69.00' }] } });
    expect(due(order, [line(A, 540)], A)).toBe('619.00');
  });

  test('a discount comes off: the amount is still the total quoted', () => {
    const order = single({ totalAmount: '559.00', discountAmount: '50.00' });
    expect(due(order, [line(A, 540)], A)).toBe('559.00');
  });
});

// The card prints one LINE's total beside the amount to collect. The parts are
// what explains the difference — so they must add up to the amount, exactly.
describe('what the amount is made of', () => {
  const partsOf = (order, items, sellerId = A) => {
    const { parts } = sellerShareOf(order, items, sellerId);
    return parts && parts.map((p) => `${p.kind} ${p.amount.toFixed(2)}`);
  };
  const adds = (order, items, sellerId = A) => {
    const { amount, parts } = sellerShareOf(order, items, sellerId);
    const sum = parts.reduce((s, p) => s + (p.kind === 'discount' ? -1 : 1) * Number(p.amount), 0);
    return [sum.toFixed(2), amount.toFixed(2)];
  };

  test('goods and the delivery charge', () => {
    expect(partsOf(single(), [line(A, 540)])).toEqual(['items 540.00', 'delivery 69.00']);
  });

  test('two lines are one "items" figure', () => {
    const order = single({ totalAmount: '1418.00', subtotal: '1349.00' });
    expect(partsOf(order, [line(A, 1200), line(A, 149)])).toEqual(['items 1349.00', 'delivery 69.00']);
  });

  test('a cancelled line is in neither the amount nor its parts', () => {
    const order = single({ totalAmount: '1418.00', subtotal: '1349.00' });
    const items = [line(A, 1200), line(A, 149, { status: 'CANCELLED' })];
    expect(partsOf(order, items)).toEqual(['items 1200.00', 'delivery 69.00']);
    expect(adds(order, items)).toEqual(['1269.00', '1269.00']);
  });

  test('tax added on top is named; tax already inside the price is not', () => {
    const onTop = single({ totalAmount: '1099.00', subtotal: '1000.00', deliveryFee: '49.00', taxAmount: '50.00' });
    const items = [line(A, 600, { taxAmount: '30.00' }), line(A, 400, { taxAmount: '20.00' })];
    expect(partsOf(onTop, items)).toEqual(['items 1000.00', 'tax 50.00', 'delivery 49.00']);

    const inside = single({ totalAmount: '1049.00', subtotal: '1000.00', deliveryFee: '49.00', taxAmount: '50.00' });
    expect(partsOf(inside, items)).toEqual(['items 1000.00', 'delivery 49.00']);
  });

  test('the cash-on-delivery fee is named apart from the delivery charge it is stored with', () => {
    const order = single({ totalAmount: '619.00', deliveryFee: '79.00', pricingSnapshot: { codFee: '10.00', shipments: [{ sellerId: A, deliveryFee: '69.00' }] } });
    expect(partsOf(order, [line(A, 540)])).toEqual(['items 540.00', 'delivery 69.00', 'codFee 10.00']);
    // Not on an order that is not cash, whatever the snapshot holds.
    expect(partsOf({ ...order, paymentMethod: 'online', paymentStatus: 'paid', totalAmount: '609.00', deliveryFee: '69.00' }, [line(A, 540)]))
      .toEqual(['items 540.00', 'delivery 69.00']);
  });

  test('a discount is listed last, and is taken OFF', () => {
    const order = single({ totalAmount: '559.00', discountAmount: '50.00' });
    expect(partsOf(order, [line(A, 540)])).toEqual(['items 540.00', 'delivery 69.00', 'discount 50.00']);
    expect(adds(order, [line(A, 540)])).toEqual(['559.00', '559.00']);
  });

  test('free delivery: only the goods', () => {
    const order = single({ totalAmount: '540.00', deliveryFee: '0.00', pricingSnapshot: { codFee: '0.00', shipments: [{ sellerId: A, deliveryFee: '0.00' }] } });
    expect(partsOf(order, [line(A, 540)])).toEqual(['items 540.00']);
  });

  test('several sellers: each sees their own goods and their own delivery, and the fee only where it is carried', () => {
    const rows = [line(A, 2190), line(B, 899)];
    expect(partsOf(double(), rows, A)).toEqual(['items 2190.00', 'delivery 49.00']);
    expect(partsOf(double(), rows, B)).toEqual(['items 899.00', 'delivery 49.00']);

    const withFee = double({
      totalAmount: '3197.00', deliveryFee: '108.00',
      pricingSnapshot: { codFee: '10.00', shipments: [{ sellerId: A, deliveryFee: '49.00' }, { sellerId: B, deliveryFee: '49.00' }] },
    });
    expect(partsOf(withFee, rows, A)).toEqual(['items 2190.00', 'delivery 49.00', 'codFee 10.00']);
    expect(partsOf(withFee, rows, B)).toEqual(['items 899.00', 'delivery 49.00']);
    expect(adds(withFee, rows, A)).toEqual(['2249.00', '2249.00']);
  });

  test('figures that do not reconcile get NO breakdown — the amount is still given', () => {
    // ₹25 in the total that nothing here accounts for (a charge added later, an old order).
    const order = single({ totalAmount: '634.00' });
    const share = sellerShareOf(order, [line(A, 540)], A);
    expect(share.amount.toFixed(2)).toBe('634.00');
    expect(share.parts).toBeNull();
  });

  test('no amount, no parts; nothing live, no parts', () => {
    expect(sellerShareOf(double({ pricingSnapshot: null }), [line(A, 2190), line(B, 899)], A).parts).toBeNull();
    expect(sellerShareOf(single(), [line(A, 540, { status: 'CANCELLED' })], A).parts).toBeNull();
  });
});

describe('several sellers on the order', () => {
  const items = () => [line(A, 2190), line(B, 899)];

  test('each collects their own goods and their own delivery charge', () => {
    expect(due(double(), items(), A)).toBe('2239.00');
    expect(due(double(), items(), B)).toBe('948.00');
  });

  test('together they collect exactly what the farmer was quoted', () => {
    const order = double();
    const sum = Number(due(order, items(), A)) + Number(due(order, items(), B));
    expect(sum.toFixed(2)).toBe(order.totalAmount);
  });

  test('one shop cancelling changes nothing for the other', () => {
    const rows = [line(A, 2190, { status: 'CANCELLED' }), line(B, 899)];
    expect(due(double(), rows, A)).toBe('0.00');
    expect(due(double(), rows, B)).toBe('948.00');
  });

  test('a seller never collects for another seller\'s line', () => {
    const rows = [line(A, 2190), line(B, 899), line(B, 100)];
    const order = double({ totalAmount: '3287.00', subtotal: '3189.00' });
    expect(due(order, rows, A)).toBe('2239.00');
  });

  test('the cash-on-delivery fee goes to the first shop that still has something to deliver', () => {
    const order = double({
      totalAmount: '3197.00', deliveryFee: '108.00',
      pricingSnapshot: { codFee: '10.00', shipments: [{ sellerId: A, deliveryFee: '49.00' }, { sellerId: B, deliveryFee: '49.00' }] },
    });
    expect(due(order, items(), A)).toBe('2249.00');
    expect(due(order, items(), B)).toBe('948.00');
    expect((Number(due(order, items(), A)) + Number(due(order, items(), B))).toFixed(2)).toBe('3197.00');

    // The first shop cancels everything: the fee moves to the one still delivering.
    const rows = [line(A, 2190, { status: 'CANCELLED' }), line(B, 899)];
    expect(due(order, rows, B)).toBe('958.00');
  });

  // The fee is ₹10 on a two-shop cash order: A is quoted first, B second.
  describe('the cash-on-delivery fee never lands on a shop after it has delivered', () => {
    const order = double({
      totalAmount: '3197.00', deliveryFee: '108.00',
      pricingSnapshot: { codFee: '10.00', shipments: [{ sellerId: A, deliveryFee: '49.00' }, { sellerId: B, deliveryFee: '49.00' }] },
    });
    const at = (hour) => new Date(Date.UTC(2026, 9, 12, hour)).toISOString();

    test('B delivers while A is still to come: B took ₹948, and A still carries the fee', () => {
      const rows = [line(A, 2190), line(B, 899, { status: 'DELIVERED', deliveredAt: at(10) })];
      expect(due(order, rows, B)).toBe('948.00');
      expect(due(order, rows, A)).toBe('2249.00');
      expect(codFeeCarrier(order.pricingSnapshot.shipments, rows)).toBe(A);
    });

    test('A cancels AFTER B delivered: B\'s card still says the ₹948 it collected', () => {
      const rows = [
        line(A, 2190, { status: 'CANCELLED', cancelledAt: at(14) }),
        line(B, 899, { status: 'DELIVERED', deliveredAt: at(10) }),
      ];
      expect(due(order, rows, B)).toBe('948.00');   // not 958: the cash has already changed hands
      expect(codFeeCarrier(order.pricingSnapshot.shipments, rows)).toBeNull();
    });

    test('A cancelled BEFORE B delivered: B was told ₹958 at the door, and still is', () => {
      const rows = [
        line(A, 2190, { status: 'CANCELLED', cancelledAt: at(8) }),
        line(B, 899, { status: 'DELIVERED', deliveredAt: at(10) }),
      ];
      expect(due(order, rows, B)).toBe('958.00');
    });

    test('A delivered with the fee: it stays A\'s, and B is never asked for it', () => {
      const rows = [line(A, 2190, { status: 'DELIVERED', deliveredAt: at(9) }), line(B, 899)];
      expect(due(order, rows, A)).toBe('2249.00');
      expect(due(order, rows, B)).toBe('948.00');
    });

    test('three shops: it passes over the one already delivered to the next one still to come', () => {
      const C = 'seller-c';
      const three = double({
        totalAmount: '3746.00', subtotal: '3589.00', deliveryFee: '147.00',
        pricingSnapshot: {
          codFee: '10.00',
          shipments: [{ sellerId: A, deliveryFee: '49.00' }, { sellerId: B, deliveryFee: '49.00' }, { sellerId: C, deliveryFee: '49.00' }],
        },
      });
      const rows = [
        line(A, 2190, { status: 'CANCELLED', cancelledAt: at(14) }),
        line(B, 899, { status: 'DELIVERED', deliveredAt: at(10) }),
        line(C, 500, { status: 'CONFIRMED' }),
      ];
      expect(due(three, rows, B)).toBe('948.00');
      expect(due(three, rows, C)).toBe('559.00');   // 500 + 49 + the fee
      // …and once C has delivered with it, it is still C's.
      const later = [rows[0], rows[1], line(C, 500, { status: 'DELIVERED', deliveredAt: at(16) })];
      expect(due(three, later, C)).toBe('559.00');
      expect(due(three, later, B)).toBe('948.00');
    });

    test('a shop that delivered some lines after cancelling others is judged by when it delivered', () => {
      const rows = [
        line(A, 2190, { status: 'CANCELLED', cancelledAt: at(14) }),
        line(B, 500, { status: 'CANCELLED', cancelledAt: at(9) }),
        line(B, 399, { status: 'DELIVERED', deliveredAt: at(10) }),
      ];
      expect(due(order, rows, B)).toBe('448.00');   // 399 + 49, no fee
    });

    test('with no times recorded the plain rule holds: the first shop with something live', () => {
      const rows = [line(A, 2190, { status: 'CANCELLED' }), line(B, 899, { status: 'DELIVERED' })];
      expect(due(order, rows, B)).toBe('958.00');
    });
  });

  test('the cash-on-delivery fee is not added to an order that is not cash', () => {
    const order = double({ paymentMethod: 'online', pricingSnapshot: { codFee: '10.00', shipments: [{ sellerId: A, deliveryFee: '49.00' }, { sellerId: B, deliveryFee: '49.00' }] } });
    expect(due(order, items(), A)).toBe('2239.00');
  });

  test('no price breakdown (an order from before it was recorded): cannot say', () => {
    expect(due(double({ pricingSnapshot: null }), items(), A)).toBeNull();
    expect(due(double({ pricingSnapshot: { shipments: [{ sellerId: B, deliveryFee: '49.00' }] } }), items(), A)).toBeNull();
  });

  test('a discount nobody says how to split: cannot say', () => {
    expect(due(double({ totalAmount: '3137.00', discountAmount: '50.00' }), items(), A)).toBeNull();
  });
});

describe('what the seller is told', () => {
  const say = (order, items, sellerId = A) => sellerPaymentFor(order, items, sellerId);

  const worth609 = { amount: '609.00', parts: [{ kind: 'items', amount: '540.00' }, { kind: 'delivery', amount: '69.00' }] };

  test('cash order, still to be delivered: collect the amount', () => {
    expect(say(single(), [line(A, 540)])).toEqual({
      method: 'cod', status: 'TO_COLLECT', amountDue: '609.00', ...worth609, lines: 1, unpaidOnline: false,
    });
  });

  test('the same after delivery — nothing here claims the cash was collected', () => {
    const delivered = say(single({ status: 'DELIVERED' }), [line(A, 540, { status: 'DELIVERED' })]);
    expect(delivered).toMatchObject({ status: 'TO_COLLECT', amountDue: '609.00' });
  });

  test('paid online: nothing is DUE — what was paid is given as information only', () => {
    const order = single({ paymentMethod: 'online', paymentStatus: 'paid' });
    expect(say(order, [line(A, 540)])).toEqual({
      // amountDue is the instruction, and it stays null on a paid order.
      method: 'online', status: 'PAID', amountDue: null, ...worth609, lines: 1, unpaidOnline: false,
    });
  });

  test('money going back, or nothing owed: no amount and no parts are stated', () => {
    const gone = [line(A, 540, { status: 'CANCELLED' })];
    for (const order of [
      single({ paymentMethod: 'online', paymentStatus: 'refund_pending', status: 'CANCELLED' }),
      single({ paymentMethod: 'online', paymentStatus: 'refunded', status: 'CANCELLED' }),
      single({ status: 'CANCELLED' }),
    ]) {
      expect(say(order, gone)).toMatchObject({ amountDue: null, amount: null, parts: null });
    }
    // An admin refund of a delivered order: refunded, with no figure put beside it.
    expect(say(single({ status: 'REFUNDED', paymentStatus: 'refunded' }), [line(A, 540, { status: 'DELIVERED' })]))
      .toMatchObject({ status: 'REFUNDED', amountDue: null, amount: null, parts: null });
  });

  test('however the method is written (upi, card, online, any case)', () => {
    for (const paymentMethod of ['upi', 'card', 'online', 'UPI']) {
      expect(say(single({ paymentMethod, paymentStatus: 'paid' }), [line(A, 540)]).status).toBe('PAID');
    }
    expect(say(single({ paymentMethod: ' COD ' }), [line(A, 540)]).method).toBe('cod');
  });

  test('another shop\'s part was refunded but this shop is still delivering: still paid', () => {
    const rows = [line(A, 2190), line(B, 899, { status: 'CANCELLED' })];
    for (const paymentStatus of ['refund_pending', 'partially_refunded']) {
      expect(say(double({ paymentMethod: 'online', paymentStatus }), rows, A).status).toBe('PAID');
    }
  });

  test('this shop\'s lines were cancelled on a paid order: the refund, not a collection', () => {
    const rows = [line(A, 2190, { status: 'CANCELLED' }), line(B, 899)];
    expect(say(double({ paymentMethod: 'online', paymentStatus: 'refund_pending' }), rows, A))
      .toMatchObject({ status: 'REFUND_PENDING', amountDue: null, lines: 0 });
    expect(say(double({ paymentMethod: 'online', paymentStatus: 'partially_refunded' }), rows, A).status).toBe('REFUNDED');
  });

  test('a cancelled cash order: nothing to collect', () => {
    expect(say(single({ status: 'CANCELLED' }), [line(A, 540, { status: 'CANCELLED' })]))
      .toMatchObject({ method: 'cod', status: 'NOTHING_DUE', amountDue: null });
  });

  test('this shop\'s lines cancelled and refunded, or the order marked REFUNDED: refunded', () => {
    expect(say(single({ paymentMethod: 'online', paymentStatus: 'refunded', status: 'CANCELLED' }), [line(A, 540, { status: 'CANCELLED' })]).status).toBe('REFUNDED');
    // An admin refund after delivery leaves the lines DELIVERED.
    expect(say(single({ paymentMethod: 'online', paymentStatus: 'refunded', status: 'REFUNDED' }), [line(A, 540, { status: 'DELIVERED' })]).status).toBe('REFUNDED');
    expect(say(single({ status: 'REFUNDED' }), [line(A, 540, { status: 'DELIVERED' })]).status).toBe('REFUNDED');
  });

  // The Razorpay refund webhook (shopPayment.service.js) writes 'refund_initiated'
  // and then 'refunded' on the ORDER for any refund — including the partial one
  // made when only one shop's lines are cancelled.
  describe('a refund recorded on the order is not this shop\'s refund while its lines are live', () => {
    const rows = [line(A, 2190, { status: 'CANCELLED' }), line(B, 899, { status: 'CONFIRMED' })];
    const paid = (paymentStatus) => double({ paymentMethod: 'online', paymentStatus });

    test.each(['refund_initiated', 'refunded', 'partially_refunded', 'refund_pending'])(
      'the other shop\'s lines were refunded (%s): this shop is still PAID, and is never told to collect',
      (paymentStatus) => {
        expect(say(paid(paymentStatus), rows, B)).toEqual({
          method: 'online', status: 'PAID', amountDue: null, lines: 1, unpaidOnline: false,
          // B's own goods and delivery — the refund of A's part changes neither.
          amount: '948.00', parts: [{ kind: 'items', amount: '899.00' }, { kind: 'delivery', amount: '49.00' }],
        });
      },
    );

    test('the shop whose lines WERE cancelled sees the refund: on its way, then made', () => {
      expect(say(paid('refund_pending'), rows, A).status).toBe('REFUND_PENDING');
      expect(say(paid('refund_initiated'), rows, A).status).toBe('REFUND_PENDING');
      expect(say(paid('partially_refunded'), rows, A).status).toBe('REFUNDED');
      expect(say(paid('refunded'), rows, A).status).toBe('REFUNDED');
    });

    test('one of a shop\'s own two lines cancelled and refunded: the other is still paid for', () => {
      const order = single({ paymentMethod: 'online', paymentStatus: 'refund_initiated', totalAmount: '1418.00', subtotal: '1349.00' });
      const own = [line(A, 1200), line(A, 149, { status: 'CANCELLED' })];
      expect(say(order, own)).toMatchObject({ status: 'PAID', amountDue: null, lines: 1 });
      expect(say({ ...order, paymentStatus: 'refunded' }, own)).toMatchObject({ status: 'PAID', amountDue: null });
    });

    test('a value this code has never heard of, on an online order: paid — never "collect"', () => {
      for (const paymentStatus of ['refund_queued', 'SETTLED', 'chargeback']) {
        const said = say(single({ paymentMethod: 'online', paymentStatus }), [line(A, 540)]);
        expect(said).toMatchObject({ status: 'PAID', amountDue: null, unpaidOnline: false });
      }
    });

    test('…and with nothing live it claims nothing about a refund it does not know of', () => {
      const said = say(single({ paymentMethod: 'online', paymentStatus: 'chargeback', status: 'CANCELLED' }), [line(A, 540, { status: 'CANCELLED' })]);
      expect(said).toMatchObject({ status: 'NOTHING_DUE', amountDue: null });
    });
  });

  test('a cash order an admin marked refunded says so; an unknown word on a cash order still collects', () => {
    expect(say(single({ paymentStatus: 'refunded', status: 'DELIVERED' }), [line(A, 540, { status: 'DELIVERED' })]).status).toBe('REFUNDED');
    // Cash is owed until something says it came in.
    expect(say(single({ paymentStatus: 'chargeback' }), [line(A, 540)])).toMatchObject({ status: 'TO_COLLECT', amountDue: '609.00', unpaidOnline: false });
  });

  test('an "online" order whose payment never arrived is still owed — and says why', () => {
    for (const paymentStatus of ['pending', 'failed', '', undefined]) {
      expect(say(single({ paymentMethod: 'upi', paymentStatus }), [line(A, 540)])).toEqual({
        method: 'online', status: 'TO_COLLECT', amountDue: '609.00', ...worth609, lines: 1, unpaidOnline: true,
      });
    }
  });

  test('a cash order already recorded as paid is not collected a second time', () => {
    expect(say(single({ paymentStatus: 'paid' }), [line(A, 540)])).toMatchObject({ method: 'cod', status: 'PAID', amountDue: null });
  });

  test('when the amount cannot be known it is null — the status still says it is owed', () => {
    const rows = [line(A, 2190), line(B, 899)];
    expect(say(double({ pricingSnapshot: null }), rows, A)).toMatchObject({ status: 'TO_COLLECT', amountDue: null, lines: 1 });
  });

  test('a seller with no line on the order is told nothing is due', () => {
    expect(say(double(), [line(A, 2190), line(B, 899)], 'someone-else')).toMatchObject({ status: 'NOTHING_DUE', amountDue: null, lines: 0 });
  });

  test('junk in, no throw', () => {
    expect(() => say(null, null, A)).not.toThrow();
    expect(say({}, [], A)).toMatchObject({ status: 'NOTHING_DUE' });
  });
});
