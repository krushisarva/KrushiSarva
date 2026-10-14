/**
 * The order number on the seller's card (utils/sellerOrders.js orderShortId).
 *
 * It exists so a farmer and a seller can name the same order on a phone call —
 * which only works if both apps print the SAME number for it.
 */
import fs from 'fs';
import path from 'path';
import { orderShortId } from '../sellerOrders';

test('the last eight characters of the order id, in capitals, behind a #', () => {
  expect(orderShortId({ id: '0d3b7c1e-52aa-4f0e-9a41-11c27a36a71c' })).toBe('#7A36A71C');
  expect(orderShortId({ id: 'ord-0000-0000-0000-000084ddadf6' })).toBe('#84DDADF6');
});

test('a short id is shown whole; surrounding space is not part of it', () => {
  expect(orderShortId({ id: 'ab12' })).toBe('#AB12');
  expect(orderShortId({ id: '  11c27a36a71c  ' })).toBe('#7A36A71C');
});

test('no usable id: nothing — never a bare "#"', () => {
  for (const order of [null, undefined, {}, { id: '' }, { id: '   ' }, { id: 42 }, { id: null }]) {
    expect(orderShortId(order)).toBeNull();
  }
});

test('it is the rule the farmer app uses on My Orders', () => {
  // The two apps cannot import from each other, so the rule is written twice.
  // If the farmer's changes, this fails and the seller's has to follow.
  const farmer = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'frontend', 'src', 'screens', 'Profile', 'MyOrdersScreen.js'),
    'utf8',
  );
  expect(farmer).toMatch(/`#\$\{order\.id\.slice\(-8\)\.toUpperCase\(\)\}`/);
});

test('the seller card prints it beside the date, and nothing when there is none', () => {
  const screen = fs.readFileSync(path.join(__dirname, '..', '..', 'screens', 'OrdersScreen.js'), 'utf8');
  expect(screen).toMatch(/const orderNo = orderShortId\(item\.order\);/);
  expect(screen).toMatch(/\{orderNo \? <Text style=\{o\.date\} numberOfLines=\{1\}>\{orderNo\}<\/Text> : null\}/);
});
