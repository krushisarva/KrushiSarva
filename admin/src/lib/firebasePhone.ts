/**
 * Firebase phone auth for the admin login (Firebase JS web SDK).
 *
 * WHY: the backend's own OTP route sends no SMS and 503s in production. The
 * farmer and seller apps sign in through Firebase (Google is the registered
 * SMS sender); this is the same proof for the admin panel. The ID
 * token goes to the SAME /auth/firebase-login route the apps use, with
 * `audience: 'admin'` (see auth.tsx) so the server refuses a non-ADMIN phone
 * without creating anything.
 *
 * OFF unless all four required VITE_FIREBASE_* values were set at build time.
 * Off, the login screen uses the dev OTP flow, which works only against a
 * development backend. The SDK itself is loaded with
 * a dynamic import() on first use, so it never runs, or loads, on an OTP-only
 * build.
 *
 * The web config is public (it identifies the Firebase project; it grants
 * nothing). It must belong to the SAME project as the backend's service account
 * (FIREBASE_PROJECT_ID), or the backend rejects every token on `aud`.
 */
import type { Auth, ConfirmationResult, RecaptchaVerifier } from 'firebase/auth';

const read = (v?: string) => (v ?? '').trim();

const config = {
  apiKey:            read(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain:        read(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId:         read(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  appId:             read(import.meta.env.VITE_FIREBASE_APP_ID),
  messagingSenderId: read(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID) || undefined,
  storageBucket:     read(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET) || undefined,
};

export const FIREBASE_WEB_ENABLED = Boolean(
  config.apiKey && config.authDomain && config.projectId && config.appId,
);

/** Element the (invisible) reCAPTCHA renders into — Login.tsx mounts it. */
export const RECAPTCHA_CONTAINER_ID = 'recaptcha-container';

// The invisible reCAPTCHA can escalate to an image challenge. If the admin closes
// it, the SDK's RecaptchaVerifier.verify() never settles (no reject path, no
// timeout), so sending would spin forever. Give up after this long instead.
const RECAPTCHA_TIMEOUT_MS = 2 * 60 * 1000;

/** An error whose message is already safe to show on the login screen. */
export class FirebasePhoneError extends Error {
  readonly code: string;
  constructor(message: string, code = '') {
    super(message);
    this.name = 'FirebasePhoneError';
    this.code = code;
  }
}

// ── Lazy SDK load ────────────────────────────────────────────────────────────
const APP_NAME = 'krushisarva-admin';
type AuthModule = typeof import('firebase/auth');
let loading: Promise<{ fb: AuthModule; auth: Auth }> | null = null;

function loadAuth() {
  if (!loading) {
    loading = (async () => {
      const [{ initializeApp, getApps }, fb] = await Promise.all([
        import('firebase/app'),
        import('firebase/auth'),
      ]);
      const app = getApps().find((a) => a.name === APP_NAME) ?? initializeApp(config, APP_NAME);
      // In-memory persistence: nothing Firebase-side survives a reload, the same
      // rule api.ts follows for our own access token. No popupRedirectResolver:
      // phone auth never needs the auth-domain iframe, so it is never loaded.
      const auth = fb.initializeAuth(app, { persistence: fb.inMemoryPersistence });
      return { fb, auth };
    })();
    // A failed chunk download (flaky network) must not wedge every later try.
    loading.catch(() => { loading = null; });
  }
  return loading;
}

// ── Phone number ─────────────────────────────────────────────────────────────
/**
 * Any user-typed Indian mobile → E.164 (+91XXXXXXXXXX), or null. Mirrors the
 * backend's digit fallback (backend/src/utils/phone.js): drop a leading 91 / 0
 * only when exactly 10 digits remain, then require a 6-9 start.
 */
export function toIndianE164(input: string): string | null {
  const digits = input.replace(/\D/g, '').replace(/^(?:91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

// ── Sign-in ──────────────────────────────────────────────────────────────────
export interface PhoneChallenge {
  /** Confirm the SMS code. Resolves the Firebase ID token for the backend. */
  confirm(code: string): Promise<string>;
  /** Remove the reCAPTCHA widget. Safe to call more than once. */
  dispose(): void;
}

/**
 * Send the SMS code (Google sends it) after an invisible reCAPTCHA check.
 * @param phone        what the admin typed (10-digit, +91 / 0 prefixes accepted)
 * @param containerId  id of an element that stays mounted until confirm()
 */
export async function startPhoneSignIn(phone: string, containerId: string): Promise<PhoneChallenge> {
  const e164 = toIndianE164(phone);
  if (!e164) {
    throw new FirebasePhoneError('Enter a valid 10-digit Indian mobile number.', 'auth/invalid-phone-number');
  }

  let sdk: { fb: AuthModule; auth: Auth };
  try {
    sdk = await loadAuth();
  } catch {
    throw new FirebasePhoneError('Could not load phone sign-in. Check your connection and try again.');
  }
  const { fb, auth } = sdk;

  const host = document.getElementById(containerId);
  if (!host) throw new FirebasePhoneError('Phone sign-in is not ready. Reload the page and try again.');

  // A fresh element per attempt. An invisible reCAPTCHA renders straight into
  // the element it is given, and grecaptcha refuses to render twice into one, so
  // reusing the container would break "use a different number" and resends.
  const el = document.createElement('div');
  host.appendChild(el);
  let verifier: RecaptchaVerifier | null = null;
  const dispose = () => {
    try { verifier?.clear(); } catch { /* already cleared */ }
    verifier = null;
    el.remove();
  };

  let confirmation: ConfirmationResult;
  let timer: number | undefined;
  try {
    verifier = new fb.RecaptchaVerifier(auth, el, { size: 'invisible' });
    // Start signed out, so nothing left from an earlier attempt can stand in
    // for this verification.
    if (auth.currentUser) await fb.signOut(auth);
    const timedOut = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new FirebasePhoneError(
        'The security check was not completed. Please try again.', 'recaptcha-timeout',
      )), RECAPTCHA_TIMEOUT_MS);
    });
    confirmation = await Promise.race([fb.signInWithPhoneNumber(auth, e164, verifier), timedOut]);
  } catch (err) {
    dispose();
    throw toFirebasePhoneError(err);
  } finally {
    window.clearTimeout(timer);
  }

  let idToken: string | null = null;
  return {
    async confirm(code: string) {
      // Already proven: the backend call is being retried after a 5xx / network
      // blip, and a spent confirmation cannot be confirmed twice.
      if (idToken) return idToken;
      try {
        const credential = await confirmation.confirm(code.trim());
        idToken = await credential.user.getIdToken();
      } catch (err) {
        throw toFirebasePhoneError(err);
      }
      // Our backend session is what grants access; the Firebase one has no use
      // after this, and leaving it signed in could mint fresh proofs later.
      await fb.signOut(auth).catch(() => {});
      dispose();
      return idToken;
    },
    dispose,
  };
}

// ── Errors ───────────────────────────────────────────────────────────────────
// Ported from shared/services/firebasePhoneAuth.js firebaseErrorMessage, plus the
// web-only reCAPTCHA / domain cases. Firebase codes are stable; their raw
// messages are developer-facing, so unknown codes get a generic line + the code.
function toFirebasePhoneError(err: unknown): FirebasePhoneError {
  if (err instanceof FirebasePhoneError) return err;
  const code = String((err as { code?: unknown })?.code || '');
  return new FirebasePhoneError(messageFor(code), code);
}

function messageFor(code: string): string {
  // e.g. auth/requests-from-referer-<empty>-are-blocked. — an HTTP-referrer
  // restriction on the web API key (see admin/README.md: restrict by API instead).
  if (code.startsWith('auth/requests-from-referer-')) {
    return 'Phone sign-in is misconfigured (the Firebase web API key blocks this site).';
  }
  switch (code) {
    case 'auth/invalid-phone-number':
      return 'That phone number is not valid.';
    case 'auth/invalid-verification-code':
      return 'Invalid or expired code.';
    case 'auth/code-expired':
    case 'auth/session-expired':
      return 'That code has expired. Please request a new one.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later.';
    case 'auth/quota-exceeded':
      return 'SMS is temporarily unavailable. Please try again later.';
    case 'auth/network-request-failed':
      return 'Network problem. Check your connection and try again.';
    case 'auth/captcha-check-failed':
    case 'auth/invalid-app-credential':
    case 'auth/missing-app-credential':
      return 'The security check failed. Please try again. If it keeps failing, this site may be missing from Firebase Authorized domains.';
    case 'auth/unauthorized-domain':
      return 'This site is not in Firebase Authentication → Authorized domains.';
    case 'auth/operation-not-allowed':
      return 'Phone sign-in is not enabled for this Firebase project.';
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid.-please-pass-a-valid-api-key.':
      return 'Phone sign-in is misconfigured (Firebase web API key).';
    default:
      return `Could not verify your phone number${code ? ` (${code})` : ''}. Please try again.`;
  }
}
