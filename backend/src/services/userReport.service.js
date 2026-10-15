/**
 * User reports → moderation queue (Google Play UGC / AI-generated content policy).
 *
 * Anyone signed in can report an AI reply, a crop-scan result, a person, a chat
 * message, a listing, a review or a crop report a farmer shared with their Krushi
 * Seva Kendra (seller app). Reports land in the SAME queue the fraud
 * signals use (ContentFlag, admin "Moderation queue"), so moderators work one
 * list. No schema change: one ContentFlag row per reported item —
 *
 *   entityType  the report targetType ('AI_MESSAGE', 'USER', … or 'AnimalListing'
 *               for the mirrored animal-listing reports)
 *   entityId    the target's id, or `snap_<hash>` of the reported text when the
 *               client has no server id (a fresh AI reply)
 *   reasons     'user_report:<reason>' for every distinct reason given
 *   score       number of DISTINCT reporters — the same person tapping Report
 *               twice updates their entry instead of inflating the count
 *   metadata    JSON { kind, snapshot, snapshotSource, reports[], previousResolutions[] }
 *               `reports` keeps the newest MAX_REPORT_ENTRIES entries only.
 *
 * Known limit of the bounded list: once an item has more than MAX_REPORT_ENTRIES
 * distinct reporters, a repeat report from someone whose entry was trimmed counts
 * again. By then the item is far past any review threshold, so the cost is a
 * slightly high number on content that is already at the top of the queue.
 */
import crypto from 'node:crypto';
import prisma from '../config/db.js';

export const REPORT_TARGET_TYPES = [
  'AI_MESSAGE', 'AI_VOICE_MESSAGE', 'AI_DIAGNOSIS',
  'USER', 'CHAT_MESSAGE', 'MACHINERY_LISTING', 'LABOUR_LISTING', 'PRODUCT_REVIEW',
  'CROP_REPORT_SHARE',
];
export const REPORT_REASONS = ['offensive', 'harmful_or_dangerous', 'wrong_information', 'spam_or_fraud', 'harassment', 'other'];

/** Types that point at a stored row the reporter can see — an id is mandatory. */
export const ID_REQUIRED_TYPES = [
  'USER', 'CHAT_MESSAGE', 'MACHINERY_LISTING', 'LABOUR_LISTING', 'PRODUCT_REVIEW', 'CROP_REPORT_SHARE',
];

/** Animal-listing reports keep their own table and are mirrored in under this type. */
export const ANIMAL_LISTING_ENTITY = 'AnimalListing';

/** Every entity type a user report can create — the admin filter accepts these. */
export const USER_REPORT_ENTITY_TYPES = [...REPORT_TARGET_TYPES, ANIMAL_LISTING_ENTITY];

export const REASON_PREFIX = 'user_report:';
export const MAX_REPORT_ENTRIES = 50;
export const SNAPSHOT_MAX = 4000;
export const DETAILS_MAX = 1000;
const MAX_PREVIOUS_RESOLUTIONS = 10;

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, expose: true });
}

const clip = (s, max) => (typeof s === 'string' && s.length > max ? s.slice(0, max) : s);

/**
 * Stable id for content that has no server id: the same text reported twice
 * (by one person or by many) lands on the same flag.
 */
export function snapshotEntityId(targetType, snapshot) {
  const normalized = String(snapshot).trim().replace(/\s+/g, ' ');
  return 'snap_' + crypto.createHash('sha256').update(`${targetType}\n${normalized}`).digest('hex').slice(0, 40);
}

export const isSnapshotEntityId = (entityId) => typeof entityId === 'string' && entityId.startsWith('snap_');

/** Parse a flag's metadata column; anything unreadable is treated as empty. */
export function parseReportMetadata(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Look the reported thing up and decide what the flag is keyed on.
 *
 * Stored targets (USER, CHAT_MESSAGE, listings, reviews, shared crop reports) must exist and be
 * visible to the reporter (404 otherwise), and nobody can report themselves or
 * their own content (400). Their snapshot comes from the DATABASE, not the client.
 *
 * AI targets are lenient on purpose: the app saves AI replies with createMany and
 * never learns their ids, so it usually sends local ids or none. An id that
 * resolves to the reporter's OWN conversation/scan is used and trusted; anything
 * else falls back to the client's snapshot (marked as such for the moderator).
 *
 * @returns {Promise<{ entityId: string, authorId: ?string, snapshot: ?string, snapshotSource: 'server'|'client'|null, verified: boolean }>}
 */
export async function resolveReportTarget({ targetType, targetId = null, reporterId, snapshot = null }) {
  const clientSnapshot = snapshot ? clip(snapshot, SNAPSHOT_MAX) : null;
  const stored = (entityId, authorId, serverSnapshot) => ({
    entityId,
    authorId,
    snapshot: serverSnapshot ? clip(serverSnapshot, SNAPSHOT_MAX) : clientSnapshot,
    snapshotSource: serverSnapshot ? 'server' : (clientSnapshot ? 'client' : null),
    verified: true,
  });

  if (ID_REQUIRED_TYPES.includes(targetType) && !targetId) {
    throw httpError('targetId is required for this report type', 400);
  }

  switch (targetType) {
    case 'USER': {
      if (targetId === reporterId) throw httpError('You cannot report yourself.', 400);
      const user = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
      if (!user) throw httpError('User not found', 404);
      // The person has no text of their own; keep whatever context the reporter sent.
      return stored(user.id, user.id, null);
    }
    case 'CHAT_MESSAGE': {
      const msg = await prisma.chatMessage.findUnique({
        where: { id: targetId },
        select: { id: true, text: true, imageUrl: true, senderId: true, chat: { select: { buyerId: true, sellerId: true } } },
      });
      // Only the two people in a chat can see its messages, so only they can report one.
      if (!msg || (msg.chat.buyerId !== reporterId && msg.chat.sellerId !== reporterId)) {
        throw httpError('Message not found', 404);
      }
      if (msg.senderId === reporterId) throw httpError('You cannot report your own message.', 400);
      const text = [msg.text, msg.imageUrl ? `[image] ${msg.imageUrl}` : null].filter(Boolean).join('\n');
      return stored(msg.id, msg.senderId, text || null);
    }
    case 'MACHINERY_LISTING': {
      const row = await prisma.machineryListing.findUnique({
        where: { id: targetId }, select: { id: true, ownerId: true, name: true, description: true },
      });
      if (!row) throw httpError('Listing not found', 404);
      if (row.ownerId === reporterId) throw httpError('You cannot report your own listing.', 400);
      return stored(row.id, row.ownerId, [row.name, row.description].filter(Boolean).join('\n'));
    }
    case 'LABOUR_LISTING': {
      const row = await prisma.labourListing.findUnique({
        where: { id: targetId }, select: { id: true, providerId: true, name: true, description: true },
      });
      if (!row) throw httpError('Listing not found', 404);
      if (row.providerId === reporterId) throw httpError('You cannot report your own listing.', 400);
      return stored(row.id, row.providerId, [row.name, row.description].filter(Boolean).join('\n'));
    }
    case 'PRODUCT_REVIEW': {
      const row = await prisma.review.findUnique({
        where: { id: targetId }, select: { id: true, userId: true, rating: true, comment: true },
      });
      if (!row) throw httpError('Review not found', 404);
      if (row.userId === reporterId) throw httpError('You cannot report your own review.', 400);
      return stored(row.id, row.userId, `Rating ${row.rating}/5${row.comment ? `\n${row.comment}` : ''}`);
    }
    case 'CROP_REPORT_SHARE': {
      // A farmer's crop scan (photos, diagnosis) and note, shared with one Krushi
      // Seva Kendra. Only the farmer and that Kendra can see it, so only the
      // Kendra can report it — the farmer is its author.
      const row = await prisma.cropReportShare.findUnique({
        where: { id: targetId },
        select: {
          id: true, farmerId: true, sellerId: true, message: true,
          report: { select: { cropType: true, primaryDisease: true, imageUrls: true } },
        },
      });
      if (!row || (row.sellerId !== reporterId && row.farmerId !== reporterId)) {
        throw httpError('Report not found', 404);
      }
      if (row.farmerId === reporterId) throw httpError('You cannot report your own report.', 400);
      return stored(row.id, row.farmerId, [
        `${row.report.cropType}: ${row.report.primaryDisease}`,
        row.message ? `Note: ${row.message}` : null,
        ...(row.report.imageUrls || []).map((url) => `[image] ${url}`),
      ].filter(Boolean).join('\n'));
    }
    case 'AI_MESSAGE':
    case 'AI_VOICE_MESSAGE':
    case 'AI_DIAGNOSIS': {
      if (targetId) {
        const own = await findOwnAiTarget(targetType, targetId, reporterId);
        if (own) return stored(own.id, null, own.text);
      }
      if (!clientSnapshot) {
        throw targetId ? httpError('Reported content not found', 404) : httpError('snapshot is required when targetId is absent', 400);
      }
      return {
        entityId: snapshotEntityId(targetType, clientSnapshot),
        authorId: null,
        snapshot: clientSnapshot,
        snapshotSource: 'client',
        verified: false,
      };
    }
    default:
      throw httpError('Unsupported report type', 400);
  }
}

/** An AI reply / voice reply / scan that belongs to the reporter, or null. */
async function findOwnAiTarget(targetType, targetId, reporterId) {
  if (targetType === 'AI_MESSAGE') {
    const m = await prisma.aIMessage.findFirst({
      where: { id: targetId, conversation: { userId: reporterId } }, select: { id: true, content: true },
    });
    return m && { id: m.id, text: m.content };
  }
  if (targetType === 'AI_VOICE_MESSAGE') {
    const m = await prisma.voiceMessage.findFirst({
      where: { id: targetId, conversation: { userId: reporterId } }, select: { id: true, content: true },
    });
    return m && { id: m.id, text: m.content };
  }
  const r = await prisma.cropDiseaseReport.findFirst({
    where: { id: targetId, userId: reporterId },
    select: { id: true, cropType: true, primaryDisease: true, confidenceScore: true, riskLevel: true },
  });
  return r && {
    id: r.id,
    text: `${r.cropType}: ${r.primaryDisease} (confidence ${r.confidenceScore}, risk ${r.riskLevel})`,
  };
}

/**
 * File (or refresh) one person's report on one item.
 *
 * Runs in a transaction holding the flag's row lock, so two people reporting the
 * same item at the same moment cannot overwrite each other's entry in the
 * metadata list (a plain read-modify-write would lose one).
 *
 * A NEW reporter re-opens a flag a moderator already resolved; the same reporter
 * reporting again does not (one person cannot keep resurrecting a dismissed item).
 *
 * @returns {Promise<{ id: string, reporterCount: number, newReporter: boolean, reopened: boolean }>}
 */
export async function recordUserReport({
  entityType, entityId, authorId = null, reporterId, reason, details = null,
  snapshot = null, snapshotSource = null, clientTargetId = null,
}) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // Create-if-absent as INSERT … ON CONFLICT DO NOTHING — no check-then-insert race.
    await tx.contentFlag.createMany({
      data: [{ entityType, entityId, authorId, reasons: [], score: 0 }],
      skipDuplicates: true,
    });
    await tx.$queryRaw`
      SELECT id FROM content_flags
      WHERE "entityType" = ${entityType} AND "entityId" = ${entityId}
      FOR UPDATE`;
    const flag = await tx.contentFlag.findUnique({ where: { entityType_entityId: { entityType, entityId } } });

    const meta = parseReportMetadata(flag.metadata);
    const reports = Array.isArray(meta.reports) ? meta.reports.filter((r) => r && r.reporterId) : [];
    const at = reports.findIndex((r) => r.reporterId === reporterId);
    const newReporter = at === -1;
    if (!newReporter) reports.splice(at, 1);
    reports.push({
      reporterId,
      reason,
      details: details ? clip(details, DETAILS_MAX) : null,
      ...(clientTargetId ? { clientTargetId: clip(String(clientTargetId), 128) } : {}),
      at: now.toISOString(),
    });
    // Oldest entries fall off first; the newest context is what a moderator needs.
    while (reports.length > MAX_REPORT_ENTRIES) reports.shift();

    const reopened = newReporter && flag.status !== 'PENDING';
    const previousResolutions = Array.isArray(meta.previousResolutions) ? meta.previousResolutions : [];
    if (reopened) {
      previousResolutions.push({
        status: flag.status, note: flag.resolution ?? null,
        reviewedById: flag.reviewedById ?? null, reviewedAt: flag.reviewedAt ?? null,
      });
      while (previousResolutions.length > MAX_PREVIOUS_RESOLUTIONS) previousResolutions.shift();
    }

    // A server-derived snapshot is the current content, so it always wins. A
    // client one is only a claim: keep the first, so later reporters cannot
    // rewrite what the earlier ones reported.
    let keptSnapshot = meta.snapshot ?? null;
    let keptSource = meta.snapshotSource ?? null;
    if (snapshot && (snapshotSource === 'server' || !keptSnapshot)) {
      keptSnapshot = clip(snapshot, SNAPSHOT_MAX);
      keptSource = snapshotSource ?? 'client';
    }

    const reasonTag = REASON_PREFIX + reason;
    const reasons = flag.reasons.includes(reasonTag) ? flag.reasons : [...flag.reasons, reasonTag];

    const updated = await tx.contentFlag.update({
      where: { id: flag.id },
      data: {
        reasons,
        score: newReporter ? flag.score + 1 : flag.score,
        ...(authorId ? { authorId } : {}),
        metadata: JSON.stringify({
          ...meta,
          kind: 'user_report',
          snapshot: keptSnapshot,
          snapshotSource: keptSource,
          reports,
          previousResolutions,
        }),
        ...(reopened ? { status: 'PENDING', reviewedById: null, reviewedAt: null, resolution: null } : {}),
      },
      select: { id: true, score: true },
    });
    return { id: updated.id, reporterCount: updated.score, newReporter, reopened };
  });
}
