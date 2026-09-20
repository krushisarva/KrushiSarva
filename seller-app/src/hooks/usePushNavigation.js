/**
 * usePushNavigation — opens the screen a tapped push notification names.
 *
 * The seller app registered for push (AuthContext → registerForPushNotifications)
 * and rendered the notifications, but nothing listened for a TAP. A "New crop
 * diagnosis report" push carries the `shareId` of the share it is about and
 * tapping it simply opened the app on the dashboard.
 *
 * Both arrival routes are covered:
 *   - app running (foreground or background) → the response listener
 *   - app killed, launched BY the tap → getLastNotificationResponseAsync, since
 *     that response was delivered before this listener could exist
 *
 * Mounted in SellerNavigator, ABOVE the NavigationContainer: React flushes child
 * effects first, so the container's ref is ready by the time this effect runs.
 * If it somehow is not, `navigate` no-ops and the app just opens normally.
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import { navigate } from '../navigation/navigationRef';
import { pushTarget, responseData } from '../utils/pushRoute';

export default function usePushNavigation(enabled = true) {
  // The cold-start response is ALSO handed to the listener on some platforms,
  // and it survives for the whole session, so navigation is keyed to the
  // notification and done once.
  const handledId = useRef(null);

  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return undefined;

    let cancelled = false;

    const handle = (response) => {
      if (cancelled) return;
      const id = response?.notification?.request?.identifier ?? null;
      if (id && handledId.current === id) return;
      const target = pushTarget(responseData(response));
      if (!target) return;
      handledId.current = id;
      navigate(target.name, target.params);
    };

    Notifications.getLastNotificationResponseAsync?.()
      .then((response) => { if (response) handle(response); })
      // A device that cannot read it still gets a working app.
      .catch(() => {});

    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    return () => {
      cancelled = true;
      sub?.remove?.();
    };
  }, [enabled]);
}
