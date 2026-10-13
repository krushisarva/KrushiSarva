/**
 * usePushNavigation — opens the screen a tapped push notification names.
 *
 * The farmer app registered for push (AuthContext → registerForPushNotifications)
 * and showed the notifications, but nothing listened for a TAP. "Order shipped"
 * simply opened the app wherever it had been left. See utils/pushRoute.js for
 * which payloads go where; this file is only the native wiring.
 *
 * Both arrival routes are covered:
 *   - app running (foreground or background) → the response listener
 *   - app killed, launched BY the tap → getLastNotificationResponseAsync, since
 *     that response was delivered before this listener could exist
 *
 * Mounted in AppNavigator, which only renders for a signed-in farmer who has
 * finished onboarding — so a tap can never navigate underneath the login screen.
 *
 * Push is an enhancement. Every failure here is swallowed: a phone that cannot
 * read the last response, or has no notification module at all, still gets a
 * working app that just opens normally.
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import { navigateWhenReady } from '../navigation/navigationRef';
import { pushTarget, responseData } from '../utils/pushRoute';

/**
 * The notification already acted on.
 *
 * Module-level, not a ref. The launch response is ALSO handed to the listener
 * on some platforms, and it stays readable for the whole session — so signing
 * out and back in remounts this hook and would send the next farmer to My
 * Orders for a tap made an hour ago. A ref would have forgotten.
 */
let handledId = null;

export default function usePushNavigation(enabled = true) {
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return undefined;

    let cancelled = false;

    const handle = (response) => {
      if (cancelled) return;
      const id = response?.notification?.request?.identifier ?? null;
      if (id && handledId === id) return;
      const target = pushTarget(responseData(response), id ? String(id) : String(Date.now()));
      if (!target) return;
      handledId = id;
      navigateWhenReady(target.name, target.params);
    };

    // Wrapped so a synchronous throw (no native module) is caught like a
    // rejected promise is.
    Promise.resolve()
      .then(() => Notifications.getLastNotificationResponseAsync?.())
      .then((response) => { if (response) handle(response); })
      .catch(() => {});

    let sub = null;
    try {
      sub = Notifications.addNotificationResponseReceivedListener(handle);
    } catch {
      // No listener — the app opens normally on a tap, as it did before.
    }

    return () => {
      cancelled = true;
      sub?.remove?.();
    };
  }, [enabled]);
}
