/**
 * Order tracking (orderTracking.js) — the timeline on My Orders.
 *
 * What a farmer reads off it has to be TRUE: a step that did not happen is not
 * shown as done, a time that was never recorded is not invented, a cancelled
 * order does not show steps it never reached, and a refund is only mentioned
 * for money that was actually paid.
 */
import { formatTrackTime, isOrderLive, orderTracking } from '../orderTracking';

const NOW = new Date('2026-10-13T12:00:00+05:30').getTime();
const T = {
  placed: '2026-10-12T09:00:00.000Z',
  confirmed: '2026-10-12T10:30:00.000Z',
  shipped: '2026-10-13T03:35:00.000Z',
  delivered: '2026-10-13T06:10:00.000Z',
  cancelled: '2026-10-13T05:00:00.000Z',
};
const A = 'seller-a';
const B = 'seller-b';

const line = (sellerId, status, times = {}) => ({ id: `l-${sellerId}-${status}-${Object.keys(times).length}`, sellerId, status, ...times });
const order = (over = {}) => ({
  id: 'ord-1', status: 'PENDING', createdAt: T.placed, expectedBy: '2026-10-15T09:00:00.000Z',
  paymentMethod: 'cod', paymentStatus: 'pending',
  items: [line(A, 'PENDING')],
  deliveries: [{ sellerId: A, sellerName: 'Krushna Krishi Bhandar', status: 'PENDING' }],
  ...over,
});

const track = (o) => orderTracking(o, { now: NOW });
const shape = (o, i = 0) => track(o).shipments[i].steps.map((s) => `${s.id}:${s.state}`);
const stepOf = (o, id, i = 0) => track(o).shipments[i].steps.find((s) => s.id === id);

describe('an order on its way', () => {
  test('just placed: the shop has not answered yet', () => {
    const o = order();
    expect(shape(o)).toEqual(['placed:current', 'confirmed:upcoming', 'shipped:upcoming', 'delivered:upcoming']);
    expect(stepOf(o, 'placed')).toMatchObject({ at: new Date(T.placed), note: { key: 'orders.trackWaitingShop' } });
    expect(track(o).live).toBe(true);
  });

  test('confirmed: the shop is getting it ready', () => {
    const o = order({
      status: 'CONFIRMED',
      items: [line(A, 'CONFIRMED', { confirmedAt: T.confirmed })],
      deliveries: [{ sellerId: A, sellerName: 'K', status: 'CONFIRMED' }],
    });
    expect(shape(o)).toEqual(['placed:done', 'confirmed:current', 'shipped:upcoming', 'delivered:upcoming']);
    expect(stepOf(o, 'confirmed')).toMatchObject({ at: new Date(T.confirmed), note: { key: 'orders.trackPreparing' } });
  });

  test('out for delivery: that is where it IS, and "Delivered" carries the promised day', () => {
    const o = order({
      status: 'SHIPPED',
      items: [line(A, 'SHIPPED', { confirmedAt: T.confirmed, shippedAt: T.shipped })],
      deliveries: [{ sellerId: A, sellerName: 'K', status: 'SHIPPED' }],
    });
    expect(shape(o)).toEqual(['placed:done', 'confirmed:done', 'shipped:current', 'delivered:upcoming']);
    expect(stepOf(o, 'shipped').at).toEqual(new Date(T.shipped));
    expect(stepOf(o, 'delivered').note).toMatchObject({ key: 'orders.arrivingBy', vars: { date: expect.any(String) } });
    expect(stepOf(o, 'delivered').time).toBeNull();
  });

  test('the promised day has passed: "Delivered" says it is running late', () => {
    const o = order({
      status: 'CONFIRMED', expectedBy: '2026-10-11T09:00:00.000Z',
      items: [line(A, 'CONFIRMED', { confirmedAt: T.confirmed })],
      deliveries: [{ sellerId: A, sellerName: 'K', status: 'CONFIRMED' }],
    });
    expect(stepOf(o, 'delivered')).toMatchObject({ tone: 'late', note: { key: 'orders.expectedLate' } });
  });

  test('no promised day on the order: "Delivered" promises nothing', () => {
    const o = order({ expectedBy: null, promisedEtaDays: null });
    expect(stepOf(o, 'delivered').note).toBeNull();
  });
});

describe('delivered', () => {
  const delivered = order({
    status: 'DELIVERED',
    items: [line(A, 'DELIVERED', { confirmedAt: T.confirmed, shippedAt: T.shipped, deliveredAt: T.delivered })],
    deliveries: [{ sellerId: A, sellerName: 'K', status: 'DELIVERED' }],
  });

  test('every step done, each with the time it happened', () => {
    expect(shape(delivered)).toEqual(['placed:done', 'confirmed:done', 'shipped:done', 'delivered:done']);
    expect(track(delivered).shipments[0].steps.map((s) => s.at)).toEqual([
      new Date(T.placed), new Date(T.confirmed), new Date(T.shipped), new Date(T.delivered),
    ]);
    expect(track(delivered).live).toBe(false);
  });

  test('handed over at the counter (pending → delivered): the skipped steps are done, with NO invented time', () => {
    const o = order({
      status: 'DELIVERED',
      items: [line(A, 'DELIVERED', { deliveredAt: T.delivered })],
      deliveries: [{ sellerId: A, sellerName: 'K', status: 'DELIVERED' }],
    });
    expect(shape(o)).toEqual(['placed:done', 'confirmed:done', 'shipped:done', 'delivered:done']);
    expect(stepOf(o, 'confirmed')).toMatchObject({ at: null, time: null });
    expect(stepOf(o, 'shipped')).toMatchObject({ at: null, time: null });
    expect(stepOf(o, 'delivered').at).toEqual(new Date(T.delivered));
  });

  test('an old order with no times at all still reads as delivered', () => {
    const o = order({ status: 'DELIVERED', items: [line(A, 'DELIVERED')], deliveries: [{ sellerId: A, status: 'DELIVERED' }] });
    expect(shape(o)).toEqual(['placed:done', 'confirmed:done', 'shipped:done', 'delivered:done']);
    expect(stepOf(o, 'delivered').time).toBeNull();
  });

  test('refunded by KrushiSarva after delivery: the refund is the last step', () => {
    const o = { ...delivered, status: 'REFUNDED', paymentMethod: 'online', paymentStatus: 'refunded' };
    expect(shape(o)).toEqual(['placed:done', 'confirmed:done', 'shipped:done', 'delivered:done', 'refund:done']);
    expect(stepOf(o, 'refund').title.key).toBe('orders.refunded');
    expect(track(o).live).toBe(false);
  });

  test('a CASH order marked refunded is not told the money went back to "the account you paid from"', () => {
    const o = { ...delivered, status: 'REFUNDED', paymentMethod: 'cod', paymentStatus: 'refunded' };
    expect(shape(o)).toEqual(['placed:done', 'confirmed:done', 'shipped:done', 'delivered:done', 'refund:done']);
    expect(stepOf(o, 'refund').title).toEqual({ key: 'orders.statusRefunded', fallback: 'Refunded' });
  });

  test('marked REFUNDED with a payment status that says nothing of it: still ends on "Refunded"', () => {
    const o = { ...delivered, status: 'REFUNDED', paymentMethod: 'online', paymentStatus: 'paid' };
    expect(shape(o).slice(-1)).toEqual(['refund:done']);
    expect(stepOf(o, 'refund').title.key).toBe('orders.statusRefunded');
  });
});

describe('refunded by an admin while the lines were never moved on', () => {
  const o = order({
    status: 'REFUNDED', paymentMethod: 'online', paymentStatus: 'refunded',
    items: [line(A, 'SHIPPED', { confirmedAt: T.confirmed, shippedAt: T.shipped })],
    deliveries: [{ sellerId: A, sellerName: 'K', status: 'SHIPPED' }],
  });

  test('no "Arriving by" beside "Refunded" — nobody is keeping that promise', () => {
    expect(shape(o)).toEqual(['placed:done', 'confirmed:done', 'shipped:current', 'delivered:upcoming', 'refund:done']);
    expect(stepOf(o, 'delivered').note).toBeNull();
    expect(stepOf(o, 'delivered').tone).toBeNull();
  });

  test('it is closed: the card offers "View details", not "Track order"', () => {
    expect(track(o).live).toBe(false);
    expect(isOrderLive(o)).toBe(false);
  });

  test('…also when the promised day has passed: not "running late" either', () => {
    expect(stepOf({ ...o, expectedBy: '2026-10-01T09:00:00.000Z' }, 'delivered').note).toBeNull();
  });
});

describe('cancelled', () => {
  test('before the shop accepted: placed, then cancelled — never "Confirmed by the shop"', () => {
    const o = order({
      status: 'CANCELLED',
      items: [line(A, 'CANCELLED', { cancelledAt: T.cancelled })],
      deliveries: [{ sellerId: A, sellerName: 'K', status: 'CANCELLED' }],
    });
    expect(shape(o)).toEqual(['placed:done', 'cancelled:failed']);
    expect(stepOf(o, 'cancelled')).toMatchObject({ at: new Date(T.cancelled), tone: 'bad', note: null });
    expect(track(o).live).toBe(false);
  });

  test('after the shop accepted: the confirmed step is kept', () => {
    const o = order({
      status: 'CANCELLED',
      items: [line(A, 'CANCELLED', { confirmedAt: T.confirmed, cancelledAt: T.cancelled })],
      deliveries: [{ sellerId: A, status: 'CANCELLED' }],
    });
    expect(shape(o)).toEqual(['placed:done', 'confirmed:done', 'cancelled:failed']);
  });

  test('went out and came back: "Could not be delivered", with the shop\'s reason', () => {
    const o = order({
      status: 'CANCELLED',
      items: [line(A, 'CANCELLED', { confirmedAt: T.confirmed, shippedAt: T.shipped, cancelledAt: T.cancelled })],
      deliveries: [{ sellerId: A, status: 'CANCELLED', failedReason: 'UNREACHABLE' }],
    });
    expect(shape(o)).toEqual(['placed:done', 'confirmed:done', 'shipped:done', 'failed:failed']);
    expect(stepOf(o, 'failed')).toMatchObject({
      title: { key: 'orders.trackFailed' }, note: { key: 'orders.trackFailedUnreachable' },
    });
  });

  test('each reason has its own words; one this build does not know is a plain cancel', () => {
    const withReason = (failedReason) => order({
      status: 'CANCELLED',
      items: [line(A, 'CANCELLED', { shippedAt: T.shipped, cancelledAt: T.cancelled })],
      deliveries: [{ sellerId: A, status: 'CANCELLED', failedReason }],
    });
    expect(stepOf(withReason('REFUSED'), 'failed').note.key).toBe('orders.trackFailedRefused');
    expect(stepOf(withReason('ADDRESS_NOT_FOUND'), 'failed').note.key).toBe('orders.trackFailedAddress');
    expect(shape(withReason('SOMETHING_NEW'))).toEqual(['placed:done', 'confirmed:done', 'shipped:done', 'cancelled:failed']);
  });

  test('a cash order says nothing about a refund', () => {
    const o = order({ status: 'CANCELLED', items: [line(A, 'CANCELLED')], deliveries: [{ sellerId: A, status: 'CANCELLED' }] });
    expect(shape(o)).not.toContain('refund:current');
    expect(shape(o)).not.toContain('refund:done');
  });

  test('paid online: where the refund is comes last', () => {
    const paid = (paymentStatus) => order({
      status: 'CANCELLED', paymentMethod: 'online', paymentStatus,
      items: [line(A, 'CANCELLED', { cancelledAt: T.cancelled })],
      deliveries: [{ sellerId: A, status: 'CANCELLED' }],
    });
    expect(shape(paid('refund_pending'))).toEqual(['placed:done', 'cancelled:failed', 'refund:current']);
    expect(stepOf(paid('refund_pending'), 'refund')).toMatchObject({ title: { key: 'orders.refundPending' }, tone: 'wait' });
    expect(shape(paid('refunded'))).toEqual(['placed:done', 'cancelled:failed', 'refund:done']);
    // Paid, cancelled, and the refund not yet raised: no promise is made.
    expect(shape(paid('paid'))).toEqual(['placed:done', 'cancelled:failed']);
  });

  test('the gateway\'s own word for a refund on its way (refund_initiated) reads the same as ours', () => {
    const o = order({
      status: 'CANCELLED', paymentMethod: 'online', paymentStatus: 'refund_initiated',
      items: [line(A, 'CANCELLED', { cancelledAt: T.cancelled })],
      deliveries: [{ sellerId: A, status: 'CANCELLED' }],
    });
    expect(shape(o)).toEqual(['placed:done', 'cancelled:failed', 'refund:current']);
    expect(stepOf(o, 'refund')).toMatchObject({ title: { key: 'orders.refundPending' }, tone: 'wait' });
  });

  test('only a refund still on its way waits: one that has been made is done', () => {
    const paid = (paymentStatus) => order({
      status: 'CANCELLED', paymentMethod: 'online', paymentStatus,
      items: [line(A, 'CANCELLED', { cancelledAt: T.cancelled })],
      deliveries: [{ sellerId: A, status: 'CANCELLED' }],
    });
    const mark = (s) => { const step = stepOf(paid(s), 'refund'); return `${step.state}/${step.tone}`; };
    expect(mark('refund_pending')).toBe('current/wait');
    expect(mark('refund_initiated')).toBe('current/wait');
    expect(mark('partially_refunded')).toBe('done/good');
    expect(mark('refunded')).toBe('done/good');
  });
});

describe('an order from two shops', () => {
  const two = order({
    status: 'SHIPPED', paymentMethod: 'online', paymentStatus: 'partially_refunded',
    items: [
      line(A, 'SHIPPED', { confirmedAt: T.confirmed, shippedAt: T.shipped }),
      line(B, 'CANCELLED', { cancelledAt: T.cancelled }),
    ],
    deliveries: [
      { sellerId: A, sellerName: 'Krushna Krishi Bhandar', status: 'SHIPPED' },
      { sellerId: B, sellerName: 'Shree Agro Center', status: 'CANCELLED' },
    ],
  });

  test('is two timelines, each telling its own story', () => {
    const t = track(two);
    expect(t.single).toBe(false);
    expect(t.shipments.map((s) => s.name)).toEqual(['Krushna Krishi Bhandar', 'Shree Agro Center']);
    expect(shape(two, 0)).toEqual(['placed:done', 'confirmed:done', 'shipped:current', 'delivered:upcoming']);
    // 'partially_refunded' is the settled state — the refund for B's part has
    // been MADE — so the step is done (a tick), not waiting (a clock).
    expect(shape(two, 1)).toEqual(['placed:done', 'cancelled:failed', 'refund:done']);
    expect(stepOf(two, 'refund', 1)).toMatchObject({ title: { key: 'orders.partiallyRefunded' }, tone: 'good' });
    expect(t.live).toBe(true);
  });

  test('the refund is mentioned only under the shop whose part was cancelled', () => {
    expect(shape(two, 0).some((s) => s.startsWith('refund'))).toBe(false);
  });

  test('each timeline uses its OWN shop\'s times', () => {
    expect(stepOf(two, 'shipped', 0).at).toEqual(new Date(T.shipped));
    expect(stepOf(two, 'cancelled', 1).at).toEqual(new Date(T.cancelled));
  });

  test('a shop with one line cancelled and one still coming says so', () => {
    const o = order({
      status: 'CONFIRMED',
      items: [line(A, 'CONFIRMED', { confirmedAt: T.confirmed }), line(A, 'CANCELLED', { cancelledAt: T.cancelled })],
      deliveries: [{ sellerId: A, sellerName: 'K', status: 'CONFIRMED' }],
    });
    expect(track(o).shipments[0].partCancelled).toBe(true);
    expect(shape(o)).toEqual(['placed:done', 'confirmed:current', 'shipped:upcoming', 'delivered:upcoming']);
  });
});

describe('what an older server sends', () => {
  test('no `deliveries`: the lines are grouped by their shop', () => {
    const o = order({
      status: 'SHIPPED', deliveries: undefined,
      items: [
        line(A, 'SHIPPED', { shippedAt: T.shipped, sellerName: 'Krushna Krishi Bhandar' }),
        line(B, 'PENDING', { sellerName: 'Shree Agro Center' }),
      ],
    });
    const t = track(o);
    expect(t.shipments.map((s) => [s.name, s.status])).toEqual([
      ['Krushna Krishi Bhandar', 'SHIPPED'], ['Shree Agro Center', 'PENDING'],
    ]);
  });

  test('lines that name no shop: the whole order is one delivery, read off its status', () => {
    const o = order({ status: 'CONFIRMED', deliveries: undefined, items: [{ id: 'x', status: 'CONFIRMED' }] });
    expect(track(o).single).toBe(true);
    expect(shape(o)).toEqual(['placed:done', 'confirmed:current', 'shipped:upcoming', 'delivered:upcoming']);
  });

  test('a status this build does not know: placed, then the status in readable words', () => {
    const o = order({ status: 'RETURN_REQUESTED', deliveries: undefined, items: [] });
    const steps = track(o).shipments[0].steps;
    expect(steps.map((s) => `${s.id}:${s.state}`)).toEqual(['placed:done', 'status:current']);
    expect(steps[1].title).toEqual({ key: null, fallback: 'Return requested' });
  });

  test('an old order with no shop on its lines, delivered and then refunded: the delivery is not lost', () => {
    // The server lists no deliveries for lines without a shop, so the order's
    // own status is all there is — and REFUNDED says where the money went, not
    // how far the goods got.
    const o = order({
      status: 'REFUNDED', paymentMethod: 'online', paymentStatus: 'refunded', deliveries: [],
      items: [{ id: 'x', status: 'DELIVERED', deliveredAt: T.delivered }],
    });
    expect(shape(o)).toEqual(['placed:done', 'confirmed:done', 'shipped:done', 'delivered:done', 'refund:done']);
    expect(stepOf(o, 'delivered').at).toEqual(new Date(T.delivered));
    // Translated — not the English word "Refunded" made out of the status code.
    expect(stepOf(o, 'refund').title.key).toBe('orders.refunded');
    expect(track(o).live).toBe(false);
  });

  test('refunded, with no lines at all to read: placed, then refunded — in the farmer\'s language', () => {
    const o = order({ status: 'REFUNDED', paymentMethod: 'online', paymentStatus: 'refunded', deliveries: undefined, items: [] });
    expect(shape(o)).toEqual(['placed:done', 'refund:done']);
    expect(stepOf(o, 'refund').title.key).toBe('orders.refunded');
  });

  test('junk in, no throw', () => {
    expect(orderTracking(null)).toEqual({ single: true, live: false, shipments: [] });
    expect(() => orderTracking({ items: 'nope', deliveries: [null, 'x', 4] })).not.toThrow();
    expect(() => orderTracking({ createdAt: 'not a date', items: [{ status: 'SHIPPED', sellerId: A, shippedAt: 'bad' }] })).not.toThrow();
  });
});

describe('isOrderLive — the cheap question a closed card asks', () => {
  const cases = {
    'just placed': order(),
    'out for delivery': order({ status: 'SHIPPED', items: [line(A, 'SHIPPED')], deliveries: [{ sellerId: A, status: 'SHIPPED' }] }),
    delivered: order({ status: 'DELIVERED', items: [line(A, 'DELIVERED')], deliveries: [{ sellerId: A, status: 'DELIVERED' }] }),
    cancelled: order({ status: 'CANCELLED', items: [line(A, 'CANCELLED')], deliveries: [{ sellerId: A, status: 'CANCELLED' }] }),
    'one shop done, one still coming': order({
      status: 'CONFIRMED', items: [line(A, 'DELIVERED'), line(B, 'CONFIRMED')],
      deliveries: [{ sellerId: A, status: 'DELIVERED' }, { sellerId: B, status: 'CONFIRMED' }],
    }),
    'older server, lines grouped by shop': order({ status: 'SHIPPED', deliveries: undefined, items: [line(A, 'DELIVERED'), line(B, 'SHIPPED')] }),
    'older server, all delivered': order({ status: 'DELIVERED', deliveries: undefined, items: [line(A, 'DELIVERED')] }),
    'no shop on the lines': order({ status: 'CONFIRMED', deliveries: undefined, items: [{ id: 'x', status: 'CONFIRMED' }] }),
    'no lines at all': order({ status: 'PENDING', deliveries: undefined, items: [] }),
    'unknown status': order({ status: 'RETURN_REQUESTED', deliveries: undefined, items: [] }),
    'junk deliveries': order({ status: 'DELIVERED', deliveries: [null, 'x'], items: [line(A, 'DELIVERED')] }),
    'refunded with lines still open': order({ status: 'REFUNDED', paymentStatus: 'refunded', items: [line(A, 'SHIPPED')], deliveries: [{ sellerId: A, status: 'SHIPPED' }] }),
    'refunded, older server': order({ status: 'REFUNDED', deliveries: undefined, items: [line(A, 'CONFIRMED')] }),
    'refunded, no shop on the lines': order({ status: 'REFUNDED', deliveries: [], items: [{ id: 'x', status: 'DELIVERED' }] }),
    'no status, no shop on the lines': order({ status: undefined, deliveries: undefined, items: [{ id: 'x', status: 'SHIPPED' }] }),
  };

  test.each(Object.entries(cases))('%s: the same answer as the full timeline', (name, o) => {
    expect(isOrderLive(o)).toBe(track(o).live);
  });

  test('live while anything is still coming, not after', () => {
    expect(isOrderLive(cases['just placed'])).toBe(true);
    expect(isOrderLive(cases['one shop done, one still coming'])).toBe(true);
    expect(isOrderLive(cases.delivered)).toBe(false);
    expect(isOrderLive(cases.cancelled)).toBe(false);
    expect(isOrderLive(null)).toBe(false);
  });
});

describe('the time beside a step', () => {
  test('day, short month and the time', () => {
    expect(formatTrackTime('2026-10-12T09:00:00.000Z')).toMatch(/1[23] Oct.*\d{1,2}:\d{2}/);
  });

  test('nothing for a time that was never recorded', () => {
    expect(formatTrackTime(null)).toBeNull();
    expect(formatTrackTime('')).toBeNull();
    expect(formatTrackTime('not a date')).toBeNull();
  });
});
