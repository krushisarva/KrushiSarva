/**
 * Renamed districts on the three district-SCOPED fan-outs: the community feed,
 * group discovery, and admin broadcast targeting.
 *
 * Half of Maharashtra's rows carry the old district name (Osmanabad) and half
 * the new one (Dharashiv) — the farmer app's picker and India Post write the new
 * one, the seller app's picker and every row predating the rename the old one.
 * An exact match therefore split one district in two:
 *   - a Dharashiv farmer's community feed dropped every post by a neighbour
 *     whose profile still said Osmanabad;
 *   - group discovery for one spelling never surfaced the district's groups
 *     created under the other, so the same district grew two parallel groups;
 *   - an admin broadcast to Dharashiv silently missed half the district, and the
 *     audience preview agreed with it, so nothing looked wrong.
 *
 * Each case is asserted in BOTH directions (old→new and new→old) plus a control
 * district that was never renamed, which must still narrow to itself.
 *
 * Sibling suite: districtAliases.api.test.js covers the buyer↔seller discovery
 * paths (Kendra lookup, buy box, serviceability, rent, animals).
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { getApp, createTestUser, cleanupTestData, prisma } from '../../fixtures/setup.js';
import { estimateAudience, broadcastNotification } from '../../../src/services/adminBroadcast.service.js';

let app;

beforeAll(async () => { app = await getApp(); }, 60_000);

afterAll(async () => {
  // Group.createdBy and GroupMessage.sender are plain relations (RESTRICT), so a
  // leftover group blocks cleanupTestData's user.deleteMany() and aborts the
  // whole cleanup transaction — which leaves every table populated for the next
  // suite. Clear them here; cleanupTestData does not know about groups.
  await prisma.groupMessage.deleteMany();
  await prisma.groupMember.deleteMany();
  await prisma.group.deleteMany();
  await prisma.broadcastLog.deleteMany();
  await cleanupTestData();
});

// ── 1. Community feed ─────────────────────────────────────────────────────────
describe('GET /community/posts?scope=district — the district feed is one feed', () => {
  let author; let oldNamePost; let newNamePost; let otherDistrictPost;

  const post = (district, title) => prisma.post.create({
    data: {
      authorId: author.user.id,
      category: 'general',
      title,
      description: 'A post scoped to one district, to be found under either of its names.',
      scope: 'DISTRICT',
      district,
    },
    select: { id: true },
  });

  beforeAll(async () => {
    author = await createTestUser({ name: 'District Feed Author' });
    oldNamePost      = await post('Osmanabad', `Alias feed old ${Date.now()}`);
    newNamePost      = await post('Dharashiv', `Alias feed new ${Date.now()}`);
    otherDistrictPost = await post('Pune',     `Alias feed control ${Date.now()}`);
  });

  const feed = async (district) => {
    const res = await request(app).get('/api/v1/community/posts').query({ scope: 'district', district, limit: 50 });
    expect(res.status).toBe(200);
    return res.body.data.map((p) => p.id);
  };

  test('a Dharashiv feed shows the post stored as Osmanabad', async () => {
    const ids = await feed('Dharashiv');
    expect(ids).toEqual(expect.arrayContaining([oldNamePost.id, newNamePost.id]));
    expect(ids).not.toContain(otherDistrictPost.id);
  });

  test('an Osmanabad feed shows the post stored as Dharashiv', async () => {
    const ids = await feed('Osmanabad');
    expect(ids).toEqual(expect.arrayContaining([oldNamePost.id, newNamePost.id]));
    expect(ids).not.toContain(otherDistrictPost.id);
  });

  test('the spelling is matched case- and spacing-insensitively', async () => {
    const ids = await feed('  dharashiv ');
    expect(ids).toEqual(expect.arrayContaining([oldNamePost.id, newNamePost.id]));
  });

  test('a district that was never renamed still narrows to itself', async () => {
    const ids = await feed('Pune');
    expect(ids).toContain(otherDistrictPost.id);
    expect(ids).not.toContain(oldNamePost.id);
    expect(ids).not.toContain(newNamePost.id);
  });
});

// ── 2. Group discovery ────────────────────────────────────────────────────────
describe('GET /groups?district — one district discovers its groups under either name', () => {
  let member; let oldNameGroup; let newNameGroup; let otherDistrictGroup;

  const group = (district, name) => prisma.group.create({
    data: { name, district, isPublic: true, createdById: member.user.id, lastMessageAt: new Date() },
    select: { id: true },
  });

  beforeAll(async () => {
    member = await createTestUser({ name: 'Group Discovery Farmer' });
    oldNameGroup       = await group('Osmanabad', `Alias group old ${Date.now()}`);
    newNameGroup       = await group('Dharashiv', `Alias group new ${Date.now()}`);
    otherDistrictGroup = await group('Pune',      `Alias group control ${Date.now()}`);
  });

  const discover = async (district) => {
    const res = await request(app).get('/api/v1/groups').query({ district, limit: 50 }).set(member.headers);
    expect(res.status).toBe(200);
    return res.body.data.map((g) => g.id);
  };

  test('a Dharashiv farmer finds the group created as Osmanabad', async () => {
    const ids = await discover('Dharashiv');
    expect(ids).toEqual(expect.arrayContaining([oldNameGroup.id, newNameGroup.id]));
    expect(ids).not.toContain(otherDistrictGroup.id);
  });

  test('an Osmanabad farmer finds the group created as Dharashiv', async () => {
    const ids = await discover('Osmanabad');
    expect(ids).toEqual(expect.arrayContaining([oldNameGroup.id, newNameGroup.id]));
    expect(ids).not.toContain(otherDistrictGroup.id);
  });

  test('a district that was never renamed still narrows to itself', async () => {
    const ids = await discover('Pune');
    expect(ids).toContain(otherDistrictGroup.id);
    expect(ids).not.toContain(oldNameGroup.id);
    expect(ids).not.toContain(newNameGroup.id);
  });
});

// ── 3. Admin broadcast targeting ──────────────────────────────────────────────
describe('Admin broadcast — a district target reaches the whole district', () => {
  // The audience is narrowed by a crop nobody else uses as well as by district,
  // so the counts below are exactly this suite's users and cannot be moved by a
  // row another test file left in the shared database.
  const CROP = `alias-crop-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  let superAdmin; let oldNameUser; let newNameUser; let otherDistrictUser;

  const farmer = async (name, district, extra = {}) => {
    const u = await createTestUser({ name, district, ...extra });
    await prisma.farmDetail.create({ data: { userId: u.user.id, district, cropTypes: [CROP] } });
    return u;
  };

  beforeAll(async () => {
    superAdmin = await createTestUser({ role: 'ADMIN', name: 'Broadcast Admin' });
    oldNameUser       = await farmer('Broadcast Old Name', 'Osmanabad');
    newNameUser       = await farmer('Broadcast New Name', 'Dharashiv');
    otherDistrictUser = await farmer('Broadcast Control', 'Pune');
  });

  const preview = async (district) => {
    const res = await request(app)
      .get('/api/v1/admin/notifications/preview')
      .query({ district, crop: CROP })
      .set(superAdmin.headers);
    expect(res.status).toBe(200);
    return res.body.data.estimated;
  };

  test('the audience preview for Dharashiv counts the Osmanabad user, and the reverse', async () => {
    expect(await preview('Dharashiv')).toBe(2);
    expect(await preview('Osmanabad')).toBe(2);
  });

  test('a district that was never renamed still narrows to itself', async () => {
    expect(await preview('Pune')).toBe(1);
    expect(await estimateAudience({ district: 'Pune', crop: CROP })).toBe(1);
  });

  test('the SEND picks the same recipients the preview promised, both directions', async () => {
    const toNew = await broadcastNotification({
      filters: { district: 'Dharashiv', crop: CROP },
      title: 'Alias test', body: 'Both spellings, please.',
    });
    expect(toNew.estimated).toBe(2);
    expect(toNew.sent).toBe(2);

    const toOld = await broadcastNotification({
      filters: { district: 'Osmanabad', crop: CROP },
      title: 'Alias test', body: 'Both spellings, please.',
    });
    expect(toOld.estimated).toBe(2);
    expect(toOld.sent).toBe(2);
  });

  test('a deactivated account is still left out of the audience', async () => {
    const banned = await farmer('Broadcast Banned', 'Osmanabad', { isActive: false });
    expect(banned.user.isActive).toBe(false);
    expect(await preview('Dharashiv')).toBe(2);
  });
});
