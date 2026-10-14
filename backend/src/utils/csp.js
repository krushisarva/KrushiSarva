/**
 * Content-Security-Policy additions for Firebase phone auth in a browser.
 *
 * The admin SPA is served same-origin at /admin, so it runs under the backend's
 * CSP. app.js applies these additions on /admin only (when FIREBASE_AUTH_ENABLED);
 * every other response keeps the global policy. helmet's defaults (`script-src 'self'`, and no
 * `connect-src` / `frame-src`, so both fall back to `default-src 'self'`) block
 * the Firebase web SDK's phone sign-in outright:
 *   - RecaptchaVerifier injects https://www.google.com/recaptcha/api.js (or
 *     enterprise.js), which in turn loads its code from www.gstatic.com/recaptcha/;
 *   - the reCAPTCHA widget and challenge are iframes on www.google.com/recaptcha/
 *     and recaptcha.google.com/recaptcha/ (Google's published CSP for reCAPTCHA);
 *   - sending the SMS and confirming the code are XHRs to identitytoolkit, and an
 *     ID-token refresh goes to securetoken.
 *
 * Path-scoped sources, not bare hosts: www.google.com serves far more than
 * reCAPTCHA. Nothing is added for the Firebase auth-domain iframe or
 * apis.google.com — those serve popup/redirect sign-in, which the admin client
 * does not use (it initialises Auth without a popupRedirectResolver).
 */
const FIREBASE_PHONE_AUTH_SOURCES = Object.freeze({
  'script-src':  ['https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'],
  'frame-src':   ['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/'],
  'connect-src': ['https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com'],
});

/**
 * Return a copy of helmet-style `directives` that also allows Firebase phone
 * auth. Every other directive is passed through untouched. A directive that was
 * not set starts from `default-src` (what the browser would have fallen back
 * to), so adding it never loosens anything beyond the listed sources.
 *
 * @param {Record<string, string[]>} directives
 * @returns {Record<string, string[]>}
 */
export function withFirebasePhoneAuthCsp(directives) {
  const out = { ...directives };
  const base = directives['default-src'] || ["'self'"];
  for (const [name, sources] of Object.entries(FIREBASE_PHONE_AUTH_SOURCES)) {
    out[name] = [...(directives[name] || base), ...sources];
  }
  return out;
}
