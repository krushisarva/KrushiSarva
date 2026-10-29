/**
 * Unit tests for deleting the Firebase Authentication record on account erasure.
 *
 * Google Play's account-deletion policy expects the sign-in record (it holds the
 * mobile number) to go with the account. The helper is best-effort: it runs after
 * the erasure transaction commits, so it must never throw, must treat "no such
 * user" as done, and must never log the phone number.
 *
 * firebase-admin is stubbed throughout; no test reaches Google.
 */
import { jest } from '@jest/globals';

const FIREBASE_ENV = {
  FIELD_ENCRYPTION_KEY:  'a'.repeat(64),
  FIREBASE_AUTH_ENABLED: 'true',
  FIREBASE_PROJECT_ID:   'krushisarva-test',
  FIREBASE_CLIENT_EMAIL: 'sa@krushisarva-test.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY:  '-----BEGIN PRIVATE KEY-----\\nFAKE\\n-----END PRIVATE KEY-----\\n',
};

const PHONE = '9876543210';
const USER_ID = 'user-erase-1';

const authError = (code) => Object.assign(new Error(`Firebase said ${code} for +91${PHONE}`), { code });

/**
 * ENV is frozen at import, so the env goes in BEFORE the dynamic import and the
 * registry is reset per case.
 */
async function loadHelper({ env = FIREBASE_ENV, getUserByPhoneNumber, deleteUser, initializeApp } = {}) {
  jest.resetModules();
  Object.assign(process.env, env);

  const stubs = {
    getUserByPhoneNumber: getUserByPhoneNumber || jest.fn(async () => ({ uid: 'fb-uid-1' })),
    deleteUser:           deleteUser || jest.fn(async () => undefined),
    initializeApp:        initializeApp || jest.fn(() => ({ name: 'krushisarva-auth' })),
    warn:                 jest.fn(),
  };

  jest.unstable_mockModule('firebase-admin/app', () => ({
    initializeApp: stubs.initializeApp,
    cert:          jest.fn((c) => c),
    getApps:       jest.fn(() => []),
  }));
  jest.unstable_mockModule('firebase-admin/auth', () => ({
    getAuth: jest.fn(() => ({
      getUserByPhoneNumber: stubs.getUserByPhoneNumber,
      deleteUser:           stubs.deleteUser,
    })),
  }));
  jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
    default: { warn: stubs.warn, info: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));

  const mod = await import('../../../src/services/firebaseUserDeletion.service.js');
  return { ...mod, ...stubs };
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(FIREBASE_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('deleteFirebaseUserByPhone', () => {
  test('finds the record by the +91 number and deletes it by uid', async () => {
    const h = await loadHelper();
    await expect(h.deleteFirebaseUserByPhone(PHONE, { userId: USER_ID })).resolves.toBe('deleted');
    expect(h.getUserByPhoneNumber).toHaveBeenCalledWith('+919876543210');
    expect(h.deleteUser).toHaveBeenCalledWith('fb-uid-1');
    expect(h.warn).not.toHaveBeenCalled();
  });

  test('"user not found" counts as done, not as a failure', async () => {
    const h = await loadHelper({
      getUserByPhoneNumber: jest.fn(async () => { throw authError('auth/user-not-found'); }),
    });
    await expect(h.deleteFirebaseUserByPhone(PHONE, { userId: USER_ID })).resolves.toBe('not_found');
    expect(h.deleteUser).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  test('a record that vanishes between lookup and delete also counts as done', async () => {
    const h = await loadHelper({
      deleteUser: jest.fn(async () => { throw authError('auth/user-not-found'); }),
    });
    await expect(h.deleteFirebaseUserByPhone(PHONE, { userId: USER_ID })).resolves.toBe('not_found');
    expect(h.warn).not.toHaveBeenCalled();
  });

  test('any other error resolves to "failed" and logs the userId, never the phone', async () => {
    const h = await loadHelper({
      deleteUser: jest.fn(async () => { throw authError('auth/internal-error'); }),
    });
    await expect(h.deleteFirebaseUserByPhone(PHONE, { userId: USER_ID })).resolves.toBe('failed');
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][0]).toEqual({ userId: USER_ID, code: 'auth/internal-error' });
    expect(JSON.stringify(h.warn.mock.calls)).not.toMatch(/9876543210/);
  });

  test('a failure to initialise firebase-admin resolves to "failed", it does not throw', async () => {
    const h = await loadHelper({
      initializeApp: jest.fn(() => { throw new Error('bad service account'); }),
    });
    await expect(h.deleteFirebaseUserByPhone(PHONE, { userId: USER_ID })).resolves.toBe('failed');
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  test('a Firebase call that hangs is cut off and resolves to "failed"', async () => {
    const h = await loadHelper({
      getUserByPhoneNumber: jest.fn(() => new Promise(() => {})),
    });
    await expect(h.deleteFirebaseUserByPhone(PHONE, { userId: USER_ID, timeoutMs: 20 })).resolves.toBe('failed');
    expect(h.warn.mock.calls[0][0]).toEqual({ userId: USER_ID, code: 'timeout' });
  });

  test('skipped when Firebase sign-in is switched off', async () => {
    const h = await loadHelper({ env: { ...FIREBASE_ENV, FIREBASE_AUTH_ENABLED: 'false' } });
    expect(h.isFirebaseDeletionConfigured()).toBe(false);
    await expect(h.deleteFirebaseUserByPhone(PHONE, { userId: USER_ID })).resolves.toBe('skipped');
    expect(h.getUserByPhoneNumber).not.toHaveBeenCalled();
    expect(h.initializeApp).not.toHaveBeenCalled();
  });

  test('skipped when the service account is incomplete', async () => {
    const h = await loadHelper({ env: { ...FIREBASE_ENV, FIREBASE_PRIVATE_KEY: '' } });
    await expect(h.deleteFirebaseUserByPhone(PHONE, { userId: USER_ID })).resolves.toBe('skipped');
    expect(h.getUserByPhoneNumber).not.toHaveBeenCalled();
  });

  test('skipped for an already-erased row, whose phone is the deleted_ sentinel', async () => {
    const h = await loadHelper();
    await expect(h.deleteFirebaseUserByPhone(`deleted_${USER_ID}`, { userId: USER_ID })).resolves.toBe('skipped');
    await expect(h.deleteFirebaseUserByPhone(null, { userId: USER_ID })).resolves.toBe('skipped');
    expect(h.getUserByPhoneNumber).not.toHaveBeenCalled();
  });
});
