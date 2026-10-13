/**
 * Where a tapped push takes the farmer.
 *
 * The backend has sent `data: { orderId, status, screen: 'OrderDetail' }` with
 * every order update, and the farmer app did nothing with a tap: no listener,
 * and no screen called OrderDetail. These tests pin the three things that make
 * the tap worth having:
 *
 *   1. an order push lands on My Orders — the only order screen there is;
 *   2. nothing in an untrusted payload can steer the app anywhere else, or
 *      reach a screen as a parameter;
 *   3. the tap that LAUNCHES the app is not lost while the navigator mounts.
 */
import fs from 'fs';
import path from 'path';
import { responseData, pushTarget, createPendingNavigation } from '../pushRoute';

/** An expo-notifications response carrying `data`. */
const response = (data) => ({ notification: { request: { identifier: 'n1', content: { data } } } });

/** Exactly what agristore.routes.js sends the buyer on a status change. */
const ORDER_PUSH = { orderId: '3f2b1c9e-8a47-4d1e-9c55-0a1b2c3d4e5f', status: 'SHIPPED', screen: 'OrderDetail' };

describe('responseData', () => {
  test('reads the data object of a notification response', () => {
    expect(responseData(response(ORDER_PUSH))).toEqual(ORDER_PUSH);
  });

  test('reads the Android shape, where the payload arrives as JSON under `body`', () => {
    expect(responseData(response({ body: JSON.stringify(ORDER_PUSH) }))).toEqual(ORDER_PUSH);
  });

  test('a real `screen` wins over anything in `body`', () => {
    const data = { screen: 'OrderDetail', body: JSON.stringify({ screen: 'Elsewhere' }) };
    expect(responseData(response(data)).screen).toBe('OrderDetail');
  });

  test('a `body` that is not JSON is left as it is', () => {
    const data = { body: 'Your order is on its way' };
    expect(responseData(response(data))).toEqual(data);
    expect(responseData(response({ body: '"just a string"' }))).toEqual({ body: '"just a string"' });
  });

  test('anything else is null, not a throw', () => {
    for (const bad of [null, undefined, {}, { notification: {} }, response(null), response('x'), response(7)]) {
      expect(responseData(bad)).toBeNull();
    }
  });
});

describe('pushTarget', () => {
  test('an order update opens My Orders, inside the Account tab', () => {
    expect(pushTarget(ORDER_PUSH, 'n1')).toEqual({
      name: 'Account',
      params: { screen: 'MyOrders', initial: false, params: { pushKey: 'n1' } },
    });
  });

  test('every status the backend pushes lands on the same screen', () => {
    for (const status of ['CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']) {
      expect(pushTarget({ ...ORDER_PUSH, status }, 'n1').params.screen).toBe('MyOrders');
    }
  });

  test('keeps the Account home underneath, so Back has somewhere to go', () => {
    // From a cold start the Account stack does not exist yet. Without
    // `initial: false` My Orders would be its only screen.
    expect(pushTarget(ORDER_PUSH, 'n1').params.initial).toBe(false);
  });

  test('carries the key of THIS tap, so an already-open list knows to reload', () => {
    expect(pushTarget(ORDER_PUSH, 'n1').params.params).toEqual({ pushKey: 'n1' });
    expect(pushTarget(ORDER_PUSH, 'n2').params.params).toEqual({ pushKey: 'n2' });
  });

  test('without a key the screen simply opens', () => {
    for (const key of [undefined, null, '', 7, {}]) {
      expect(pushTarget(ORDER_PUSH, key).params.params).toEqual({});
    }
  });

  test('NOTHING from the payload is passed on to the screen', () => {
    // My Orders loads the signed-in farmer's own list. A push — which anything
    // able to mint one for this project can forge — must not be able to hand it
    // an id, a status or a delivery code.
    const forged = {
      ...ORDER_PUSH, orderId: 'someone-elses-order', deliveryCode: '4072',
      params: { admin: true }, initial: true, name: 'Checkout',
    };
    const target = pushTarget(forged, 'n1');
    expect(target).toEqual({
      name: 'Account',
      params: { screen: 'MyOrders', initial: false, params: { pushKey: 'n1' } },
    });
    expect(JSON.stringify(target)).not.toMatch(/someone-elses-order|4072|admin|Checkout/);
  });

  test('a payload that names no known screen opens the app normally', () => {
    for (const data of [
      {},
      { screen: 'Checkout' },
      { screen: 'MyOrders' },            // only the name the backend actually sends
      { screen: 'orderdetail' },
      { screen: ['OrderDetail'] },
      { kind: 'crop_report_share', shareId: 'x' }, // a seller-app push
      { kind: 'new_order', orderId: ORDER_PUSH.orderId },
      { type: 'ORDER_STATUS' },          // `type` is not in the push data
    ]) {
      expect(pushTarget(data, 'n1')).toBeNull();
    }
  });

  test('junk is null, not a throw', () => {
    for (const bad of [null, undefined, 'OrderDetail', 7, true, []]) {
      expect(pushTarget(bad, 'n1')).toBeNull();
    }
  });

  test('the routes it names are real ones', () => {
    // The payload's own name, OrderDetail, was never a route — that is the bug.
    // This keeps the replacement honest if a screen is ever renamed.
    const nav = fs.readFileSync(path.resolve(__dirname, '../../navigation/AppNavigator.js'), 'utf8');
    const target = pushTarget(ORDER_PUSH, 'n1');
    expect(nav).toMatch(new RegExp(`<Tab\\.Screen\\s+name="${target.name}"`));
    expect(nav).toMatch(new RegExp(`<ProfileStack\\.Screen\\s+name="${target.params.screen}"`));
    expect(nav).not.toMatch(/name="OrderDetail"/);
  });
});

describe('createPendingNavigation', () => {
  const setup = ({ ready = false, maxAgeMs } = {}) => {
    const state = { ready, clock: 1_000_000 };
    const navigate = jest.fn();
    const nav = createPendingNavigation({
      isReady: () => state.ready,
      navigate,
      now: () => state.clock,
      ...(maxAgeMs ? { maxAgeMs } : {}),
    });
    return { state, navigate, nav };
  };

  test('navigates at once when the navigator is up', () => {
    const { navigate, nav } = setup({ ready: true });
    nav.go('Account', { screen: 'MyOrders' });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('Account', { screen: 'MyOrders' });
  });

  test('COLD START: a tap read before the navigator mounts is held, then delivered', () => {
    const { state, navigate, nav } = setup();
    nav.go('Account', { screen: 'MyOrders' });
    expect(navigate).not.toHaveBeenCalled(); // a plain navigate() would be lost here

    state.ready = true;
    nav.flush(); // the container's onReady
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('Account', { screen: 'MyOrders' });
  });

  test('delivers once — a second onReady does not navigate again', () => {
    const { state, navigate, nav } = setup();
    nav.go('Account', {});
    state.ready = true;
    nav.flush();
    nav.flush();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test('the newest tap wins', () => {
    const { state, navigate, nav } = setup();
    nav.go('Account', { n: 1 });
    nav.go('Account', { n: 2 });
    state.ready = true;
    nav.flush();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('Account', { n: 2 });
  });

  test('a flush that comes too early keeps holding the tap', () => {
    const { state, navigate, nav } = setup();
    nav.go('Account', {});
    nav.flush(); // not ready yet
    expect(navigate).not.toHaveBeenCalled();
    state.ready = true;
    nav.flush();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test('a held tap EXPIRES, so it cannot fire for whoever signs in later', () => {
    const { state, navigate, nav } = setup();
    nav.go('Account', {});
    state.clock += 60_001;
    state.ready = true;
    nav.flush();
    expect(navigate).not.toHaveBeenCalled();
    // …and it is gone, not waiting for the clock to be wound back.
    state.clock -= 60_001;
    nav.flush();
    expect(navigate).not.toHaveBeenCalled();
  });

  test('a held tap inside the window is still delivered', () => {
    const { state, navigate, nav } = setup();
    nav.go('Account', {});
    state.clock += 59_000;
    state.ready = true;
    nav.flush();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test('a direct navigation supersedes a held one', () => {
    const { state, navigate, nav } = setup();
    nav.go('Account', { n: 1 });
    state.ready = true;
    nav.go('Account', { n: 2 });
    nav.flush();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('Account', { n: 2 });
  });

  test('flushing with nothing held is a no-op', () => {
    const { navigate, nav } = setup({ ready: true });
    nav.flush();
    expect(navigate).not.toHaveBeenCalled();
  });
});
