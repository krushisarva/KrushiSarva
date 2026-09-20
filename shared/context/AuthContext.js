/**
 * AuthContext — handles OTP auth, token storage, and user state.
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Platform, AppState } from 'react-native';
import api, {
  saveTokens, clearTokens, getAccessToken, getUserId, onSessionExpired, revokeSessionOnServer,
} from '../services/api';
import { setLastActiveAt, getLastActiveAt, isSessionIdleExpired } from '../utils/storage';
import { SESSION_IDLE_TIMEOUT_MS, FIREBASE_AUTH_ENABLED } from '../constants/config';
import { solveProofOfWork } from '../utils/proofOfWork';
import { resetSocket } from '../services/socket';
import { isDefinitiveAuthFailure } from '../services/authFailure';
import {
  registerForPushNotifications, forgetPushRegistration, getDevicePushToken,
} from '../services/pushRegistration';

const AuthContext = createContext(null);

// How often to re-check idle while the app is open, and how often to persist the
// activity stamp (throttled so frequent navigation doesn't hammer SecureStore).
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;
const ACTIVITY_PERSIST_THROTTLE_MS = 60 * 1000;

// Background retries of a session restore that could not reach the server:
// jittered exponential backoff from ~5 s up to a 60 s ceiling.
const RESTORE_RETRY_BASE_MS = 5_000;
const RESTORE_RETRY_MAX_MS  = 60_000;

// How long to wait after a Firebase send for an on-device verification to land
// (see firebasePhoneAuth.instantVerificationToken). Android only — iOS has no
// instant verification. Resolves early the moment the sign-in arrives.
const INSTANT_VERIFY_WAIT_MS = Platform.OS === 'android' ? 1_000 : 0;

// How long "Resend" stays disabled, per provider. Firebase will not send a
// second SMS for the same number inside a minute — and the modular
// signInWithPhoneNumber() of @react-native-firebase v26 takes no force-resend
// argument (only the removed namespaced API did), so a resend before then
// resolves as if it worked while no SMS is sent. MSG91 has no such window, so
// that path keeps the shorter wait.
export const FIREBASE_RESEND_SECONDS = 60;
export const OTP_RESEND_SECONDS = 30;

/**
 * The countdown the login screen runs after a code was sent.
 *
 * Normally just `otpResendSeconds` from this context. The fallback — for a
 * value that never arrived, or arrived as 0/NaN — is the FIREBASE number on
 * purpose, because the two failure modes are not symmetric: waiting 60 s on
 * MSG91 costs a farmer half a minute, while offering "Resend" after 30 s on
 * Firebase burns their one chance (it resolves as if it sent, and no SMS
 * comes). Lives here so the screen reuses these constants instead of keeping
 * its own copy that could drift.
 */
export function resendSeconds(otpResendSeconds) {
  const n = Number(otpResendSeconds);
  return Number.isFinite(n) && n > 0 ? n : FIREBASE_RESEND_SECONDS;
}

/**
 * `phoneAuth` — optional Firebase Phone Auth adapter, INJECTED by the app rather
 * than imported here on purpose.
 *
 * shared/ is bundled into BOTH apps (seller-app pulls ../shared through Metro
 * watchFolders). @react-native-firebase/auth is a native module installed only in
 * frontend/, and Metro resolves every require statically — so importing it in this
 * file put an unresolvable module in seller-app's graph and broke its bundle
 * outright, regardless of any runtime feature flag. Injection keeps the module in
 * the one app that actually has it.
 *
 * Pass `{ sendFirebaseOtp, confirmFirebaseOtp, signOutFirebase, firebaseErrorMessage }`
 * (see shared/services/firebasePhoneAuth.js). When absent, the MSG91 path is used.
 */
export function AuthProvider({ children, phoneAuth = null }) {
  // Firebase is used only when the build enabled it AND the host app supplied the
  // adapter. Web is excluded: @react-native-firebase is native-only, so a web
  // build must keep using MSG91 rather than crash on a missing module.
  const useFirebase = Boolean(
    FIREBASE_AUTH_ENABLED && phoneAuth && Platform.OS !== 'web'
  );
  const [user, setUser] = useState(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  // A saved session exists but could not be checked (no signal, timeout, 5xx).
  // The apps show "Can't reach the server — Retry" instead of Login for it.
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // Read by callbacks that must not act on a stale render's value.
  const isLoggedInRef = useRef(false);
  isLoggedInRef.current = isLoggedIn;

  // In-memory last-activity time (authoritative for interval checks) + a
  // throttle marker so we only persist roughly once a minute.
  const lastActiveRef  = useRef(Date.now());
  const lastPersistRef = useRef(0);

  // Pending Firebase phone-verification handle (holds the verificationId between
  // "send code" and "confirm code"). Only used when FIREBASE_AUTH_ENABLED. A ref,
  // not state, because changing it must not re-render the login screen mid-entry.
  const fbConfirmationRef = useRef(null);

  // Record user activity. Updates the in-memory clock immediately and persists
  // it (throttled, or forced on key transitions like login/foreground).
  const markActivity = useCallback((force = false) => {
    const now = Date.now();
    lastActiveRef.current = now;
    if (force || now - lastPersistRef.current > ACTIVITY_PERSIST_THROTTLE_MS) {
      lastPersistRef.current = now;
      setLastActiveAt(now).catch(() => {});
    }
  }, []);

  // Everything signing out means on THIS device. Shared by logout and by a
  // session the server ended mid-use (onSessionExpired below).
  const endLocalSession = useCallback(async () => {
    resetSocket();
    // Forget the memo so the NEXT person to log in on this device re-POSTs the
    // token and claims it. The token belongs to the device, but the row maps it
    // to a user — without this, their pushes would keep arriving against the
    // previous user's row. The server's upsert reassigns userId on conflict,
    // which handles it, but only if the token is actually sent again.
    forgetPushRegistration();
    // Firebase keeps its own session alongside ours. Left signed in, a later
    // getIdToken() could mint a fresh proof for the account just logged out.
    // Best-effort and never throws — clearing OUR tokens below is what matters.
    if (useFirebase) {
      fbConfirmationRef.current = null;
      await phoneAuth.signOutFirebase();
    }
    await clearTokens();
    setUser(null);
    setIsLoggedIn(false);
    setRestoreFailed(false);
  }, [useFirebase, phoneAuth]);

  // Defined here (before the idle-enforcement callbacks that call it) so those
  // callbacks can list it in their deps without a temporal-dead-zone error.
  const logout = useCallback(async () => {
    // Server first, while this device can still authenticate: revoke the
    // refresh token (the old body-less call left it valid) and drop this
    // device's push token so the account stops receiving pushes here. Bounded,
    // never throws — a dead connection must not keep anyone signed in.
    await revokeSessionOnServer({ pushToken: getDevicePushToken() });
    await endLocalSession();
  }, [endLocalSession]);

  // The server ended the session mid-use: a refresh was refused (or may have
  // spent the token — see performRefresh). The tokens are already cleared; the
  // UI has to follow, or the app keeps looking signed in while every screen
  // fails. Nobody signed in → nothing to do: a failed refresh during login or
  // the startup restore is handled where it happens.
  useEffect(() => onSessionExpired(() => {
    if (isLoggedInRef.current) endLocalSession().catch(() => {});
  }), [endLocalSession]);

  // Log out if idle past the timeout. Uses the most recent of the in-memory and
  // persisted stamps (persisted survives an app restart). Returns true if it
  // logged the user out.
  const enforceIdleTimeout = useCallback(async () => {
    let last = lastActiveRef.current;
    try {
      const persisted = await getLastActiveAt();
      if (persisted != null) last = Math.max(last, persisted);
    } catch { /* fall back to in-memory */ }

    if (Date.now() - last > SESSION_IDLE_TIMEOUT_MS) {
      await logout();
      return true;
    }
    return false;
  }, [logout]);

  // Check for existing session on mount.
  // On web the access token lives only in memory (gone after a reload), but the
  // refresh token persists in an httpOnly cookie — so we still attempt
  // /users/me: the request 401s with no token and the api interceptor silently
  // refreshes from the cookie, restoring the session securely across reloads.
  // On native we require a stored access token before hitting the API.
  //
  // Also the Retry for a restore that could not reach the server. Concurrent
  // callers (the Retry button, the backoff timer, a return to the foreground)
  // share one attempt.
  const restoreInFlightRef = useRef(null);
  const restoreSession = useCallback(() => {
    if (restoreInFlightRef.current) return restoreInFlightRef.current;
    setRestoring(true);
    const attempt = (async () => {
      try {
        // Idle gate BEFORE restoring: if the last recorded activity is older than
        // the idle window, force a clean logout instead of resurrecting a stale
        // session that would otherwise linger until the first 401.
        if (await isSessionIdleExpired()) {
          await clearTokens(); // also drops the idle stamp
          setRestoreFailed(false);
          return;
        }

        const token = await getAccessToken();
        if (token || Platform.OS === 'web') {
          const { data } = await api.get('/users/me');
          setUser(data.data);
          setIsLoggedIn(true);
          setRestoreFailed(false);
          markActivity(true); // start a fresh idle clock on restore
          // Register on RESTORE as well as on login. A returning farmer opens the
          // app with a stored session and never touches verifyOtp, so without
          // this only brand-new logins would ever have a push token — which is
          // almost nobody after the first week. Also the natural place to pick up
          // a token Expo rotated while the app was closed.
          registerForPushNotifications();
        }
      } catch (err) {
        // Same rule as performRefresh: only a definitive rejection ends the
        // session. A cold start with no usable signal is routine in a field, and
        // clearing here on any error meant an app-open on a dead cell logged the
        // farmer out permanently — the one failure a farmer cannot recover from
        // without re-verifying a phone number.
        //
        // On a transport failure (no response, timeout, 5xx, 429) we keep the
        // tokens and say so. This used to fall through to Login with the tokens
        // still stored and nothing retrying — so a farmer who opened the app
        // with no signal was asked for an OTP they could not receive, for a
        // session that was fine. restoreFailed shows "Can't reach the server —
        // Retry" instead, and the effect below keeps retrying.
        if (err?.sessionExpired || isDefinitiveAuthFailure(err)) {
          await clearTokens().catch(() => {});
          setRestoreFailed(false);
        } else {
          setRestoreFailed(true);
        }
      } finally {
        setLoading(false);
        setRestoring(false);
        restoreInFlightRef.current = null;
      }
    })();
    restoreInFlightRef.current = attempt;
    return attempt;
  }, [markActivity]);

  useEffect(() => { restoreSession(); }, [restoreSession]);

  // Restore failed for want of a server: keep trying without the farmer having
  // to — on a jittered backoff (so a fleet coming back after an outage does not
  // arrive in lockstep) and at once on return to the foreground, the usual
  // moment signal is back. Stops as soon as the session is restored or ended.
  useEffect(() => {
    if (!restoreFailed) return undefined;
    let attempt = 0;
    let timer = null;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      const ceiling = Math.min(RESTORE_RETRY_MAX_MS, RESTORE_RETRY_BASE_MS * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(
        () => { restoreSession().then(schedule); },
        Math.round(ceiling * (0.5 + Math.random() * 0.5)),
      );
    };
    schedule();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') restoreSession();
    });
    return () => { stopped = true; clearTimeout(timer); sub.remove(); };
  }, [restoreFailed, restoreSession]);

  // While logged in: re-check idle on a timer and whenever the app returns to the
  // foreground (catches "backgrounded / phone locked for days then reopened").
  useEffect(() => {
    if (!isLoggedIn) return;

    const interval = setInterval(() => { enforceIdleTimeout(); }, IDLE_CHECK_INTERVAL_MS);

    const sub = AppState.addEventListener('change', async (state) => {
      if (state === 'active') {
        const loggedOut = await enforceIdleTimeout();
        if (!loggedOut) markActivity(true);
      } else {
        // Going to background/inactive: flush the latest activity time so a long
        // background (or an app kill) is measured from real last-use.
        setLastActiveAt(lastActiveRef.current).catch(() => {});
      }
    });

    return () => { clearInterval(interval); sub.remove(); };
  }, [isLoggedIn, enforceIdleTimeout, markActivity]);

  // All callbacks are memoised with stable identities. Without this, every
  // AuthProvider render creates new function references; consumers that list
  // these in effect deps (e.g. ProfileScreen's useFocusEffect → refreshUser)
  // would re-run on every render, and refreshUser → setUser → render forms an
  // infinite request loop. useCallback + useMemo break that cycle.

  // Store a freshly issued session and sign the user in. Every way a login can
  // complete ends here: a typed code (either provider) or Firebase verifying
  // the number on the device.
  const startSession = useCallback(async (data) => {
    if (data.data?.accessToken) {
      await saveTokens({
        accessToken: data.data.accessToken,
        refreshToken: data.data.refreshToken,
        userId: data.data.user?.id,
      });
      setUser(data.data.user);
      setRestoreFailed(false);
      setIsLoggedIn(true);
      markActivity(true); // start the idle clock at login
      // Fire-and-forget on purpose: registration needs a permission prompt and a
      // network round trip, and neither should stand between a farmer and their
      // home screen. It never throws — see pushRegistration.js.
      registerForPushNotifications();
    }
    return data;
  }, [markActivity]);

  const sendOtp = useCallback(async (phone) => {
    // ── Firebase path (while DLT registration is pending) ────────────────────
    // Google sends the SMS because it is the DLT-registered sender; MSG91 cannot
    // deliver to Indian numbers until our own registration is approved. Returns
    // no devOtp — there is nothing to auto-fill, a real SMS arrives.
    if (useFirebase) {
      let idToken = null;
      try {
        fbConfirmationRef.current = await phoneAuth.sendFirebaseOtp(phone);
        // Login only. A signed-in user sending a code is re-verifying before an
        // irreversible action (confirmReauthCode) and must not get a new session.
        if (!isLoggedInRef.current && phoneAuth.instantVerificationToken) {
          idToken = await phoneAuth.instantVerificationToken(phone, INSTANT_VERIFY_WAIT_MS);
        }
      } catch (err) {
        // LoginScreen reads err.userMessage first — give it a farmer-readable one.
        err.userMessage = phoneAuth.firebaseErrorMessage(err);
        throw err;
      }
      if (!idToken) return {};

      // Android verified the number on the device: no SMS is coming and there
      // is no code to type, so finish the login here. `signedIn` tells the
      // login screen not to move to the code step. If this request fails the
      // farmer stays on the number step with the error, and sending again
      // re-verifies from scratch.
      const { data } = await api.post('/auth/firebase-login', { idToken });
      fbConfirmationRef.current = null;
      await startSession(data);
      return { signedIn: Boolean(data.data?.accessToken) };
    }

    try {
      const { data } = await api.post('/auth/send-otp', { phone });
      return data;
    } catch (err) {
      // Under suspicion the server replies 428 with a proof-of-work challenge.
      // Solve it transparently and retry once — legit users just wait ~a second.
      const pow = err?.response?.status === 428 && err.response.data?.error?.details?.proofOfWork;
      if (!pow) throw err;
      const solution = await solveProofOfWork(pow);
      if (!solution) throw err; // couldn't solve in budget → surface original error
      const { data } = await api.post('/auth/send-otp', { phone }, {
        headers: { 'x-otp-pow': JSON.stringify(solution) },
      });
      return data;
    }
  }, [useFirebase, phoneAuth, startSession]);

  const verifyOtp = useCallback(async (phone, otp) => {
    let data;

    if (useFirebase) {
      // Firebase checks the code and returns a Google-signed ID token; the
      // backend verifies that token and mints OUR session. The 6-digit code
      // never reaches our server on this path.
      let idToken;
      try {
        // `phone` lets a code Android already auto-retrieved still complete.
        idToken = await phoneAuth.confirmFirebaseOtp(fbConfirmationRef.current, otp, phone);
      } catch (err) {
        err.userMessage = phoneAuth.firebaseErrorMessage(err);
        throw err;
      }
      // Clear the handle ONLY after the backend accepts the token. Clearing it
      // here used to strand the user: one flaky request on a field connection and
      // both the handle and the token were gone, so "Invalid code" appeared for a
      // code that was correct and the farmer had to burn another SMS. Firebase
      // has already consumed the code either way, so on a transport failure we
      // keep the confirmation and let them retry the same code.
      ({ data } = await api.post('/auth/firebase-login', { idToken }));
      fbConfirmationRef.current = null;
    } else {
      ({ data } = await api.post('/auth/verify-otp', { phone, otp }));
    }

    return startSession(data);
  }, [startSession, useFirebase, phoneAuth]);

  const updateUser = useCallback((updates) => {
    setUser((prev) => (prev ? { ...prev, ...updates } : prev));
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await api.get('/users/me');
      setUser(data.data);
    } catch {
      // ignore
    }
  }, []);

  /**
   * Exchange the SMS code for a Firebase ID token WITHOUT minting a session.
   *
   * Login and re-authorisation need different things from the same challenge:
   * verifyOtp() trades the code for OUR session, which is wrong for a user who
   * is already signed in and is instead proving they still hold the handset
   * before an irreversible action. This returns the raw token so the caller can
   * hand it to a route that re-checks it (account erasure, phone change).
   *
   * Call sendOtp() first — it stores the confirmation handle this reads.
   */
  const confirmReauthCode = useCallback(async (code) => {
    if (!useFirebase) {
      throw new Error('Phone re-verification is unavailable in this build.');
    }
    try {
      return await phoneAuth.confirmFirebaseOtp(fbConfirmationRef.current, code);
    } catch (err) {
      err.userMessage = phoneAuth.firebaseErrorMessage(err);
      throw err;
    }
  }, [useFirebase, phoneAuth]);

  const value = useMemo(
    () => ({
      user, isLoggedIn, loading, sendOtp, verifyOtp, confirmReauthCode, logout, updateUser, refreshUser, markActivity,
      restoreFailed, restoring, retryRestore: restoreSession,
      // The login screen's Resend countdown. Provider-dependent, so it is
      // decided here rather than hard-coded next to the button.
      otpResendSeconds: useFirebase ? FIREBASE_RESEND_SECONDS : OTP_RESEND_SECONDS,
    }),
    [user, isLoggedIn, loading, sendOtp, verifyOtp, confirmReauthCode, logout, updateUser, refreshUser, markActivity,
     restoreFailed, restoring, restoreSession, useFirebase]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export default AuthContext;
