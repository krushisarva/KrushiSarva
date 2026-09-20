/**
 * The sentences said to a farmer whose money has moved.
 *
 * `t()` returns the KEY when a lookup misses, so a missing translation here does
 * not degrade to English — it puts the literal text "orders.refundPending" where
 * a refund promise should be. Three of these keys were missing from
 * translations.js while the helpers were already returning them, which is the
 * regression the last block in this file exists to stop.
 *
 * The load-bearing rule is that nothing may offer "try again" to someone whose
 * money is still held: that is how a farmer gets charged twice.
 */
import { translations } from '@krushisarva/shared/i18n/translations';
import {
  paymentStatusNotice, confirmFailureNotice, orderRefundLabel,
  humanOrderStatus, canCancelOrder, cancelRefundPreview,
} from '../shopUtils';

/** Mirrors LanguageContext: a flat dotted key first, then the nested path. */
const resolveKey = (dict, key) => {
  if (dict && typeof dict[key] === 'string') return dict[key];
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);
};

/** The nine `state` values intentPublicStatus() can return. */
const SERVER_STATES = [
  'ORDER_CREATED', 'CONFIRMING', 'PENDING', 'REFUNDING',
  'REFUNDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'UNKNOWN',
];

describe('paymentStatusNotice', () => {
  test('recognises all eight states that describe an actual intent', () => {
    const unknown = SERVER_STATES
      .filter((s) => s !== 'UNKNOWN')
      .filter((s) => !paymentStatusNotice({ state: s }).known);
    expect(unknown).toEqual([]);
  });

  test('UNKNOWN means there is no intent at all, so it is not "known"', () => {
    const n = paymentStatusNotice({ state: 'UNKNOWN' });
    expect(n.known).toBe(false);
    expect(n.moneyTaken).toBe(false);
    expect(n.mayRetry).toBe(false); // the money MAY have moved — never say retry
  });

  test('never offers "try again" while the money is still held', () => {
    // REFUNDED is the one state where moneyTaken and mayRetry are both true:
    // the money came back, so ordering again is safe. Every other held state
    // must refuse to suggest a second payment.
    const offenders = [...SERVER_STATES, 'REFUND_INITIATED', 'PAID', 'CREATED', 'WHAT_IS_THIS']
      .map((state) => ({ state, n: paymentStatusNotice({ state }) }))
      .filter(({ n }) => n.moneyTaken && n.refund !== 'done' && n.mayRetry)
      .map(({ state }) => state);
    expect(offenders).toEqual([]);
  });

  test('REFUNDING promises 5-7 days only when the gateway accepted the refund', () => {
    const onWay = paymentStatusNotice({ state: 'REFUNDING', refundPending: true });
    expect(onWay.refund).toBe('onWay');
    expect(onWay.bodyFallback).toMatch(/working days/);

    // refundPending:false means the gateway CALL ITSELF failed. No date may be
    // promised for a refund nobody has successfully raised.
    const arranging = paymentStatusNotice({ state: 'REFUNDING', refundPending: false });
    expect(arranging.refund).toBe('arranging');
    expect(arranging.bodyFallback).not.toMatch(/working days/);
  });

  test('REFUNDING with no refundPending field still promises nothing wrong', () => {
    const n = paymentStatusNotice({ state: 'REFUNDING' });
    expect(n.refund).toBe('onWay'); // only an explicit `false` means the call failed
    expect(n.moneyTaken).toBe(true);
    expect(n.mayRetry).toBe(false);
  });

  test('raw intent statuses from an older server are not read as "no money taken"', () => {
    // This is the regression: REFUND_INITIATED used to fall through to PENDING,
    // which this app renders as "No money was taken. You can try again."
    expect(paymentStatusNotice({ state: 'REFUND_INITIATED' }).refund).toBe('onWay');
    expect(paymentStatusNotice({ state: 'REFUND_INITIATED' }).moneyTaken).toBe(true);
    expect(paymentStatusNotice({ state: 'PAID' }).moneyTaken).toBe(true);
    expect(paymentStatusNotice({ state: 'PAID' }).mayRetry).toBe(false);
    expect(paymentStatusNotice({ state: 'CREATED' }).known).toBe(true);
  });

  test('a state added to the server after this build ships degrades safely', () => {
    const n = paymentStatusNotice({ state: 'RETURN_INITIATED' });
    expect(n.known).toBe(false);
    expect(n.mayRetry).toBe(false);
    expect(n.titleFallback).not.toMatch(/RETURN_INITIATED/);
    expect(n.bodyFallback).not.toMatch(/RETURN_INITIATED/);
    expect(n.preferServerMessage).toBe(true);
  });

  test('a missing or malformed payload is UNKNOWN, not a crash', () => {
    for (const bad of [null, undefined, {}, { state: 42 }, { state: '' }]) {
      const n = paymentStatusNotice(bad);
      expect(n.known).toBe(false);
      expect(n.mayRetry).toBe(false);
      expect(typeof n.titleFallback).toBe('string');
    }
  });

  test('names the amount only when the server sent a usable one', () => {
    const withAmount = paymentStatusNotice({ state: 'REFUNDING', amount: '450.50' });
    expect(withAmount.amount).toBe(450.5);
    expect(withAmount.bodyFallback).toMatch(/\{\{amount\}\}/);

    // A blank figure in a refund sentence is worse than no figure at all.
    for (const bad of [undefined, null, '0', 0, -5, 'abc']) {
      const n = paymentStatusNotice({ state: 'REFUNDING', amount: bad });
      expect(n.amount).toBeNull();
      expect(n.bodyFallback).not.toMatch(/\{\{amount\}\}/);
    }
  });
});

describe('orderRefundLabel', () => {
  test('labels the three refund states', () => {
    expect(orderRefundLabel('refund_pending')).toMatchObject({ key: 'orders.refundPending', done: false });
    expect(orderRefundLabel('partially_refunded')).toMatchObject({ key: 'orders.partiallyRefunded', done: false });
    expect(orderRefundLabel('refunded')).toMatchObject({ key: 'orders.refunded', done: true });
  });

  test('says nothing about a refund when there is nothing to say', () => {
    // Silence beats a wrong promise about money, and an unrecognised value must
    // never reach the screen as raw text.
    for (const s of ['pending', 'paid', 'failed', 'WHAT', '', null, undefined]) {
      expect(orderRefundLabel(s)).toBeNull();
    }
  });
});

describe('humanOrderStatus', () => {
  test('title-cases a status this build has never heard of', () => {
    expect(humanOrderStatus('RETURN_REQUESTED')).toBe('Return requested');
    expect(humanOrderStatus('OUT-FOR-DELIVERY')).toBe('Out for delivery');
  });

  test('renders nothing rather than an empty pill', () => {
    for (const bad of ['', '   ', null, undefined, 42]) {
      expect(humanOrderStatus(bad)).toBeNull();
    }
  });
});

describe('canCancelOrder', () => {
  const order = (status, items) => ({ status, items });

  test('mirrors the server: PENDING order with a still-open line', () => {
    expect(canCancelOrder(order('PENDING', [{ status: 'PENDING' }]))).toBe(true);
    expect(canCancelOrder(order('PENDING', [{ status: 'PENDING' }, { status: 'CANCELLED' }]))).toBe(true);
  });

  test('refuses once a seller has moved any line', () => {
    expect(canCancelOrder(order('PENDING', [{ status: 'CONFIRMED' }]))).toBe(false);
    expect(canCancelOrder(order('PENDING', [{ status: 'PENDING' }, { status: 'SHIPPED' }]))).toBe(false);
  });

  test('refuses when every line is already cancelled, or the order is not PENDING', () => {
    expect(canCancelOrder(order('PENDING', [{ status: 'CANCELLED' }]))).toBe(false);
    expect(canCancelOrder(order('CONFIRMED', [{ status: 'PENDING' }]))).toBe(false);
    expect(canCancelOrder(null)).toBe(false);
  });

  test('defers to the server when the list payload carries no items', () => {
    expect(canCancelOrder(order('PENDING', []))).toBe(true);
    expect(canCancelOrder({ status: 'PENDING' })).toBe(true);
  });
});

describe('cancelRefundPreview', () => {
  const paidOrder = (over = {}) => ({
    paymentMethod: 'online',
    paymentRef: 'pay_123',
    paymentStatus: 'paid',
    subtotal: '1000', deliveryFee: '50', taxAmount: '0',
    discountAmount: '0', totalAmount: '1050',
    items: [{ status: 'PENDING', totalPrice: '1000', taxAmount: '0' }],
    ...over,
  });

  test('a cash order is never promised a refund', () => {
    const p = cancelRefundPreview(paidOrder({ paymentMethod: 'cod', paymentRef: null }));
    expect(p).toEqual({ refundable: false, cod: true, amount: null });
  });

  test('an unpaid online order is not promised one either', () => {
    expect(cancelRefundPreview(paidOrder({ paymentRef: null })).refundable).toBe(false);
    expect(cancelRefundPreview(paidOrder({ paymentStatus: 'pending' })).refundable).toBe(false);
  });

  test('returns the whole remaining total, delivery fee included', () => {
    expect(cancelRefundPreview(paidOrder())).toEqual({ refundable: true, cod: false, amount: 1050 });
  });

  test('subtracts what a seller-cancelled line was already refunded', () => {
    // Naming the order total here would promise money that has already been sent.
    const p = cancelRefundPreview(paidOrder({
      items: [
        { status: 'CANCELLED', totalPrice: '400', taxAmount: '0' },
        { status: 'PENDING', totalPrice: '600', taxAmount: '0' },
      ],
    }));
    expect(p.amount).toBe(650); // 1050 - 400
  });

  test('adds a line tax only when the order added tax on top', () => {
    // total = subtotal + delivery + addedTax - discount  ->  1100 = 1000 + 50 + 50
    const p = cancelRefundPreview(paidOrder({
      taxAmount: '50', totalAmount: '1100',
      items: [
        { status: 'CANCELLED', totalPrice: '500', taxAmount: '25' },
        { status: 'PENDING', totalPrice: '500', taxAmount: '25' },
      ],
    }));
    expect(p.amount).toBe(575); // 1100 - (500 + 25)
  });

  test('tax already included in the prices is not subtracted twice', () => {
    // total == subtotal + delivery, so nothing was added on top.
    const p = cancelRefundPreview(paidOrder({
      taxAmount: '50', totalAmount: '1050',
      items: [
        { status: 'CANCELLED', totalPrice: '400', taxAmount: '20' },
        { status: 'PENDING', totalPrice: '600', taxAmount: '30' },
      ],
    }));
    expect(p.amount).toBe(650); // 1050 - 400, the line's own tax not re-added
  });

  test('promises a refund without naming a figure when it cannot compute one', () => {
    const p = cancelRefundPreview(paidOrder({ items: [] }));
    expect(p).toEqual({ refundable: true, cod: false, amount: null });
  });

  test('sums in paise, so it agrees with the server Decimal to the rupee', () => {
    const p = cancelRefundPreview(paidOrder({
      subtotal: '10.10', deliveryFee: '0.10', totalAmount: '10.20',
      items: [{ status: 'CANCELLED', totalPrice: '0.10', taxAmount: '0' }],
    }));
    expect(p.amount).toBe(10.1); // not 10.099999999999998
  });
});

describe('confirmFailureNotice', () => {
  // Confirm only runs on a signature-verified payment, so every refusal means
  // the money moved and no order exists.
  const conflict = (over = {}) => ({ status: 409, ...over });

  test('an order that did get created is reported as ordered, not as a refund', () => {
    const n = confirmFailureNotice(conflict(), { state: 'ORDER_CREATED', orderId: 'o1' });
    expect(n.ordered).toBe(true);
  });

  test('reason 1/2 - the intent is refunding, so the refund sentence is used', () => {
    const n = confirmFailureNotice(
      conflict({ issues: [{ message: 'Only 3 left of Urea 50kg' }] }),
      { state: 'REFUNDING', refundPending: true, amount: '900' },
    );
    expect(n.bodyFallback).toMatch(/working days/);
    expect(n.amount).toBe(900);
    // The server's specific words are appended, never substituted for the refund.
    expect(n.detail).toBe('Only 3 left of Urea 50kg');
  });

  test('reason 3/4 - indistinguishable in the envelope, so the intent decides', () => {
    // CONFIRMING: captured but no refund raised yet. The reconciler owns it.
    const n = confirmFailureNotice(conflict(), { state: 'CONFIRMING' });
    expect(n.bodyFallback).toMatch(/arranging your refund/);
    expect(n.bodyFallback).not.toMatch(/working days/);
  });

  test('a gateway failure is a plain failure, and retrying is safe', () => {
    const n = confirmFailureNotice(conflict(), { state: 'FAILED' });
    expect(n.mayRetry).toBe(true);
    expect(n.bodyFallback).toMatch(/No money was taken/);
  });

  test('without an authoritative answer, refundStarted decides the promise', () => {
    const started = confirmFailureNotice(conflict({ refundStarted: true }), null);
    expect(started.bodyFallback).toMatch(/working days/);

    const notStarted = confirmFailureNotice(conflict(), null);
    expect(notStarted.bodyFallback).toMatch(/arranging your refund/);
    expect(notStarted.bodyFallback).not.toMatch(/working days/);
  });

  test('a timeout or 5xx never says "try again" - the money may have moved', () => {
    const n = confirmFailureNotice({ status: 0 }, null);
    expect(n.mayRetry).toBeFalsy();
    expect(n.bodyFallback).toMatch(/do not pay again/i);
  });
});

describe('every key these helpers return resolves to real text', () => {
  /**
   * The guard for the bug this pass found: the helpers were already returning
   * `orders.refundPending`, `orders.partiallyRefunded` and `orders.refunded`
   * while translations.js had none of the three, so a farmer owed money saw the
   * literal key. A helper and its translation must not be able to drift again.
   */
  const keysFromHelpers = () => {
    const keys = new Set();
    const take = (o) => {
      if (!o) return;
      for (const k of ['titleKey', 'bodyKey', 'leadKey']) {
        if (typeof o[k] === 'string') keys.add(o[k]);
      }
    };

    for (const state of [...SERVER_STATES, 'REFUND_INITIATED', 'PAID', 'CREATED', 'NEVER_HEARD_OF_IT']) {
      for (const refundPending of [true, false, undefined]) {
        // Both the plain and the amount-bearing wording.
        take(paymentStatusNotice({ state, refundPending }));
        take(paymentStatusNotice({ state, refundPending, amount: '100' }));
      }
    }
    for (const info of [{ status: 409 }, { status: 409, refundStarted: true }, { status: 0 }]) {
      for (const status of [
        null,
        { state: 'REFUNDING', refundPending: true },
        { state: 'CONFIRMING' },
        { state: 'FAILED' },
      ]) {
        take(confirmFailureNotice(info, status));
      }
    }
    for (const s of ['refund_pending', 'partially_refunded', 'refunded']) {
      const l = orderRefundLabel(s);
      if (l) keys.add(l.key);
    }
    return [...keys].sort();
  };

  test('the helpers really do return keys to check', () => {
    expect(keysFromHelpers().length).toBeGreaterThan(10);
  });

  test.each(['en', 'hi', 'mr'])('%s has every one of them', (lang) => {
    const missing = keysFromHelpers()
      .filter((k) => typeof resolveKey(translations[lang], k) !== 'string');
    expect(missing).toEqual([]);
  });

  test('no key resolves to an object, which renders as the key itself', () => {
    const objects = keysFromHelpers().filter((k) => {
      const v = resolveKey(translations.en, k);
      return v !== undefined && typeof v !== 'string';
    });
    expect(objects).toEqual([]);
  });

  test('the three keys that were missing are present in every language', () => {
    // Named explicitly so the regression is readable in the failure output.
    const REQUIRED = ['orders.refundPending', 'orders.partiallyRefunded', 'orders.refunded'];
    for (const lang of ['en', 'hi', 'mr']) {
      const missing = REQUIRED.filter((k) => typeof resolveKey(translations[lang], k) !== 'string');
      expect({ lang, missing }).toEqual({ lang, missing: [] });
    }
  });
});
