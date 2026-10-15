/**
 * Content moderation routes (Admin) — the REV-5 review queue that fake-content
 * signals (FRAUD-5) route suspicious reviews/listings into.
 *
 * GET  /api/v1/admin/moderation              ?status=&entityType=&limit=
 *      List the moderation queue (defaults to PENDING, newest first;
 *      status=ALL lists every status).
 * GET  /api/v1/admin/moderation/:id
 *      One flag, the flagged content, and — for user reports (POST /reports and
 *      mirrored animal-listing reports) — who reported it, why, and what they saw.
 * POST /api/v1/admin/moderation/:id/resolve  { status: APPROVED|REJECTED, note? }
 *      Clear (APPROVED) or remove (REJECTED) a flagged item.
 */
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';
import logger from '../utils/logger.js';
import prisma from '../config/db.js';
import { listFlags, resolveFlag, MODERATION_STATUSES } from '../services/moderation.service.js';
import {
  USER_REPORT_ENTITY_TYPES, isSnapshotEntityId, parseReportMetadata,
} from '../services/userReport.service.js';
import { uuidParamGuard } from '../middleware/uuidParams.js';

const router = Router();

// Structural UUID guard. These routes each carried their own param('...').isUUID(),
// which works only for as long as every future route remembers to repeat it — the
// invariant lived in a convention rather than anywhere it could be enforced. Same
// 400 as the per-route chains, which stay in place.
router.param('id', uuidParamGuard);

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') return sendError(res, 'Admin access required', 403);
  next();
}

router.use(authenticate, requireAdmin);

// ── GET / — the moderation queue ─────────────────────────────────────────────
router.get(
  '/',
  [
    query('status').optional().isIn([...MODERATION_STATUSES, 'ALL']),
    query('entityType').optional().isIn(['Review', 'Product', ...USER_REPORT_ENTITY_TYPES]),
    query('limit').optional().isInt({ min: 1, max: 200 }),
  ],
  validate,
  async (req, res) => {
    try {
      const flags = await listFlags({
        // An absent status means PENDING (the work queue); null lifts the filter.
        status: req.query.status === 'ALL' ? null : req.query.status,
        entityType: req.query.entityType,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      });
      return sendSuccess(res, { flags });
    } catch (err) {
      logger.error({ err }, '[Moderation] GET / error');
      return sendError(res, 'Failed to load moderation queue', 500);
    }
  }
);

const USER_BRIEF = { select: { id: true, name: true } };

/**
 * The flagged item as it is NOW, for the moderator. Null when the row is gone, or
 * when a user report has no stored row (an AI reply known only by its text).
 */
async function loadFlaggedEntity(flag) {
  if (isSnapshotEntityId(flag.entityId)) return null;
  const where = { id: flag.entityId };
  switch (flag.entityType) {
    case 'Review':
    case 'PRODUCT_REVIEW':
      return prisma.review.findUnique({ where, include: { user: USER_BRIEF, product: { select: { id: true, name: true } } } });
    case 'Product':
      return prisma.product.findUnique({ where, include: { seller: USER_BRIEF } });
    case 'AnimalListing':
      return prisma.animalListing.findUnique({
        where,
        select: {
          id: true, animal: true, breed: true, price: true, description: true, status: true, images: true,
          sellerLocation: true, createdAt: true, seller: USER_BRIEF,
          // The listing's own report rows — filed before this queue mirrored them too.
          reports: {
            orderBy: { createdAt: 'desc' }, take: 50,
            select: { reason: true, details: true, status: true, createdAt: true, reporter: USER_BRIEF },
          },
        },
      });
    case 'MACHINERY_LISTING':
      return prisma.machineryListing.findUnique({
        where,
        select: { id: true, name: true, category: true, description: true, status: true, images: true, location: true, district: true, createdAt: true, owner: USER_BRIEF },
      });
    case 'LABOUR_LISTING':
      return prisma.labourListing.findUnique({
        where,
        select: { id: true, name: true, skills: true, description: true, status: true, location: true, district: true, createdAt: true, provider: USER_BRIEF },
      });
    case 'CHAT_MESSAGE':
      return prisma.chatMessage.findUnique({
        where,
        select: { id: true, text: true, imageUrl: true, createdAt: true, senderId: true, chatId: true, chat: { select: { listingId: true, buyerId: true, sellerId: true } } },
      });
    case 'USER':
      return prisma.user.findUnique({
        where,
        select: { id: true, name: true, role: true, isActive: true, district: true, state: true, createdAt: true },
      });
    case 'AI_MESSAGE':
      return prisma.aIMessage.findUnique({ where, select: { id: true, role: true, content: true, modelUsed: true, language: true, createdAt: true } });
    case 'AI_VOICE_MESSAGE':
      return prisma.voiceMessage.findUnique({ where, select: { id: true, role: true, content: true, modelUsed: true, language: true, createdAt: true } });
    case 'CROP_REPORT_SHARE':
      return prisma.cropReportShare.findUnique({
        where,
        select: {
          id: true, message: true, status: true, createdAt: true, farmer: USER_BRIEF, seller: USER_BRIEF,
          report: { select: { id: true, cropType: true, primaryDisease: true, imageUrls: true } },
        },
      });
    case 'AI_DIAGNOSIS':
      return prisma.cropDiseaseReport.findUnique({
        where,
        select: { id: true, cropType: true, primaryDisease: true, confidenceScore: true, riskLevel: true, imageUrls: true, createdAt: true },
      });
    default:
      return null;
  }
}

/**
 * Who reported a user-report flag, why, and what they saw — newest report first,
 * with names for the reporters and the author (one bounded lookup, ≤ 51 ids).
 * Null for the fraud-signal flags, which carry no reports.
 */
async function userReportSummary(flag) {
  if (!USER_REPORT_ENTITY_TYPES.includes(flag.entityType)) return null;
  const meta = parseReportMetadata(flag.metadata);
  const entries = Array.isArray(meta.reports) ? [...meta.reports].reverse() : [];
  const ids = [...new Set([flag.authorId, ...entries.map((e) => e.reporterId)].filter(Boolean))];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  return {
    reporterCount: flag.score,
    snapshot: meta.snapshot ?? null,
    snapshotSource: meta.snapshotSource ?? null,
    author: flag.authorId ? { id: flag.authorId, name: names.get(flag.authorId) ?? null } : null,
    reports: entries.map((e) => ({ ...e, reporterName: names.get(e.reporterId) ?? null })),
    previousResolutions: Array.isArray(meta.previousResolutions) ? meta.previousResolutions : [],
  };
}

// ── GET /:id — flag detail + the underlying flagged content ──────────────────
router.get('/:id', [param('id').isUUID()], validate, async (req, res) => {
  try {
    const flag = await prisma.contentFlag.findUnique({ where: { id: req.params.id } });
    if (!flag) return sendNotFound(res, 'Flag');

    const [entity, report] = await Promise.all([loadFlaggedEntity(flag), userReportSummary(flag)]);
    return sendSuccess(res, { flag, entity, report });
  } catch (err) {
    logger.error({ err }, '[Moderation] GET /:id error');
    return sendError(res, 'Failed to load flag detail', 500);
  }
});

// ── POST /:id/resolve — clear or remove a flagged item ───────────────────────
router.post(
  '/:id/resolve',
  [
    param('id').isUUID(),
    body('status').isIn(['APPROVED', 'REJECTED']),
    body('note').optional().trim().isLength({ max: 2000 }),
  ],
  validate,
  async (req, res) => {
    try {
      const updated = await resolveFlag({
        id: req.params.id,
        status: req.body.status,
        reviewedById: req.user.id,
        note: req.body.note ?? null,
      });
      if (!updated) return sendNotFound(res, 'Flag');
      return sendSuccess(res, updated);
    } catch (err) {
      if (err?.expose) return sendError(res, err.message, err.statusCode || 400);
      logger.error({ err }, '[Moderation] POST /:id/resolve error');
      return sendError(res, 'Failed to resolve flag', 500);
    }
  }
);

export default router;
