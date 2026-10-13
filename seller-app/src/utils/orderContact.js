/**
 * Reaching the farmer on a delivery run — no React, no React Native.
 *
 * The order card printed the delivery phone and address as text. A seller on a
 * tempo, one hand on the wheel, had to read the number off the screen and type
 * it into the dialler, and had no way to hand the address to a map. These build
 * the two links the Call and Map buttons open (through utils/openUrl.js).
 *
 * There are no coordinates: Order.deliveryAddress stores name, phone, flat,
 * street, landmark, city, state and PIN code only, so the map is opened on the
 * address as a TEXT search.
 */

const str = (v) => (v == null ? '' : String(v).trim());

/**
 * A number the dialler will accept, as +91XXXXXXXXXX, or null.
 *
 * Checkout accepts any shape whose last ten digits are a mobile number
 * ("+91 98…", "098…", "98765 43210"), so those ten are what is dialled rather
 * than whatever was typed. Fewer than ten digits is not a number anyone can
 * call, and dialling it would connect the seller to a stranger or to nobody.
 */
export function dialableNumber(raw) {
  const digits = str(raw).replace(/\D/g, '');
  return digits.length >= 10 ? `+91${digits.slice(-10)}` : null;
}

/**
 * Who to call about this order: the phone typed at checkout, else the buyer's
 * account phone.
 *
 * In that order on purpose — a farmer ordering for a relative's farm gives the
 * relative's number, and that is the person standing at the gate. The account
 * phone is the fallback for an address saved without one.
 */
export function deliveryPhone(order) {
  const address = order?.deliveryAddress;
  const typed = address && typeof address === 'object' ? address.phone : null;
  return dialableNumber(typed) || dialableNumber(order?.user?.phone);
}

/** `tel:` link for a number from deliveryPhone(), or null. */
export function telUrl(number) {
  return number ? `tel:${number}` : null;
}

/**
 * The address as one line a map app can search, house → PIN code, or ''.
 *
 * The recipient's name and phone are left out (a map cannot use them, and they
 * are personal data handed to another app for nothing), and the landmark goes in
 * bare — the card's translated "Landmark:" label would only be noise in a
 * search. `addressLine` is read only for an old order that has no flat/street,
 * the same rule the card uses.
 */
export function mapQuery(address) {
  if (!address || typeof address !== 'object') return '';
  const flat = str(address.flat);
  const street = str(address.street);
  return [
    flat,
    street,
    flat || street ? '' : str(address.addressLine),
    str(address.landmark),
    str(address.city),
    str(address.state),
    str(address.pincode),
  ].filter(Boolean).join(', ');
}

/**
 * Links that open the address in a map, best first. Empty when there is no
 * address to search for.
 *
 *   - Android: `geo:0,0?q=` goes to whichever map app the seller uses. It is
 *     not an https link, so openExternalUrl() tries it without asking
 *     canOpenURL (which answers false for it on Android 11+).
 *   - iOS has no `geo:`; maps.apple.com opens Apple Maps.
 *   - The Google Maps web link is last everywhere: it works in any browser, so
 *     a phone with no map app still shows the place.
 */
export function mapUrls(address, platform) {
  const query = mapQuery(address);
  if (!query) return [];
  const q = encodeURIComponent(query);
  const web = `https://www.google.com/maps/search/?api=1&query=${q}`;
  if (platform === 'android') return [`geo:0,0?q=${q}`, web];
  if (platform === 'ios') return [`https://maps.apple.com/?q=${q}`, web];
  return [web];
}
