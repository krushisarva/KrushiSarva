/**
 * shared/services/firebasePhoneAuth.js — Android verifying a number with no
 * code to type (#39).
 *
 * Instant verification (no SMS at all) and auto-retrieval (Play Services reads
 * the SMS) both sign the user in natively and spend the confirmation handle.
 * The farmer sat on the OTP screen waiting for a code that never came.
 */

const mockAuth = { currentUser: null };
const mockAuthListeners = new Set();

jest.mock('@react-native-firebase/auth', () => ({
  getAuth: jest.fn(() => mockAuth),
  signInWithPhoneNumber: jest.fn(),
  signOut: jest.fn(async (auth) => { auth.currentUser = null; }),
  onAuthStateChanged: jest.fn((auth, listener) => {
    mockAuthListeners.add(listener);
    return () => mockAuthListeners.delete(listener);
  }),
  getIdToken: jest.fn(),
}));

const firebase = require('@react-native-firebase/auth');
const {
  sendFirebaseOtp, instantVerificationToken, confirmFirebaseOtp,
} = require('../firebasePhoneAuth');

const PHONE = '9876543210';
const fbUser = (phoneNumber, token = `id-token-for-${phoneNumber}`) => ({
  phoneNumber,
  getIdToken: jest.fn(async () => token),
});
// What RN Firebase does when a native sign-in reaches JS.
const signInNatively = (user) => {
  mockAuth.currentUser = user;
  mockAuthListeners.forEach((l) => l(user));
};

beforeEach(() => {
  mockAuth.currentUser = null;
  mockAuthListeners.clear();
  jest.clearAllMocks();
  firebase.signInWithPhoneNumber.mockResolvedValue({ confirm: jest.fn() });
});

afterEach(() => { jest.useRealTimers(); });

describe('sendFirebaseOtp', () => {
  test('signs a leftover Firebase user out BEFORE sending, so it cannot pass for this verification', async () => {
    mockAuth.currentUser = fbUser(`+91${PHONE}`);

    await sendFirebaseOtp(PHONE);

    expect(firebase.signOut).toHaveBeenCalledTimes(1);
    expect(firebase.signOut.mock.invocationCallOrder[0])
      .toBeLessThan(firebase.signInWithPhoneNumber.mock.invocationCallOrder[0]);
    expect(firebase.signInWithPhoneNumber).toHaveBeenCalledWith(mockAuth, `+91${PHONE}`);
    expect(await instantVerificationToken(PHONE)).toBeNull();
  });

  test('does not sign out when nobody is signed in', async () => {
    await sendFirebaseOtp(PHONE);
    expect(firebase.signOut).not.toHaveBeenCalled();
  });
});

describe('instantVerificationToken', () => {
  test('returns the ID token when Firebase already signed THIS number in', async () => {
    mockAuth.currentUser = fbUser(`+91${PHONE}`, 'instant-token');
    expect(await instantVerificationToken(PHONE)).toBe('instant-token');
  });

  test('ignores a user signed in for a different number', async () => {
    mockAuth.currentUser = fbUser('+919999999999');
    expect(await instantVerificationToken(PHONE, 0)).toBeNull();
  });

  test('waits for a sign-in that reaches JS just after the send resolved', async () => {
    jest.useFakeTimers();
    const pending = instantVerificationToken(PHONE, 1_000);

    await jest.advanceTimersByTimeAsync(200);
    signInNatively(fbUser(`+91${PHONE}`, 'late-token'));

    expect(await pending).toBe('late-token');
    expect(mockAuthListeners.size).toBe(0); // unsubscribed
  });

  test('gives up after the wait when no sign-in comes (the normal SMS case)', async () => {
    jest.useFakeTimers();
    let settled = false;
    const pending = instantVerificationToken(PHONE, 1_000).then((v) => { settled = true; return v; });

    await jest.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(mockAuthListeners.size).toBe(0);
  });
});

describe('confirmFirebaseOtp', () => {
  test('the normal path returns the confirmed user\'s token', async () => {
    const confirmation = { confirm: jest.fn(async () => ({ user: fbUser(`+91${PHONE}`, 'typed-token') })) };
    expect(await confirmFirebaseOtp(confirmation, '123456', PHONE)).toBe('typed-token');
  });

  test('a code Android already auto-retrieved still completes', async () => {
    // The background sign-in spent the handle, so confirm() fails for the right code.
    signInNatively(fbUser(`+91${PHONE}`, 'auto-token'));
    const spent = Object.assign(new Error('session expired'), { code: 'auth/session-expired' });
    const confirmation = { confirm: jest.fn(async () => { throw spent; }) };

    expect(await confirmFirebaseOtp(confirmation, '123456', PHONE)).toBe('auto-token');
  });

  test('a wrong code with nobody signed in still fails', async () => {
    const wrong = Object.assign(new Error('bad code'), { code: 'auth/invalid-verification-code' });
    const confirmation = { confirm: jest.fn(async () => { throw wrong; }) };

    await expect(confirmFirebaseOtp(confirmation, '000000', PHONE)).rejects.toBe(wrong);
  });
});
