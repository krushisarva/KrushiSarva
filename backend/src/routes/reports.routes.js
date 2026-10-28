/**
 * User reports — "Report" on AI replies, scan results, people, chat messages,
 * listings and reviews (Google Play UGC + AI-generated content policies).
 *
 * POST /api/v1/reports   (auth, 20/hour/user)
 *   { targetType, targetId?, reason, details?, snapshot? }
 *   → 201 { reported: true, duplicate }
 *
 * Every report goes into the admin moderation queue (ContentFlag) for a human to
 * review; nothing is hidden or removed automatically. Blocking a person is a
 * separate call: POST /api/v1/animals/sellers/:sellerId/block.
 */
import { Router } from 'express';
import { body } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { rateLimiter, clientIp } from '../middleware/rateLimit.js';
import { sendCreated, sendError, sendServerError } from '../utils/response.js';
import { stripHtml } from '../utils/encrypt.js';
import { auditLog } from '../services/audit.service.js';
import {
  REPORT_TARGET_TYPES, REPORT_REASONS, SNAPSHOT_MAX, DETAILS_MAX,
  resolveReportTarget, recordUserReport,
} from '../services/userReport.service.js';

const router = Router();

// Keyed on the user (authenticate runs first). Generous for a farmer flagging
// what they see; tight enough that one account cannot flood the queue.
const reportLimit = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  prefix: 'reports:create',
  key: (req) => req.user?.id || clientIp(req),
  message: 'Too many reports. Please try again later.',
});

router.post(
  '/',
  authenticate,
  reportLimit,
  [
    body('targetType').isIn(REPORT_TARGET_TYPES).withMessage(`must be one of: ${REPORT_TARGET_TYPES.join(', ')}`),
    // A numeric local id (an unsaved AI reply) is accepted as its string form.
    body('targetId').optional({ values: 'falsy' })
      .customSanitizer((v) => (typeof v === 'number' ? String(v) : v))
      .isString().trim().isLength({ min: 1, max: 128 }),
    body('reason').isIn(REPORT_REASONS).withMessage(`must be one of: ${REPORT_REASONS.join(', ')}`),
    body('details').optional({ values: 'falsy' }).isString().isLength({ max: DETAILS_MAX }),
    body('snapshot').optional({ values: 'falsy' }).isString().isLength({ max: SNAPSHOT_MAX }),
  ],
  validate,
  async (req, res) => {
    const { targetType, reason } = req.body;
    const targetId = req.body.targetId || null;
    const snapshot = req.body.snapshot?.trim() || null;
    const details = stripHtml(req.body.details || '') || null;
    if (!targetId && !snapshot) return sendError(res, 'snapshot is required when targetId is absent', 400);

    try {
      const target = await resolveReportTarget({ targetType, targetId, reporterId: req.user.id, snapshot });
      const result = await recordUserReport({
        entityType: targetType,
        entityId: target.entityId,
        authorId: target.authorId,
        reporterId: req.user.id,
        reason,
        details,
        snapshot: target.snapshot,
        snapshotSource: target.snapshotSource,
        // An AI id the server could not match is kept for the moderator, not trusted.
        clientTargetId: targetId && !target.verified ? targetId : null,
      });

      auditLog({
        userId: req.user.id, action: 'CONTENT_REPORT', entity: targetType,
        entityId: target.entityId, metadata: { reason, flagId: result.id },
        ip: clientIp(req), requestId: req.id,
      }).catch(() => {});

      return sendCreated(res, { reported: true, duplicate: !result.newReporter });
    } catch (err) {
      if (err?.expose) return sendError(res, err.message, err.statusCode || 400);
      return sendServerError(res, err, 'Could not submit the report');
    }
  },
);

export default router;
