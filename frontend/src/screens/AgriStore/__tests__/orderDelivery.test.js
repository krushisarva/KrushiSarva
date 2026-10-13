/**
 * Delivery on My Orders — the promised date, the shops, and the code.
 *
 * Three ways this goes wrong for a farmer, and the reason each block exists:
 *
 *   1. A PROMISE THE APP CANNOT KEEP. "Arriving by 14 Oct" shown on the 17th, or
 *      under a Delivered badge, or as "Arriving by Invalid Date".
 *   2. THE WRONG CODE. An order from two shops has two codes. Shown without its
 *      shop, or read out as "four thousand and seventy-two", the code the farmer
 *      gives at the door is not the one the seller has to type.
 *   3. AN OLDER BACKEND. Every field this reads is new and optional. A server
 *      that sends none of them must leave the card exactly as it was — no empty
 *      box, no "undefined", no crash.
 *
 * Dates are built with the LOCAL constructor on purpose: "late" is decided by
 * the calendar day on the phone, so these tests have to hold in whatever zone
 * they run in, not only in India.
 */
import fs from 'fs';
import path from 'path';
import {
  orderStatusLabel, orderExpectedBy, formatOrderDay, orderEta,
  deliveryCodeView, callablePhone, orderDeliveries,
} from '../shopUtils';

/** A local wall-clock time, as the ISO string the API would send. */
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
const iso = (...a) => at(...a).toISOString();

const NONE = { compact: false, blocks: [] };

// ── Status wording ────────────────────────────────────────────────────────────
describe('orderStatusLabel', () => {
  test('SHIPPED reads "Out for delivery", through a NEW key', () => {
    const l = orderStatusLabel('SHIPPED');
    expect(l).toEqual({ key: 'orders.statusOutForDelivery', fallback: 'Out for delivery' });
    // The existing key is left alone — the seller app and older builds read it.
    expect(l.key).not.toBe('orders.statusShipped');
  });

  test('every other status keeps the key it already had', () => {
    expect(orderStatusLabel('PENDING').key).toBe('orders.statusPending');
    expect(orderStatusLabel('CONFIRMED').key).toBe('orders.statusConfirmed');
    expect(orderStatusLabel('DELIVERED').key).toBe('orders.statusDelivered');
    expect(orderStatusLabel('CANCELLED').key).toBe('orders.statusCancelled');
    expect(orderStatusLabel('REFUNDED').key).toBe('orders.statusRefunded');
  });

  test('every known status carries real English, so a missing key never shows as a key', () => {
    for (const s of ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']) {
      const l = orderStatusLabel(s);
      expect(l.fallback).toMatch(/^[A-Z][a-z]/);
      expect(l.fallback).not.toMatch(/orders\./);
    }
  });

  test('a status this build has never heard of is a phrase, not a constant', () => {
    expect(orderStatusLabel('RETURN_REQUESTED')).toEqual({ key: null, fallback: 'Return requested' });
  });

  test('a missing status is nothing at all — no empty pill', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}]) {
      expect(orderStatusLabel(bad)).toBeNull();
    }
  });

  test('a status named after an Object.prototype member is not looked up there', () => {
    expect(orderStatusLabel('constructor')).toEqual({ key: null, fallback: 'Constructor' });
    expect(orderStatusLabel('toString')).toEqual({ key: null, fallback: 'Tostring' });
  });
});

// ── The promised date ─────────────────────────────────────────────────────────
describe('orderExpectedBy', () => {
  test('uses the date the server sent', () => {
    const d = orderExpectedBy({ expectedBy: iso(2026, 10, 16, 14, 32) });
    expect(d.getTime()).toBe(at(2026, 10, 16, 14, 32).getTime());
  });

  test('OLDER BACKEND: no expectedBy, so it is createdAt + promisedEtaDays', () => {
    const d = orderExpectedBy({ createdAt: iso(2026, 10, 13, 14, 32), promisedEtaDays: 3 });
    expect(d.getTime()).toBe(at(2026, 10, 13, 14, 32).getTime() + 3 * 24 * 60 * 60 * 1000);
  });

  test('the local sum is the same instant the server would have sent', () => {
    const createdAt = iso(2026, 10, 13, 9, 5);
    const server = new Date(new Date(createdAt).getTime() + 5 * 86400000).toISOString();
    expect(orderExpectedBy({ createdAt, promisedEtaDays: 5 }).toISOString()).toBe(server);
    expect(orderExpectedBy({ createdAt, promisedEtaDays: 5, expectedBy: server }).toISOString()).toBe(server);
  });

  test('the server date wins over a local sum that disagrees', () => {
    const d = orderExpectedBy({
      expectedBy: iso(2026, 10, 20), createdAt: iso(2026, 10, 13), promisedEtaDays: 3,
    });
    expect(d.getDate()).toBe(20);
  });

  test('a same-day promise (0 days) is a date, not a missing one', () => {
    const d = orderExpectedBy({ createdAt: iso(2026, 10, 13, 8), promisedEtaDays: 0 });
    expect(d.getTime()).toBe(at(2026, 10, 13, 8).getTime());
  });

  test('no promise recorded means NO date — never an invented one', () => {
    const createdAt = iso(2026, 10, 13);
    // `Number(null)` and `Number('')` are both 0, which would otherwise promise
    // delivery on the day the order was placed.
    for (const promisedEtaDays of [null, undefined, '', '  ', 'abc', NaN, -1, Infinity, {}, []]) {
      expect(orderExpectedBy({ createdAt, promisedEtaDays })).toBeNull();
    }
    // The contract's own shape for it: both null.
    expect(orderExpectedBy({ createdAt, expectedBy: null, promisedEtaDays: null })).toBeNull();
  });

  test('a missing or unreadable order date means no date', () => {
    for (const createdAt of [undefined, null, '', 'not a date', 0, 1760000000000, {}]) {
      expect(orderExpectedBy({ createdAt, promisedEtaDays: 3 })).toBeNull();
    }
  });

  test('a garbage expectedBy falls back to the local sum rather than to nothing', () => {
    const d = orderExpectedBy({
      expectedBy: 'soon', createdAt: iso(2026, 10, 13), promisedEtaDays: 3,
    });
    expect(d.getDate()).toBe(16);
  });

  test('never hands back an Invalid Date', () => {
    expect(orderExpectedBy({ createdAt: iso(2026, 10, 13), promisedEtaDays: 1e12 })).toBeNull();
    expect(orderExpectedBy({ expectedBy: '2026-13-45T99:99:99Z' })).toBeNull();
  });

  test('survives no order at all', () => {
    for (const bad of [null, undefined, {}, 'x', 7]) expect(orderExpectedBy(bad)).toBeNull();
  });
});

describe('formatOrderDay', () => {
  const now = at(2026, 10, 13);

  test('day and short month, the Indian way round', () => {
    expect(formatOrderDay(at(2026, 10, 16), now)).toBe('16 Oct');
  });

  test('no leading zero on the day', () => {
    expect(formatOrderDay(at(2026, 10, 5), now)).toBe('5 Oct');
  });

  test('is the en-IN formatter the card footer uses, for every month', () => {
    // Not a hand-built month table: this engine writes September "Sept", an
    // older one writes "Sep", and whichever the phone has is what the order
    // date in the footer of the same card will say.
    for (let m = 1; m <= 12; m++) {
      const d = at(2026, m, 9);
      expect(formatOrderDay(d, at(2026, 6, 1)))
        .toBe(d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
    }
  });

  test('names the year only when it is not this year', () => {
    expect(formatOrderDay(at(2027, 1, 6), at(2026, 12, 30))).toBe('6 Jan 2027');
    expect(formatOrderDay(at(2025, 12, 28), at(2026, 1, 4))).toBe('28 Dec 2025');
    expect(formatOrderDay(at(2026, 1, 6), at(2026, 12, 30))).toBe('6 Jan');
  });

  test('an engine that cannot format still produces a date, not a blank', () => {
    const spy = jest.spyOn(Date.prototype, 'toLocaleDateString');
    try {
      spy.mockImplementation(() => { throw new RangeError('no locale data'); });
      expect(formatOrderDay(at(2026, 10, 16), now)).toBe('16 Oct');
      expect(formatOrderDay(at(2027, 1, 6), now)).toBe('6 Jan 2027');

      spy.mockImplementation(() => '');
      expect(formatOrderDay(at(2026, 9, 3), now)).toBe('3 Sep');
    } finally {
      spy.mockRestore();
    }
  });

  test('nothing to format is null, not "Invalid Date"', () => {
    for (const bad of [null, undefined, '', 'x', new Date('x'), 0]) {
      expect(formatOrderDay(bad, now)).toBeNull();
    }
  });
});

describe('orderEta', () => {
  const order = (over = {}) => ({
    status: 'CONFIRMED',
    createdAt: iso(2026, 10, 13, 14, 32),
    promisedEtaDays: 3,
    expectedBy: iso(2026, 10, 16, 14, 32),
    ...over,
  });

  test('before the day: "Arriving by <date>"', () => {
    const eta = orderEta(order(), at(2026, 10, 14, 9));
    expect(eta).toMatchObject({ late: false, key: 'orders.arrivingBy', dateText: '16 Oct' });
    expect(eta.fallback).toBe('Arriving by {{date}}');
  });

  test('ON the day, even after the exact time, the promise is not broken yet', () => {
    // expectedBy is 2:32 pm — order time plus three days — but what the farmer
    // was told is a DAY. At 9 pm on the 16th the seller is not late.
    const eta = orderEta(order(), at(2026, 10, 16, 21, 0));
    expect(eta.late).toBe(false);
    expect(eta.key).toBe('orders.arrivingBy');
  });

  test('the last minute of the day is still on time; the first of the next is late', () => {
    expect(orderEta(order(), at(2026, 10, 16, 23, 59)).late).toBe(false);
    expect(orderEta(order(), at(2026, 10, 17, 0, 1)).late).toBe(true);
  });

  test('once the day has passed it says so, and still names the day that was promised', () => {
    const eta = orderEta(order(), at(2026, 10, 19, 10));
    expect(eta).toMatchObject({ late: true, key: 'orders.expectedLate', dateText: '16 Oct' });
    expect(eta.fallback).toMatch(/running late/);
    // Not the wording of a live promise.
    expect(eta.fallback).not.toMatch(/Arriving/);
  });

  test('late is by calendar day across a month and a year boundary too', () => {
    const o = order({ expectedBy: iso(2026, 12, 31, 18) });
    expect(orderEta(o, at(2026, 12, 31, 23, 30)).late).toBe(false);
    expect(orderEta(o, at(2027, 1, 1, 0, 30)).late).toBe(true);
    // An early date in a LATER month is not "before" a late date in this one.
    const nov = order({ expectedBy: iso(2026, 11, 2) });
    expect(orderEta(nov, at(2026, 10, 30)).late).toBe(false);
  });

  test('each wording has exactly one {{date}} for the screen to fill', () => {
    for (const now of [at(2026, 10, 14), at(2026, 10, 20)]) {
      expect(orderEta(order(), now).fallback.match(/\{\{date\}\}/g)).toHaveLength(1);
    }
  });

  test('shown for every status still on its way', () => {
    for (const status of ['PENDING', 'CONFIRMED', 'SHIPPED']) {
      expect(orderEta(order({ status }), at(2026, 10, 14))).not.toBeNull();
    }
  });

  test('a finished order has no arrival to wait for — late or not', () => {
    for (const status of ['DELIVERED', 'CANCELLED', 'REFUNDED']) {
      expect(orderEta(order({ status }), at(2026, 10, 14))).toBeNull();
      expect(orderEta(order({ status }), at(2026, 10, 30))).toBeNull();
    }
  });

  test('a status this build does not know gets no promise', () => {
    for (const status of ['RETURN_REQUESTED', '', null, undefined, 42]) {
      expect(orderEta(order({ status }), at(2026, 10, 14))).toBeNull();
    }
  });

  test('OLDER BACKEND: no expectedBy, the date is worked out from the order', () => {
    const eta = orderEta(order({ expectedBy: undefined }), at(2026, 10, 14));
    expect(eta).toMatchObject({ late: false, dateText: '16 Oct' });
    expect(orderEta(order({ expectedBy: undefined }), at(2026, 10, 18)).late).toBe(true);
  });

  test('OLDER BACKEND with no promise on the order: nothing, not an empty line', () => {
    expect(orderEta({ status: 'CONFIRMED', createdAt: iso(2026, 10, 13) }, at(2026, 10, 14))).toBeNull();
    expect(orderEta({ status: 'CONFIRMED' }, at(2026, 10, 14))).toBeNull();
    expect(orderEta(order({ expectedBy: null, promisedEtaDays: null }), at(2026, 10, 14))).toBeNull();
  });

  test('accepts the clock as milliseconds or a Date, and defaults to now', () => {
    expect(orderEta(order(), at(2026, 10, 19).getTime()).late).toBe(true);
    expect(orderEta(order(), at(2026, 10, 14)).late).toBe(false);
    // A promise a century out cannot be late today.
    expect(orderEta(order({ expectedBy: iso(2126, 1, 1) })).late).toBe(false);
    expect(orderEta(order({ expectedBy: iso(2001, 1, 1) })).late).toBe(true);
  });

  test('survives no order at all', () => {
    for (const bad of [null, undefined, {}, 'x']) expect(orderEta(bad)).toBeNull();
  });
});

// ── The delivery code ─────────────────────────────────────────────────────────
describe('deliveryCodeView', () => {
  test('spaces the digits for the eye and separates them for the ear', () => {
    expect(deliveryCodeView('4072')).toEqual({
      digits: ['4', '0', '7', '2'],
      spaced: '4 0 7 2',
      spoken: '4, 0, 7, 2',
    });
  });

  test('the spoken form can never be read as one number', () => {
    // "4072" is announced "four thousand and seventy-two", and that is not what
    // the delivery person types.
    const v = deliveryCodeView('4072');
    expect(v.spoken).not.toMatch(/\d\d/);
    expect(v.spaced).not.toMatch(/\d\d/);
    expect(v.spoken.split(', ')).toEqual(['4', '0', '7', '2']);
  });

  test('keeps leading zeros — 0042 is four digits, not forty-two', () => {
    expect(deliveryCodeView('0042').spaced).toBe('0 0 4 2');
    expect(deliveryCodeView('0000').spoken).toBe('0, 0, 0, 0');
  });

  test('tolerates stray whitespace around the code', () => {
    expect(deliveryCodeView(' 4072\n').spaced).toBe('4 0 7 2');
  });

  test('refuses a NUMBER: its leading zeros are already gone', () => {
    expect(deliveryCodeView(4072)).toBeNull();
    expect(deliveryCodeView(407)).toBeNull(); // was this 0407?
    expect(deliveryCodeView(0)).toBeNull();
  });

  test('OLDER BACKEND and every "no code yet" shape: null, so no box is drawn', () => {
    for (const bad of [undefined, null, '', '    ', {}, [], true]) {
      expect(deliveryCodeView(bad)).toBeNull();
    }
  });

  test('refuses anything that is not purely 4 to 6 digits', () => {
    for (const bad of ['123', '1234567', '12a4', '12 34', '12-34', '4072.0', '+4072', '１２３４', '१२३४']) {
      expect(deliveryCodeView(bad)).toBeNull();
    }
  });

  test('a longer code from a later server is still shown, digit by digit', () => {
    expect(deliveryCodeView('407215').spoken).toBe('4, 0, 7, 2, 1, 5');
  });
});

describe('callablePhone', () => {
  test('reduces a number to what the dialler accepts', () => {
    expect(callablePhone('98765 43210')).toBe('9876543210');
    expect(callablePhone('+91 98765-43210')).toBe('+919876543210');
    expect(callablePhone('(02162) 234567')).toBe('02162234567');
    expect(callablePhone(9876543210)).toBe('9876543210');
  });

  test('keeps one leading + and drops any other', () => {
    expect(callablePhone('+91+9876543210')).toBe('+919876543210');
  });

  test('nothing usable is null, so no Call button is offered', () => {
    for (const bad of [undefined, null, '', '   ', 'call me', {}, [], true]) {
      expect(callablePhone(bad)).toBeNull();
    }
  });

  test('a masked or truncated number is not offered as callable', () => {
    expect(callablePhone('98******10')).toBeNull();
    expect(callablePhone('12345')).toBeNull();
    expect(callablePhone('1234567890123456')).toBeNull();
  });

  test('cannot smuggle anything but digits into a tel: link', () => {
    expect(callablePhone('9876543210;ext=1,,*#')).toBe('98765432101');
    expect(callablePhone('tel:9876543210?x=<script>')).toBe('9876543210');
  });
});

// ── One block per shop ────────────────────────────────────────────────────────
describe('orderDeliveries', () => {
  const KENDRA = 'seller-kendra';
  const AGRO = 'seller-agro';

  const entry = (over = {}) => ({
    sellerId: KENDRA,
    sellerName: 'Shree Krushi Kendra',
    status: 'CONFIRMED',
    sellerPhone: null,
    deliveryCode: null,
    ...over,
  });

  const order = (deliveries, over = {}) => ({
    id: 'o1', status: 'CONFIRMED', deliveries,
    items: [
      { id: 'i1', sellerId: KENDRA, status: 'CONFIRMED', productName: 'Urea 50kg', productNameMr: 'युरिया ५० किलो' },
    ],
    ...over,
  });

  describe('older backend and missing data', () => {
    test('no `deliveries` field at all: no blocks, the card is as it was', () => {
      const legacy = {
        id: 'o1', status: 'CONFIRMED', createdAt: iso(2026, 10, 13), promisedEtaDays: 3,
        items: [{ id: 'i1', sellerId: KENDRA, sellerName: 'Shree Krushi Kendra', status: 'CONFIRMED' }],
      };
      expect(orderDeliveries(legacy)).toEqual(NONE);
    });

    test('a `deliveries` that is not a usable list: no blocks, no crash', () => {
      for (const deliveries of [undefined, null, [], {}, 'x', 7, true]) {
        expect(orderDeliveries(order(deliveries))).toEqual(NONE);
      }
    });

    test('no order: no blocks, no crash', () => {
      for (const bad of [null, undefined, {}, 'x']) expect(orderDeliveries(bad)).toEqual(NONE);
      // …and no options either.
      expect(orderDeliveries(order([entry()]), null).blocks).toHaveLength(1);
    });

    test('junk inside the list is skipped, not rendered', () => {
      const vm = orderDeliveries(order([null, 'x', 42, [], undefined, entry({ sellerPhone: '9876543210' })]));
      expect(vm.blocks).toHaveLength(1);
      expect(vm.compact).toBe(true);
      expect(vm.blocks[0].name).toBe('Shree Krushi Kendra');
    });

    test('a shop the server could not name is `name: null`, for the screen to label', () => {
      const vm = orderDeliveries(order([entry({ sellerName: null, sellerPhone: '9876543210' })]));
      expect(vm.blocks[0]).toMatchObject({ name: null, ordinal: 1, phone: '9876543210' });
      // Blank and whitespace names are the same as none.
      expect(orderDeliveries(order([entry({ sellerName: '   ', sellerPhone: '9876543210' })])).blocks[0].name).toBeNull();
    });

    test('ONE shop with no name, no phone and no code: nothing, not an empty row', () => {
      expect(orderDeliveries(order([entry({ sellerName: null })]))).toEqual(NONE);
      expect(orderDeliveries(order([{ status: 'CONFIRMED' }]))).toEqual(NONE);
    });

    test('an entry with every optional field absent still renders by name', () => {
      const vm = orderDeliveries(order([{ sellerId: KENDRA, sellerName: 'Shree Krushi Kendra', status: 'PENDING' }], { status: 'PENDING' }));
      expect(vm.blocks[0]).toMatchObject({ name: 'Shree Krushi Kendra', phone: null, code: null });
    });
  });

  describe('a finished order shows nothing', () => {
    test.each(['DELIVERED', 'CANCELLED', 'REFUNDED'])('%s', (status) => {
      const vm = orderDeliveries(order(
        [entry({ status: 'SHIPPED', sellerPhone: '9876543210', deliveryCode: '4072' })],
        { status },
      ));
      // Even if the row still carries a phone and a code.
      expect(vm).toEqual(NONE);
    });

    test('nothing still on its way, even under a stale order status', () => {
      const vm = orderDeliveries(order(
        [entry({ status: 'DELIVERED' }), entry({ sellerId: AGRO, sellerName: 'Patil Agro', status: 'CANCELLED' })],
        { status: 'SHIPPED' },
      ));
      expect(vm).toEqual(NONE);
    });
  });

  describe('one shop — kept compact', () => {
    test('before the seller confirms: the shop name, and nothing to press', () => {
      const vm = orderDeliveries(order([entry({ status: 'PENDING' })], { status: 'PENDING' }));
      expect(vm.compact).toBe(true);
      expect(vm.blocks).toHaveLength(1);
      expect(vm.blocks[0]).toMatchObject({
        name: 'Shree Krushi Kendra', status: 'PENDING', phone: null, code: null,
      });
    });

    test('does not repeat the status the order badge already shows', () => {
      const vm = orderDeliveries(order([entry()]));
      expect(vm.blocks[0].showStatus).toBe(false);
    });

    test('does not repeat the goods the item row already shows', () => {
      const vm = orderDeliveries(order([entry()]));
      expect(vm.blocks[0]).toMatchObject({ itemNames: [], moreItems: 0 });
    });

    test('says the shop\'s own status when it differs from the order badge', () => {
      const vm = orderDeliveries(order([entry({ status: 'SHIPPED' })], { status: 'CONFIRMED' }));
      expect(vm.blocks[0].showStatus).toBe(true);
      expect(vm.blocks[0].statusLabel.fallback).toBe('Out for delivery');
    });

    test('confirmed: the Call button appears', () => {
      const vm = orderDeliveries(order([entry({ sellerPhone: '98765 43210' })]));
      expect(vm.blocks[0].phone).toBe('9876543210');
      expect(vm.blocks[0].code).toBeNull();
    });

    test('out for delivery: the code appears', () => {
      const vm = orderDeliveries(order(
        [entry({ status: 'SHIPPED', sellerPhone: '9876543210', deliveryCode: '4072' })],
        { status: 'SHIPPED' },
      ));
      expect(vm.blocks[0].code).toEqual({
        digits: ['4', '0', '7', '2'], spaced: '4 0 7 2', spoken: '4, 0, 7, 2',
      });
      expect(vm.blocks[0].phone).toBe('9876543210');
    });
  });

  describe('the phone and the code are shown only while they mean something', () => {
    test('a code on anything but an out-for-delivery shop is not shown', () => {
      for (const status of ['PENDING', 'CONFIRMED', 'DELIVERED', 'CANCELLED', 'RETURNED', null]) {
        const vm = orderDeliveries(order([
          entry({ status, deliveryCode: '4072' }),
          entry({ sellerId: AGRO, sellerName: 'Patil Agro', status: 'CONFIRMED' }),
        ]));
        expect(vm.blocks[0].code).toBeNull();
      }
    });

    test('a malformed code is not shown as one', () => {
      for (const deliveryCode of [4072, '40', 'abcd', '', null, undefined, {}]) {
        const vm = orderDeliveries(order([entry({ status: 'SHIPPED', deliveryCode })], { status: 'SHIPPED' }));
        expect(vm.blocks[0].code).toBeNull();
      }
    });

    test('a shop that has delivered or cancelled keeps no Call button', () => {
      const vm = orderDeliveries(order([
        entry({ status: 'DELIVERED', sellerPhone: '9876543210' }),
        entry({ sellerId: AGRO, sellerName: 'Patil Agro', status: 'CANCELLED', sellerPhone: '9123456780' }),
        entry({ sellerId: 's3', sellerName: 'Third', status: 'SHIPPED', sellerPhone: '9000000001' }),
      ], { status: 'SHIPPED' }));
      expect(vm.blocks.map((b) => b.phone)).toEqual([null, null, '9000000001']);
    });

    test('an unusable phone is no Call button, not a dead one', () => {
      for (const sellerPhone of [null, undefined, '', '98******10', 'n/a', {}]) {
        const vm = orderDeliveries(order([entry({ sellerPhone })]));
        expect(vm.blocks[0].phone).toBeNull();
      }
    });
  });

  describe('two shops on one order', () => {
    const two = (over = {}) => order([
      entry({ status: 'SHIPPED', sellerPhone: '9876543210', deliveryCode: '4072' }),
      entry({ sellerId: AGRO, sellerName: 'Patil Agro', status: 'SHIPPED', sellerPhone: '9123456780', deliveryCode: '0915' }),
    ], {
      status: 'SHIPPED',
      items: [
        { id: 'i1', sellerId: KENDRA, status: 'SHIPPED', productName: 'Urea 50kg', productNameMr: 'युरिया ५० किलो' },
        { id: 'i2', sellerId: AGRO, status: 'SHIPPED', productName: 'Sprayer pump' },
        { id: 'i3', sellerId: KENDRA, status: 'SHIPPED', productName: 'DAP 50kg' },
      ],
      ...over,
    });

    test('is not compact, and keeps the server\'s order', () => {
      const vm = orderDeliveries(two());
      expect(vm.compact).toBe(false);
      expect(vm.blocks.map((b) => [b.ordinal, b.name])).toEqual([
        [1, 'Shree Krushi Kendra'], [2, 'Patil Agro'],
      ]);
    });

    test('EACH CODE STAYS WITH ITS OWN SHOP', () => {
      // The one mistake that fails a delivery at the door.
      const byShop = Object.fromEntries(orderDeliveries(two()).blocks.map((b) => [b.name, b.code.spaced]));
      expect(byShop).toEqual({ 'Shree Krushi Kendra': '4 0 7 2', 'Patil Agro': '0 9 1 5' });
    });

    test('each phone stays with its own shop too', () => {
      const byShop = Object.fromEntries(orderDeliveries(two()).blocks.map((b) => [b.name, b.phone]));
      expect(byShop).toEqual({ 'Shree Krushi Kendra': '9876543210', 'Patil Agro': '9123456780' });
    });

    test('each block names the goods THAT shop is bringing', () => {
      const [kendra, agro] = orderDeliveries(two()).blocks;
      expect(kendra.itemNames).toEqual(['Urea 50kg', 'DAP 50kg']);
      expect(agro.itemNames).toEqual(['Sprayer pump']);
    });

    test('every block says its own status in words', () => {
      const vm = orderDeliveries(order([
        entry({ status: 'DELIVERED' }),
        entry({ sellerId: AGRO, sellerName: 'Patil Agro', status: 'SHIPPED', deliveryCode: '0915' }),
      ], { status: 'SHIPPED' }));
      expect(vm.blocks.map((b) => [b.showStatus, b.statusLabel.fallback])).toEqual([
        [true, 'Delivered'], [true, 'Out for delivery'],
      ]);
      // The delivered shop's code is gone; the other shop's is still there.
      expect(vm.blocks.map((b) => b.code?.spaced ?? null)).toEqual([null, '0 9 1 5']);
    });

    test('two unnamed shops are still told apart, by position', () => {
      const vm = orderDeliveries(two({
        deliveries: [
          entry({ sellerName: null, status: 'SHIPPED', deliveryCode: '4072' }),
          entry({ sellerId: AGRO, sellerName: null, status: 'SHIPPED', deliveryCode: '0915' }),
        ],
      }));
      expect(vm.blocks.map((b) => [b.name, b.ordinal, b.code.spaced])).toEqual([
        [null, 1, '4 0 7 2'], [null, 2, '0 9 1 5'],
      ]);
      // …and by what each one is bringing, which is what the farmer can check.
      expect(vm.blocks.map((b) => b.itemNames)).toEqual([['Urea 50kg', 'DAP 50kg'], ['Sprayer pump']]);
    });

    test('lists two names and counts the rest', () => {
      const vm = orderDeliveries(two({
        items: [
          { sellerId: KENDRA, status: 'SHIPPED', productName: 'Urea 50kg' },
          { sellerId: KENDRA, status: 'SHIPPED', productName: 'DAP 50kg' },
          { sellerId: KENDRA, status: 'SHIPPED', productName: 'Zinc sulphate' },
          { sellerId: KENDRA, status: 'SHIPPED', productName: 'Neem oil' },
          { sellerId: AGRO, status: 'SHIPPED', productName: 'Sprayer pump' },
        ],
      }));
      expect(vm.blocks[0]).toMatchObject({ itemNames: ['Urea 50kg', 'DAP 50kg'], moreItems: 2 });
      expect(vm.blocks[1]).toMatchObject({ itemNames: ['Sprayer pump'], moreItems: 0 });
    });

    test('a line the shop cancelled is not listed as coming', () => {
      const vm = orderDeliveries(two({
        items: [
          { sellerId: KENDRA, status: 'CANCELLED', productName: 'Urea 50kg' },
          { sellerId: KENDRA, status: 'SHIPPED', productName: 'DAP 50kg' },
          { sellerId: AGRO, status: 'SHIPPED', productName: 'Sprayer pump' },
        ],
      }));
      expect(vm.blocks[0].itemNames).toEqual(['DAP 50kg']);
    });

    test('a shop that cancelled everything still says what it was for', () => {
      const vm = orderDeliveries(order([
        entry({ status: 'CANCELLED' }),
        entry({ sellerId: AGRO, sellerName: 'Patil Agro', status: 'CONFIRMED' }),
      ], {
        items: [
          { sellerId: KENDRA, status: 'CANCELLED', productName: 'Urea 50kg' },
          { sellerId: AGRO, status: 'CONFIRMED', productName: 'Sprayer pump' },
        ],
      }));
      expect(vm.blocks[0]).toMatchObject({ itemNames: ['Urea 50kg'], phone: null, code: null });
      expect(vm.blocks[0].statusLabel.fallback).toBe('Cancelled');
    });

    test('uses the Marathi product name when the app is in Marathi', () => {
      expect(orderDeliveries(two(), { language: 'mr' }).blocks[0].itemNames).toEqual(['युरिया ५० किलो', 'DAP 50kg']);
      expect(orderDeliveries(two(), { language: 'hi' }).blocks[0].itemNames).toEqual(['Urea 50kg', 'DAP 50kg']);
    });

    test('falls back to the live product name for a line with no snapshot', () => {
      const vm = orderDeliveries(two({
        items: [
          { sellerId: KENDRA, status: 'SHIPPED', product: { name: 'Urea (live)' } },
          { sellerId: KENDRA, status: 'SHIPPED' }, // no name anywhere — skipped
          { sellerId: AGRO, status: 'SHIPPED', productName: 'Sprayer pump' },
        ],
      }));
      expect(vm.blocks[0]).toMatchObject({ itemNames: ['Urea (live)'], moreItems: 0 });
    });

    test('OLDER ROW SHAPES: no items, or lines with no seller — blocks without a goods line', () => {
      for (const items of [undefined, null, [], [null], [{ status: 'SHIPPED', productName: 'Orphan line' }]]) {
        const vm = orderDeliveries(two({ items }));
        expect(vm.blocks).toHaveLength(2);
        expect(vm.blocks.map((b) => b.itemNames)).toEqual([[], []]);
      }
    });

    test('a status this build does not know is a readable phrase, with no code under it', () => {
      const vm = orderDeliveries(order([
        entry({ status: 'RETURN_REQUESTED', deliveryCode: '4072', sellerPhone: '9876543210' }),
        entry({ sellerId: AGRO, sellerName: 'Patil Agro', status: 'CONFIRMED' }),
      ]));
      expect(vm.blocks[0].statusLabel).toEqual({ key: null, fallback: 'Return requested' });
      expect(vm.blocks[0].code).toBeNull();
    });

    test('row keys are unique even if the server repeats a seller', () => {
      const vm = orderDeliveries(order([entry(), entry(), entry({ sellerId: undefined })]));
      expect(new Set(vm.blocks.map((b) => b.key)).size).toBe(3);
    });
  });

  test('does not modify the order it was given', () => {
    const deepFreeze = (o) => {
      if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
      return o;
    };
    const frozen = deepFreeze(order([
      entry({ status: 'SHIPPED', sellerPhone: '9876543210', deliveryCode: '4072' }),
      entry({ sellerId: AGRO, sellerName: 'Patil Agro', status: 'CONFIRMED' }),
    ], { status: 'CONFIRMED' }));
    expect(() => orderDeliveries(frozen, { language: 'mr' })).not.toThrow();
    expect(() => orderEta(frozen)).not.toThrow();
  });
});

// ── The code stays on the screen ──────────────────────────────────────────────
describe('the delivery code and the shop phone never leave My Orders', () => {
  const read = (rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
  const SCREEN = read('../../Profile/MyOrdersScreen.js');
  const UTILS = read('../shopUtils.js');
  // From the delivery section to the end of the file — what this work added.
  const DELIVERY_UTILS = UTILS.slice(UTILS.indexOf('// ── Delivery: the promised date'));

  test('the delivery helpers were found', () => {
    expect(DELIVERY_UTILS.length).toBeGreaterThan(1000);
    expect(SCREEN).toMatch(/orderDeliveries\(/);
  });

  test.each([
    ['console', /\bconsole\s*\./],
    ['a logger', /\blogger\s*\./i],
    ['analytics / tracking', /\b(analytics|track(Event)?|logEvent|Sentry|crashlytics)\s*[.(]/i],
    ['device storage', /\b(AsyncStorage|SecureStore|writeCache|setItem)\b/],
    ['the clipboard or a share sheet', /\b(Clipboard|Share)\s*\./],
  ])('the screen and the helpers do not touch %s', (_name, pattern) => {
    expect(SCREEN).not.toMatch(pattern);
    expect(DELIVERY_UTILS).not.toMatch(pattern);
  });

  test('the code is never put into navigation params', () => {
    expect(SCREEN).not.toMatch(/navigate\([^)]*(deliveryCode|\bcode\b)/);
  });
});

// ── Call shop ─────────────────────────────────────────────────────────────────
describe('the Call button tries the dialler instead of asking permission to', () => {
  // On Android 11+ `Linking.canOpenURL('tel:…')` answers FALSE unless the
  // manifest declares the query, so a button gated on it does nothing on a
  // phone that can plainly make calls. The link is opened and a refusal handled.
  const read = (rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

  test('My Orders opens tel: through the shared helper', () => {
    const screen = read('../../Profile/MyOrdersScreen.js');
    expect(screen).toMatch(/safeOpenURL\(`tel:\$\{sanitizePhone\(/);
    // A CALL to it — the comment explaining why it is not used may name it.
    expect(screen).not.toMatch(/canOpenURL\s*\(/);
    expect(screen).not.toMatch(/Linking\s*\./);
  });

  test('the helper itself does not gate on canOpenURL, and never throws', () => {
    const helper = read('../../../utils/sanitize.js');
    const body = helper.slice(helper.indexOf('export function safeOpenURL'));
    expect(body).toMatch(/Linking\.openURL\(safe\)\.then\(\(\) => true\)\.catch\(\(\) => false\)/);
    expect(helper).not.toMatch(/canOpenURL\s*\(/);
  });
});
