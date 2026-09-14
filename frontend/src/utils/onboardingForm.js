/**
 * Input cleaning for the onboarding farm-profile form — no React, no React Native.
 *
 * The number fields use keyboards that do not actually restrict what arrives:
 * `numeric` on many Android keyboards still types "." and "-", and a pasted or
 * suggested value can hold anything. `decimal-pad` types "," in locales that use
 * a decimal comma, and parseFloat("2,5") is 2 — the farmer saw 2,5 and saved 2.
 */

export const PINCODE_LENGTH = 6;
// Five integer digits covers any real holding in acres; more is a typo.
const ACRES_INT_DIGITS = 5;
const ACRES_DECIMALS = 2;

/** Keep digits only, capped at `max`. */
export const digitsOnly = (value, max) => String(value ?? '').replace(/\D/g, '').slice(0, max);

/** Pincode as typed → at most six digits. */
export const cleanPincode = (value) => digitsOnly(value, PINCODE_LENGTH);

/**
 * Land size as typed → "12", "12.", "12.5" or "12.75".
 * A decimal comma becomes a point, only the first point is kept, and anything
 * that is not a digit is dropped. A trailing point stays so "2." can become "2.5".
 */
export function cleanAcres(value) {
  const s = String(value ?? '').replace(/,/g, '.').replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  const int = (dot === -1 ? s : s.slice(0, dot)).slice(0, ACRES_INT_DIGITS);
  if (dot === -1) return int;
  const frac = s.slice(dot + 1).replace(/\./g, '').slice(0, ACRES_DECIMALS);
  return `${int || '0'}.${frac}`;
}

/** The land size to send: a positive finite number, or null. */
export function acresOrNull(value) {
  const n = parseFloat(cleanAcres(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The crop a typed name refers to, if it is already a card or an added crop.
 * "rice" must select the Rice card, not add a second "rice" chip beside it.
 */
export function findCrop(name, crops) {
  const wanted = String(name ?? '').trim().toLowerCase();
  if (!wanted) return null;
  for (const crop of crops) {
    if (crop.toLowerCase() === wanted) return crop;
  }
  return null;
}
