/**
 * deliveryBreakdownLines — the lines printed under "Delivery charges".
 *
 * The cart showed one figure, and a shop's extra charge for a far village was
 * folded into it unannounced. These pin when the split is shown (only when
 * there is something to explain), what it says, and that an older backend or an
 * older order — which sends no split — leaves the screen exactly as it was.
 */
import { deliveryBreakdownLines } from '../shopUtils';

const quote = (deliveryBreakdown, shipments = [{ freeDeliveryApplied: false }]) => ({ deliveryBreakdown, shipments });
const ids = (lines) => lines.map((l) => l.id);

describe('nothing to explain → no lines', () => {
  test('only the standard fee: the one "Delivery charges" row already says it', () => {
    expect(deliveryBreakdownLines(quote({ base: '49.00', heavy: '0.00', area: '0.00', cod: '0.00' }))).toEqual([]);
  });

  test('a free delivery with no extras', () => {
    expect(deliveryBreakdownLines(quote({ base: '0.00', heavy: '0.00', area: '0.00', cod: '0.00' }, [{ freeDeliveryApplied: true }]))).toEqual([]);
  });

  test('an older backend, or an order placed before the split was recorded', () => {
    expect(deliveryBreakdownLines({ deliveryFee: '69.00', shipments: [] })).toEqual([]);
    expect(deliveryBreakdownLines({ deliveryBreakdown: null })).toEqual([]);
    expect(deliveryBreakdownLines({ deliveryBreakdown: [] })).toEqual([]);
    expect(deliveryBreakdownLines({ deliveryBreakdown: 'x' })).toEqual([]);
    expect(deliveryBreakdownLines(null)).toEqual([]);
    expect(deliveryBreakdownLines(undefined)).toEqual([]);
  });
});

describe('a shop\'s extra charge for the area', () => {
  test('₹49 standard + ₹20 for the area: both lines, in that order', () => {
    const lines = deliveryBreakdownLines(quote({ base: '49.00', heavy: '0.00', area: '20.00', cod: '0.00' }));
    expect(lines).toEqual([
      { id: 'base', key: 'cart.deliveryStandard', fallback: 'Standard delivery', amount: 49, free: false },
      { id: 'area', key: 'cart.deliveryArea', fallback: 'Extra charge for your area', amount: 20, free: false },
    ]);
    // The lines add up to the delivery charge the server sent.
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(69);
  });

  test('free delivery plus an area charge: the standard line says FREE, so ₹20 is not a contradiction', () => {
    const lines = deliveryBreakdownLines(quote({ base: '0.00', heavy: '0.00', area: '20.00', cod: '0.00' }, [{ freeDeliveryApplied: true }]));
    expect(lines).toEqual([
      { id: 'base', key: 'cart.deliveryStandard', fallback: 'Standard delivery', amount: 0, free: true },
      { id: 'area', key: 'cart.deliveryArea', fallback: 'Extra charge for your area', amount: 20, free: false },
    ]);
  });

  test('no standard fee and no free delivery (a heavy-only delivery): no standard line is invented', () => {
    const lines = deliveryBreakdownLines(quote({ base: '0.00', heavy: '250.00', area: '20.00', cod: '0.00' }));
    expect(ids(lines)).toEqual(['area', 'heavy']);
  });
});

describe('the other parts', () => {
  test('heavy-item handling and a cash-on-delivery fee each get their own line', () => {
    const lines = deliveryBreakdownLines(quote({ base: '49.00', heavy: '250.00', area: '0.00', cod: '15.00' }));
    expect(ids(lines)).toEqual(['base', 'heavy', 'cod']);
    expect(lines.find((l) => l.id === 'heavy')).toMatchObject({ key: 'cart.deliveryHeavy', amount: 250 });
    expect(lines.find((l) => l.id === 'cod')).toMatchObject({ key: 'cart.deliveryCod', amount: 15 });
  });

  test('all four, in a fixed order', () => {
    const lines = deliveryBreakdownLines(quote({ base: '98.00', heavy: '250.00', area: '20.00', cod: '15.00' }));
    expect(ids(lines)).toEqual(['base', 'area', 'heavy', 'cod']);
  });
});

describe('what the server sends is read safely', () => {
  test('numbers and numeric strings are both accepted', () => {
    const lines = deliveryBreakdownLines(quote({ base: 49, heavy: 0, area: 20.5, cod: '0' }));
    expect(lines.map((l) => l.amount)).toEqual([49, 20.5]);
  });

  test('junk, negatives and blanks count as nothing — never as NaN on screen', () => {
    expect(deliveryBreakdownLines(quote({ base: '49.00', heavy: 'abc', area: -5, cod: '' }))).toEqual([]);
    const lines = deliveryBreakdownLines(quote({ base: 'abc', heavy: null, area: '20.00', cod: undefined }));
    expect(lines).toEqual([
      { id: 'area', key: 'cart.deliveryArea', fallback: 'Extra charge for your area', amount: 20, free: false },
    ]);
  });

  test('works on an order\'s frozen pricingSnapshot, which has the same shape', () => {
    const snapshot = {
      version: 1,
      deliveryBreakdown: { base: '49.00', heavy: '0.00', area: '20.00', cod: '0.00' },
      shipments: [{ sellerId: 's1', deliveryFee: '69.00', freeDeliveryApplied: false }],
    };
    expect(ids(deliveryBreakdownLines(snapshot))).toEqual(['base', 'area']);
  });

  test('a missing shipments list does not throw', () => {
    expect(ids(deliveryBreakdownLines({ deliveryBreakdown: { base: '0', area: '20' } }))).toEqual(['area']);
  });
});
