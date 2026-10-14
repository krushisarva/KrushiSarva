/**
 * OTP Service — the development login. No SMS is ever sent: the code is logged
 * and returned to the caller for auto-fill. Production SMS sign-in is Firebase
 * Phone Auth (firebaseAuth.service.js); outside development sendOtp() refuses.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../config/db.js';
import { ENV } from '../config/env.js';
import logger from '../utils/logger.js';
import { sendPushToUser, NOTIFICATION_CATEGORIES } from './push.service.js';
import { checkOtpLock, recordOtpFailure, clearOtpLockout } from './otpLockout.service.js';

function generateOtp() {
  // [FIX #8] Use crypto.randomInt — cryptographically secure, not Math.random()
  return String(crypto.randomInt(100000, 999999));
}

/**
 * Send OTP to phone number.
 * Creates an OtpSession in DB (hashed).
 * Returns { sessionId } on success.
 */
export async function sendOtp(phone) {
  // This path cannot deliver the code to the phone's owner: it hands the code
  // back to the CALLER and prints it to the log — fine on a developer's machine,
  // a complete sign-in bypass anywhere else (anyone could request a code for any
  // number and read it from the response). Fail closed before a session is even
  // created.
  if (!ENV.IS_DEV) {
    const err = new Error('SMS sign-in is not available right now. Please try again later.');
    err.statusCode = 503;
    err.expose = true;
    err.code = 'OTP_DELIVERY_UNAVAILABLE';
    throw err;
  }

  const otp = generateOtp();
  // [FIX #20] Increase bcrypt rounds from 8 to 10 for OTP hashing
  const hashed = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + ENV.OTP_EXPIRE_MINUTES * 60 * 1000);

  // Invalidate any existing un-verified sessions for this phone
  await prisma.otpSession.updateMany({
    where: { phone, verified: false },
    data: { attempts: ENV.OTP_MAX_ATTEMPTS }, // max out so they expire
  });

  const session = await prisma.otpSession.create({
    data: { phone, otp: hashed, expiresAt },
  });

  // Unreachable in production: the guard at the top of this function throws first.
  console.log(`[OTP DEV] Phone: ${phone} | OTP: ${otp}`);
  // Return the OTP in the response so the dev app can auto-fill it.
  return { sessionId: session.id, devOtp: otp };
}

/**
 * Verify OTP. Returns { success, userId? } on success.
 * On failure: { success: false, reason, locked?, retryAfterSec? }.
 * userId is set if this phone already has a registered user.
 *
 * Brute-force protection: repeated wrong OTPs lock the number (exponential
 * backoff) — see otpLockout.service.js. A locked number is rejected before the
 * OTP is even checked; the lock clears on timeout or on a successful verify.
 */
export async function verifyOtp(phone, otp) {
  // 1. Refuse outright if the number is currently locked.
  const lock = await checkOtpLock(phone);
  if (lock.locked) {
    return {
      success: false,
      locked: true,
      retryAfterSec: lock.retryAfterSec,
      reason: 'Too many incorrect attempts. This number is temporarily locked. Please try again later.',
    };
  }

  const session = await prisma.otpSession.findFirst({
    where: {
      phone,
      verified: false,
      expiresAt: { gt: new Date() },
      attempts: { lt: ENV.OTP_MAX_ATTEMPTS },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!session) {
    return { success: false, reason: 'OTP expired or not found. Please request a new one.' };
  }

  // [FIX #3] Dev bypass — fail-closed and resolved once at boot. ENV.OTP_DEV_BYPASS
  // is true ONLY for an explicit non-prod opt-in with no SMS provider, and is
  // hard-forced false in production (see config/env.js). Never re-derive the rule
  // here — gate solely on the frozen flag so prod can't reach this path.
  const devBypass = ENV.OTP_DEV_BYPASS && otp === '000000';
  const match = devBypass || await bcrypt.compare(otp, session.otp);

  if (!match) {
    await prisma.otpSession.update({
      where: { id: session.id },
      data: { attempts: { increment: 1 } },
    });

    // Count this failure toward the per-phone lockout.
    const fail = await recordOtpFailure(phone);
    if (fail.locked) {
      // Best-effort security notification to the account owner (if registered).
      notifyOtpLockout(phone, fail.lockSeconds);
      return {
        success: false,
        locked: true,
        retryAfterSec: fail.retryAfterSec,
        reason: 'Too many incorrect attempts. This number has been temporarily locked. Please try again later.',
      };
    }

    return {
      success: false,
      reason: 'Incorrect OTP.',
      attemptsRemaining: fail.attemptsRemaining,
    };
  }

  // Mark verified
  await prisma.otpSession.update({
    where: { id: session.id },
    data: { verified: true },
  });

  // Successful verification clears any accumulated failure / lock state.
  await clearOtpLockout(phone);

  // Lookup existing user
  const user = await prisma.user.findUnique({ where: { phone } });

  return { success: true, isNewUser: !user, userId: user?.id || null };
}

/**
 * Notify the account owner that their number was locked by failed OTP attempts.
 * Best-effort and non-blocking: only registered users can receive an in-app /
 * push notification; unknown numbers are silently skipped. Never throws.
 */
async function notifyOtpLockout(phone, lockSeconds) {
  try {
    const user = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
    if (!user) return;
    const minutes = Math.max(1, Math.round((lockSeconds || ENV.OTP_LOCK_BASE_SECONDS) / 60));
    await sendPushToUser({
      userId: user.id,
      type: 'SYSTEM',
      title: 'Security alert: sign-in temporarily locked',
      body: `We blocked your number after several incorrect OTP attempts. Try again in about ${minutes} minute(s). If this wasn't you, your account is safe — no one was signed in.`,
      data: { kind: 'otp_lockout', lockSeconds: lockSeconds || ENV.OTP_LOCK_BASE_SECONDS },
      category: NOTIFICATION_CATEGORIES.SECURITY,
    });
  } catch (err) {
    logger.warn('[OTP] lockout notification failed: %s', err.message);
  }
}
