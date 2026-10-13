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
 *
 * AND IT SHOWS A PUSH THAT ARRIVES WHILE THE APP IS OPEN
 * ------------------------------------------------------
 * expo-notifications presents nothing in the foreground unless the app sets a
 * handler, and this app never set one. That did not matter for a crop report.
 * It matters for "New order": a Kendra with the app open on the counter is the
 * seller most likely to be there to pack it, and was the one seller who would
 * hear nothing. The handler is set for every signed-in account, not only for
 * `enabled` ones — a sign-in security alert is for an account still on the KYC
 * form too.
 */
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

import { navigate } from "../navigation/navigationRef";
import { pushTarget, responseData } from "../utils/pushRoute";

// With the app open: show it and sound it, like any other. `shouldPlaySound` is
// not optional on Android — with it false the notification is not shown at all,
// whatever the channel says. The badge is left alone: nothing in this app clears
// one, so a count would only ever go up.
const FOREGROUND_BEHAVIOUR = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

export default function usePushNavigation(enabled = true) {
  // The cold-start response is ALSO handed to the listener on some platforms,
  // and it survives for the whole session, so navigation is keyed to the
  // notification and done once.
  const handledId = useRef(null);

  useEffect(() => {
    if (Platform.OS === "web") return undefined;
    Notifications.setNotificationHandler({
      handleNotification: async () => FOREGROUND_BEHAVIOUR,
    });
    // Signed out (this hook unmounts with the navigator): back to the default.
    return () => Notifications.setNotificationHandler(null);
  }, []);

  useEffect(() => {
    if (!enabled || Platform.OS === "web") return undefined;

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
      .then((response) => {
        if (response) handle(response);
      })
      // A device that cannot read it still gets a working app.
      .catch(() => {});

    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    return () => {
      cancelled = true;
      sub?.remove?.();
    };
  }, [enabled]);
}
