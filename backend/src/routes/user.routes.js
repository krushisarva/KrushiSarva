/**
 * User Routes
 * GET  /api/v1/users/me                → get own profile (includes sellerProfile)
 * PUT  /api/v1/users/me                → update name, avatar, language, location,
 *                                        businessType, gst, taluka, village
 * PUT  /api/v1/users/me/seller-profile → upsert bank account + KYC documents
 *   (both: changing Aadhaar/PAN/payout account sends a VERIFIED or REJECTED
 *    KYC back to SUBMITTED for admin review — see kycReviewReset — and a
 *    PENDING account's first Aadhaar/PAN submits it — see kycFirstSubmit.
 *    Minors may not store any of these fields on either route.)
 * PUT  /api/v1/users/me/farm           → upsert farm details
 * POST /api/v1/users/me/push-token     → register Expo push token
 *
 * Security fixes applied:
 *   C1  – PII masked in every API response (Aadhaar, PAN, bank account)
 *   C2  – PII encrypted at rest via AES-256-GCM before DB write
 *   H2  – GST number validated with regex server-side
 *   H3  – Aadhaar validated as exactly 12 digits
 *   M1  – Per-endpoint rate limit on state-changing routes (20 writes / 15 min)
 *   M3  – cropTypes array capped at 20 items, each item max 50 chars
 *   M4  – gstOptOut coercion bug fixed
 *   M5  – soilType / irrigationType max length enforced
 *   L1  – Push token max length + Expo format validation
 *   L2  – IFSC regex applied consistently on PUT /me
 *   L3  – try/catch on every async handler
 *   L5  – HTML stripped from all free-text fields before storage
 */
import { Router } from 'express';
import { body } from 'express-validator';
import { rateLimiter, clientIp } from '../middleware/rateLimit.js';
import { authenticate, requireRole, blockMinors, MINOR_BLOCKED_MESSAGE } from '../middleware/auth.js';
import { uuidParamGuard } from '../middleware/uuidParams.js';
import { isMinorDob } from '../utils/age.js';
import { isSensitivePiiUpdate } from '../constants/pii.js';
import { validate } from '../middleware/validate.js';
import {
  createUploader, createAvatarUploader, uploadFiles,
  uploadPrivateFiles, signedPrivateUrl, KYC_SIGNED_URL_TTL_SEC,
} from '../config/cloudinary.js';
import prisma from '../config/db.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';
import {
  encrypt,
  decrypt,
  encryptNumber,
  stripHtml,
} from '../utils/encrypt.js';
import { maskSensitiveFields } from '../utils/mask.js';
import logger from '../utils/logger.js';
import { auditPiiUpdate, auditLog, auditAction, AUDIT_ACTIONS } from '../services/audit.service.js';
import { verifyFirebaseReauth, isFirebaseAuthEnabled } from '../services/firebaseAuth.service.js';
import { eraseUserAccount } from '../services/erasure.service.js';
import { signAccessToken, createRefreshToken, enforceSessionLimit } from '../utils/jwt.js';
import { CONSENT_PURPOSES, CONSENT_POLICY_VERSION } from '../constants/consent.js';

const router = Router();
router.param('userId', uuidParamGuard); // :userId (admin KYC lookup) — reject non-UUIDs with 400
router.use(authenticate); // all user routes require auth

const avatarUpload = createAvatarUploader();
// KYC documents are buffered in memory by multer, then streamed to Cloudinary's
// PRIVATE (authenticated) storage — never the public CDN. Field name: 'images'.
const kycUpload = createUploader(5);

// Map stored Cloudinary public_ids → short-lived signed URLs for the response.
// We never return the raw public_ids; access always goes back through signing.
function signKycDocs(publicIds) {
  return (publicIds || [])
    .filter(Boolean)
    .map((id) => ({ url: signedPrivateUrl(id), expiresInSec: KYC_SIGNED_URL_TTL_SEC }));
}

// ── [M1] Per-user rate limiter for expensive write operations ─────────────────
// Caps profile / seller-profile / farm writes at 20 per 15 min per user. These
// routes encrypt PII and run audit writes, so they're costly and a prime target
// for abuse. Keyed on the authenticated user id (these routes sit behind
// `authenticate`); falls back to client IP only if user is somehow absent.
// Sliding window backed by Redis with an in-memory fallback (see middleware).
const profileWriteLimit = rateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      20,             // 20 writes / 15 min / user
  prefix:   'user:write',
  key:      (req) => req.user?.id || clientIp(req),
  message:  'Too many profile updates. Please wait a few minutes and try again.',
});

// ── Dedicated rate limit for SENSITIVE PII churn ─────────────────────────────
// The general profileWriteLimit (20/15min) is shared with benign edits (name,
// avatar, location). Sensitive identifiers (Aadhaar, PAN, bank, GST, DOB) change
// very rarely, so they get their own much tighter budget on top: 5 changes per
// hour per user. Excess sensitive-PII updates return 429. Used in two flavours:
//   - piiUpdateLimit:   only counts requests that actually carry a sensitive PII
//                       field (so a name-only PUT /me is unaffected).
//   - kycSubmitLimit:   unconditional — KYC docs arrive as multipart files (not
//                       body fields), and every submission is inherently PII.
// Both share the 'user:pii' counter so the cap spans all sensitive-PII routes.
const PII_LIMIT = { windowMs: 60 * 60 * 1000, max: 5, prefix: 'user:pii',
  message: 'Too many updates to sensitive details. For your security, please wait before changing these again.' };

const piiUpdateLimit = rateLimiter({
  ...PII_LIMIT,
  key: (req) => (req.user?.id && isSensitivePiiUpdate(req.body) ? req.user.id : null),
});

const kycSubmitLimit = rateLimiter({
  ...PII_LIMIT,
  key: (req) => req.user?.id || clientIp(req),
});

// ── Helper: recalculate profile completion (0-100) ────────────────────────────
function calcProfileCompletion(user, sellerProfile) {
  const checks = [
    user.name,
    user.businessType,
    user.district,
    user.taluka,
    user.village,
    user.gstNumber || user.gstOptOut,
    sellerProfile?.bankAccountNumber,
    sellerProfile?.bankIfsc,
    sellerProfile?.bankHolderName,
    sellerProfile?.bankName,
  ];
  const filled = checks.filter(Boolean).length;
  return Math.round((filled / checks.length) * 100);
}

// ── Helper: build the masked/safe seller-profile response shape ───────────────
// [C1] Never expose full Aadhaar, PAN, or bank account numbers.
const safeSellerProfile = maskSensitiveFields;

// ── Helper: sanitised bank/KYC plaintext from a request body ──────────────────
// [L5] stripHtml / uppercase FIRST, so the ciphertext decrypts back to the clean
// canonical value — and so the KYC re-review below compares like with like.
function bankKycPlaintext({ bankHolderName, bankName, bankAccountNumber, bankIfsc, aadharNumber, panNumber }) {
  const plain = {};
  if (bankHolderName    !== undefined) plain.bankHolderName    = stripHtml(bankHolderName);
  if (bankName          !== undefined) plain.bankName          = stripHtml(bankName);
  if (bankAccountNumber !== undefined) plain.bankAccountNumber = bankAccountNumber;
  if (bankIfsc          !== undefined) plain.bankIfsc          = bankIfsc?.toUpperCase();
  if (aadharNumber      !== undefined) plain.aadharNumber      = aadharNumber;
  if (panNumber         !== undefined) plain.panNumber         = panNumber?.toUpperCase();
  return plain;
}

/** [C2] Encrypt every value for storage ('' stays '' — encrypt is a no-op on it). */
const encryptEach = (plain) =>
  Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, encrypt(v)]));

// ── KYC re-review when identity or payout details change ─────────────────────
// An admin's VERIFY or REJECT is a decision about one specific Aadhaar, PAN and
// payout account. Once any of them changes, that decision no longer describes
// what is on file, so the account goes back to SUBMITTED — the status the admin
// KYC queue shows by default. Without this a VERIFIED seller could swap in
// someone else's bank account and keep the badge, and a REJECTED seller who
// corrected their details stayed REJECTED, outside the queue, for good.
//
// bankName is left out on purpose: payouts route on account number + IFSC, and
// the bank name is a label — "SBI" → "State Bank of India" must not unverify a
// shop. GST is not part of the KYC review. PENDING and SUBMITTED accounts are
// already awaiting a decision, so they are left alone.
// Roles that "become a seller" when the account opts in by submitting the
// business profile. Mirrors SELLER_FLIP_FROM in routes/admin/kyc.routes.js,
// which flips the same roles on KYC approval — the two must agree, or an
// account the admin queue would promote can never reach the queue. FARMER alone
// left LABOUR_PROVIDER and MACHINERY_OWNER stuck on the seller app's
// BusinessProfile screen: every save answered "not a seller account yet" and
// every seller route kept 403-ing.
const SELLER_FLIP_FROM = new Set(['FARMER', 'VERIFIED_FARMER', 'LABOUR_PROVIDER', 'MACHINERY_OWNER']);

const KYC_REVIEW_FIELDS = ['aadharNumber', 'panNumber', 'bankAccountNumber', 'bankIfsc', 'bankHolderName'];
const KYC_REREVIEW_FROM = new Set(['VERIFIED', 'REJECTED']);
const KYC_REVIEW_STATUS = 'SUBMITTED';
// The old approval and the old rejection reason both described details that are
// no longer on file. licenceVerifiedAt stays: licence fields aren't editable here.
const KYC_RESET_PROFILE = { kycVerifiedAt: null, kycRejectedReason: null };

// Retyping the same PAN, or "ramesh  patil" as "Ramesh Patil", is not a new identity.
const kycComparable = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

/**
 * The re-review an update triggers, or null. `user` is the row as it was BEFORE
 * this write, with its sellerProfile; `plain` is bankKycPlaintext() of the body.
 *
 * Stored values are decrypted to compare: encrypt() draws a fresh IV per call, so
 * two encryptions of the same value never match. One we cannot decrypt (retired
 * key, corruption) counts as changed — nobody can show an admin reviewed it.
 */
function kycReviewReset(user, plain) {
  if (!KYC_REREVIEW_FROM.has(user?.kycStatus)) return null;
  const stored = user.sellerProfile;
  const fields = KYC_REVIEW_FIELDS.filter((f) => {
    if (plain[f] === undefined) return false;
    const before = stored?.[f] ? decrypt(stored[f]) : '';
    return before == null || kycComparable(before) !== kycComparable(plain[f]);
  });
  return fields.length
    ? { from: user.kycStatus, action: AUDIT_ACTIONS.KYC_RESUBMIT, metadata: { changedFields: fields } }
    : null;
}

// ── First KYC submission ─────────────────────────────────────────────────────
// PENDING is the schema default for EVERY account, so it cannot mean "waiting
// for an admin", and the admin KYC queue lists SUBMITTED. A new seller's first
// Aadhaar/PAN therefore never reached a reviewer — and selling now requires
// VERIFIED (middleware/sellerKyc.js). Once an identity number is on file the
// account is SUBMITTED: the same point at which the seller app starts showing
// "pending review" (kycState in seller-app/src/utils/businessProfile.js).
const KYC_ID_FIELDS = ['aadharNumber', 'panNumber'];

function kycFirstSubmit(user, plain) {
  if (user?.kycStatus !== 'PENDING') return null;
  // On file after this write: the body's value if it carries one, else the stored
  // one. Ciphertext is non-empty exactly when the plaintext is (encrypt('') === '').
  const fields = KYC_ID_FIELDS.filter((f) => (plain[f] !== undefined ? plain[f] : user.sellerProfile?.[f]));
  return fields.length
    ? { from: user.kycStatus, action: AUDIT_ACTIONS.KYC_SUBMIT, metadata: { idFields: fields } }
    : null;
}

/** The move to SUBMITTED a bank/KYC write triggers, or null. Same arguments as kycReviewReset. */
const kycSubmission = (user, plain) => kycReviewReset(user, plain) ?? kycFirstSubmit(user, plain);

// Audited after commit, so a rolled-back write leaves no trail. Field NAMES only.
function auditKycSubmission(req, change) {
  auditAction(req, {
    action:   change.action,
    entity:   'User',
    entityId: req.user.id,
    before:   { kycStatus: change.from },
    after:    { kycStatus: KYC_REVIEW_STATUS },
    metadata: change.metadata,
  }).catch(() => {});
}

// Thrown inside the PUT /me transaction to roll it back; answered with blockMinors' 403.
const MINOR_KYC_REFUSED = new Error('Minors may not store identity or payout details');

// ── GET /me ───────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, phone: true, email: true, name: true, avatar: true,
        role: true, language: true, createdAt: true,
        notificationsEnabled: true,
        statusQuote: true,
        pincode: true, district: true, taluka: true, village: true,
        city: true, state: true,
        businessType: true, gstNumber: true, gstOptOut: true,
        kycStatus: true, profileCompletion: true,
        isOnline: true, lastSeenAt: true,
        // Farmer profile module
        onboardingStep: true, activeFarmId: true, totalFarms: true, totalLandAcres: true,
        gender: true, education: true, farmingExperienceYrs: true,
        // [DPDP §9] surface minor status + guardian-consent state to the client
        dateOfBirth: true, isMinor: true, guardianConsentAt: true,
        sellerProfile: {
          select: {
            id: true,
            bankHolderName: true, bankName: true,
            bankAccountNumber: true, bankIfsc: true,
            aadharNumber: true, panNumber: true,
            kycVerifiedAt: true, kycRejectedReason: true,
            // Krushi Seva Kendra licence summary (not personal PII; safe to echo).
            // licenceDocUrls is intentionally NOT selected — doc references are
            // private and served only via GET /me/licence-documents (signed URLs).
            licenceNumber: true, licenceType: true, licenceIssuingState: true,
            licenceExpiry: true, licenceVerifiedAt: true,
            updatedAt: true,
          },
        },
        farmDetail: true,
        _count: {
          select: {
            orders: true, animalListings: true, posts: true,
            bookings: true, sellerProducts: true, cropDiseaseReports: true,
            machineryListings: { where: { status: 'ACTIVE' } },
            labourListings:    { where: { status: 'ACTIVE' } },
          },
        },
      },
    });

    if (!user) return sendNotFound(res, 'User');

    // [C1] Return masked PII; [C2] decrypt the owner's own GST for display.
    return sendSuccess(res, {
      ...user,
      gstNumber: user.gstNumber ? (decrypt(user.gstNumber) ?? user.gstNumber) : user.gstNumber,
      sellerProfile: safeSellerProfile(user.sellerProfile),
    });
  } catch (err) {
    logger.error({ err }, '[User] GET /me error');
    return sendError(res, 'Failed to load profile', 500);
  }
});

// ── PUT /me ───────────────────────────────────────────────────────────────────
router.put(
  '/me',
  profileWriteLimit, // [M1]
  (req, res, next) => avatarUpload(req, res, (err) => {
    if (err) return sendError(res, err.message, 400);
    next();
  }),
  piiUpdateLimit, // tight cap on sensitive-PII churn (runs after body is parsed)
  [
    body('name').optional().trim().isLength({ min: 2, max: 80 }),
    // Optional contact email. `values: 'falsy'` lets the client clear it by
    // sending '' (→ stored as NULL below) without tripping the format check.
    body('email').optional({ values: 'falsy' }).trim().isEmail().isLength({ max: 200 })
      .withMessage('Enter a valid email address'),
    body('language').optional().isIn(['en', 'hi', 'mr']),
    body('notificationsEnabled').optional().isBoolean(),
    body('statusQuote').optional().trim().isLength({ max: 200 }),
    // `values: 'falsy'` lets the client clear a stored PIN by sending '' (→ NULL
    // below), the same escape hatch `email` uses; anything non-empty must still
    // be six digits.
    body('pincode').optional({ values: 'falsy' }).matches(/^\d{6}$/),
    body('district').optional().trim().isLength({ max: 100 }),
    body('taluka').optional().trim().isLength({ max: 100 }),
    body('village').optional().trim().isLength({ max: 100 }),
    body('city').optional().trim().isLength({ max: 100 }),
    body('state').optional().trim().isLength({ max: 100 }),
    body('lat').optional({ values: 'null' }).isFloat({ min: -90,  max: 90  }).withMessage('lat must be between -90 and 90'),
    body('lng').optional({ values: 'null' }).isFloat({ min: -180, max: 180 }).withMessage('lng must be between -180 and 180'),
    // [DPDP §9] Date of birth — drives minor detection. Must be a valid past date.
    body('dateOfBirth').optional({ values: 'null' }).isISO8601().withMessage('dateOfBirth must be a valid date')
      .custom((val) => { if (val && new Date(val) > new Date()) throw new Error('dateOfBirth cannot be in the future'); return true; }),
    body('businessType').optional().isIn([
      'individual_farmer', 'farmer_group', 'fpc', 'cooperative', 'agri_business',
      'krushi_kendra', 'fertilizer_dealer', 'pesticide_dealer', 'seed_supplier', 'agri_input_shop',
    ]),
    // Explicit opt-in to become a SELLER. Required before any FARMER→SELLER
    // promotion; setting businessType alone never escalates the role.
    body('sellerConsent').optional().isBoolean(),
    // [H2] GST format validated server-side, not just length
    body('gstNumber').optional().trim()
      .custom((val, { req: r }) => {
        // Only validate format when gstOptOut is not set
        if (r.body.gstOptOut === true || r.body.gstOptOut === 'true') return true;
        if (!val) return true; // blank is fine (user hasn't added it yet)
        const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
        if (!gstRegex.test(val.toUpperCase())) {
          throw new Error('Invalid GST number format (e.g. 27ABCDE1234F1Z5)');
        }
        return true;
      }),
    body('gstOptOut').optional().isBoolean(),
    body('bankHolderName').optional().trim().isLength({ max: 100 }),
    body('bankName').optional().trim().isLength({ max: 100 }),
    // KYC/bank fields use `values: 'falsy'` so the frontend can send empty
    // strings (for fields the user hasn't filled yet) without tripping format
    // checks. Empty → skip validation; non-empty → enforce format.
    body('bankAccountNumber').optional({ values: 'falsy' }).trim().isLength({ max: 20 }),
    // [L2] IFSC regex consistent with PUT /me/seller-profile
    body('bankIfsc').optional({ values: 'falsy' }).trim()
      .matches(/^[A-Z]{4}0[A-Z0-9]{6}$/i)
      .withMessage('IFSC must be 11 characters (e.g. SBIN0012345)'),
    // [H3] Aadhaar must be exactly 12 digits
    body('aadharNumber').optional({ values: 'falsy' }).trim()
      .matches(/^\d{12}$/)
      .withMessage('Aadhaar must be exactly 12 digits'),
    body('panNumber').optional({ values: 'falsy' }).trim().isLength({ min: 10, max: 10 }),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        name, email, language, statusQuote, notificationsEnabled,
        pincode, district, taluka, village, city, state,
        lat, lng, dateOfBirth,
        businessType, gstNumber, gstOptOut,
      } = req.body;

      // Upload avatar if file was attached
      let avatar;
      if (req.files?.length) {
        try {
          const urls = await uploadFiles(req.files, 'avatars');
          avatar = urls[0] || undefined;
        } catch (uploadErr) {
          logger.error({ err: uploadErr }, '[PUT /me] avatar upload failed');
          return sendError(res, 'Photo upload failed. Please try a different image.', 400);
        }
      }

      // [M4] Coerce gstOptOut to boolean FIRST so the gstNumber conditional is correct
      const resolvedGstOptOut = gstOptOut !== undefined ? Boolean(JSON.parse(gstOptOut)) : undefined;

      // ── 1. Build User update payload ───────────────────────────────────────
      const userData = {};
      // [L5] Strip HTML from all free-text fields before storage
      if (name        !== undefined) userData.name        = stripHtml(name);
      // Empty string clears the email (→ NULL); otherwise store it normalised
      // (lowercased + trimmed) so the unique index treats casing consistently.
      if (email       !== undefined) userData.email       = email ? stripHtml(email.trim().toLowerCase()) : null;
      if (language    !== undefined) userData.language    = language;
      // The Account → Notifications switch. Multipart bodies arrive as strings,
      // so 'false' must not be read as truthy — this is exactly the coercion bug
      // that made gstOptOut behave backwards ([M4]).
      if (notificationsEnabled !== undefined) {
        userData.notificationsEnabled = notificationsEnabled === true || notificationsEnabled === 'true';
      }
      if (avatar      !== undefined) userData.avatar      = avatar;
      if (statusQuote !== undefined) userData.statusQuote = stripHtml(statusQuote);
      // '' (or null) clears the PIN → NULL. The seller form sends it when the
      // field is emptied; without it a wrong stored PIN could never be removed.
      if (pincode     !== undefined) userData.pincode     = pincode || null;
      if (district    !== undefined) userData.district    = district;
      if (taluka      !== undefined) userData.taluka      = taluka;
      if (village     !== undefined) userData.village     = village;
      if (city        !== undefined) userData.city        = city;
      if (state       !== undefined) userData.state       = state;
      // [C2] Encrypt geolocation at rest — stored as ciphertext, decrypted to a
      // Float in app code (e.g. the sellers-nearby geo search) when needed.
      if (lat         !== undefined) userData.lat         = lat === null ? null : encryptNumber(lat);
      if (lng         !== undefined) userData.lng         = lng === null ? null : encryptNumber(lng);
      // [DPDP §9] Persist dob and derive minor status so restricted flows can be
      // gated. Setting dob recomputes isMinor; clearing it resets the flag.
      if (dateOfBirth !== undefined) {
        userData.dateOfBirth = dateOfBirth === null ? null : new Date(dateOfBirth);
        userData.isMinor     = dateOfBirth === null ? false : isMinorDob(dateOfBirth);
      }
      if (businessType !== undefined) userData.businessType = businessType;
      // Promotion to SELLER (from any SELLER_FLIP_FROM role) is CONSENT-GATED,
      // not a side-effect of setting businessType. The caller must opt in via
      // `sellerConsent: true`; the actual role flip + a SELLER_ONBOARDING
      // ConsentRecord are then written atomically inside the transaction below
      // (so the role only ever changes alongside recorded consent — DPDP §5).
      // The role lives in the JWT, so fresh tokens are re-issued at the end of
      // this handler when the flip happens. [DPDP §9] A minor is never promoted.
      const sellerConsent = req.body.sellerConsent === true || req.body.sellerConsent === 'true';
      const wantsSeller   = sellerConsent && SELLER_FLIP_FROM.has(req.user.role);
      if (resolvedGstOptOut !== undefined) userData.gstOptOut = resolvedGstOptOut;
      // [M4] Use the already-resolved boolean, not the raw body string.
      // [C2] GST is a financial identifier — encrypt at rest. The empty
      // opt-out value stays '' (encrypt is a no-op on ''), so the truthiness
      // check in calcProfileCompletion still works.
      if (gstNumber !== undefined) {
        const gstPlain = resolvedGstOptOut ? '' : (gstNumber?.trim().toUpperCase() || '');
        userData.gstNumber = encrypt(gstPlain);
      }

      // ── 2. Build SellerProfile payload — plaintext now, [C2] encrypted at write
      const spPlain = bankKycPlaintext(req.body);
      const hasBankOrKyc = Object.keys(spPlain).length > 0;

      if (!Object.keys(userData).length && !hasBankOrKyc) {
        return sendError(res, 'No fields to update', 400);
      }

      // ── 3. Run updates in a transaction ────────────────────────────────────
      let kycReset = null;
      const [updatedUser] = await prisma.$transaction(async (tx) => {
        let user = await tx.user.findUnique({
          where: { id: req.user.id },
          include: { sellerProfile: true },
        });

        const effectiveMinor = userData.isMinor !== undefined ? userData.isMinor : user.isMinor;

        // [DPDP §9] Minors may not store identity or payout details — what
        // blockMinors refuses on /me/seller-profile and /me/kyc-documents, which
        // write the same fields. Minor on file OR by this request's dob. Blank
        // values (the seller app sends them for unfilled fields) carry nothing
        // and are dropped, so the rest of a minor's profile still saves.
        const minor = user.isMinor === true || effectiveMinor === true;
        if (minor && Object.values(spPlain).some(Boolean)) throw MINOR_KYC_REFUSED;
        const writeBankKyc = hasBankOrKyc && !minor;

        // Decided against the row as it was before this write, and applied in
        // the same user update + seller-profile upsert as the change itself, so
        // the new details can never sit under the old decision.
        kycReset = writeBankKyc ? kycSubmission(user, spPlain) : null;
        if (kycReset) userData.kycStatus = KYC_REVIEW_STATUS;

        // Decide the FARMER → SELLER promotion against AUTHORITATIVE state:
        // this request's dob if it was just set, otherwise the stored flag, so
        // a previously-recorded minor can't slip through by omitting dob here.
        // [DPDP §9] Minors are never promoted. The flip and its consent proof
        // are committed together — the role can't change without the record.
        const promoteToSeller = wantsSeller && SELLER_FLIP_FROM.has(user.role) && effectiveMinor !== true;
        if (promoteToSeller) userData.role = 'SELLER';

        if (Object.keys(userData).length) {
          user = await tx.user.update({
            where: { id: req.user.id },
            data: userData,
            include: { sellerProfile: true },
          });
        }

        if (promoteToSeller) {
          // DPDP §5 proof of the explicit opt-in, atomic with the role change.
          await tx.consentRecord.create({
            data: {
              userId:        req.user.id,
              purpose:       CONSENT_PURPOSES.SELLER_ONBOARDING,
              granted:       true,
              policyVersion: CONSENT_POLICY_VERSION,
              method:        'seller_onboarding',
              ip:            clientIp(req),
              userAgent:     req.headers['user-agent'] || null,
              metadata:      JSON.stringify({ businessType: user.businessType || null }),
            },
          });
        }

        if (writeBankKyc) {
          // [C2] Encrypt all bank/KYC financial PII before writing to DB.
          const spData = encryptEach(spPlain);
          const spWrite = kycReset ? { ...spData, ...KYC_RESET_PROFILE } : spData;

          const sp = await tx.sellerProfile.upsert({
            where:  { userId: req.user.id },
            create: { userId: req.user.id, ...spWrite },
            update: spWrite,
          });
          user = { ...user, sellerProfile: sp };

          // [FIX] Audit log PII changes (fields redacted, only tracks WHICH fields changed)
          auditPiiUpdate(req, 'SellerProfile', req.user.id, spData).catch(() => {});
        }

        const completion = calcProfileCompletion(user, user.sellerProfile);
        if (completion !== user.profileCompletion) {
          user = await tx.user.update({
            where: { id: req.user.id },
            data:  { profileCompletion: completion },
            include: { sellerProfile: true },
          });
        }

        return [user];
      });

      if (kycReset) auditKycSubmission(req, kycReset);

      // If we flipped FARMER → SELLER above, re-issue tokens so the new role
      // is reflected in the JWT immediately (no logout/login round-trip).
      // req.user.role is the pre-update role, so this is true only on a real flip.
      const didPromote = req.user.role !== 'SELLER' && updatedUser.role === 'SELLER';
      let tokens = null;
      if (didPromote) {
        const accessToken  = signAccessToken({ sub: updatedUser.id, role: updatedUser.role, tokenVersion: updatedUser.tokenVersion });
        const refreshToken = await createRefreshToken(updatedUser.id);
        await enforceSessionLimit(updatedUser.id); // cap concurrent sessions
        tokens = { accessToken, refreshToken };
      }

      // [C1] Return masked PII — never send full Aadhaar / account in response
      return sendSuccess(res, {
        id:                updatedUser.id,
        phone:             updatedUser.phone,
        email:             updatedUser.email,
        name:              updatedUser.name,
        avatar:            updatedUser.avatar,
        role:              updatedUser.role,
        language:          updatedUser.language,
        statusQuote:       updatedUser.statusQuote,
        pincode:           updatedUser.pincode,
        district:          updatedUser.district,
        taluka:            updatedUser.taluka,
        village:           updatedUser.village,
        city:              updatedUser.city,
        state:             updatedUser.state,
        businessType:      updatedUser.businessType,
        gstNumber:         updatedUser.gstNumber ? (decrypt(updatedUser.gstNumber) ?? updatedUser.gstNumber) : updatedUser.gstNumber,
        gstOptOut:         updatedUser.gstOptOut,
        kycStatus:         updatedUser.kycStatus,
        profileCompletion: updatedUser.profileCompletion,
        sellerProfile:     safeSellerProfile(updatedUser.sellerProfile),
        createdAt:         updatedUser.createdAt,
        ...(tokens && { tokens }),
      });
    } catch (err) {
      if (err === MINOR_KYC_REFUSED) return sendError(res, MINOR_BLOCKED_MESSAGE, 403);
      // Unique-constraint hit on email → friendly 409 instead of a generic 500.
      if (err?.code === 'P2002' && (err?.meta?.target?.includes?.('email') || /email/i.test(String(err?.meta?.target)))) {
        return sendError(res, 'This email is already linked to another account', 409);
      }
      logger.error({ err }, '[User] PUT /me error');
      return sendError(res, 'Failed to update profile', 500);
    }
  }
);

// ── PUT /me/seller-profile ────────────────────────────────────────────────────
router.put(
  '/me/seller-profile',
  profileWriteLimit, // [M1]
  blockMinors,       // [DPDP §9] no financial/seller onboarding for under-18s
  piiUpdateLimit,    // tight cap on sensitive-PII churn (bank / Aadhaar / PAN)
  [
    body('bankHolderName').optional().trim().isLength({ max: 100 }),
    body('bankName').optional().trim().isLength({ max: 100 }),
    body('bankAccountNumber').optional().trim().isLength({ max: 20 }),
    body('bankIfsc').optional().trim()
      .matches(/^[A-Z]{4}0[A-Z0-9]{6}$/i)
      .withMessage('IFSC must be 11 characters (e.g. SBIN0012345)'),
    // [H3] Exactly 12 digits
    body('aadharNumber').optional().trim()
      .matches(/^\d{12}$/)
      .withMessage('Aadhaar must be exactly 12 digits'),
    body('panNumber').optional().trim().isLength({ min: 10, max: 10 })
      .withMessage('PAN must be 10 characters'),
  ],
  validate,
  async (req, res) => {
    try {
      const plain = bankKycPlaintext(req.body);
      if (!Object.keys(plain).length) return sendError(res, 'No fields to update', 400);
      // [C2] Encrypt all bank/KYC financial PII before write.
      const data = encryptEach(plain);

      // Same KYC re-review / first submission as PUT /me — otherwise this route
      // is the way around it.
      let kycReset = null;
      const sp = await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: req.user.id }, include: { sellerProfile: true } });
        kycReset = kycSubmission(user, plain);
        const write = kycReset ? { ...data, ...KYC_RESET_PROFILE } : data;

        const row = await tx.sellerProfile.upsert({
          where:  { userId: req.user.id },
          create: { userId: req.user.id, ...write },
          update: write,
        });
        await tx.user.update({
          where: { id: req.user.id },
          data:  {
            profileCompletion: calcProfileCompletion(user, row),
            ...(kycReset && { kycStatus: KYC_REVIEW_STATUS }),
          },
        });
        return row;
      });

      if (kycReset) auditKycSubmission(req, kycReset);

      // [C1] Return masked PII — NOT the raw `sp` row
      return sendSuccess(res, safeSellerProfile(sp));
    } catch (err) {
      logger.error({ err }, '[User] PUT /me/seller-profile error');
      return sendError(res, 'Failed to update seller profile', 500);
    }
  }
);

// ── KYC documents — PRIVATE storage, signed-URL access ────────────────────────
// ID proofs must never be publicly fetchable. They are uploaded to Cloudinary's
// authenticated storage; we persist only the opaque public_id and hand out
// short-lived signed URLs (default 5 min). A plain/public request for the asset
// fails at Cloudinary (401). Read access is gated to the owner and ADMIN.

// POST /me/kyc-documents — owner (re)submits KYC document images.
router.post(
  '/me/kyc-documents',
  profileWriteLimit, // [M1]
  blockMinors,       // [DPDP §9] no identity/KYC submission for under-18s
  kycSubmitLimit,    // tight cap on sensitive KYC submissions (5/hour/user)
  (req, res, next) => kycUpload(req, res, (err) => {
    if (err) return sendError(res, err.message, 400);
    next();
  }),
  async (req, res) => {
    try {
      if (!req.files?.length) {
        return sendError(res, 'At least one KYC document image is required', 400);
      }
      // Store privately under a per-user folder; keep only the public_ids.
      const publicIds = await uploadPrivateFiles(req.files, `kyc/${req.user.id}`);

      // Persist references and move KYC to SUBMITTED — new docs need re-review.
      // SUBMITTED, not PENDING: PENDING is every account's default and is not in
      // the admin queue, so documents sent here used to wait for nobody. The old
      // decision no longer describes what is on file (KYC_RESET_PROFILE).
      const [sp] = await prisma.$transaction([
        prisma.sellerProfile.upsert({
          where:  { userId: req.user.id },
          create: { userId: req.user.id, kycDocumentUrls: publicIds },
          update: { kycDocumentUrls: publicIds, ...KYC_RESET_PROFILE },
          select: { kycDocumentUrls: true },
        }),
        prisma.user.update({
          where: { id: req.user.id },
          data:  { kycStatus: KYC_REVIEW_STATUS },
        }),
      ]);

      auditPiiUpdate(req, 'SellerProfile', req.user.id, { kycDocumentUrls: publicIds }).catch(() => {});

      return sendSuccess(res, { documents: signKycDocs(sp.kycDocumentUrls) }, 201);
    } catch (err) {
      logger.error({ err }, '[User] POST /me/kyc-documents error');
      // Surface the "not configured" guard so misconfig is obvious; otherwise generic.
      const msg = /Cloudinary is not configured/.test(err.message) ? err.message : 'Failed to upload KYC documents';
      return sendError(res, msg, 500);
    }
  }
);

// GET /me/kyc-documents — owner fetches fresh signed URLs for their own docs.
router.get('/me/kyc-documents', async (req, res) => {
  try {
    const sp = await prisma.sellerProfile.findUnique({
      where:  { userId: req.user.id },
      select: { kycDocumentUrls: true },
    });
    return sendSuccess(res, { documents: signKycDocs(sp?.kycDocumentUrls) });
  } catch (err) {
    logger.error({ err }, '[User] GET /me/kyc-documents error');
    return sendError(res, 'Failed to load KYC documents', 500);
  }
});

// ── Krushi Seva Kendra licence documents — PRIVATE storage, signed-URL access ──
// A Kendra's dealer-licence scans are reviewed by an admin before approval. They
// are sensitive business documents, so — exactly like KYC ID proofs — they live in
// Cloudinary's authenticated storage (public_ids persisted, never public URLs) and
// are only ever delivered through short-lived signed URLs. Submitting (re)sets the
// account's kycStatus to SUBMITTED so it re-enters the admin verification queue.

// POST /me/licence-documents — Kendra (re)submits its licence document images.
router.post(
  '/me/licence-documents',
  profileWriteLimit, // [M1]
  blockMinors,       // [DPDP §9] no identity/licence submission for under-18s
  kycSubmitLimit,    // tight cap on sensitive document submissions (5/hour/user)
  (req, res, next) => kycUpload(req, res, (err) => {
    if (err) return sendError(res, err.message, 400);
    next();
  }),
  async (req, res) => {
    try {
      if (!req.files?.length) {
        return sendError(res, 'At least one licence document image is required', 400);
      }
      // Store privately under a per-user folder; keep only the public_ids.
      const publicIds = await uploadPrivateFiles(req.files, `licence/${req.user.id}`);

      // Persist references and move KYC to SUBMITTED — new docs need re-review.
      const [sp] = await prisma.$transaction([
        prisma.sellerProfile.upsert({
          where:  { userId: req.user.id },
          create: { userId: req.user.id, licenceDocUrls: publicIds },
          update: { licenceDocUrls: publicIds },
          select: { licenceDocUrls: true },
        }),
        prisma.user.update({
          where: { id: req.user.id },
          data:  { kycStatus: 'SUBMITTED' },
        }),
      ]);

      auditPiiUpdate(req, 'SellerProfile', req.user.id, { licenceDocUrls: publicIds }).catch(() => {});

      return sendSuccess(res, { documents: signKycDocs(sp.licenceDocUrls) }, 201);
    } catch (err) {
      logger.error({ err }, '[User] POST /me/licence-documents error');
      const msg = /Cloudinary is not configured/.test(err.message) ? err.message : 'Failed to upload licence documents';
      return sendError(res, msg, 500);
    }
  }
);

// GET /me/licence-documents — Kendra fetches fresh signed URLs for their own docs.
router.get('/me/licence-documents', async (req, res) => {
  try {
    const sp = await prisma.sellerProfile.findUnique({
      where:  { userId: req.user.id },
      select: { licenceDocUrls: true },
    });
    return sendSuccess(res, { documents: signKycDocs(sp?.licenceDocUrls) });
  } catch (err) {
    logger.error({ err }, '[User] GET /me/licence-documents error');
    return sendError(res, 'Failed to load licence documents', 500);
  }
});

// GET /:userId/kyc-documents — ADMIN fetches signed URLs to review a seller.
router.get('/:userId/kyc-documents', requireRole('ADMIN'), async (req, res) => {
  try {
    const sp = await prisma.sellerProfile.findUnique({
      where:  { userId: req.params.userId },
      select: { kycDocumentUrls: true },
    });
    if (!sp) return sendNotFound(res, 'Seller profile');

    // Audit admin access to another user's KYC PII (who viewed whose documents).
    auditAction(req, {
      action:   AUDIT_ACTIONS.KYC_ACCESS,
      entity:   'SellerProfile',
      entityId: req.params.userId,
      metadata: { accessedBy: req.user.id, docCount: (sp.kycDocumentUrls || []).length },
    }).catch(() => {});

    return sendSuccess(res, { documents: signKycDocs(sp.kycDocumentUrls) });
  } catch (err) {
    logger.error({ err }, '[User] GET /:userId/kyc-documents error');
    return sendError(res, 'Failed to load KYC documents', 500);
  }
});

// ── DELETE /me — Right to Erasure (DPDP Act §8) ───────────────────────────────
// Irreversible. The caller must re-prove possession of their registered handset
// by completing a fresh Firebase SMS challenge and passing the resulting ID
// token. Fresh is enforced on auth_time, not token validity: an ID token stays
// usable for an hour and refreshes indefinitely, so "valid token" would mean
// "signed in earlier today" — far too weak to authorise erasure. On success we
// anonymize the
// user row + shared records, hard-delete personal data and purge media, then
// record an audit entry. The just-deleted sessions + bumped tokenVersion make
// the caller's current tokens invalid immediately afterwards.
router.delete(
  '/me',
  profileWriteLimit, // [M1]
  [
    body('idToken').isString().trim().isLength({ min: 20, max: 4096 })
      .withMessage('A fresh phone verification is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const me = await prisma.user.findUnique({
        where:  { id: req.user.id },
        select: { phone: true },
      });
      if (!me) return sendNotFound(res, 'User');

      // [verification] A fresh Firebase phone challenge, for THIS user's phone.
      if (!isFirebaseAuthEnabled()) {
        return sendError(res, 'Phone verification is not available on this server', 503);
      }
      let verifiedPhone;
      try {
        ({ phone: verifiedPhone } = await verifyFirebaseReauth(req.body.idToken));
      } catch (err) {
        if (err.serverFault) {
          logger.error({ err }, '[Account] erasure re-auth unavailable');
          return sendError(res, 'Phone verification is temporarily unavailable', 503);
        }
        logger.warn({ err: err.message }, '[Account] erasure re-auth rejected');
        // staleReauth is a distinct, actionable failure: the token was genuine but
        // the SMS was too long ago. Say so, or the user retries the same stale
        // token forever and reads it as "the app is broken".
        return sendError(res, err.staleReauth
          ? 'Please verify your phone number again to continue'
          : 'Phone verification failed', 401);
      }
      if (verifiedPhone !== me.phone) {
        // The token proved possession of SOME handset — it must be this account's.
        // Without this, anyone could erase any account by verifying their own phone.
        logger.warn({ userId: req.user.id }, '[Account] erasure re-auth phone mismatch');
        return sendError(res, 'Phone verification failed', 401);
      }

      const summary = await eraseUserAccount(req.user.id);
      if (!summary.erased) return sendNotFound(res, 'User');

      // Audit AFTER erasure. AuditLog has no FK to User, so it survives; we store
      // only non-PII counters, never the erased values.
      await auditLog({
        userId:    req.user.id,
        action:    'ACCOUNT_ERASURE',
        entity:    'User',
        entityId:  req.user.id,
        ip:        req.ip,
        requestId: req.id,
        metadata:  { mediaRefs: summary.mediaRefs, mediaDeleted: summary.mediaDeleted },
      });

      logger.info({ userId: req.user.id, ...summary }, '[User] account erased (DPDP §8)');
      return sendSuccess(res, {
        erased: true,
        message: 'Your account and personal data have been permanently erased.',
      });
    } catch (err) {
      logger.error({ err }, '[User] DELETE /me erasure error');
      return sendError(res, 'Failed to erase account. Please try again.', 500);
    }
  }
);

// ── PUT /me/farm ──────────────────────────────────────────────────────────────
router.put(
  '/me/farm',
  profileWriteLimit, // [M1]
  [
    body('village').optional().trim().isLength({ max: 100 }),
    body('district').optional().trim().isLength({ max: 100 }),
    body('state').optional().trim().isLength({ max: 100 }),
    // `values: 'falsy'` lets the client clear a stored value by sending '' (→
    // NULL in the handler), the same escape hatch PUT /me gives `pincode` and
    // `email`. Without it the format check ran on '' and answered 400, so a PIN
    // or a land size entered once — or entered wrongly — could never be removed.
    // The free-text fields below need no change: '' already passes isLength.
    body('pincode').optional({ values: 'falsy' }).matches(/^\d{6}$/),
    body('landAcres').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100000 }),
    // [M3] Array capped at 20 items; each item max 50 chars
    body('cropTypes').optional()
      .isArray({ max: 20 }).withMessage('cropTypes must have at most 20 items')
      .custom((arr) => {
        if (!Array.isArray(arr)) return true;
        for (const item of arr) {
          if (typeof item !== 'string' || item.length > 50) {
            throw new Error('Each crop type must be a string of max 50 characters');
          }
        }
        return true;
      }),
    // [M5] Max length enforced
    body('soilType').optional().trim().isLength({ max: 50 }),
    body('irrigationType').optional().trim().isLength({ max: 50 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { village, district, state, pincode, landAcres, cropTypes, soilType, irrigationType } = req.body;

      // '' (or null) CLEARS the field → NULL, exactly as PUT /me clears `pincode`
      // and `email`. Every one of these columns is nullable, and the route used
      // to have two different wrong answers for an emptied box: `pincode` and
      // `landAcres` were rejected outright by their format validators (400 — the
      // bug: a wrong PIN could not be removed), while `village`, `district`,
      // `state`, `soilType` and `irrigationType` were stored as the empty string,
      // so "cleared" and "never filled in" were two different rows.
      const clear = (v) => (v === null || v === '' ? null : v);
      // Not `landAcres ? parseFloat(...) : undefined`: 0 is inside the validator's
      // own `min: 0` range, and that truthiness test silently dropped it.
      const acres = landAcres === null || landAcres === '' ? null : parseFloat(landAcres);

      // One payload for both halves of the upsert, so a create and an update of
      // the same body can no longer normalise it differently.
      const data = {
        ...(village        !== undefined && { village:        clear(village) }),
        ...(district       !== undefined && { district:       clear(district) }),
        ...(state          !== undefined && { state:          clear(state) }),
        ...(pincode        !== undefined && { pincode:        clear(pincode) }),
        ...(landAcres      !== undefined && { landAcres:      acres }),
        ...(cropTypes      !== undefined && { cropTypes }),
        ...(soilType       !== undefined && { soilType:       clear(soilType) }),
        ...(irrigationType !== undefined && { irrigationType: clear(irrigationType) }),
      };

      const farm = await prisma.farmDetail.upsert({
        where:  { userId: req.user.id },
        create: { userId: req.user.id, cropTypes: cropTypes || [], ...data },
        update: data,
      });

      return sendSuccess(res, farm);
    } catch (err) {
      logger.error({ err }, '[User] PUT /me/farm error');
      return sendError(res, 'Failed to update farm details', 500);
    }
  }
);

// ── POST /me/push-token ────────────────────────────────────────────────────────
router.post(
  '/me/push-token',
  [
    // [L1] Expo token format: ExponentPushToken[xxxx...] or ExpoPushToken[xxxx...]
    // Max length ~100 chars. Validate format to prevent junk tokens being stored.
    body('token')
      .trim()
      .notEmpty().withMessage('Expo push token required')
      .isLength({ max: 100 }).withMessage('Token too long')
      .matches(/^Expo(nent)?PushToken\[.+\]$/)
      .withMessage('Invalid Expo push token format'),
    body('platform').isIn(['ios', 'android']).withMessage('platform must be ios or android'),
  ],
  validate,
  async (req, res) => {
    try {
      const { token, platform } = req.body;

      await prisma.pushToken.upsert({
        where:  { token },
        create: { token, userId: req.user.id, platform },
        update: { userId: req.user.id },
      });

      return sendSuccess(res, { registered: true });
    } catch (err) {
      logger.error({ err }, '[User] POST /me/push-token error');
      return sendError(res, 'Failed to register push token', 500);
    }
  }
);

export default router;
