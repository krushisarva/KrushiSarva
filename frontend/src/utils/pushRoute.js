/**
 * Where a tapped push notification takes the farmer — no React, no React
 * Native, so the plain-node Jest config can test it without a renderer.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 * The backend has pushed order updates to the buyer for a long time:
 *
 *     data: { orderId, status, screen: 'OrderDetail' }
 *
 * (agristore.routes.js, the seller status change). The farmer app registered for
 * push and showed the notification, but NOTHING listened for the tap — and the
 * screen the payload names, `OrderDetail`, does not exist in this app. Tapping
 * "Order shipped" opened the app on whatever it was showing last, or on the Shop
 * tab from a cold start, and left the farmer to find the order by hand. With a
 * delivery code now waiting on that order, that is the tap that matters.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * There is no order-detail screen; My Orders is the detail (its cards carry the
 * date, the shop and the code). So `screen: 'OrderDetail'` resolves to My Orders
 * inside the Account tab.
 *
 * A notification payload is NOT trusted input — anything that can mint a push
 * for this project can choose its `data`. So this is an allowlist of screens,
 * and nothing from the payload is passed on as a parameter: My Orders loads the
 * signed-in farmer's own list and takes no id from the notification. An unknown
 * payload returns null, which means "open normally".
 */

/**
 * The `data` object of an expo-notifications response, or null.
 *
 * Android has historically delivered the payload as a JSON string under `body`
 * rather than as the object Expo documents, so that shape is read too — but only
 * when the plain object names no `screen` of its own.
 */
export function responseData(response) {
  const raw = response?.notification?.request?.content?.data;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.screen == null && typeof raw.body === 'string') {
    try {
      const parsed = JSON.parse(raw.body);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Not JSON. Fall through to the raw object.
    }
  }
  return raw;
}

/**
 * `{ name, params }` for the screen this notification names, or null when it
 * names none this app knows.
 *
 * @param {object|null} data    the notification's `data`
 * @param {string} [pushKey]    identifies THIS tap (the notification id). My
 *   Orders reloads its first page when the key changes, because a list that was
 *   already open is showing the status from before the push — the one thing the
 *   farmer tapped to see. Omitted, the screen simply opens.
 */
export function pushTarget(data, pushKey) {
  if (!data || typeof data !== 'object') return null;

  switch (data.screen) {
    case 'OrderDetail':
      return {
        name: 'Account',
        params: {
          screen: 'MyOrders',
          // Without this, a cold start would make My Orders the ONLY screen in
          // the Account stack and Back would have nowhere to go.
          initial: false,
          params: typeof pushKey === 'string' && pushKey ? { pushKey } : {},
        },
      };
    default:
      return null;
  }
}

/**
 * Navigate now if the navigator is ready, otherwise once it is.
 *
 * The tap that LAUNCHES the app is read before the navigation tree has mounted
 * (the container waits on the initial deep-link lookup first), and a plain
 * `navigate` at that moment is silently dropped — which would lose exactly the
 * cold-start tap this exists for. One target is held, the newest wins, and
 * `flush` is called from the container's `onReady`.
 *
 * A held target expires. If the navigator never became ready — the farmer was
 * signed out, say — a stale tap must not fire minutes later for whoever signs in
 * next.
 *
 * Dependencies are injected so this is testable without React Navigation.
 */
export function createPendingNavigation({ isReady, navigate, now = Date.now, maxAgeMs = 60_000 }) {
  let pending = null;

  return {
    go(name, params) {
      if (isReady()) {
        pending = null;
        navigate(name, params);
        return;
      }
      pending = { name, params, at: now() };
    },
    flush() {
      // Not ready yet: keep holding. Clearing here would lose the tap if this
      // were ever called a moment early.
      if (!pending || !isReady()) return;
      const next = pending;
      pending = null;
      if (now() - next.at > maxAgeMs) return;
      navigate(next.name, next.params);
    },
  };
}
