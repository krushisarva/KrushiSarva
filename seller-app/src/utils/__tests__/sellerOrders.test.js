import {
  canMove, canSellerCancel, moveSellerLines, nextStatusFor, orderItemQty,
  sellerStatusByOrder, sellerStatusOf,
} from '../sellerOrders';
import { refusalMessage } from '../apiError';

// One row per order item, as GET /agristore/seller/orders returns them.
const row = (id, orderId, status, orderStatus = 'CONFIRMED') => ({
  id, status, order: { id: orderId, status: orderStatus },
});
const statusOf = (rows, r) => sellerStatusOf(r, sellerStatusByOrder(rows));

describe('sellerStatusOf', () => {
  test('uses the seller\'s own line, not the order rollup other sellers moved', () => {
    // The other Kendra shipped; the rollup says SHIPPED, this line is untouched.
    const r = row('a', 'o1', 'PENDING', 'SHIPPED');
    expect(statusOf([r], r)).toBe('PENDING');
    expect(nextStatusFor(statusOf([r], r))).toBe('CONFIRMED');
    expect(canSellerCancel(statusOf([r], r))).toBe(true);
  });

  test('mixed lines on one order show the least-advanced live one on every live card', () => {
    const rows = [row('a', 'o1', 'SHIPPED'), row('b', 'o1', 'CONFIRMED'), row('c', 'o2', 'DELIVERED')];
    expect(statusOf(rows, rows[0])).toBe('CONFIRMED');
    expect(statusOf(rows, rows[1])).toBe('CONFIRMED');
    expect(statusOf(rows, rows[2])).toBe('DELIVERED');
  });

  test('a cancelled line stays cancelled beside a live one, and does not drag the live one', () => {
    const rows = [row('a', 'o1', 'CANCELLED'), row('b', 'o1', 'SHIPPED')];
    expect(statusOf(rows, rows[0])).toBe('CANCELLED');
    expect(statusOf(rows, rows[1])).toBe('SHIPPED');
    // Order of rows does not matter.
    const flipped = [rows[1], rows[0]];
    expect(statusOf(flipped, rows[1])).toBe('SHIPPED');
  });

  test('an admin-refunded order is REFUNDED whatever its lines say', () => {
    const r = row('a', 'o1', 'PENDING', 'REFUNDED');
    expect(statusOf([r], r)).toBe('REFUNDED');
    expect(nextStatusFor('REFUNDED')).toBeNull();
    expect(canSellerCancel('REFUNDED')).toBe(false);
  });

  test('falls back to the order status for a row with no line status', () => {
    const r = { id: 'a', order: { id: 'o1', status: 'CONFIRMED' } };
    expect(statusOf([r], r)).toBe('CONFIRMED');
  });
});

describe('actions match the server transitions', () => {
  test('cancel is offered while PENDING or CONFIRMED, never after shipping', () => {
    expect(canSellerCancel('PENDING')).toBe(true);
    expect(canSellerCancel('CONFIRMED')).toBe(true);
    expect(canSellerCancel('SHIPPED')).toBe(false);
    expect(canSellerCancel('DELIVERED')).toBe(false);
    expect(canSellerCancel('CANCELLED')).toBe(false);
  });

  test('next step walks the flow and stops at DELIVERED', () => {
    expect(nextStatusFor('PENDING')).toBe('CONFIRMED');
    expect(nextStatusFor('SHIPPED')).toBe('DELIVERED');
    expect(nextStatusFor('DELIVERED')).toBeNull();
    expect(nextStatusFor('CANCELLED')).toBeNull();
    expect(canMove('SHIPPED', 'CONFIRMED')).toBe(false);
  });

  test('moveSellerLines moves only this order\'s lines that may make the move', () => {
    const rows = [
      row('a', 'o1', 'PENDING'), row('b', 'o1', 'CANCELLED'), row('c', 'o1', 'SHIPPED'),
      row('d', 'o2', 'PENDING'),
    ];
    const moved = moveSellerLines(rows, 'o1', 'CONFIRMED');
    expect(moved.map((r) => r.status)).toEqual(['CONFIRMED', 'CANCELLED', 'SHIPPED', 'PENDING']);
    // Untouched rows keep their identity (memoised cards do not re-render).
    expect(moved[1]).toBe(rows[1]);
    expect(moved[3]).toBe(rows[3]);
  });
});

describe('orderItemQty', () => {
  test('prints the unit frozen on the line', () => {
    expect(orderItemQty({ quantity: 2, unit: 'kg' })).toBe('2 kg');
  });

  test('falls back to the variant the route attaches', () => {
    expect(orderItemQty({ quantity: 2, unit: null, variant: { unit: 'bag' } })).toBe('2 bag');
  });

  test('just the number when no unit is known; a dash with no quantity', () => {
    expect(orderItemQty({ quantity: 3, product: { name: 'Seed' } })).toBe('3');
    expect(orderItemQty({})).toBe('—');
  });
});

describe('refusalMessage', () => {
  const err = (status, message) => ({ response: { status, data: { error: { message } } } });

  test('shows the server\'s reason for a 409 or 403', () => {
    expect(refusalMessage(err(409, 'This order is already shipped and cannot be marked cancelled.')))
      .toBe('This order is already shipped and cannot be marked cancelled.');
    expect(refusalMessage(err(403, 'This offer has been blocked by KrushiSarva. Contact support.')))
      .toBe('This offer has been blocked by KrushiSarva. Contact support.');
  });

  test('null for anything else, so 5xx text never reaches the screen', () => {
    expect(refusalMessage(err(500, 'PrismaClientKnownRequestError: ...'))).toBeNull();
    expect(refusalMessage(err(409, '  '))).toBeNull();
    expect(refusalMessage({ message: 'Network Error' })).toBeNull();
    expect(refusalMessage(null)).toBeNull();
  });
});
