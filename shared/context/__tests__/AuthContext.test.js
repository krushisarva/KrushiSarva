/**
 * shared/context/AuthContext.js — the session lifecycle both apps share.
 *
 *   #35  a session the server ends mid-use returns the user to Login
 *   #36  logout revokes server-side (with the push token, #37) before clearing
 *   #38  a restore that cannot reach the server offers Retry, not Login
 *   #39  Firebase verifying the number on the device completes the login
 *   L8   the Resend countdown is 60 s on Firebase — never the 30 s fallback
 */
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';

jest.mock('react-native', () => ({
  Platform: { OS: 'android', select: (spec) => spec.android ?? spec.default },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

jest.mock('../../services/api', () => {
  const expiredListeners = new Set();
  return {
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn() },
    expiredListeners,
    saveTokens: jest.fn(async () => {}),
    clearTokens: jest.fn(async () => {}),
    getAccessToken: jest.fn(async () => 'stored-access'),
    getUserId: jest.fn(async () => 'u1'),
    onSessionExpired: jest.fn((listener) => {
      expiredListeners.add(listener);
      return () => expiredListeners.delete(listener);
    }),
    revokeSessionOnServer: jest.fn(async () => true),
  };
});
jest.mock('../../utils/storage', () => ({
  setLastActiveAt: jest.fn(async () => {}),
  getLastActiveAt: jest.fn(async () => null),
  isSessionIdleExpired: jest.fn(async () => false),
}));
jest.mock('../../constants/config', () => ({
  SESSION_IDLE_TIMEOUT_MS: 7 * 24 * 60 * 60 * 1000,
  FIREBASE_AUTH_ENABLED: true,
}));
jest.mock('../../utils/proofOfWork', () => ({ solveProofOfWork: jest.fn() }));
jest.mock('../../services/socket', () => ({ resetSocket: jest.fn() }));
jest.mock('../../services/pushRegistration', () => ({
  registerForPushNotifications: jest.fn(),
  forgetPushRegistration: jest.fn(),
  getDevicePushToken: jest.fn(() => 'ExponentPushToken[this-device]'),
}));

const apiModule = require('../../services/api');
const api = apiModule.default;
const { resetSocket } = require('../../services/socket');
const {
  AuthProvider, useAuth, resendSeconds, FIREBASE_RESEND_SECONDS, OTP_RESEND_SECONDS,
} = require('../AuthContext');

global.IS_REACT_ACT_ENVIRONMENT = true;

const realConsoleError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((msg, ...rest) => {
    if (String(msg).includes('react-test-renderer is deprecated')) return;
    realConsoleError(msg, ...rest);
  });
});
afterAll(() => console.error.mockRestore());

const ME = { id: 'u1', name: 'Farmer', phone: '9876543210' };
const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

function makePhoneAuth() {
  return {
    sendFirebaseOtp: jest.fn(async () => ({ confirm: jest.fn() })),
    instantVerificationToken: jest.fn(async () => null),
    confirmFirebaseOtp: jest.fn(),
    signOutFirebase: jest.fn(async () => {}),
    firebaseErrorMessage: jest.fn(() => 'firebase message'),
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {});
  }
}

// Unmounted after each test: a signed-in provider keeps its idle-check interval
// running, which would hold the jest process open.
const mounted = [];

async function renderAuth(phoneAuth = makePhoneAuth()) {
  const out = { current: null, phoneAuth };
  function Probe() {
    out.current = useAuth();
    return null;
  }
  await act(async () => {
    mounted.push(TestRenderer.create(<AuthProvider phoneAuth={phoneAuth}><Probe /></AuthProvider>));
  });
  await settle();
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  apiModule.expiredListeners.clear();
  apiModule.getAccessToken.mockResolvedValue('stored-access');
  api.get.mockResolvedValue({ data: { data: ME } });
});

afterEach(() => {
  act(() => { mounted.splice(0).forEach((r) => r.unmount()); });
  jest.useRealTimers();
});

describe('the server ending a session mid-use (#35)', () => {
  test('returns a signed-in user to Login', async () => {
    const auth = await renderAuth();
    expect(auth.current.isLoggedIn).toBe(true);

    await act(async () => { apiModule.expiredListeners.forEach((l) => l()); });
    await settle();

    expect(auth.current.isLoggedIn).toBe(false);
    expect(auth.current.user).toBeNull();
    expect(resetSocket).toHaveBeenCalled();
    expect(apiModule.clearTokens).toHaveBeenCalled();
  });

  test('is ignored when nobody is signed in', async () => {
    apiModule.getAccessToken.mockResolvedValue(null);
    const auth = await renderAuth();

    await act(async () => { apiModule.expiredListeners.forEach((l) => l()); });
    await settle();

    expect(auth.current.isLoggedIn).toBe(false);
    expect(resetSocket).not.toHaveBeenCalled();
  });
});

describe('logout (#36, #37)', () => {
  test('revokes on the server with this device\'s push token, then clears locally', async () => {
    const auth = await renderAuth();

    await act(async () => { await auth.current.logout(); });

    expect(apiModule.revokeSessionOnServer).toHaveBeenCalledWith({ pushToken: 'ExponentPushToken[this-device]' });
    expect(apiModule.revokeSessionOnServer.mock.invocationCallOrder[0])
      .toBeLessThan(apiModule.clearTokens.mock.invocationCallOrder[0]);
    expect(auth.current.isLoggedIn).toBe(false);
  });

  test('still signs out locally when the server cannot be reached', async () => {
    apiModule.revokeSessionOnServer.mockResolvedValueOnce(false);
    const auth = await renderAuth();

    await act(async () => { await auth.current.logout(); });

    expect(apiModule.clearTokens).toHaveBeenCalled();
    expect(auth.current.isLoggedIn).toBe(false);
  });
});

describe('restoring a saved session at startup (#38)', () => {
  test('no signal → Retry state, tokens kept; Retry restores the session', async () => {
    api.get.mockRejectedValueOnce(networkError());
    const auth = await renderAuth();

    expect(auth.current.loading).toBe(false);
    expect(auth.current.isLoggedIn).toBe(false);
    expect(auth.current.restoreFailed).toBe(true);
    expect(apiModule.clearTokens).not.toHaveBeenCalled();

    await act(async () => { await auth.current.retryRestore(); });

    expect(auth.current.isLoggedIn).toBe(true);
    expect(auth.current.restoreFailed).toBe(false);
    expect(auth.current.user).toEqual(ME);
  });

  test('a 5xx is not a verdict on the session either', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('503'), { response: { status: 503 } }));
    const auth = await renderAuth();
    expect(auth.current.restoreFailed).toBe(true);
    expect(apiModule.clearTokens).not.toHaveBeenCalled();
  });

  test('a real expired session still goes to Login', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('401'), {
      response: { status: 401 }, sessionExpired: true, refreshFailed: true,
    }));
    const auth = await renderAuth();

    expect(auth.current.restoreFailed).toBe(false);
    expect(auth.current.isLoggedIn).toBe(false);
    expect(apiModule.clearTokens).toHaveBeenCalled();
  });

  test('retries on its own, with backoff, until the server answers', async () => {
    jest.useFakeTimers();
    api.get
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue({ data: { data: ME } });
    const auth = await renderAuth();
    expect(auth.current.restoreFailed).toBe(true);

    // First retry lands within 2.5–5 s, the second within 5–10 s after it.
    await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(auth.current.isLoggedIn).toBe(false);

    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
    await settle();
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(auth.current.isLoggedIn).toBe(true);
    expect(auth.current.restoreFailed).toBe(false);

    // And stops once restored.
    await act(async () => { await jest.advanceTimersByTimeAsync(120_000); });
    expect(api.get).toHaveBeenCalledTimes(3);
  });
});

describe('Firebase verifying the number on the device (#39)', () => {
  const session = { data: { data: { accessToken: 'a', refreshToken: 'r', user: ME } } };

  test('sendOtp completes the login itself — no code step', async () => {
    apiModule.getAccessToken.mockResolvedValue(null);
    const phoneAuth = makePhoneAuth();
    phoneAuth.instantVerificationToken.mockResolvedValue('instant-id-token');
    api.post.mockResolvedValue(session);
    const auth = await renderAuth(phoneAuth);

    let result;
    await act(async () => { result = await auth.current.sendOtp('9876543210'); });

    expect(result).toEqual({ signedIn: true });
    expect(phoneAuth.instantVerificationToken).toHaveBeenCalledWith('9876543210', expect.any(Number));
    expect(api.post).toHaveBeenCalledWith('/auth/firebase-login', { idToken: 'instant-id-token' });
    expect(auth.current.isLoggedIn).toBe(true);
  });

  test('without it, the normal SMS code step follows', async () => {
    apiModule.getAccessToken.mockResolvedValue(null);
    const auth = await renderAuth();

    let result;
    await act(async () => { result = await auth.current.sendOtp('9876543210'); });

    expect(result).toEqual({});
    expect(api.post).not.toHaveBeenCalled();
    expect(auth.current.isLoggedIn).toBe(false);
  });

  test('a signed-in user re-verifying is never handed a session by the send', async () => {
    const phoneAuth = makePhoneAuth();
    phoneAuth.instantVerificationToken.mockResolvedValue('instant-id-token');
    const auth = await renderAuth(phoneAuth);
    expect(auth.current.isLoggedIn).toBe(true);

    let result;
    await act(async () => { result = await auth.current.sendOtp('9876543210'); });

    expect(result).toEqual({});
    expect(phoneAuth.instantVerificationToken).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  test('verifyOtp passes the phone so an auto-retrieved code still completes', async () => {
    apiModule.getAccessToken.mockResolvedValue(null);
    const phoneAuth = makePhoneAuth();
    phoneAuth.confirmFirebaseOtp.mockResolvedValue('typed-id-token');
    api.post.mockResolvedValue(session);
    const auth = await renderAuth(phoneAuth);

    await act(async () => { await auth.current.sendOtp('9876543210'); });
    await act(async () => { await auth.current.verifyOtp('9876543210', '123456'); });

    expect(phoneAuth.confirmFirebaseOtp).toHaveBeenCalledWith(expect.anything(), '123456', '9876543210');
    expect(auth.current.isLoggedIn).toBe(true);
  });
});

// ── L8: the Resend countdown ────────────────────────────────────────────────
// Firebase refuses a second SMS to the same number inside a minute and resolves
// the request as if it sent one, so a countdown shorter than 60 s hands the
// farmer a Resend that silently does nothing.
describe('the Resend countdown (L8)', () => {
  test('is 60 s while Firebase is the sender', async () => {
    const auth = await renderAuth();
    expect(auth.current.otpResendSeconds).toBe(FIREBASE_RESEND_SECONDS);
    expect(auth.current.otpResendSeconds).toBe(60);
  });

  test('stays 30 s on the MSG91 path', async () => {
    // No adapter injected → the context uses MSG91, which has no send window.
    const auth = await renderAuth(null);
    expect(auth.current.otpResendSeconds).toBe(OTP_RESEND_SECONDS);
    expect(auth.current.otpResendSeconds).toBe(30);
  });

  test('the login screen runs exactly what the context gives it', () => {
    expect(resendSeconds(60)).toBe(60);
    expect(resendSeconds(30)).toBe(30);
    expect(resendSeconds(120)).toBe(120);
  });

  test('a missing or unusable value falls back to the Firebase minute, not 30 s', () => {
    // The old fallback was a hard-coded 30, which on a Firebase build offered a
    // resend at half the window Google enforces.
    [undefined, null, 0, NaN, -5, 'soon'].forEach((bad) => {
      expect(resendSeconds(bad)).toBe(FIREBASE_RESEND_SECONDS);
      expect(resendSeconds(bad)).toBeGreaterThanOrEqual(60);
    });
  });
});
