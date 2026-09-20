/**
 * Deep-link security config for the seller app's NavigationContainer.
 *
 * Same posture as the buyer app: the OS hands us any `krushisarva-seller://` URL, so
 * we WHITELIST the only deep-link target we accept — the dashboard landing screen,
 * which takes no params and performs no sensitive action — and REJECT everything
 * else (product editing, KYC, order status changes, parameter injection) by
 * returning no navigation state.
 *
 * To expose a new target, add its path to BOTH `ALLOWED_DEEP_LINK_PATHS` and
 * `config.screens` — and validate any params it reads, since deep link params are
 * attacker-controlled.
 *
 * A whitelisted path is not enough on its own. Every screen in this stack is
 * behind the SAME gate the navigator applies at mount: an account without a
 * seller role lands on BusinessProfile (KYC) because the dashboard's every
 * request would 403. A deep link bypassed that — `krushisarva-seller://dashboard`
 * builds a state naming SellerDashboard, which overrides `initialRouteName` —
 * so a farmer who has not onboarded, or a link opened before login and replayed
 * by React Navigation when the navigator finally mounts, landed on a dashboard
 * that could only show errors. `createLinking` takes the same gate and, when it
 * is closed, returns no state: the app opens on its normal initial route, which
 * is the login screen when signed out and the KYC form when not yet a seller.
 */
import { Platform } from 'react-native';
import { getStateFromPath as defaultGetStateFromPath } from '@react-navigation/native';

// The ONLY first path segments that may resolve to a screen. Lowercased.
export const ALLOWED_DEEP_LINK_PATHS = new Set(['dashboard']);

/**
 * True only for an explicitly whitelisted deep-link path. Strips query/hash and
 * leading slashes, then checks the first path segment against the allowlist.
 * A bare scheme (no path) is NOT a target — the app just opens normally.
 */
export function isAllowedDeepLink(path) {
  const clean = String(path || '').replace(/[?#].*$/, '').replace(/^\/+/, '');
  if (!clean) return false;
  const segment = clean.split('/')[0].toLowerCase();
  return ALLOWED_DEEP_LINK_PATHS.has(segment);
}

/**
 * Build the NavigationContainer `linking` config.
 *
 * @param {(() => boolean)|boolean} canOpenGatedScreens  the app's own gate —
 *   pass a GETTER (not a snapshot) so the answer is read at the moment a URL
 *   arrives, not at the moment the container mounted. Every path in
 *   `config.screens` is a gated screen; if that ever stops being true, gate
 *   per-path here rather than opening the whole config.
 *
 * Deliberately no default export: a caller that forgot to supply the gate would
 * otherwise get a config that navigates anyone, anywhere.
 */
export function createLinking(canOpenGatedScreens) {
  const gateOpen = typeof canOpenGatedScreens === 'function'
    ? canOpenGatedScreens
    : () => Boolean(canOpenGatedScreens);

  return {
    // Native only — web doesn't use the scheme and we don't URL-sync there.
    enabled: Platform.OS !== 'web',
    prefixes: ['krushisarva-seller://', 'https://seller.cropsetu.app'],
    config: {
      screens: {
        SellerDashboard: 'dashboard',
      },
    },
    // Security gate: reject any path that isn't explicitly whitelisted, and any
    // link into the app for an account that may not be there, BEFORE React
    // Navigation resolves it. Returning undefined => no deep-link navigation,
    // so the app just opens to its normal initial route.
    getStateFromPath(path, options) {
      if (!isAllowedDeepLink(path)) {
        if (__DEV__) console.warn(`[linking] Rejected non-whitelisted deep link: ${path}`);
        return undefined;
      }
      if (!gateOpen()) {
        if (__DEV__) console.warn(`[linking] Rejected deep link for an un-onboarded account: ${path}`);
        return undefined;
      }
      return defaultGetStateFromPath(path, options);
    },
  };
}
