import { pushTarget, responseData } from '../pushRoute';

const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

// An expo-notifications response, as the tap listener receives it.
const response = (data) => ({ notification: { request: { identifier: 'n1', content: { data } } } });

describe('pushTarget — new order (contract §8.1)', () => {
  test('opens the order list, with no params', () => {
    expect(pushTarget({ kind: 'new_order', orderId: UUID })).toEqual({ name: 'SellerOrders', params: {} });
  });

  test('the order id is checked but not handed to the screen', () => {
    const target = pushTarget({ kind: 'new_order', orderId: UUID, sellerId: 'x', screen: 'AddProduct' });
    expect(target).toEqual({ name: 'SellerOrders', params: {} });
    expect(Object.keys(target.params)).toHaveLength(0);
  });

  test('accepts an id whatever its case or padding', () => {
    expect(pushTarget({ kind: 'new_order', orderId: ` ${UUID.toUpperCase()} ` }))
      .toEqual({ name: 'SellerOrders', params: {} });
  });

  test('null when the id is missing or is not a UUID — the app just opens', () => {
    expect(pushTarget({ kind: 'new_order' })).toBeNull();
    expect(pushTarget({ kind: 'new_order', orderId: '' })).toBeNull();
    expect(pushTarget({ kind: 'new_order', orderId: '42' })).toBeNull();
    expect(pushTarget({ kind: 'new_order', orderId: `${UUID}/../admin` })).toBeNull();
    expect(pushTarget({ kind: 'new_order', orderId: { id: UUID } })).toBeNull();
    expect(pushTarget({ kind: 'new_order', orderId: 12345 })).toBeNull();
  });

  test('the kind is matched exactly', () => {
    expect(pushTarget({ kind: 'NEW_ORDER', orderId: UUID })).toBeNull();
    expect(pushTarget({ type: 'NEW_ORDER', orderId: UUID })).toBeNull();
    expect(pushTarget({ kind: 'new_order ', orderId: UUID })).toBeNull();
  });
});

describe('pushTarget — crop report (unchanged)', () => {
  test('opens that report', () => {
    expect(pushTarget({ kind: 'crop_report_share', shareId: UUID, reportId: 'r1' }))
      .toEqual({ name: 'ReceivedReportDetail', params: { shareId: UUID } });
  });

  test('null without a usable share id', () => {
    expect(pushTarget({ kind: 'crop_report_share', shareId: 'nope' })).toBeNull();
    // An order id is not a share id: each kind reads only its own field.
    expect(pushTarget({ kind: 'crop_report_share', orderId: UUID })).toBeNull();
    expect(pushTarget({ kind: 'new_order', shareId: UUID })).toBeNull();
  });
});

describe('pushTarget — everything else opens the app normally', () => {
  test('unknown kinds and non-objects', () => {
    // The buyer's order push names a buyer screen; it must not move a seller.
    expect(pushTarget({ orderId: UUID, status: 'SHIPPED', screen: 'OrderDetail' })).toBeNull();
    expect(pushTarget({ kind: 'order_status', orderId: UUID })).toBeNull();
    expect(pushTarget({})).toBeNull();
    expect(pushTarget(null)).toBeNull();
    expect(pushTarget('new_order')).toBeNull();
  });
});

describe('responseData → pushTarget, as usePushNavigation chains them', () => {
  test('the documented object shape', () => {
    expect(pushTarget(responseData(response({ kind: 'new_order', orderId: UUID }))))
      .toEqual({ name: 'SellerOrders', params: {} });
  });

  test('Android\'s JSON-string-under-body shape', () => {
    const data = { body: JSON.stringify({ kind: 'new_order', orderId: UUID }) };
    expect(pushTarget(responseData(response(data)))).toEqual({ name: 'SellerOrders', params: {} });
  });

  test('a body that is not JSON, or no data at all, opens nothing', () => {
    expect(pushTarget(responseData(response({ body: '₹1,240 · Kasegaon' })))).toBeNull();
    expect(pushTarget(responseData(response(undefined)))).toBeNull();
    expect(pushTarget(responseData(null))).toBeNull();
  });

  test('an object that names its own kind is not replaced by its body', () => {
    const data = { kind: 'new_order', orderId: UUID, body: JSON.stringify({ kind: 'crop_report_share', shareId: UUID }) };
    expect(pushTarget(responseData(response(data)))).toEqual({ name: 'SellerOrders', params: {} });
  });
});
