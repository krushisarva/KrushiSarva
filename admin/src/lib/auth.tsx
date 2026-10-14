/**
 * Admin authentication — phone OTP → JWT (cookie refresh) → ADMIN-only guard.
 *
 * Login reuses the unchanged backend OTP flow (/auth/send-otp, /auth/verify-otp).
 * A non-ADMIN account is hard-rejected client-side (the server ALSO enforces ADMIN
 * on every /admin route — this is just UX). On reload the session is recovered via
 * the httpOnly refresh cookie. An idle-timeout auto-logs-out, mirroring the app.
 *
 * When the build has a Firebase web config (FIREBASE_WEB_ENABLED), the SMS code is
 * sent and checked by Firebase instead, and the resulting ID token goes to
 * /auth/firebase-login with audience 'admin' — the server then refuses any phone
 * whose account is not ADMIN without creating anything. Everything after login
 * (cookies, CSRF, refresh, idle logout) is the same session either way.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isAxiosError } from 'axios';
import { api, apiPost, decodeJwt, getAccessToken, onSessionLost, performRefresh, setAccessToken } from './api';
import {
  FIREBASE_WEB_ENABLED, FirebasePhoneError, RECAPTCHA_CONTAINER_ID, startPhoneSignIn, type PhoneChallenge,
} from './firebasePhone';

const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 min of inactivity → auto-logout

export interface AdminUser {
  id: string;
  role: string;
  name?: string | null;
  phone?: string | null;
}

type Status = 'loading' | 'unauthed' | 'authed';

// /auth/verify-otp and /auth/firebase-login return the same session payload.
interface LoginResponse { accessToken: string; csrfToken?: string; user: AdminUser }

interface AuthState {
  status: Status;
  user: AdminUser | null;
  notAdmin: boolean; // a valid login that turned out NOT to be ADMIN
  sendOtp: (phone: string) => Promise<{ devOtp?: string }>;
  verifyOtp: (phone: string, otp: string) => Promise<void>;
  logout: (reason?: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function resolveUserFromToken(): Promise<AdminUser | null> {
  const token = getAccessToken();
  if (!token) return null;
  const payload = decodeJwt(token);
  if (!payload?.sub) return null;
  const user: AdminUser = { id: payload.sub, role: payload.role || 'FARMER' };
  if (user.role !== 'ADMIN') return user; // caller decides; don't fetch profile
  // Best-effort name for the top bar — never blocks auth.
  try {
    const res = await api.get('/users/me');
    const me = res.data?.data?.user ?? res.data?.data;
    if (me) { user.name = me.name; user.phone = me.phone; }
  } catch { /* ignore — name is cosmetic */ }
  return user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<AdminUser | null>(null);
  const [notAdmin, setNotAdmin] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);

  const logout = useMemo(
    () => async (_reason?: string) => {
      try { await apiPost('/auth/logout'); } catch { /* best-effort */ }
      setAccessToken(null);
      setUser(null);
      setNotAdmin(false);
      setStatus('unauthed');
    },
    [],
  );

  // Recover the session on first load via the refresh cookie.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await performRefresh();
        const u = await resolveUserFromToken();
        if (cancelled) return;
        if (u && u.role === 'ADMIN') { setUser(u); setStatus('authed'); }
        else { setAccessToken(null); setStatus('unauthed'); }
      } catch {
        if (!cancelled) setStatus('unauthed');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // React to a hard session loss surfaced by the axios refresh interceptor.
  useEffect(() => onSessionLost(() => { setUser(null); setStatus('unauthed'); }), []);

  // Idle-timeout auto-logout (only while authenticated).
  useEffect(() => {
    if (status !== 'authed') return;
    const reset = () => {
      window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => { void logout('idle'); }, IDLE_TIMEOUT_MS);
    };
    const events: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'click', 'scroll'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(idleTimer.current);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [status, logout]);

  // Firebase path only: the pending SMS verification (holds the reCAPTCHA widget).
  const challenge = useRef<PhoneChallenge | null>(null);
  const dropChallenge = () => { challenge.current?.dispose(); challenge.current = null; };

  const sendOtp = async (phone: string) => {
    if (FIREBASE_WEB_ENABLED) {
      // Google sends the SMS; there is never a devOtp on this path.
      dropChallenge();
      challenge.current = await startPhoneSignIn(phone, RECAPTCHA_CONTAINER_ID);
      return {};
    }
    // In dev (no SMS provider) the backend returns devOtp so the login screen can
    // show / auto-fill it. It is absent in production (guarded server-side).
    return apiPost<{ sessionId: string; devOtp?: string }>('/auth/send-otp', { phone });
  };

  const firebaseLogin = async (otp: string) => {
    const pending = challenge.current;
    if (!pending) throw new FirebasePhoneError('No verification in progress. Please request a new code.');
    const idToken = await pending.confirm(otp);
    try {
      // audience 'admin' only narrows the route: no session unless this phone's
      // account is ADMIN, and no account, consent row or cookie is created
      // otherwise. Role and scopes are never sent — the server reads its DB.
      const data = await apiPost<LoginResponse>('/auth/firebase-login', { idToken, audience: 'admin' });
      dropChallenge();
      return data;
    } catch (err) {
      const status = isAxiosError(err) ? err.response?.status : undefined;
      // A 4xx is a verdict on this token (not admin, inactive, locked, rejected):
      // the next try needs a new code. A 5xx / network error, or a 429 (only
      // "slow down"), keeps the proven token so "Verify" can be pressed again.
      if (status !== undefined && status < 500 && status !== 429) dropChallenge();
      if (status === 403 && isAxiosError(err) && err.response?.data?.error?.details?.code === 'NOT_ADMIN') {
        setNotAdmin(true);
        setStatus('unauthed');
      }
      throw err;
    }
  };

  const verifyOtp = async (phone: string, otp: string) => {
    const data = FIREBASE_WEB_ENABLED
      ? await firebaseLogin(otp)
      : await apiPost<LoginResponse>('/auth/verify-otp', { phone, otp });
    setAccessToken(data.accessToken);
    const role = data.user?.role || decodeJwt(data.accessToken)?.role;
    if (role !== 'ADMIN') {
      // Valid credentials, wrong role — reject and drop the token.
      setAccessToken(null);
      setNotAdmin(true);
      setStatus('unauthed');
      throw new Error('This account is not an administrator.');
    }
    setNotAdmin(false);
    setUser({ id: data.user.id, role, name: data.user.name, phone: data.user.phone });
    setStatus('authed');
  };

  const value: AuthState = { status, user, notAdmin, sendOtp, verifyOtp, logout };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
