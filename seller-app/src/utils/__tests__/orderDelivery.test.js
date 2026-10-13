import {
  FAILED_REASONS, NO_CODE_REASONS, afterMoveSucceeded, buildStatusPayload, cancelAction,
  cleanDeliveryCode, clockTime, deliveryInfo, deliveryRefusal, isCompleteCode,
  isStaleStatusRefusal, lockEndsAt, lockedText, noCodeReasonOptions, patchDelivery,
  refusalText, statusPrompt,
} from '../orderDelivery';
import { moveSellerLines } from '../sellerOrders';

// LanguageContext's t(), for keys that are not translated yet.
const t = (key, arg) => {
  if (typeof arg === 'string') return arg;
  const template = arg?.defaultValue ?? key;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(arg?.[k] ?? ''));
};

const row = (id, orderId, status, delivery) => ({
  id, status, order: { id: orderId, status: 'CONFIRMED', ...(delivery === undefined ? {} : { delivery }) },
});

// The house error envelope: { success:false, error:{ message, details } }.
const refused = (details, status = 409, message = 'Refused.') => ({
  response: { status, data: { success: false, error: { message, details } } },
});

const HAS_CODE = { hasCode: true, codeRequired: false, lockedUntil: null };
const NO_CODE_REQUIRED = { hasCode: false, codeRequired: true, lockedUntil: null };
const NO_CODE_OPTIONAL = { hasCode: false, codeRequired: false, lockedUntil: null };

describe('deliveryInfo', () => {
  test('null on an older backend that sends no delivery', () => {
    expect(deliveryInfo(row('a', 'o1', 'SHIPPED'))).toBeNull();
    expect(deliveryInfo(row('a', 'o1', 'SHIPPED', null))).toBeNull();
    expect(deliveryInfo({})).toBeNull();
    expect(deliveryInfo(null)).toBeNull();
  });

  test('reads only real booleans and a real time', () => {
    expect(deliveryInfo(row('a', 'o1', 'SHIPPED', { hasCode: true, codeRequired: true, lockedUntil: '2026-10-13T10:15:00.000Z' })))
      .toEqual({ hasCode: true, codeRequired: true, lockedUntil: '2026-10-13T10:15:00.000Z' });
    // A partial or sloppy object never switches the code flow on by accident.
    expect(deliveryInfo(row('a', 'o1', 'SHIPPED', { hasCode: 'yes', lockedUntil: 'soon' })))
      .toEqual({ hasCode: false, codeRequired: false, lockedUntil: null });
    expect(deliveryInfo(row('a', 'o1', 'SHIPPED', {}))).toEqual({ hasCode: false, codeRequired: false, lockedUntil: null });
  });
});

describe('statusPrompt — what to ask before a move', () => {
  test('marking delivered on an older backend is one confirm, as before', () => {
    expect(statusPrompt('SHIPPED', 'DELIVERED', null)).toBe('confirm');
  });

  test('a code exists: ask for it, demanded or not', () => {
    expect(statusPrompt('SHIPPED', 'DELIVERED', HAS_CODE)).toBe('code');
    expect(statusPrompt('SHIPPED', 'DELIVERED', { ...HAS_CODE, codeRequired: true })).toBe('code');
  });

  test('no code but one is demanded: ask why (handed over at the shop)', () => {
    expect(statusPrompt('SHIPPED', 'DELIVERED', NO_CODE_REQUIRED)).toBe('noCodeReason');
    expect(statusPrompt('PENDING', 'DELIVERED', NO_CODE_REQUIRED)).toBe('noCodeReason');
  });

  test('no code and none demanded: one confirm, as before', () => {
    expect(statusPrompt('SHIPPED', 'DELIVERED', NO_CODE_OPTIONAL)).toBe('confirm');
  });

  test('the steps before delivery never ask for anything new', () => {
    for (const d of [null, HAS_CODE, NO_CODE_REQUIRED]) {
      expect(statusPrompt('PENDING', 'CONFIRMED', d)).toBe('confirm');
      expect(statusPrompt('CONFIRMED', 'SHIPPED', d)).toBe('confirm');
    }
  });

  test('cancel before shipping is the plain confirm; after shipping it needs a reason', () => {
    expect(statusPrompt('PENDING', 'CANCELLED', HAS_CODE)).toBe('confirm');
    expect(statusPrompt('CONFIRMED', 'CANCELLED', HAS_CODE)).toBe('confirm');
    expect(statusPrompt('SHIPPED', 'CANCELLED', HAS_CODE)).toBe('failedReason');
    expect(statusPrompt('SHIPPED', 'CANCELLED', NO_CODE_OPTIONAL)).toBe('failedReason');
  });
});

describe('cancelAction — the way out a card offers', () => {
  test('"Cancel order" before the goods leave, on any backend', () => {
    for (const d of [null, HAS_CODE]) {
      expect(cancelAction('PENDING', d)).toBe('cancel');
      expect(cancelAction('CONFIRMED', d)).toBe('cancel');
    }
  });

  test('"Could not deliver" once shipped — only where the backend can take it', () => {
    expect(cancelAction('SHIPPED', HAS_CODE)).toBe('undelivered');
    expect(cancelAction('SHIPPED', NO_CODE_OPTIONAL)).toBe('undelivered');
    // Older backend: a shipped order cannot be cancelled, so nothing is offered.
    expect(cancelAction('SHIPPED', null)).toBeNull();
  });

  test('nothing on a finished order', () => {
    for (const status of ['DELIVERED', 'CANCELLED', 'REFUNDED', null]) {
      expect(cancelAction(status, HAS_CODE)).toBeNull();
    }
  });
});

describe('noCodeReasonOptions', () => {
  test('always the four values the route accepts, likeliest first', () => {
    expect(noCodeReasonOptions(true)[0]).toBe('FARMER_PHONE_OFF');
    expect(noCodeReasonOptions(false)[0]).toBe('HANDED_AT_SHOP');
    for (const hasCode of [true, false]) {
      expect([...noCodeReasonOptions(hasCode)].sort()).toEqual([...NO_CODE_REASONS].sort());
    }
  });
});

describe('the code field', () => {
  test('keeps four digits of whatever was typed or pasted', () => {
    expect(cleanDeliveryCode('12 34')).toBe('1234');
    expect(cleanDeliveryCode('12345')).toBe('1234');
    expect(cleanDeliveryCode('a1b2')).toBe('12');
    expect(cleanDeliveryCode(null)).toBe('');
  });

  test('a code is complete at exactly four digits — leading zeros count', () => {
    expect(isCompleteCode('0007')).toBe(true);
    expect(isCompleteCode('123')).toBe(false);
    expect(isCompleteCode('12345')).toBe(false);
    expect(isCompleteCode(1234)).toBe(false);
    expect(isCompleteCode('')).toBe(false);
  });
});

describe('buildStatusPayload', () => {
  test('the steps before delivery send the status alone', () => {
    expect(buildStatusPayload('CONFIRMED')).toEqual({ status: 'CONFIRMED' });
    expect(buildStatusPayload('SHIPPED', { deliveryCode: '1234', failedReason: 'REFUSED' })).toEqual({ status: 'SHIPPED' });
  });

  test('delivered with the code sends it as a 4-digit STRING', () => {
    expect(buildStatusPayload('DELIVERED', { deliveryCode: '0420' })).toEqual({ status: 'DELIVERED', deliveryCode: '0420' });
  });

  test('delivered without the code sends the reason instead', () => {
    expect(buildStatusPayload('DELIVERED', { noCodeReason: 'HANDED_AT_SHOP' }))
      .toEqual({ status: 'DELIVERED', noCodeReason: 'HANDED_AT_SHOP' });
  });

  test('never both: a reason beside a code would be judged as a code attempt', () => {
    expect(buildStatusPayload('DELIVERED', { deliveryCode: '1234', noCodeReason: 'OTHER' }))
      .toEqual({ status: 'DELIVERED', deliveryCode: '1234' });
  });

  test('delivered with nothing to add is the request an older app sends', () => {
    expect(buildStatusPayload('DELIVERED')).toEqual({ status: 'DELIVERED' });
    expect(buildStatusPayload('DELIVERED', {})).toEqual({ status: 'DELIVERED' });
    expect(buildStatusPayload('DELIVERED', null)).toEqual({ status: 'DELIVERED' });
  });

  test('a half-typed code or an unknown reason is dropped, not sent to earn a 400', () => {
    expect(buildStatusPayload('DELIVERED', { deliveryCode: '12' })).toEqual({ status: 'DELIVERED' });
    expect(buildStatusPayload('DELIVERED', { noCodeReason: 'BECAUSE' })).toEqual({ status: 'DELIVERED' });
    expect(buildStatusPayload('CANCELLED', { failedReason: 'BECAUSE' })).toEqual({ status: 'CANCELLED' });
  });

  test('could not deliver sends its reason; a plain cancel sends none', () => {
    expect(buildStatusPayload('CANCELLED', { failedReason: 'REFUSED' })).toEqual({ status: 'CANCELLED', failedReason: 'REFUSED' });
    expect(buildStatusPayload('CANCELLED')).toEqual({ status: 'CANCELLED' });
    // A reason for one status never rides along on another.
    expect(buildStatusPayload('CANCELLED', { noCodeReason: 'OTHER', deliveryCode: '1234' })).toEqual({ status: 'CANCELLED' });
    expect(buildStatusPayload('DELIVERED', { failedReason: 'REFUSED' })).toEqual({ status: 'DELIVERED' });
  });

  test('every value the contract lists is accepted', () => {
    for (const r of NO_CODE_REASONS) expect(buildStatusPayload('DELIVERED', { noCodeReason: r }).noCodeReason).toBe(r);
    for (const r of FAILED_REASONS) expect(buildStatusPayload('CANCELLED', { failedReason: r }).failedReason).toBe(r);
    expect(NO_CODE_REASONS).toEqual(['FARMER_PHONE_OFF', 'RECEIVED_BY_OTHER', 'HANDED_AT_SHOP', 'OTHER']);
    expect(FAILED_REASONS).toEqual(['REFUSED', 'UNREACHABLE', 'ADDRESS_NOT_FOUND']);
  });
});

describe('deliveryRefusal', () => {
  test('reads the machine code from error.details.code', () => {
    expect(deliveryRefusal(refused({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 3 })))
      .toEqual({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 3, lockedUntil: null });
    expect(deliveryRefusal(refused({ code: 'DELIVERY_CODE_LOCKED', lockedUntil: '2026-10-13T10:15:00.000Z' })))
      .toEqual({ code: 'DELIVERY_CODE_LOCKED', attemptsLeft: null, lockedUntil: '2026-10-13T10:15:00.000Z' });
    expect(deliveryRefusal(refused({ code: 'DELIVERY_CODE_REQUIRED' })))
      .toEqual({ code: 'DELIVERY_CODE_REQUIRED', attemptsLeft: null, lockedUntil: null });
    expect(deliveryRefusal(refused({ code: 'FAILED_REASON_REQUIRED' })).code).toBe('FAILED_REASON_REQUIRED');
  });

  test('the last wrong try may carry the lock it started', () => {
    expect(deliveryRefusal(refused({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 0, lockedUntil: '2026-10-13T10:15:00.000Z' })))
      .toEqual({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 0, lockedUntil: '2026-10-13T10:15:00.000Z' });
  });

  test('junk in the extra fields is not shown to the seller', () => {
    expect(deliveryRefusal(refused({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 'few' })).attemptsLeft).toBeNull();
    expect(deliveryRefusal(refused({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: -2 })).attemptsLeft).toBe(0);
    expect(deliveryRefusal(refused({ code: 'DELIVERY_CODE_LOCKED', lockedUntil: 'soon' })).lockedUntil).toBeNull();
  });

  test('null for everything that is not one of the four', () => {
    // The existing "already shipped" refusal keeps its own details.
    expect(deliveryRefusal(refused({ from: ['SHIPPED'] }))).toBeNull();
    expect(deliveryRefusal(refused({ code: 'KYC_REQUIRED' }, 403))).toBeNull();
    expect(deliveryRefusal(refused({ code: 'DELIVERY_CODE_WRONG' }, 500))).toBeNull();
    expect(deliveryRefusal({ message: 'Network Error' })).toBeNull();
    expect(deliveryRefusal({ response: { status: 409, data: null } })).toBeNull();
    expect(deliveryRefusal(null)).toBeNull();
  });
});

describe('isStaleStatusRefusal', () => {
  test('only the "already X" refusal means the card is out of date', () => {
    expect(isStaleStatusRefusal(refused({ from: ['SHIPPED'] }))).toBe(true);
    expect(isStaleStatusRefusal(refused({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 2 }))).toBe(false);
    expect(isStaleStatusRefusal(refused({ from: ['SHIPPED'] }, 500))).toBe(false);
    expect(isStaleStatusRefusal({ message: 'Network Error' })).toBe(false);
  });
});

describe('the lock', () => {
  const now = new Date(2026, 9, 13, 15, 30).getTime();
  const later = new Date(2026, 9, 13, 15, 45).toISOString();
  const earlier = new Date(2026, 9, 13, 15, 0).toISOString();

  test('lockEndsAt is the end time only while it is still ahead', () => {
    expect(lockEndsAt(later, now)).toBe(Date.parse(later));
    expect(lockEndsAt(earlier, now)).toBeNull();
    expect(lockEndsAt(null, now)).toBeNull();
    expect(lockEndsAt('soon', now)).toBeNull();
  });

  test('clockTime reads as a 12-hour clock', () => {
    expect(clockTime(new Date(2026, 9, 13, 15, 45).getTime())).toBe('3:45 PM');
    expect(clockTime(new Date(2026, 9, 13, 9, 5).getTime())).toBe('9:05 AM');
    expect(clockTime(new Date(2026, 9, 13, 0, 0).getTime())).toBe('12:00 AM');
    expect(clockTime(new Date(2026, 9, 13, 12, 30).getTime())).toBe('12:30 PM');
  });

  test('lockedText says until when, or just "later" when it cannot', () => {
    expect(lockedText(later, t, now)).toBe('Too many wrong codes. You can try the code again after 3:45 PM.');
    expect(lockedText(earlier, t, now)).toBe('Too many wrong codes. Try the code again later.');
    expect(lockedText(null, t, now)).toBe('Too many wrong codes. Try the code again later.');
  });
});

describe('refusalText', () => {
  const now = new Date(2026, 9, 13, 15, 30).getTime();
  const text = (details) => refusalText(deliveryRefusal(refused(details)), t, now);

  test('a wrong code says how many tries are left', () => {
    expect(text({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 4 })).toBe('Wrong code. 4 tries left.');
    expect(text({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 1 })).toBe('Wrong code. 1 try left.');
    expect(text({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 0 })).toBe('Wrong code. No tries are left for now.');
    expect(text({ code: 'DELIVERY_CODE_WRONG' })).toBe('Wrong code. Check it with the farmer and try again.');
  });

  test('a lock says until when', () => {
    expect(text({ code: 'DELIVERY_CODE_LOCKED', lockedUntil: new Date(2026, 9, 13, 15, 45).toISOString() }))
      .toBe('Too many wrong codes. You can try the code again after 3:45 PM.');
  });

  test('the two "something is missing" refusals say what', () => {
    expect(text({ code: 'DELIVERY_CODE_REQUIRED' })).toMatch(/delivery code/);
    expect(text({ code: 'FAILED_REASON_REQUIRED' })).toMatch(/could not be delivered/);
  });

  test('null when it was not a delivery refusal, so the caller falls back', () => {
    expect(refusalText(null, t, now)).toBeNull();
    expect(refusalText(deliveryRefusal(refused({ from: ['SHIPPED'] })), t, now)).toBeNull();
  });
});

describe('patchDelivery / afterMoveSucceeded', () => {
  test('marking out for delivery issues the code, so the next tap asks for it', () => {
    const rows = [row('a', 'o1', 'SHIPPED', NO_CODE_OPTIONAL), row('b', 'o1', 'SHIPPED', NO_CODE_OPTIONAL), row('c', 'o2', 'PENDING', NO_CODE_OPTIONAL)];
    const next = afterMoveSucceeded(rows, 'o1', 'SHIPPED');
    expect(deliveryInfo(next[0]).hasCode).toBe(true);
    expect(deliveryInfo(next[1]).hasCode).toBe(true);
    expect(statusPrompt('SHIPPED', 'DELIVERED', deliveryInfo(next[0]))).toBe('code');
    // Another order's card is not touched, and does not re-render.
    expect(next[2]).toBe(rows[2]);
  });

  test('no other move changes delivery', () => {
    const rows = [row('a', 'o1', 'CONFIRMED', NO_CODE_OPTIONAL)];
    for (const to of ['CONFIRMED', 'DELIVERED', 'CANCELLED']) expect(afterMoveSucceeded(rows, 'o1', to)).toBe(rows);
  });

  test('an older backend\'s rows are never given a delivery they did not send', () => {
    const rows = [row('a', 'o1', 'SHIPPED')];
    const next = afterMoveSucceeded(rows, 'o1', 'SHIPPED');
    expect(next[0]).toBe(rows[0]);
    expect(deliveryInfo(next[0])).toBeNull();
    expect(statusPrompt('SHIPPED', 'DELIVERED', deliveryInfo(next[0]))).toBe('confirm');
  });

  test('a lock from a refusal lands on every line of that order', () => {
    const lockedUntil = '2026-10-13T10:15:00.000Z';
    const rows = [row('a', 'o1', 'SHIPPED', HAS_CODE), row('b', 'o2', 'SHIPPED', HAS_CODE)];
    const next = patchDelivery(rows, 'o1', { lockedUntil });
    expect(deliveryInfo(next[0])).toEqual({ ...HAS_CODE, lockedUntil });
    expect(next[0].status).toBe('SHIPPED');
    expect(next[1]).toBe(rows[1]);
  });
});

describe('a whole delivery, as the screen walks it', () => {
  test('could not deliver: shipped lines are cancelled, and only with the reason', () => {
    const rows = [row('a', 'o1', 'SHIPPED', HAS_CODE), row('b', 'o1', 'CANCELLED', HAS_CODE)];
    const sent = { failedReason: 'REFUSED' };
    expect(statusPrompt('SHIPPED', 'CANCELLED', deliveryInfo(rows[0]))).toBe('failedReason');
    expect(buildStatusPayload('CANCELLED', sent)).toEqual({ status: 'CANCELLED', failedReason: 'REFUSED' });
    expect(moveSellerLines(rows, 'o1', 'CANCELLED', sent).map((r) => r.status)).toEqual(['CANCELLED', 'CANCELLED']);
    // Without it the server leaves them, and so does the screen.
    expect(moveSellerLines(rows, 'o1', 'CANCELLED').map((r) => r.status)).toEqual(['SHIPPED', 'CANCELLED']);
  });

  test('a wrong code changes nothing on the card', () => {
    const rows = [row('a', 'o1', 'SHIPPED', HAS_CODE)];
    const refusal = deliveryRefusal(refused({ code: 'DELIVERY_CODE_WRONG', attemptsLeft: 2 }));
    // The screen applies a sheet move only after the server accepts it, so on a
    // refusal the rows are whatever they were: still out for delivery.
    expect(refusal.lockedUntil).toBeNull();
    expect(rows[0].status).toBe('SHIPPED');
    expect(statusPrompt('SHIPPED', 'DELIVERED', deliveryInfo(rows[0]))).toBe('code');
  });
});
