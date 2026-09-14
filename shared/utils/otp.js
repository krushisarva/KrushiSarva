// ─────────────────────────────────────────────────────────────────────────────
// OTP entry logic — pure, so paste / SMS autofill / auto-submit behaviour can be
// tested without a renderer.
//
// The code field is ONE text input laid over six display cells (see
// shared/screens/LoginScreen.js). It used to be six inputs, which is what broke
// autofill: Android offers an SMS code to the FOCUSED field, and after the first
// digit focus had moved to a box marked autoComplete="off". With one input a
// typed digit, a paste, a keyboard suggestion and an SMS autofill all arrive the
// same way — as the input's whole text.
// ─────────────────────────────────────────────────────────────────────────────

export const OTP_LENGTH = 6;

const asString = (value) => (Array.isArray(value) ? value.join('') : String(value ?? ''));

/**
 * Digits only, capped at `len`. An SMS app or clipboard may hand over "482 913"
 * or "482-913"; the input's maxLength has slack for that, and this strips it.
 */
export function sanitizeOtp(raw, len = OTP_LENGTH) {
  return asString(raw).replace(/\D/g, '').slice(0, len);
}

/**
 * True when one change added more than one digit — an SMS autofill, a keyboard
 * code suggestion or a paste, never a keystroke. Drives the "Auto-filled" banner
 * and the slightly longer pause before auto-submit.
 */
export function arrivedWhole(prev, next, len = OTP_LENGTH) {
  return sanitizeOtp(next, len).length - sanitizeOtp(prev, len).length > 1;
}

/** Index of the cell that shows the caret: the next empty one, or the last. */
export function activeOtpCell(code, len = OTP_LENGTH) {
  return Math.min(sanitizeOtp(code, len).length, len - 1);
}

export function isOtpComplete(code, len = OTP_LENGTH) {
  const s = asString(code);
  return s.length === len && /^\d+$/.test(s);
}

/**
 * Should the code submit itself, without the farmer tapping "Verify"?
 *
 * Guards, in order: the code must be complete; a verify must not already be in
 * flight; and the exact same code must not have been auto-submitted already —
 * otherwise a re-render after a failed attempt would fire a second identical
 * request. `lastSubmitted` is reset by the caller on error / resend / going
 * back, so a farmer retyping the same code by hand is still allowed through.
 */
export function shouldAutoSubmitOtp({ code, verifying, lastSubmitted, len = OTP_LENGTH }) {
  if (!isOtpComplete(code, len)) return false;
  if (verifying) return false;
  return asString(code) !== lastSubmitted;
}
