/**
 * User reports — POST /api/v1/reports → the admin moderation queue (ContentFlag).
 *
 * The contract the apps call: validation, one entry per reporter however many
 * times they tap, nobody reporting themselves or their own content, private
 * targets only reportable by the people who can see them, a resolved item
 * re-opened only by a NEW reporter, and the per-user rate limit. Plus the two
 * moderator-facing halves: animal-listing reports mirrored into the queue, and
 * the detail endpoint showing who reported what.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCropReport, createTestCropShare, cleanupTestData, prisma,
} from '../../fixtures/setup.js';
import { resetRateLimitStore } from '../../../src/middleware/rateLimit.js';

const API = '/api/v1/reports';
const ADMIN_API = '/api/v1/admin/moderation';

let app;

beforeAll(async () => {
  app = await getApp();
});

afterAll(async () => {
  await prisma.contentFlag.deleteMany();
  await cleanupTestData();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.contentFlag.deleteMany();
  await cleanupTestData();
  resetRateLimitStore();
});

const report = (who, body) => request(app).post(API).set(who.headers).send(body);
const flagsFor = (entityType) => prisma.contentFlag.findMany({ where: { entityType } });
const metaOf = (flag) => JSON.parse(flag.metadata);

async function makeAnimalListing(sellerId) {
  return prisma.animalListing.create({
    data: {
      sellerId, animal: 'Buffalo', breed: 'Murrah', age: '4 years', gender: 'FEMALE', weight: '520 kg',
      price: 85000, description: 'Healthy milch buffalo', sellerLocation: 'Baramati, Pune, Maharashtra',
      images: [], tags: [], status: 'ACTIVE', lat: 18.52, lng: 73.85,
    },
  });
}

async function makeAiReply(userId, content = 'Spray 10 ml per litre.') {
  const conv = await prisma.aIConversation.create({
    data: { userId, messages: { create: [{ role: 'assistant', content }] } },
    include: { messages: true },
  });
  return conv.messages[0];
}

describe('POST /reports — validation', () => {
  it('requires authentication', async () => {
    const res = await request(app).post(API).send({ targetType: 'AI_MESSAGE', reason: 'offensive', snapshot: 'x' });
    expect(res.status).toBe(401);
  });

  it.each([
    ['an unknown targetType', { targetType: 'POST', reason: 'offensive', snapshot: 'x' }],
    ['an unknown reason', { targetType: 'AI_MESSAGE', reason: 'boring', snapshot: 'x' }],
    ['details over 1000 chars', { targetType: 'AI_MESSAGE', reason: 'other', snapshot: 'x', details: 'd'.repeat(1001) }],
    ['a snapshot over 4000 chars', { targetType: 'AI_MESSAGE', reason: 'other', snapshot: 's'.repeat(4001) }],
    ['no targetId and no snapshot', { targetType: 'AI_MESSAGE', reason: 'wrong_information' }],
    ['a USER report without targetId', { targetType: 'USER', reason: 'harassment', snapshot: 'he shouted' }],
  ])('rejects %s with 400', async (_label, body) => {
    const u = await createTestUser();
    const res = await report(u, body);
    expect(res.status).toBe(400);
    expect(await prisma.contentFlag.count()).toBe(0);
  });
});

describe('POST /reports — people', () => {
  it('will not let a user report themselves', async () => {
    const u = await createTestUser();
    const res = await report(u, { targetType: 'USER', targetId: u.user.id, reason: 'harassment' });
    expect(res.status).toBe(400);
    expect(await prisma.contentFlag.count()).toBe(0);
  });

  it('404s an unknown user', async () => {
    const u = await createTestUser();
    const res = await report(u, { targetType: 'USER', targetId: '00000000-0000-4000-8000-000000000000', reason: 'spam_or_fraud' });
    expect(res.status).toBe(404);
  });

  it('counts one entry per reporter however many times they tap, and each new reporter once', async () => {
    const [a, b, target] = [await createTestUser(), await createTestUser(), await createTestUser()];

    const first = await report(a, { targetType: 'USER', targetId: target.user.id, reason: 'harassment' });
    const again = await report(a, { targetType: 'USER', targetId: target.user.id, reason: 'spam_or_fraud', details: 'asked for advance' });
    const other = await report(b, { targetType: 'USER', targetId: target.user.id, reason: 'harassment' });

    expect(first.status).toBe(201);
    expect(first.body.data).toEqual({ reported: true, duplicate: false });
    expect(again.status).toBe(201);
    expect(again.body.data.duplicate).toBe(true);
    expect(other.body.data.duplicate).toBe(false);

    const flags = await flagsFor('USER');
    expect(flags).toHaveLength(1);
    const [flag] = flags;
    expect(flag).toMatchObject({ entityId: target.user.id, authorId: target.user.id, score: 2, status: 'PENDING' });
    expect(flag.reasons.sort()).toEqual(['user_report:harassment', 'user_report:spam_or_fraud']);
    const reports = metaOf(flag).reports;
    expect(reports).toHaveLength(2);
    // The repeat tap replaced a's entry rather than adding one.
    expect(reports.find((r) => r.reporterId === a.user.id)).toMatchObject({ reason: 'spam_or_fraud', details: 'asked for advance' });
  });

  it('re-opens a resolved flag for a NEW reporter only', async () => {
    const [a, b, target] = [await createTestUser(), await createTestUser(), await createTestUser()];
    await report(a, { targetType: 'USER', targetId: target.user.id, reason: 'harassment' });
    const flag = (await flagsFor('USER'))[0];
    await prisma.contentFlag.update({
      where: { id: flag.id },
      data: { status: 'APPROVED', reviewedAt: new Date(), resolution: 'no violation' },
    });

    // The same person again: stays resolved.
    await report(a, { targetType: 'USER', targetId: target.user.id, reason: 'harassment' });
    expect((await prisma.contentFlag.findUnique({ where: { id: flag.id } })).status).toBe('APPROVED');

    // Someone new: back in the queue, with the earlier decision kept for context.
    await report(b, { targetType: 'USER', targetId: target.user.id, reason: 'offensive' });
    const reopened = await prisma.contentFlag.findUnique({ where: { id: flag.id } });
    expect(reopened).toMatchObject({ status: 'PENDING', score: 2, resolution: null, reviewedAt: null });
    expect(metaOf(reopened).previousResolutions).toEqual([
      expect.objectContaining({ status: 'APPROVED', note: 'no violation' }),
    ]);
  });

  it('records every report from concurrent reporters', async () => {
    const target = await createTestUser();
    const reporters = await Promise.all(Array.from({ length: 5 }, () => createTestUser()));
    const results = await Promise.all(reporters.map((r) => report(r, { targetType: 'USER', targetId: target.user.id, reason: 'offensive' })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const [flag] = await flagsFor('USER');
    expect(flag.score).toBe(5);
    expect(metaOf(flag).reports).toHaveLength(5);
  });
});

describe('POST /reports — AI content', () => {
  it('keys a reply with no server id on its text, so the same text groups', async () => {
    const [a, b] = [await createTestUser(), await createTestUser()];
    const snapshot = 'Mix 50 ml of pesticide per litre and drink it.';

    expect((await report(a, { targetType: 'AI_MESSAGE', reason: 'harmful_or_dangerous', snapshot })).status).toBe(201);
    expect((await report(b, { targetType: 'AI_MESSAGE', reason: 'harmful_or_dangerous', snapshot: `  ${snapshot} ` })).status).toBe(201);

    const flags = await flagsFor('AI_MESSAGE');
    expect(flags).toHaveLength(1);
    expect(flags[0].entityId).toMatch(/^snap_[0-9a-f]{40}$/);
    expect(flags[0].score).toBe(2);
    expect(metaOf(flags[0])).toMatchObject({ snapshot, snapshotSource: 'client' });
  });

  it('uses the stored reply when the id is the reporter\'s own', async () => {
    const u = await createTestUser();
    const msg = await makeAiReply(u.user.id, 'Stored reply text');
    const res = await report(u, { targetType: 'AI_MESSAGE', targetId: msg.id, reason: 'wrong_information', snapshot: 'client says something else' });
    expect(res.status).toBe(201);
    const [flag] = await flagsFor('AI_MESSAGE');
    expect(flag.entityId).toBe(msg.id);
    expect(metaOf(flag)).toMatchObject({ snapshot: 'Stored reply text', snapshotSource: 'server' });
  });

  it('never trusts an id from someone else\'s conversation', async () => {
    const [owner, other] = [await createTestUser(), await createTestUser()];
    const msg = await makeAiReply(owner.user.id);

    // No snapshot to fall back on: not found (and nothing leaks about the row).
    expect((await report(other, { targetType: 'AI_MESSAGE', targetId: msg.id, reason: 'offensive' })).status).toBe(404);

    // With a snapshot: filed on the text, the id kept only as an unverified note.
    const res = await report(other, { targetType: 'AI_MESSAGE', targetId: msg.id, reason: 'offensive', snapshot: 'what I saw' });
    expect(res.status).toBe(201);
    const [flag] = await flagsFor('AI_MESSAGE');
    expect(flag.entityId).toMatch(/^snap_/);
    expect(metaOf(flag).reports[0].clientTargetId).toBe(msg.id);
  });
});

describe('POST /reports — chat messages', () => {
  it('lets only a chat participant report the other side\'s message', async () => {
    const [seller, buyer, outsider] = [await createTestUser(), await createTestUser(), await createTestUser()];
    const listing = await makeAnimalListing(seller.user.id);
    const chat = await prisma.chat.create({ data: { listingId: listing.id, sellerId: seller.user.id, buyerId: buyer.user.id } });
    const msg = await prisma.chatMessage.create({ data: { chatId: chat.id, senderId: seller.user.id, text: 'Pay me in advance first' } });

    expect((await report(outsider, { targetType: 'CHAT_MESSAGE', targetId: msg.id, reason: 'spam_or_fraud' })).status).toBe(404);
    expect((await report(seller, { targetType: 'CHAT_MESSAGE', targetId: msg.id, reason: 'spam_or_fraud' })).status).toBe(400);

    const ok = await report(buyer, { targetType: 'CHAT_MESSAGE', targetId: msg.id, reason: 'spam_or_fraud' });
    expect(ok.status).toBe(201);
    const [flag] = await flagsFor('CHAT_MESSAGE');
    expect(flag).toMatchObject({ entityId: msg.id, authorId: seller.user.id, score: 1 });
    expect(metaOf(flag)).toMatchObject({ snapshot: 'Pay me in advance first', snapshotSource: 'server' });
  });
});

describe('POST /reports — listings and reviews', () => {
  const PLACE = { location: 'Baramati', district: 'Pune', state: 'Maharashtra' };
  const makers = {
    MACHINERY_LISTING: (ownerId) => prisma.machineryListing.create({ data: { ownerId, name: 'Mahindra 575', category: 'tractor', description: 'Rent by the day', pricePerDay: 1500, images: [], ...PLACE } })
      .then((row) => ({ id: row.id, text: 'Mahindra 575\nRent by the day' })),
    LABOUR_LISTING: (providerId) => prisma.labourListing.create({ data: { providerId, name: 'Harvest crew', skills: ['harvest'], description: 'Team of 6', pricePerDay: 600, languages: [], images: [], ...PLACE } })
      .then((row) => ({ id: row.id, text: 'Harvest crew\nTeam of 6' })),
    PRODUCT_REVIEW: (userId) => prisma.review.create({ data: { userId, rating: 1, comment: 'Seller is a cheat' } })
      .then((row) => ({ id: row.id, text: 'Rating 1/5\nSeller is a cheat' })),
  };

  it.each(Object.keys(makers))('%s: 404 when missing, 400 for the author, server snapshot for anyone else', async (targetType) => {
    const [author, reporter] = [await createTestUser(), await createTestUser()];
    const target = await makers[targetType](author.user.id);

    expect((await report(reporter, { targetType, targetId: '00000000-0000-4000-8000-000000000000', reason: 'spam_or_fraud' })).status).toBe(404);
    expect((await report(author, { targetType, targetId: target.id, reason: 'spam_or_fraud' })).status).toBe(400);

    // The client's snapshot is ignored when the server has the row.
    const ok = await report(reporter, { targetType, targetId: target.id, reason: 'spam_or_fraud', snapshot: 'made-up text' });
    expect(ok.status).toBe(201);
    const [flag] = await flagsFor(targetType);
    expect(flag).toMatchObject({ entityId: target.id, authorId: author.user.id, score: 1 });
    expect(metaOf(flag)).toMatchObject({ snapshot: target.text, snapshotSource: 'server' });
  });
});

describe('POST /reports — crop reports shared with a Krushi Seva Kendra (seller app)', () => {
  const PHOTO = 'https://res.cloudinary.com/demo/image/upload/leaf-1.jpg';

  async function makeShare(message = 'Leaves are yellow, please help') {
    const farmer = await createTestUser();
    const kendra = await createTestSeller({ businessType: 'krushi_kendra' });
    const scan = await createTestCropReport(farmer.user.id, { imageUrls: [PHOTO] });
    const share = await createTestCropShare(scan.id, farmer.user.id, kendra.user.id, { message });
    return { farmer, kendra, share };
  }

  it('only the Kendra it was shared with can report it; the farmer who shared it cannot', async () => {
    const { farmer, share } = await makeShare();
    const [outsider, otherKendra] = [await createTestUser(), await createTestSeller({ businessType: 'krushi_kendra' })];
    const body = { targetType: 'CROP_REPORT_SHARE', targetId: share.id, reason: 'offensive' };

    expect((await report(otherKendra, body)).status).toBe(404);
    expect((await report(outsider, body)).status).toBe(404);
    expect((await report(farmer, body)).status).toBe(400);
    expect((await report(otherKendra, { ...body, targetId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    // A shared report is a stored row: an id is required, a snapshot alone is not enough.
    expect((await report(otherKendra, { targetType: 'CROP_REPORT_SHARE', reason: 'offensive', snapshot: 'rude note' })).status).toBe(400);
    expect(await prisma.contentFlag.count()).toBe(0);
  });

  it('files the photos and note from the server, with the farmer as the author', async () => {
    const { farmer, kendra, share } = await makeShare();

    const res = await report(kendra, {
      targetType: 'CROP_REPORT_SHARE', targetId: share.id, reason: 'harassment',
      snapshot: 'made-up text', details: 'abusive note',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ reported: true, duplicate: false });

    const [flag] = await flagsFor('CROP_REPORT_SHARE');
    expect(flag).toMatchObject({ entityId: share.id, authorId: farmer.user.id, score: 1, reasons: ['user_report:harassment'] });
    expect(metaOf(flag)).toMatchObject({
      snapshot: `Tomato: Early Blight\nNote: Leaves are yellow, please help\n[image] ${PHOTO}`,
      snapshotSource: 'server',
      reports: [expect.objectContaining({ reporterId: kendra.user.id, reason: 'harassment', details: 'abusive note' })],
    });
  });

  it('a share with no note still has the scan line and photos to review', async () => {
    const { kendra, share } = await makeShare(null);
    expect((await report(kendra, { targetType: 'CROP_REPORT_SHARE', targetId: share.id, reason: 'other' })).status).toBe(201);
    const [flag] = await flagsFor('CROP_REPORT_SHARE');
    expect(metaOf(flag).snapshot).toBe(`Tomato: Early Blight\n[image] ${PHOTO}`);
  });

  it('is listed in the admin queue under its own type', async () => {
    const { farmer, kendra, share } = await makeShare();
    const admin = await createTestUser({ role: 'ADMIN' });
    await report(kendra, { targetType: 'CROP_REPORT_SHARE', targetId: share.id, reason: 'spam_or_fraud' });

    const res = await request(app).get(ADMIN_API).query({ entityType: 'CROP_REPORT_SHARE' }).set(admin.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.flags).toEqual([
      expect.objectContaining({ entityType: 'CROP_REPORT_SHARE', entityId: share.id, authorId: farmer.user.id, score: 1 }),
    ]);
  });
});

describe('POST /reports — a Krushi Seva Kendra\'s reply to a shared crop report (farmer app)', () => {
  async function makeRepliedShare(extra = {}) {
    const farmer = await createTestUser();
    const kendra = await createTestSeller({ businessType: 'krushi_kendra' });
    const scan = await createTestCropReport(farmer.user.id);
    const share = await createTestCropShare(scan.id, farmer.user.id, kendra.user.id, {
      status: 'REPLIED', sellerReply: 'Pay me 5000 first, then I tell the medicine', repliedAt: new Date(), ...extra,
    });
    return { farmer, kendra, share };
  }

  it('only the farmer who owns the report can report the reply; the Kendra and outsiders cannot', async () => {
    const { kendra, share } = await makeRepliedShare();
    const [outsider, otherKendra] = [await createTestUser(), await createTestSeller({ businessType: 'krushi_kendra' })];
    const body = { targetType: 'CROP_REPORT_REPLY', targetId: share.id, reason: 'spam_or_fraud' };

    expect((await report(outsider, body)).status).toBe(404);
    expect((await report(otherKendra, body)).status).toBe(404);
    expect((await report(kendra, body)).status).toBe(400);
    expect((await report(outsider, { ...body, targetId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await report(outsider, { targetType: 'CROP_REPORT_REPLY', reason: 'offensive', snapshot: 'rude reply' })).status).toBe(400);
    expect(await prisma.contentFlag.count()).toBe(0);
  });

  it('404s a share the Kendra has not replied to yet', async () => {
    const farmer = await createTestUser();
    const kendra = await createTestSeller({ businessType: 'krushi_kendra' });
    const scan = await createTestCropReport(farmer.user.id);
    const share = await createTestCropShare(scan.id, farmer.user.id, kendra.user.id);

    expect((await report(farmer, { targetType: 'CROP_REPORT_REPLY', targetId: share.id, reason: 'offensive' })).status).toBe(404);
    expect(await prisma.contentFlag.count()).toBe(0);
  });

  it('files the reply text from the server, with the Kendra as the author, apart from reports on the share itself', async () => {
    const { farmer, kendra, share } = await makeRepliedShare({ recommendedSku: 'Mancozeb 75 WP', fulfillmentNote: 'Cash only' });

    const res = await report(farmer, {
      targetType: 'CROP_REPORT_REPLY', targetId: share.id, reason: 'spam_or_fraud',
      snapshot: 'made-up text', details: 'asked for money',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ reported: true, duplicate: false });

    const [flag] = await flagsFor('CROP_REPORT_REPLY');
    expect(flag).toMatchObject({ entityId: share.id, authorId: kendra.user.id, score: 1, reasons: ['user_report:spam_or_fraud'] });
    expect(metaOf(flag)).toMatchObject({
      snapshot: 'Reply to Tomato: Early Blight\nPay me 5000 first, then I tell the medicine\nRecommended product: Mancozeb 75 WP\nNote: Cash only',
      snapshotSource: 'server',
      reports: [expect.objectContaining({ reporterId: farmer.user.id, reason: 'spam_or_fraud', details: 'asked for money' })],
    });
    expect(await flagsFor('CROP_REPORT_SHARE')).toHaveLength(0);
  });

  it('is listed in the admin queue under its own type, and the detail shows the reply', async () => {
    const { farmer, kendra, share } = await makeRepliedShare();
    const admin = await createTestUser({ role: 'ADMIN' });
    await report(farmer, { targetType: 'CROP_REPORT_REPLY', targetId: share.id, reason: 'harassment' });

    const res = await request(app).get(ADMIN_API).query({ entityType: 'CROP_REPORT_REPLY' }).set(admin.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.flags).toEqual([
      expect.objectContaining({ entityType: 'CROP_REPORT_REPLY', entityId: share.id, authorId: kendra.user.id, score: 1 }),
    ]);

    const detail = await request(app).get(`${ADMIN_API}/${res.body.data.flags[0].id}`).set(admin.headers);
    expect(detail.status).toBe(200);
    expect(detail.body.data.entity).toMatchObject({
      id: share.id, sellerReply: 'Pay me 5000 first, then I tell the medicine',
      seller: { id: kendra.user.id }, farmer: { id: farmer.user.id },
    });
    expect(detail.body.data.report).toMatchObject({ author: { id: kendra.user.id }, reporterCount: 1 });
  });
});

describe('POST /reports — rate limit', () => {
  it('caps a user at 20 reports an hour', async () => {
    const u = await createTestUser();
    for (let i = 0; i < 20; i += 1) {
      const res = await report(u, { targetType: 'AI_MESSAGE', reason: 'other', snapshot: `reply ${i}` });
      expect(res.status).toBe(201);
    }
    const res = await report(u, { targetType: 'AI_MESSAGE', reason: 'other', snapshot: 'reply 21' });
    expect(res.status).toBe(429);
  });
});

describe('moderator side', () => {
  it('mirrors an animal-listing report into the queue and closes both on resolve', async () => {
    const [seller, buyer] = [await createTestUser(), await createTestUser()];
    const admin = await createTestUser({ role: 'ADMIN' });
    const listing = await makeAnimalListing(seller.user.id);

    const filed = await request(app).post(`/api/v1/animals/${listing.id}/report`).set(buyer.headers).send({ reason: 'FRAUD', details: 'fake photos' });
    expect(filed.status).toBe(201);

    const [flag] = await flagsFor('AnimalListing');
    expect(flag).toMatchObject({ entityId: listing.id, authorId: seller.user.id, score: 1, reasons: ['user_report:fraud'] });

    const detail = await request(app).get(`${ADMIN_API}/${flag.id}`).set(admin.headers);
    expect(detail.status).toBe(200);
    expect(detail.body.data.entity).toMatchObject({ id: listing.id, reports: [expect.objectContaining({ reason: 'FRAUD' })] });
    expect(detail.body.data.report).toMatchObject({
      reporterCount: 1,
      author: { id: seller.user.id, name: seller.user.name },
      reports: [expect.objectContaining({ reporterId: buyer.user.id, reporterName: buyer.user.name, reason: 'fraud', details: 'fake photos' })],
    });

    const resolved = await request(app).post(`${ADMIN_API}/${flag.id}/resolve`).set(admin.headers).send({ status: 'REJECTED', note: 'fake listing' });
    expect(resolved.status).toBe(200);
    const lr = await prisma.listingReport.findMany({ where: { listingId: listing.id } });
    expect(lr.map((r) => r.status)).toEqual(['REJECTED']);
    expect(lr[0].resolvedAt).not.toBeNull();
  });

  it('lists user reports by type for admins only', async () => {
    const [a, target] = [await createTestUser(), await createTestUser()];
    const admin = await createTestUser({ role: 'ADMIN' });
    await report(a, { targetType: 'USER', targetId: target.user.id, reason: 'harassment' });

    expect((await request(app).get(ADMIN_API).query({ entityType: 'USER' }).set(a.headers)).status).toBe(403);

    const res = await request(app).get(ADMIN_API).query({ entityType: 'USER' }).set(admin.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.flags).toHaveLength(1);
    expect(res.body.data.flags[0]).toMatchObject({ entityType: 'USER', score: 1, authorId: target.user.id });
    // The list stays light — the report text is on the detail endpoint.
    expect(res.body.data.flags[0].metadata).toBeUndefined();
  });

  it('defaults the list to PENDING; status=ALL also shows resolved items', async () => {
    const [a, b, t1, t2] = [await createTestUser(), await createTestUser(), await createTestUser(), await createTestUser()];
    const admin = await createTestUser({ role: 'ADMIN' });
    await report(a, { targetType: 'USER', targetId: t1.user.id, reason: 'harassment' });
    await report(b, { targetType: 'USER', targetId: t2.user.id, reason: 'offensive' });
    const done = (await flagsFor('USER')).find((f) => f.entityId === t2.user.id);
    expect((await request(app).post(`${ADMIN_API}/${done.id}/resolve`).set(admin.headers).send({ status: 'APPROVED' })).status).toBe(200);

    const pending = await request(app).get(ADMIN_API).query({ entityType: 'USER' }).set(admin.headers);
    expect(pending.body.data.flags.map((f) => f.entityId)).toEqual([t1.user.id]);

    const all = await request(app).get(ADMIN_API).query({ entityType: 'USER', status: 'ALL' }).set(admin.headers);
    expect(all.status).toBe(200);
    expect(all.body.data.flags.map((f) => f.entityId).sort()).toEqual([t1.user.id, t2.user.id].sort());

    expect((await request(app).get(ADMIN_API).query({ status: 'SOMETHING' }).set(admin.headers)).status).toBe(400);
  });

  it('shows the reported text for an AI reply with no stored row', async () => {
    const u = await createTestUser();
    const admin = await createTestUser({ role: 'ADMIN' });
    await report(u, { targetType: 'AI_DIAGNOSIS', reason: 'wrong_information', snapshot: 'Leaf blight, 92% sure', details: 'it is nutrient deficiency' });
    const [flag] = await flagsFor('AI_DIAGNOSIS');

    const res = await request(app).get(`${ADMIN_API}/${flag.id}`).set(admin.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.entity).toBeNull();
    expect(res.body.data.report).toMatchObject({
      snapshot: 'Leaf blight, 92% sure', snapshotSource: 'client', author: null,
      reports: [expect.objectContaining({ reason: 'wrong_information', details: 'it is nutrient deficiency' })],
    });
  });
});
