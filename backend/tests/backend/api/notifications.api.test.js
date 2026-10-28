/**
 * The in-app notification inbox — GET /api/v1/notifications and friends.
 *
 * This route had no test, and it did not work: keysetPage() was called without
 * the `hydrate` it requires, so the list threw for every user who had at least
 * one notification, and the catch block then called sendError() with its
 * arguments in the wrong order — the message landed in the status-code slot,
 * res.status() threw on it, and the request never got a response at all. It
 * only "worked" for a user with nothing in their inbox, which is exactly what a
 * fresh test account has.
 *
 * It matters more now than it did: an order update (ORDER_UPDATE) and a seller's
 * new order (NEW_ORDER) both write a row here so they can be read back.
 */
import request from 'supertest';
import { getApp, createTestUser, cleanupTestData, prisma } from '../../fixtures/setup.js';

const API = '/api/v1/notifications';

let app, farmer, other;

beforeAll(async () => {
  app = await getApp();
  farmer = await createTestUser({ name: 'Inbox Farmer' });
  other = await createTestUser({ name: 'Inbox Other' });
}, 60_000);

afterAll(async () => {
  await cleanupTestData();
});

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [farmer.user.id, other.user.id] } } });
});

/** One row, `minutesAgo` old, so the newest-first order is known. */
const note = (userId, minutesAgo, over = {}) => prisma.notification.create({
  data: {
    userId,
    type: 'ORDER_UPDATE',
    title: `Title ${minutesAgo}`,
    body: 'Body',
    data: { orderId: 'x' },
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
    ...over,
  },
});

describe('GET /notifications', () => {
  test('an empty inbox is an empty page, not an error', async () => {
    const res = await request(app).get(API).set(farmer.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ items: [], hasMore: false, nextCursor: null });
  });

  test('a user WITH notifications gets them, newest first — the case that used to throw', async () => {
    await note(farmer.user.id, 30, { title: 'oldest' });
    await note(farmer.user.id, 10, { title: 'newest', type: 'NEW_ORDER' });
    await note(farmer.user.id, 20, { title: 'middle', type: 'SYSTEM' });

    const res = await request(app).get(API).set(farmer.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((n) => n.title)).toEqual(['newest', 'middle', 'oldest']);
    expect(res.body.data.items[0]).toMatchObject({ type: 'NEW_ORDER', body: 'Body', readAt: null });
    expect(res.body.data.hasMore).toBe(false);
  });

  test('never returns another user\'s notification', async () => {
    await note(farmer.user.id, 5, { title: 'mine' });
    await note(other.user.id, 1, { title: 'theirs' });

    const res = await request(app).get(API).set(farmer.headers);
    expect(res.body.data.items.map((n) => n.title)).toEqual(['mine']);
  });

  test('pages by cursor without repeating or skipping a row', async () => {
    for (const m of [1, 2, 3, 4, 5]) await note(farmer.user.id, m, { title: `n${m}` });

    const first = await request(app).get(API).query({ limit: 2 }).set(farmer.headers);
    expect(first.status).toBe(200);
    expect(first.body.data.items.map((n) => n.title)).toEqual(['n1', 'n2']);
    expect(first.body.data.hasMore).toBe(true);

    const second = await request(app).get(API)
      .query({ limit: 2, cursor: first.body.data.nextCursor }).set(farmer.headers);
    expect(second.body.data.items.map((n) => n.title)).toEqual(['n3', 'n4']);

    const third = await request(app).get(API)
      .query({ limit: 2, cursor: second.body.data.nextCursor }).set(farmer.headers);
    expect(third.body.data.items.map((n) => n.title)).toEqual(['n5']);
    expect(third.body.data.hasMore).toBe(false);
    expect(third.body.data.nextCursor).toBeNull();
  });

  test('a nonsense limit is clamped, not passed to the database', async () => {
    await note(farmer.user.id, 1);
    for (const limit of ['-5', '0', 'abc', '99999']) {
      const res = await request(app).get(API).query({ limit }).set(farmer.headers);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
    }
  });

  test('requires a signed-in user', async () => {
    const res = await request(app).get(API);
    expect(res.status).toBe(401);
  });
});

describe('unread count and marking read', () => {
  test('counts unread, and marking one read lowers the count', async () => {
    const a = await note(farmer.user.id, 2);
    await note(farmer.user.id, 1);

    expect((await request(app).get(`${API}/unread`).set(farmer.headers)).body.data).toEqual({ count: 2 });

    const marked = await request(app).patch(`${API}/${a.id}/read`).set(farmer.headers);
    expect(marked.status).toBe(200);
    expect((await request(app).get(`${API}/unread`).set(farmer.headers)).body.data).toEqual({ count: 1 });
  });

  test('marking someone else\'s notification answers 404 — and does answer', async () => {
    // This path called sendError(res, 'NOT_FOUND', 'Notification not found', 404):
    // the message went in as the status code and the request hung.
    const theirs = await note(other.user.id, 1);

    const res = await request(app).patch(`${API}/${theirs.id}/read`).set(farmer.headers);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { message: 'Notification not found' } });

    const still = await prisma.notification.findUnique({ where: { id: theirs.id } });
    expect(still.readAt).toBeNull();
  });

  test('read-all marks only the caller\'s rows', async () => {
    await note(farmer.user.id, 1);
    await note(farmer.user.id, 2);
    await note(other.user.id, 1);

    const res = await request(app).patch(`${API}/read-all`).set(farmer.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 2 });
    expect(await prisma.notification.count({ where: { userId: other.user.id, readAt: null } })).toBe(1);
  });
});
