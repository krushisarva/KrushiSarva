/**
 * Seller KYC gate — nothing goes on sale until an admin has verified the
 * seller's KYC (Aadhaar / PAN / payout account).
 *
 * Every path that puts a NEW offer on sale checks it:
 *   POST  /agristore/listings              create an offer
 *   POST  /agristore/seller/products       legacy create (old seller-app builds)
 *   POST  /agristore/catalog/products      propose a catalogue entry — step 3 of
 *                                          add-product, always followed by POST
 *                                          /listings; gated so it fails before
 *                                          leaving an orphan entry in the QC queue
 *   PATCH /agristore/listings/:id          only when a paused offer goes live
 *   PUT   /agristore/seller/products/:id   legacy resume, same rule
 * Admin catalogue QC approval releases a seller's draft offers only when that
 * seller is verified (routes/admin/catalogQc.routes.js).
 *
 * Offers already live are left alone: pausing, deleting, restocking, editing
 * price and fulfilling orders all stay open, so a seller whose KYC went back
 * for review can still serve the buyers they have. An admin KYC reject is what
 * takes a seller's live offers down (routes/admin/kyc.routes.js).
 *
 * Roles (the AgriStore SELLER_ROLES):
 *   SELLER, VERIFIED_FARMER — gated. VERIFIED_FARMER is a role, not a KYC
 *     decision, and admin KYC approval turns it into SELLER anyway.
 *   ADMIN — exempt. Admin accounts never go through seller KYC, and an admin
 *     acting on an offer is a deliberate operator decision.
 *
 * kycStatus is read from the database, not the token: the JWT carries only
 * { sub, role }, and a KYC decision must apply on the next request, not at the
 * next token refresh. One primary-key read, on these write routes only.
 */
import prisma from '../config/db.js';
import { sendError } from '../utils/response.js';

export const KYC_REQUIRED_CODE = 'KYC_REQUIRED';
export const KYC_REQUIRED_MESSAGE = 'Your KYC must be verified before you can sell. Complete it in Business Profile.';

/** Offer states a buyer can reach, or that return to sale by themselves on restock. */
export const LIVE_LISTING_STATES = ['ACTIVE', 'OUT_OF_STOCK'];

/** True if this listing status change puts an offer (back) on sale. */
export function goesLive(fromStatus, toStatus) {
  return LIVE_LISTING_STATES.includes(toStatus) && !LIVE_LISTING_STATES.includes(fromStatus);
}

/** May `user` ({ id, role } from authenticate) put an offer on sale? */
export async function canSell(user) {
  if (user?.role === 'ADMIN') return true;
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { kycStatus: true } });
  return row?.kycStatus === 'VERIFIED';
}

/** 403 with a code the apps can branch on, and a message a seller can act on. */
export function sendKycRequired(res) {
  return sendError(res, KYC_REQUIRED_MESSAGE, 403, { code: KYC_REQUIRED_CODE });
}

/** Route middleware; place after authenticate + requireRole. */
export async function requireSellerKyc(req, res, next) {
  try {
    if (!(await canSell(req.user))) return sendKycRequired(res);
    next();
  } catch (err) {
    next(err);
  }
}
