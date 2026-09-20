/**
 * seller-app/src/navigation/linking.js — the deep-link gate (L7).
 *
 * Two things must hold for a `krushisarva-seller://…` URL to become navigation:
 * the path is on the allowlist, AND the account is one the app would have let
 * into that screen anyway. The second half is what was missing: every screen in
 * this stack is behind SellerNavigator's seller/KYC gate, but a deep link built
 * its own state and overrode the initial route, dropping a farmer who has not
 * onboarded (or one whose link was opened before login and replayed when the
 * navigator finally mounted) onto a dashboard that can only 403.
 */

// linking.js logs rejections under __DEV__, which the bundler defines and a
// plain node test environment does not.
global.__DEV__ = false;

jest.mock('@react-navigation/native', () => ({
  getStateFromPath: jest.fn((path) => ({ routes: [{ name: 'SellerDashboard', path }] })),
}));

const { getStateFromPath: defaultGetStateFromPath } = require('@react-navigation/native');
const { createLinking, isAllowedDeepLink, ALLOWED_DEEP_LINK_PATHS } = require('../linking');

beforeEach(() => jest.clearAllMocks());

describe('the path allowlist', () => {
  test('accepts only the whitelisted first segment', () => {
    expect(isAllowedDeepLink('dashboard')).toBe(true);
    expect(isAllowedDeepLink('/dashboard')).toBe(true);
    expect(isAllowedDeepLink('DASHBOARD?x=1')).toBe(true);
    expect(isAllowedDeepLink('orders')).toBe(false);
    expect(isAllowedDeepLink('kyc')).toBe(false);
    expect(isAllowedDeepLink('')).toBe(false);
    expect(isAllowedDeepLink(null)).toBe(false);
  });

  test('is a short, explicit list', () => {
    expect([...ALLOWED_DEEP_LINK_PATHS]).toEqual(['dashboard']);
  });
});

describe('the seller/KYC gate', () => {
  test('an un-onboarded account gets no deep-link state, so it lands on its normal route', () => {
    const linking = createLinking(() => false);

    expect(linking.getStateFromPath('dashboard')).toBeUndefined();
    // Never even resolved: the rejection happens before React Navigation sees it.
    expect(defaultGetStateFromPath).not.toHaveBeenCalled();
  });

  test('an onboarded seller is taken to the screen', () => {
    const linking = createLinking(() => true);

    expect(linking.getStateFromPath('dashboard', { config: {} }))
      .toEqual({ routes: [{ name: 'SellerDashboard', path: 'dashboard' }] });
    expect(defaultGetStateFromPath).toHaveBeenCalledWith('dashboard', { config: {} });
  });

  test('the gate is read per URL, not captured when the container mounted', () => {
    // An account promoted by the KYC form mid-session must start honouring its
    // own deep links without the navigator being torn down and rebuilt.
    let isSeller = false;
    const linking = createLinking(() => isSeller);

    expect(linking.getStateFromPath('dashboard')).toBeUndefined();
    isSeller = true;
    expect(linking.getStateFromPath('dashboard')).toBeDefined();
  });

  test('a non-whitelisted path is rejected even for a seller', () => {
    const linking = createLinking(() => true);

    expect(linking.getStateFromPath('orders/42/cancel')).toBeUndefined();
    expect(defaultGetStateFromPath).not.toHaveBeenCalled();
  });

  test('a plain boolean gate works too', () => {
    expect(createLinking(false).getStateFromPath('dashboard')).toBeUndefined();
    expect(createLinking(true).getStateFromPath('dashboard')).toBeDefined();
  });

  test('every path the config exposes is behind the gate', () => {
    const linking = createLinking(() => false);
    Object.values(linking.config.screens).forEach((path) => {
      expect(linking.getStateFromPath(path)).toBeUndefined();
    });
    expect(defaultGetStateFromPath).not.toHaveBeenCalled();
  });
});
