/**
 * The purpose-agnostic payment core (PAY-001).
 *
 * `PaymentIntent` now serves every product area, which means two things the
 * AgriStore-only version never had to be careful about:
 *
 *   1. The money arrives in different shapes. AgriStore holds a quote in rupees;
 *      an AI credit pack is priced in paise. `createIntent` accepts either and
 *      derives the other — so the one thing it must never do is accept BOTH and
 *      believe them separately. A row that says ₹49 while the gateway charged
 *      ₹4,900 is the worst shape a payments bug can take, and it is silent.
 *
 *   2. `purpose` decides which handler settles the payment. A typo'd or unknown
 *      purpose must fail loudly at the point of writing, not later, when a
 *      webhook arrives and no handler claims it.
 *
 * Prisma is mocked: these are properties of the function, not of the database,
 * and they should be provable without one.
 */
import { jest } from '@jest/globals';

const created = [];

jest.unstable_mockModule('../../../src/config/db.js', () => ({
  default: {
    paymentIntent: {
      create: jest.fn(async ({ data }) => {
        created.push(data);
        return { id: 'pi_test', ...data };
      }),
    },
  },
}));

const {
  createIntent, receiptFor, webhookEventId, PAYMENT_PURPOSE, TERMINAL, SETTLED,
} = await import('../../../src/services/paymentIntent.service.js');

const base = { userId: 'u_1', providerOrderId: 'order_1', receipt: 'rcpt_1' };

beforeEach(() => { created.length = 0; });

describe('createIntent — the amount is one number in two representations', () => {
  test('rupees in, paise derived', async () => {
    await createIntent({ ...base, amount: '449.00' });
    expect(created[0]).toMatchObject({ amount: '449.00', amountPaise: 44900 });
  });

  test('paise in, rupees derived — a pack priced in paise needs no conversion at the call site', async () => {
    await createIntent({ ...base, amountPaise: 4900 });
    expect(created[0]).toMatchObject({ amount: '49.00', amountPaise: 4900 });
  });

  test('both, agreeing, is accepted', async () => {
    await createIntent({ ...base, amount: 199, amountPaise: 19900 });
    expect(created[0]).toMatchObject({ amount: '199.00', amountPaise: 19900 });
  });

  test('both, DISAGREEING, throws and writes nothing', async () => {
    // The ₹49 pack sent with the ₹499 pack's paise. Picking either one silently
    // would mean the row and the gateway disagree about what was charged.
    await expect(createIntent({ ...base, amount: '49.00', amountPaise: 49900 }))
      .rejects.toMatchObject({ code: 'BAD_AMOUNT' });
    expect(created).toHaveLength(0);
  });

  test.each([
    ['zero', 0],
    ['negative', -100],
    ['fractional paise', 4900.5],
  ])('%s paise is refused', async (_label, amountPaise) => {
    await expect(createIntent({ ...base, amountPaise }))
      .rejects.toMatchObject({ code: 'BAD_AMOUNT' });
    expect(created).toHaveLength(0);
  });

  test('no amount at all is refused', async () => {
    await expect(createIntent({ ...base })).rejects.toMatchObject({ code: 'BAD_AMOUNT' });
  });
});

describe('createIntent — purpose', () => {
  test('defaults to SHOP_ORDER, matching the column default every historical row carries', async () => {
    await createIntent({ ...base, amount: '10.00' });
    expect(created[0].purpose).toBe('SHOP_ORDER');
  });

  test('an unknown purpose throws rather than reaching the database', async () => {
    await expect(createIntent({ ...base, amount: '10.00', purpose: 'RENT_BOOKINGS' }))
      .rejects.toMatchObject({ code: 'BAD_PURPOSE' });
    expect(created).toHaveLength(0);
  });

  test('a ref pair is stored so "has this booking been paid for" is answerable', async () => {
    await createIntent({
      ...base, amount: '10.00',
      purpose: PAYMENT_PURPOSE.RENT_BOOKING, refType: 'booking', refId: 'bk_9',
    });
    expect(created[0]).toMatchObject({ purpose: 'RENT_BOOKING', refType: 'booking', refId: 'bk_9' });
  });

  test('the JS purpose list and the Prisma enum agree', () => {
    // Drift here is invisible until a write fails in production, because Prisma
    // only rejects an unknown enum value at the database.
    expect(Object.values(PAYMENT_PURPOSE).sort())
      .toEqual(['AI_CREDITS', 'ANIMAL_TOKEN', 'RENT_BOOKING', 'SHOP_ORDER']);
  });
});

describe('the state-machine vocabulary travels with the state machine', () => {
  test('SETTLED is the set no late "paid" may regress', () => {
    expect(SETTLED).toEqual(['ORDER_CREATED', 'REFUND_INITIATED', 'REFUNDED']);
  });

  test('TERMINAL is what the reconciler does not revisit', () => {
    expect([...TERMINAL].sort())
      .toEqual(['CANCELLED', 'EXPIRED', 'FAILED', 'ORDER_CREATED', 'REFUNDED']);
  });
});

describe('receiptFor', () => {
  test('is unique per call — the old `cart_<userId>` proved only whose payment it was, not which', () => {
    const a = receiptFor('11111111-2222-3333-4444-555555555555');
    const b = receiptFor('11111111-2222-3333-4444-555555555555');
    expect(a).not.toBe(b);
    expect(a.startsWith('cs_11111111_')).toBe(true);
  });
});

describe('webhookEventId', () => {
  test('a refund event is identified by the refund, not the payment it refunds', () => {
    // Otherwise `refund.processed` for pay_X would collide with an earlier
    // `payment.captured` claim for the same payment and be dropped as a replay.
    expect(webhookEventId({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_1' } }, payment: { entity: { id: 'pay_1' } } },
    })).toBe('refund.processed:rfnd_1');
  });

  test('a capture is identified by the payment', () => {
    expect(webhookEventId({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1' } } },
    })).toBe('payment.captured:pay_1');
  });

  test('an order-only event falls back to the order', () => {
    expect(webhookEventId({
      event: 'order.paid', payload: { order: { entity: { id: 'order_1' } } },
    })).toBe('order.paid:order_1');
  });

  test('an event identifying nothing gets a unique id, so it is never treated as a replay of another', () => {
    const a = webhookEventId({ event: 'weird.thing', payload: {} });
    const b = webhookEventId({ event: 'weird.thing', payload: {} });
    expect(a).not.toBe(b);
  });
});
