/**
 * Delete a user's Firebase Authentication record when their account is erased.
 *
 * KrushiSarva stores no Firebase UID: User.phone (10-digit national form) is the
 * only link, and Firebase keys phone sign-ins by the E.164 number. So the record
 * is found with getUserByPhoneNumber('+91' + phone) and then deleted by uid.
 *
 * Kept out of firebaseAuth.service.js on purpose: the API suites replace that
 * module with stubs listing only its login exports, and a new import from it
 * would stop every one of those suites from loading.
 *
 * Best-effort by contract: resolves to an outcome string and never throws, so a
 * Firebase fault cannot fail an erasure that has already committed.
 *   'deleted'   — the record existed and is gone
 *   'not_found' — Firebase holds no record for this number (nothing to delete)
 *   'skipped'   — Firebase sign-in is not configured here, or no real phone
 *   'failed'    — anything else; logged with the userId only
 */
import { ENV } from '../config/env.js';
import logger from '../utils/logger.js';

const APP_NAME = 'krushisarva-auth';
const DELETE_TIMEOUT_MS = 10_000;

export function isFirebaseDeletionConfigured() {
  return Boolean(
    ENV.FIREBASE_AUTH_ENABLED &&
    ENV.FIREBASE_PROJECT_ID &&
    ENV.FIREBASE_CLIENT_EMAIL &&
    ENV.FIREBASE_PRIVATE_KEY
  );
}

async function getAdminAuth() {
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  // Same named app as the login path, so whichever runs first creates it and the
  // other reuses it.
  const app = getApps().find((a) => a.name === APP_NAME)
    || initializeApp({
        credential: cert({
          projectId:   ENV.FIREBASE_PROJECT_ID,
          clientEmail: ENV.FIREBASE_CLIENT_EMAIL,
          privateKey:  ENV.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        projectId: ENV.FIREBASE_PROJECT_ID,
      }, APP_NAME);
  return getAuth(app);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'timeout' })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function deleteByPhone(phone) {
  const auth = await getAdminAuth();
  const { uid } = await auth.getUserByPhoneNumber(`+91${phone}`);
  await auth.deleteUser(uid);
}

export async function deleteFirebaseUserByPhone(phone, { userId, timeoutMs = DELETE_TIMEOUT_MS } = {}) {
  if (!isFirebaseDeletionConfigured()) return 'skipped';
  // An already-erased row carries the `deleted_<id>` sentinel, not a number.
  if (typeof phone !== 'string' || !/^\d{10}$/.test(phone)) return 'skipped';

  try {
    await withTimeout(deleteByPhone(phone), timeoutMs);
    return 'deleted';
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return 'not_found';
    // Only the code: Firebase messages can echo the identifier, i.e. the phone.
    logger.warn({ userId, code: err?.code || 'unknown' }, '[erasure] Firebase sign-in record was not deleted');
    return 'failed';
  }
}
