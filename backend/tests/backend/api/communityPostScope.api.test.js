/**
 * A community post has to reach its author's district feed.
 *
 * GET /community/posts?scope=district matches `{ scope: 'DISTRICT', district }`,
 * but POST /community/posts set neither column — every post made through the API
 * fell to the schema default (ALL), so the district arm of the feed had no
 * producer at all and could only ever match rows written straight to the
 * database. The DISTRICT half of the feed could not fill up.
 *
 * What the write side must get right, and what each block below pins down:
 *   - a scoped post is stamped with the AUTHOR's district, and shows up in that
 *     district's feed and nowhere else;
 *   - it is stored in the spelling the author's profile carries. The read side
 *     expands a renamed district to all of its names (districtIn), so the two
 *     sides meet there — normalising on write would rewrite what the farmer
 *     entered for no gain;
 *   - the district is NOT taken from the request body, or any account could
 *     publish into any district's feed;
 *   - an app build that sends no scope still posts to everyone, exactly as
 *     before, because the absent value still means ALL;
 *   - a scope the profile cannot satisfy falls back to ALL rather than writing a
 *     row that matches no feed at all.
 *
 * Sibling suite: districtAliasesSocial.api.test.js covers the same alias
 * expansion on the READ side, from rows written directly.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { getApp, createTestUser, cleanupTestData } from '../../fixtures/setup.js';

const API = '/api/v1/community';

let app;

beforeAll(async () => { app = await getApp(); }, 60_000);

// This suite creates only posts (and their authors), both of which
// cleanupTestData already clears. No groups, so nothing extra to sweep.
afterAll(async () => { await cleanupTestData(); });

let seq = 0;
const createPost = (author, body = {}) => request(app)
  .post(`${API}/posts`)
  .set(author.headers)
  .send({
    title: `Scope post ${Date.now()}-${seq++}`,
    description: 'A post created through the API, exactly the way the app creates one.',
    category: 'general',
    ...body,
  });

const feedIds = async (query) => {
  const res = await request(app).get(`${API}/posts`).query({ limit: 50, ...query });
  expect(res.status).toBe(200);
  return res.body.data.map((p) => p.id);
};

const districtFeed = (district) => feedIds({ scope: 'district', district });

// ── The district feed has a producer ─────────────────────────────────────────
describe('POST /community/posts — a district-scoped post reaches its district', () => {
  it('stamps the author\'s own district and appears in that feed only', async () => {
    const author = await createTestUser({ name: 'Solapur Farmer', district: 'Solapur' });

    const res = await createPost(author, { scope: 'district' });
    expect(res.status).toBe(201);
    expect(res.body.data.scope).toBe('DISTRICT');
    expect(res.body.data.district).toBe('Solapur');

    expect(await districtFeed('Solapur')).toContain(res.body.data.id);
    // The point of the scope: it is NOT in a different district's feed. Before
    // the fix this post was ALL and showed up here too.
    expect(await districtFeed('Nagpur')).not.toContain(res.body.data.id);
  });

  it('accepts the scope in either the feed\'s spelling or the enum\'s', async () => {
    const author = await createTestUser({ name: 'Satara Farmer', district: 'Satara' });

    const lower = await createPost(author, { scope: 'district' });
    const upper = await createPost(author, { scope: 'DISTRICT' });

    expect(lower.body.data.scope).toBe('DISTRICT');
    expect(upper.body.data.scope).toBe('DISTRICT');

    const ids = await districtFeed('Satara');
    expect(ids).toEqual(expect.arrayContaining([lower.body.data.id, upper.body.data.id]));
  });

  it('rejects a scope that is not one of the three', async () => {
    const author = await createTestUser({ name: 'Bad Scope Farmer', district: 'Latur' });
    const res = await createPost(author, { scope: 'taluka' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/scope: must be all, district or city/i);
  });
});

// ── Renamed districts ────────────────────────────────────────────────────────
// The write side stores the profile's spelling verbatim; the read side expands
// it. Asserted in BOTH directions, because half of Maharashtra's rows carry the
// old name and half the new one.
describe('POST /community/posts — a renamed district is one district', () => {
  it('a post by an Osmanabad farmer is found under Dharashiv', async () => {
    const author = await createTestUser({ name: 'Old Name Farmer', district: 'Osmanabad' });

    const res = await createPost(author, { scope: 'district' });
    expect(res.status).toBe(201);
    // Stored exactly as the profile carries it — not normalised to the new name.
    expect(res.body.data.district).toBe('Osmanabad');

    expect(await districtFeed('Dharashiv')).toContain(res.body.data.id);
    expect(await districtFeed('Osmanabad')).toContain(res.body.data.id);
    expect(await districtFeed('Pune')).not.toContain(res.body.data.id);
  });

  it('a post by a Dharashiv farmer is found under Osmanabad', async () => {
    const author = await createTestUser({ name: 'New Name Farmer', district: 'Dharashiv' });

    const res = await createPost(author, { scope: 'district' });
    expect(res.body.data.district).toBe('Dharashiv');

    expect(await districtFeed('Osmanabad')).toContain(res.body.data.id);
    expect(await districtFeed('Dharashiv')).toContain(res.body.data.id);
  });
});

// ── ALL posts are untouched ──────────────────────────────────────────────────
describe('POST /community/posts — an ALL post still goes everywhere', () => {
  it('a build that sends no scope keeps posting to everyone', async () => {
    const author = await createTestUser({ name: 'Old Client Farmer', district: 'Kolhapur' });

    // Exactly the body an app build that predates the scope field sends.
    const res = await createPost(author);
    expect(res.status).toBe(201);
    expect(res.body.data.scope).toBe('ALL');
    expect(res.body.data.district).toBeNull();

    // Visible in the unscoped feed and in every district's feed, via the
    // `scope: 'ALL'` arm — unchanged behaviour.
    expect(await feedIds({})).toContain(res.body.data.id);
    expect(await districtFeed('Kolhapur')).toContain(res.body.data.id);
    expect(await districtFeed('Nagpur')).toContain(res.body.data.id);
  });

  it('an empty scope field is treated as not sent, not as invalid', async () => {
    const author = await createTestUser({ name: 'Empty Scope Farmer', district: 'Nashik' });

    const res = await createPost(author, { scope: '' });
    expect(res.status).toBe(201);
    expect(res.body.data.scope).toBe('ALL');
  });

  it('an explicit all is still ALL', async () => {
    const author = await createTestUser({ name: 'Explicit All Farmer', district: 'Nashik' });

    const res = await createPost(author, { scope: 'all' });
    expect(res.status).toBe(201);
    expect(res.body.data.scope).toBe('ALL');
    expect(res.body.data.district).toBeNull();
    expect(await districtFeed('Nagpur')).toContain(res.body.data.id);
  });
});

// ── The district is the author's, not the caller's ───────────────────────────
describe('POST /community/posts — the district comes from the profile', () => {
  it('ignores a district supplied in the request body', async () => {
    const author = await createTestUser({ name: 'Injecting Farmer', district: 'Beed' });

    // A caller trying to publish into a district that is not theirs. Taking this
    // from the body would make every district's feed writable by anyone.
    const res = await createPost(author, { scope: 'district', district: 'Nagpur', city: 'Nagpur' });
    expect(res.status).toBe(201);
    expect(res.body.data.district).toBe('Beed');

    expect(await districtFeed('Beed')).toContain(res.body.data.id);
    expect(await districtFeed('Nagpur')).not.toContain(res.body.data.id);
  });

  it('a profile with no district falls back to ALL instead of a post no feed shows', async () => {
    const author = await createTestUser({ name: 'Districtless Farmer', district: null });

    const res = await createPost(author, { scope: 'district' });
    expect(res.status).toBe(201);
    // A DISTRICT row with a NULL district matches neither the district arm
    // (`district IN (…)` never matches NULL) nor the ALL arm — it would be
    // invisible in every feed. The response reports what was actually stored.
    expect(res.body.data.scope).toBe('ALL');
    expect(res.body.data.district).toBeNull();
    expect(await feedIds({})).toContain(res.body.data.id);
  });
});

// ── City scope, the same contract one level down ─────────────────────────────
describe('POST /community/posts — city scope', () => {
  it('stamps the author\'s city and appears in that city\'s feed', async () => {
    const author = await createTestUser({
      name: 'City Farmer', district: 'Ahmednagar', city: 'Sangamner',
    });

    const res = await createPost(author, { scope: 'city' });
    expect(res.status).toBe(201);
    expect(res.body.data.scope).toBe('CITY');
    expect(res.body.data.city).toBe('Sangamner');

    expect(await feedIds({ scope: 'city', city: 'Sangamner' })).toContain(res.body.data.id);
    expect(await feedIds({ scope: 'city', city: 'Pune' })).not.toContain(res.body.data.id);
  });

  it('a profile with no city falls back to ALL', async () => {
    const author = await createTestUser({ name: 'Cityless Farmer', district: 'Jalna', city: null });

    const res = await createPost(author, { scope: 'city' });
    expect(res.status).toBe(201);
    expect(res.body.data.scope).toBe('ALL');
    expect(res.body.data.city).toBeNull();
  });
});
