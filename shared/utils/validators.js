/**
 * Shared form validators — single source of truth for field validation rules
 * used across every client form (login, checkout, KYC, ...).
 *
 * Centralised so the regexes can't drift between screens (the bug this fixes:
 * the phone regex was copy-pasted in LoginScreen and CheckoutScreen, and the
 * pincode regex lived only in CheckoutScreen). The backend remains AUTHORITATIVE;
 * these mirror its expectations to give fast, consistent client-side feedback.
 *
 * Each rule is exposed as a boolean predicate that trims/normalises input
 * first; PHONE_RE and PINCODE_RE are additionally exported as RegExps, for the
 * callers that need the raw pattern.
 */

// Indian mobile number: 10 digits, first digit 6-9 (the valid operator series).
export const PHONE_RE = /^[6-9]\d{9}$/;
// Indian PIN code: exactly 6 digits.
export const PINCODE_RE = /^\d{6}$/;
// One-time password: 6 digits.
const OTP_RE = /^\d{6}$/;
// GSTIN, e.g. 27ABCDE1234F1Z5.
const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
// Bank IFSC, e.g. SBIN0012345.
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
// Aadhaar: 12 digits.
const AADHAAR_RE = /^\d{12}$/;
// PAN, e.g. ABCDE1234F.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// Indian bank account numbers run from 9 to 18 digits depending on the bank.
const BANK_ACCOUNT_RE = /^\d{9,18}$/;

/**
 * Reduce raw phone input to a bare 10-digit national number. Strips non-digits,
 * then drops a +91 country code (12 digits) or a leading 0 trunk prefix (11
 * digits). Length-aware so it never strips "91" from a genuine 10-digit number
 * that happens to start with 91 (the bug in the old CheckoutScreen normPhone).
 */
export function normalizePhone(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

/** True for a valid Indian mobile number (after normalisation). */
export function isValidPhone(value) {
  return PHONE_RE.test(normalizePhone(value));
}

/** True for a valid 6-digit PIN code. */
export function isValidPincode(value) {
  return PINCODE_RE.test(String(value ?? '').trim());
}

/** True for a valid 6-digit OTP. */
export function isValidOtp(value) {
  return OTP_RE.test(String(value ?? '').trim());
}

/** True for a valid GSTIN (case-insensitive). */
export function isValidGst(value) {
  return GST_RE.test(String(value ?? '').trim().toUpperCase());
}

/** True for a valid bank IFSC (case-insensitive). */
export function isValidIfsc(value) {
  return IFSC_RE.test(String(value ?? '').trim().toUpperCase());
}

/** True for a valid 12-digit Aadhaar number. */
export function isValidAadhaar(value) {
  return AADHAAR_RE.test(String(value ?? '').trim());
}

/** True for a valid PAN (case-insensitive). */
export function isValidPan(value) {
  return PAN_RE.test(String(value ?? '').trim().toUpperCase());
}

/** True for a 9–18 digit bank account number. */
export function isValidBankAccount(value) {
  return BANK_ACCOUNT_RE.test(String(value ?? '').trim());
}

// ── Check digits ─────────────────────────────────────────────────────────────
// The format predicates above mirror the backend and accept any string of the
// right shape. The two below go further and catch typos: a single wrong digit or
// two swapped neighbours in an Aadhaar number or GSTIN fails its check digit.
// Only use them for fresh input, never to reject a value the server returned.

// Verhoeff dihedral-group tables (UIDAI uses this scheme for Aadhaar).
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * True when a 12-digit Aadhaar number passes UIDAI's rules: it cannot start
 * with 0 or 1, and its last digit is a Verhoeff check digit.
 */
export function isAadhaarChecksumValid(value) {
  const s = String(value ?? '').trim();
  if (!/^[2-9]\d{11}$/.test(s)) return false;
  let c = 0;
  for (let i = 0; i < s.length; i += 1) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(s[s.length - 1 - i])]];
  }
  return c === 0;
}

const GST_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** True when a GSTIN's 15th character matches its mod-36 check character. */
export function isGstChecksumValid(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!GST_RE.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = GST_CHARSET.indexOf(s[i]) * ((i % 2) + 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GST_CHARSET[(36 - (sum % 36)) % 36] === s[14];
}
