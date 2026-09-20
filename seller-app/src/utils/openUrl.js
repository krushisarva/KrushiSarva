/**
 * Open a URL outside the app. Resolves true when it opened, false when not.
 *
 * WHY canOpenURL IS ONLY ASKED ABOUT https
 * ----------------------------------------
 * On Android 11+ `Linking.canOpenURL` returns false for any scheme not declared
 * in the manifest's `<queries>` block, and app.json declares none for tel — so
 * "check, then open" told every seller "This device cannot place calls" on a
 * phone that can obviously dial. `openURL` is not subject to that filter, so for
 * anything but https (tel, sms, whatsapp, geo…) we simply try it and treat a
 * rejection as "can't"
 * (same reasoning as frontend/src/utils/sellerApp.js).
 *
 * `linking` is injectable so this can be tested without React Native.
 */
export async function openExternalUrl(url, linking) {
  try {
    if (/^https:/i.test(String(url)) && !(await linking.canOpenURL(url))) return false;
    await linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
