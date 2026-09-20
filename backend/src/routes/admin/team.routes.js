/**
 * Admin team & access management — /api/v1/admin/team (+ /api/v1/admin/me)
 *
 * GET   /me               acting admin's identity + RBAC scopes (drives SPA nav gating)
 * GET   /team             list admins (phones masked)
 * POST  /team/invite      promote an existing ACTIVE user (by phone) to ADMIN + assign scopes
 * PATCH /team/:id/scopes  update an admin's scopes
 * POST  /team/:id/revoke  demote to FARMER, clear scopes, force-logout, pull live offers
 *
 * /team is SUPER_ADMIN-gated at the parent router; /me is open to any admin.
 * Every mutation bumps tokenVersion so the role/scope change takes effect on the
 * target's next request, and writes an audit row. PII (phone) is masked.
 *
 * ── Deactivated accounts ──────────────────────────────────────────────────────
 * Only /invite checks `isActive`, and deliberately so. GRANTING admin to a
 * pulled account is the bug (see the check below); SEEING and REMOVING one is
 * the job. So the list keeps returning deactivated admins with their isActive
 * flag for the SPA to mark, and both /scopes and /revoke keep working on them —
 * the deactivated admin who still holds scopes is precisely the one an operator
 * needs to narrow or demote, and refusing would mean reactivating the account
 * first just to take its access away. An admin console that hides rows from
 * admins is worse than one that shows a disabled row.
 */
import { Router } from 'express';
import { body, param } from 'express-validator';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { sendSuccess, sendServerError, sendNotFound } from '../../utils/response.js';
import { keysetList } from '../../utils/adminList.js';
import { adminAudit, listParams } from './_helpers.js';
import { ADMIN_ACTIONS, maskPhone } from '../../services/audit.service.js';
import { ALL_ADMIN_SCOPES } from '../../middleware/admin.js';
import { LIVE_LISTING_STATES } from '../../middleware/sellerKyc.js';
import { bumpListingVersion } from '../../utils/listingCache.js';
import { invalidateBuyBox } from '../../services/buyBox.service.js';

const meRouter = Router();
const teamRouter = Router();

// ── GET /me — the acting admin's own identity + scopes ─────────────────────────
meRouter.get('/', (req, res) => {
  return sendSuccess(res, {
    id: req.user.id,
    role: req.user.role,
    scopes: req.admin?.scopes ?? [],
    isSuperAdmin: Boolean(req.admin?.isSuperAdmin),
    allScopes: ALL_ADMIN_SCOPES,
  });
});

const TEAM_SELECT = {
  id: true, name: true, phone: true, adminScopes: true, isActive: true,
  lastActiveAt: true, createdAt: true,
};

const shapeAdmin = (u) => ({ ...u, phone: maskPhone(u.phone) });

const scopesValidator = body('scopes')
  .isArray().withMessage('scopes must be an array')
  .bail()
  .custom((arr) => arr.every((s) => ALL_ADMIN_SCOPES.includes(s)))
  .withMessage(`scopes must be a subset of: ${ALL_ADMIN_SCOPES.join(', ')}`);

// ── GET /team ──────────────────────────────────────────────────────────────────
teamRouter.get('/', async (req, res) => {
  try {
    const { cursor, limit } = listParams(req);
    const page = await keysetList(prisma.user, { where: { role: 'ADMIN' }, cursor, limit, select: TEAM_SELECT });
    const items = page.items.map(shapeAdmin);
    return sendSuccess(res, { items }, 200, { hasMore: page.hasMore, nextCursor: page.nextCursor, count: items.length });
  } catch (err) {
    return sendServerError(res, err, 'Failed to load admin team');
  }
});

// ── POST /team/invite — promote an existing user to ADMIN with scopes ──────────
teamRouter.post(
  '/invite',
  [
    body('phone').isString().trim().isLength({ min: 6, max: 20 }),
    scopesValidator,
    body('reason').optional().isString().trim().isLength({ max: 500 }),
  ],
  validate,
  async (req, res) => {
    try {
      const phone = req.body.phone.trim();
      const scopes = req.body.scopes;
      const user = await prisma.user.findUnique({
        where: { phone },
        select: { id: true, role: true, name: true, adminScopes: true, isActive: true },
      });
      if (!user) {
        return sendServerError(
          res,
          Object.assign(new Error('No user with that phone — they must sign up in the app first'), { expose: true, statusCode: 404 }),
          'User not found', 404,
        );
      }
      // A DEACTIVATED account cannot be promoted. Deactivation is how an account
      // is pulled: authenticate() rejects its every request, and the seller paths
      // refuse to treat it as live (buyBox.activeSellerWhere). Promoting it
      // anyway granted the ADMIN role and full scopes to a banned account —
      // silently, since the invite reported success and GET /team then listed it
      // as a colleague. Nothing happened until someone flipped isActive back,
      // and at that moment the account was an administrator: the deactivation no
      // longer held, and no one had decided that it should not.
      //
      // 409 rather than 404: the account exists and the caller may legitimately
      // reactivate it first, so hiding it would send them looking for a signup
      // that already happened.
      if (user.isActive === false) {
        return sendServerError(
          res,
          Object.assign(new Error('That account is deactivated — reactivate it before granting admin access'), { expose: true, statusCode: 409 }),
          'Account deactivated', 409,
        );
      }
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { role: 'ADMIN', adminScopes: scopes, tokenVersion: { increment: 1 } },
        select: { id: true, role: true, adminScopes: true },
      });
      await adminAudit(req, ADMIN_ACTIONS.TEAM_INVITE, 'User', user.id, {
        before: { role: user.role, adminScopes: user.adminScopes },
        after: { role: updated.role, adminScopes: updated.adminScopes },
        metadata: { reason: req.body.reason ?? null },
      });
      return sendSuccess(res, { id: updated.id, role: updated.role, adminScopes: updated.adminScopes });
    } catch (err) {
      return sendServerError(res, err, 'Failed to invite admin');
    }
  },
);

// ── PATCH /team/:id/scopes ─────────────────────────────────────────────────────
teamRouter.patch(
  '/:id/scopes',
  [param('id').isUUID(), scopesValidator, body('reason').optional().isString().trim().isLength({ max: 500 })],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const current = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, adminScopes: true } });
      if (!current || current.role !== 'ADMIN') return sendNotFound(res, 'Admin');
      const updated = await prisma.user.update({
        where: { id },
        data: { adminScopes: req.body.scopes, tokenVersion: { increment: 1 } },
        select: { id: true, adminScopes: true },
      });
      await adminAudit(req, ADMIN_ACTIONS.TEAM_SCOPES_UPDATE, 'User', id, {
        before: { adminScopes: current.adminScopes },
        after: { adminScopes: updated.adminScopes },
        metadata: { reason: req.body.reason ?? null },
      });
      return sendSuccess(res, { id: updated.id, adminScopes: updated.adminScopes });
    } catch (err) {
      return sendServerError(res, err, 'Failed to update scopes');
    }
  },
);

// ── POST /team/:id/revoke — demote + force-logout everywhere ───────────────────
teamRouter.post(
  '/:id/revoke',
  [param('id').isUUID(), body('reason').isString().trim().isLength({ min: 3, max: 500 })],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (id === req.user.id) {
        return sendServerError(
          res,
          Object.assign(new Error('You cannot revoke your own admin access'), { expose: true, statusCode: 400 }),
          'Cannot revoke self', 400,
        );
      }
      const current = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, adminScopes: true } });
      if (!current || current.role !== 'ADMIN') return sendNotFound(res, 'Admin');

      // Demote to a regular user, clear scopes, bump tokenVersion AND delete refresh
      // tokens → a true logout everywhere (mirrors users.routes force-logout). We
      // demote to FARMER since the prior non-admin role isn't tracked.
      //
      // ADMIN is a SELLER_ROLE (agristore.routes), so an admin can hold AgriStore
      // offers — and FARMER cannot. Revoking therefore pulls their live offers in
      // the SAME transaction, exactly as PATCH /admin/users/:id does for a seller
      // demotion: otherwise the offers keep winning the buy box for a seller who
      // now fails requireRole on every route that would confirm or dispatch them.
      // Not reversed by a later re-invite — prices and stock may be stale by then,
      // so the seller re-enables each offer once they have checked it.
      const [updated, revoked, pulled] = await prisma.$transaction([
        prisma.user.update({ where: { id }, data: { role: 'FARMER', adminScopes: [], tokenVersion: { increment: 1 } }, select: { id: true, role: true } }),
        prisma.refreshToken.deleteMany({ where: { userId: id } }),
        prisma.sellerListing.updateMany({
          where: { sellerId: id, status: { in: LIVE_LISTING_STATES } },
          data: { status: 'INACTIVE' },
        }),
      ]);
      const listingsDeactivated = pulled.count;
      if (listingsDeactivated) {
        await Promise.all([bumpListingVersion('agristore:products'), invalidateBuyBox()]);
      }

      await adminAudit(req, ADMIN_ACTIONS.TEAM_REVOKE, 'User', id, {
        before: { role: current.role, adminScopes: current.adminScopes },
        after: { role: updated.role, adminScopes: [] },
        metadata: { reason: req.body.reason, refreshTokensRevoked: revoked.count, listingsDeactivated },
      });
      return sendSuccess(res, {
        id: updated.id, role: updated.role, refreshTokensRevoked: revoked.count, listingsDeactivated,
      });
    } catch (err) {
      return sendServerError(res, err, 'Failed to revoke admin');
    }
  },
);

export { teamRouter, meRouter };
