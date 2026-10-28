/**
 * Animal Trade — blocking, end to end.
 *
 * A block has to hold on EVERY path a message can take. The HTTP send refused,
 * but the socket `send_message` (and `dm_send`) stored and broadcast anyway, so
 * a blocked buyer only had to use the other transport. These pin:
 *   • both transports refuse, store nothing, broadcast nothing, push nothing;
 *   • every block refusal carries `error.code: 'USER_BLOCKED'`;
 *   • the inbox and the history tell the app whether it may message, without
 *     revealing "they blocked me" beyond `canMessage: false`;
 *   • GET /blocks, and unblock's edges (self, repeat, gone user).
 *
 * The push service is replaced before the app loads so the assertions see
 * exactly what the routes hand to it, without Expo or the queue. The socket
 * handlers run against the real database through a fake io/socket pair (this
 * package has no socket.io-client) — see security/socketChatOwnership.test.js.
 */
import { jest } from '@jest/globals';

const sendPushToUser = jest.fn(async () => ({ enqueued: false, ranInline: true }));
jest.unstable_mockModule('../../../src/services/push.service.js', () => ({
  sendPushToUser,
  deliverUserNotification: jest.fn(async () => {}),
  NOTIFICATION_CATEGORIES: { ACTIVITY: 'ACTIVITY', SECURITY: 'SECURITY' },
}));

const { default: request } = await import('supertest');
const { getApp, createTestUser, cleanupTestData, prisma } = await import('../../fixtures/setup.js');
const { registerChatSocket } = await import('../../../src/socket/chat.socket.js');

const API = '/api/v1/animals';
const BLOCKED_MSG = 'You can no longer message this user.';

let app;

beforeAll(async () => { app = await getApp(); });
afterAll(async () => { await cleanupTestData(); await prisma.$disconnect(); });
beforeEach(async () => { await cleanupTestData(); sendPushToUser.mockClear(); });

function makeListing(sellerId) {
  return prisma.animalListing.create({
    data: {
      sellerId, animal: 'Buffalo', breed: 'Murrah', age: '4 years', gender: 'FEMALE',
      weight: '520 kg', price: 85000, sellerLocation: 'Baramati, Pune', status: 'ACTIVE',
      images: ['https://res.cloudinary.com/demo/image/upload/v1/farmeasy/animals/a.jpg'],
    },
  });
}

/** Seller + buyer with an open chat on one listing. */
async function openChat() {
  const s = await createTestUser({ name: 'Seller' });
  const b = await createTestUser({ name: 'Buyer' });
  const l = await makeListing(s.user.id);
  const res = await request(app).post(`${API}/${l.id}/chat`).set(b.headers);
  expect(res.status).toBe(200);
  return { s, b, l, chatId: res.body.data.id };
}

const block = (by, target) => request(app).post(`${API}/sellers/${target.user.id}/block`).set(by.headers).send({});
const unblock = (by, target) => request(app).delete(`${API}/sellers/${target.user.id}/block`).set(by.headers);

/**
 * Register the socket handlers for one already-authenticated user. Returns the
 * handlers, what was emitted to THIS socket, and what went to any room.
 */
async function connectAs(userId) {
  const handlers = {};
  const toSocket = [];
  const toRooms = [];
  const socket = {
    id: `sock-${userId}`, userId, handshake: { auth: { token: 't' } },
    on: (event, fn) => { handlers[event] = fn; },
    join: () => {}, leave: () => {}, disconnect: () => {},
    emit: (event, payload) => toSocket.push({ event, payload }),
  };
  let onConnection;
  registerChatSocket({
    use: () => {},
    on: (event, fn) => { if (event === 'connection') onConnection = fn; },
    to: (room) => ({ emit: (event, payload) => toRooms.push({ room, event, payload }) }),
  });
  await onConnection(socket);
  return { handlers, toSocket, toRooms };
}

describe('socket send_message', () => {
  it('is refused both ways once a block exists: nothing stored, broadcast or pushed', async () => {
    const { s, b, chatId } = await openChat();
    await block(b, s);

    // The blocker tries to send…
    const buyer = await connectAs(b.user.id);
    await buyer.handlers.send_message({ chatId, text: 'still there?', clientMsgId: 'cm-1' });
    // …and so does the one who was blocked.
    const seller = await connectAs(s.user.id);
    await seller.handlers.send_message({ chatId, text: 'hello?', clientMsgId: 'cm-2' });

    expect(await prisma.chatMessage.count({ where: { chatId } })).toBe(0);
    expect([...buyer.toRooms, ...seller.toRooms].filter((e) => e.event === 'new_message')).toHaveLength(0);
    expect(sendPushToUser).not.toHaveBeenCalled();

    // Only the sender hears why, with the chat and the bubble to resolve.
    expect(buyer.toSocket).toContainEqual({
      event: 'error',
      payload: { code: 'USER_BLOCKED', message: BLOCKED_MSG, chatId, clientMsgId: 'cm-1' },
    });
    expect(seller.toSocket.find((e) => e.event === 'error')?.payload).toMatchObject({ code: 'USER_BLOCKED', clientMsgId: 'cm-2' });
  });

  it('still delivers when there is no block, and again after an unblock', async () => {
    const { s, b, chatId } = await openChat();
    const buyer = await connectAs(b.user.id);

    await buyer.handlers.send_message({ chatId, text: 'first' });
    expect(await prisma.chatMessage.count({ where: { chatId } })).toBe(1);

    await block(s, b);
    await buyer.handlers.send_message({ chatId, text: 'blocked' });
    expect(await prisma.chatMessage.count({ where: { chatId } })).toBe(1);

    await unblock(s, b);
    await buyer.handlers.send_message({ chatId, text: 'after unblock' });
    expect(await prisma.chatMessage.count({ where: { chatId } })).toBe(2);
    expect(buyer.toRooms.filter((e) => e.event === 'new_message' && e.room === chatId)).toHaveLength(2);
  });

  it('keeps join_chat history and mark_read working after a block', async () => {
    const { s, b, chatId } = await openChat();
    await request(app).post(`${API}/chats/${chatId}/messages`).set(s.headers).send({ text: 'old offer' });
    await block(b, s);

    const buyer = await connectAs(b.user.id);
    await buyer.handlers.join_chat({ chatId });
    const history = buyer.toSocket.find((e) => e.event === 'chat_history');
    expect(history.payload.map((m) => m.text)).toEqual(['old offer']);

    await buyer.handlers.mark_read({ chatId });
    expect(await prisma.chatMessage.count({ where: { chatId, readAt: null } })).toBe(0);
  });
});

describe('socket direct messages', () => {
  it('dm_send and dm_typing deliver nothing between blocked users', async () => {
    const a = await createTestUser({ name: 'A' });
    const c = await createTestUser({ name: 'C' });
    await block(c, a);

    const sockA = await connectAs(a.user.id);
    await sockA.handlers.dm_send({ receiverId: c.user.id, text: 'hi' });
    await sockA.handlers.dm_typing({ receiverId: c.user.id, isTyping: true });

    expect(await prisma.directMessage.count({ where: { senderId: a.user.id } })).toBe(0);
    expect(sockA.toRooms).toHaveLength(0);
    expect(sockA.toSocket.find((e) => e.event === 'error')?.payload)
      .toEqual({ code: 'USER_BLOCKED', message: BLOCKED_MSG, receiverId: c.user.id });
    expect(sendPushToUser).not.toHaveBeenCalled();

    // Control: with the block lifted the same calls are delivered.
    await unblock(c, a);
    await sockA.handlers.dm_send({ receiverId: c.user.id, text: 'hi again' });
    await sockA.handlers.dm_typing({ receiverId: c.user.id, isTyping: true });
    expect(await prisma.directMessage.count({ where: { senderId: a.user.id } })).toBe(1);
    expect(sockA.toRooms.map((e) => e.event)).toEqual(['dm_new_message', 'dm_typing_update']);
  });

  it('the HTTP DM send refuses with USER_BLOCKED too', async () => {
    const a = await createTestUser({ name: 'A' });
    const c = await createTestUser({ name: 'C' });
    await block(a, c);

    // The blocked side writes to the one who blocked them.
    const res = await request(app).post(`/api/v1/messages/${a.user.id}`).set(c.headers).send({ text: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'USER_BLOCKED', message: BLOCKED_MSG });
    expect(await prisma.directMessage.count()).toBe(0);
  });
});

describe('read receipts between blocked users', () => {
  it('socket mark_read marks the rows but sends no messages_read once blocked', async () => {
    const { s, b, chatId } = await openChat();
    await request(app).post(`${API}/chats/${chatId}/messages`).set(s.headers).send({ text: 'offer 1' });
    const buyer = await connectAs(b.user.id);

    // Control: no block → the receipt goes to the room.
    await buyer.handlers.mark_read({ chatId });
    expect(buyer.toRooms.filter((e) => e.event === 'messages_read')).toEqual([
      { room: chatId, event: 'messages_read', payload: { chatId, userId: b.user.id } },
    ]);

    await request(app).post(`${API}/chats/${chatId}/messages`).set(s.headers).send({ text: 'offer 2' });
    await block(s, b); // the OTHER side blocked the reader
    await buyer.handlers.mark_read({ chatId });
    expect(await prisma.chatMessage.count({ where: { chatId, readAt: null } })).toBe(0);
    expect(buyer.toRooms.filter((e) => e.event === 'messages_read')).toHaveLength(1);
  });

  it('dm_read marks the rows but sends no dm_read_receipt once blocked', async () => {
    const a = await createTestUser({ name: 'A' });
    const c = await createTestUser({ name: 'C' });
    await prisma.directMessage.create({ data: { senderId: a.user.id, receiverId: c.user.id, text: 'one' } });
    const sockC = await connectAs(c.user.id);

    await sockC.handlers.dm_read({ senderId: a.user.id });
    expect(sockC.toRooms).toEqual([
      { room: `user:${a.user.id}`, event: 'dm_read_receipt', payload: { by: c.user.id } },
    ]);

    await prisma.directMessage.create({ data: { senderId: a.user.id, receiverId: c.user.id, text: 'two' } });
    await block(c, a); // the reader blocked the sender
    await sockC.handlers.dm_read({ senderId: a.user.id });
    expect(await prisma.directMessage.count({ where: { receiverId: c.user.id, readAt: null } })).toBe(0);
    expect(sockC.toRooms).toHaveLength(1);
  });

  it('opening the history over HTTP sends no messages_read once blocked', async () => {
    const { s, b, chatId } = await openChat();
    const sent = [];
    app.set('io', { to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) });
    try {
      await request(app).post(`${API}/chats/${chatId}/messages`).set(s.headers).send({ text: 'offer 1' });
      await request(app).get(`${API}/chats/${chatId}/messages`).set(b.headers);
      expect(sent.filter((e) => e.event === 'messages_read')).toHaveLength(1);

      await request(app).post(`${API}/chats/${chatId}/messages`).set(s.headers).send({ text: 'offer 2' });
      await block(b, s);
      const res = await request(app).get(`${API}/chats/${chatId}/messages`).set(b.headers);
      expect(res.status).toBe(200);
      expect(await prisma.chatMessage.count({ where: { chatId, readAt: null } })).toBe(0);
      expect(sent.filter((e) => e.event === 'messages_read')).toHaveLength(1);
    } finally {
      app.set('io', undefined);
    }
  });
});

describe('HTTP refusals carry USER_BLOCKED', () => {
  it('on send, both directions, with nothing stored or pushed', async () => {
    const { s, b, chatId } = await openChat();
    await block(b, s);

    for (const who of [b, s]) {
      const res = await request(app).post(`${API}/chats/${chatId}/messages`).set(who.headers)
        .send({ text: 'hello', clientMsgId: `cm-${who.user.id}` });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'USER_BLOCKED', message: BLOCKED_MSG });
    }
    expect(await prisma.chatMessage.count({ where: { chatId } })).toBe(0);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('on open-chat, listing detail and contact reveal', async () => {
    const s = await createTestUser({ name: 'Seller' });
    const b = await createTestUser({ name: 'Buyer' });
    const l = await makeListing(s.user.id);
    await block(s, b); // the SELLER blocked this buyer

    const open = await request(app).post(`${API}/${l.id}/chat`).set(b.headers);
    expect(open.status).toBe(403);
    expect(open.body.error.code).toBe('USER_BLOCKED');

    const detail = await request(app).get(`${API}/${l.id}`).set(b.headers);
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe('USER_BLOCKED');

    const contact = await request(app).get(`${API}/${l.id}/contact`).set(b.headers);
    expect(contact.status).toBe(403);
    expect(contact.body.error.code).toBe('USER_BLOCKED');
  });

  it('leaves other 403s without a code', async () => {
    const { chatId } = await openChat();
    const nosy = await createTestUser({ name: 'Nosy' });
    const res = await request(app).post(`${API}/chats/${chatId}/messages`).set(nosy.headers).send({ text: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBeUndefined();
  });

  it('open-chat success says the user may message', async () => {
    const s = await createTestUser({ name: 'Seller' });
    const b = await createTestUser({ name: 'Buyer' });
    const l = await makeListing(s.user.id);
    const res = await request(app).post(`${API}/${l.id}/chat`).set(b.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ blockedByMe: false, canMessage: true });
  });
});

describe('block state for the apps', () => {
  it('chats/my flags each row for blocker, blocked and neither', async () => {
    const { s, b, chatId } = await openChat();
    // A second chat for the same buyer, with a seller nobody blocked.
    const s2 = await createTestUser({ name: 'Seller 2' });
    const l2 = await makeListing(s2.user.id);
    const other = await request(app).post(`${API}/${l2.id}/chat`).set(b.headers);
    await block(b, s);

    const mine = await request(app).get(`${API}/chats/my`).set(b.headers);
    const row = (id) => mine.body.data.find((r) => r.id === id);
    expect(row(chatId)).toMatchObject({ blockedByMe: true, canMessage: false });
    expect(row(other.body.data.id)).toMatchObject({ blockedByMe: false, canMessage: true });

    // The blocked side learns only that it cannot message.
    const theirs = await request(app).get(`${API}/chats/my`).set(s.headers);
    expect(theirs.body.data.find((r) => r.id === chatId)).toMatchObject({ blockedByMe: false, canMessage: false });
  });

  it('message history stays readable and its meta carries the flags', async () => {
    const { s, b, chatId } = await openChat();
    await request(app).post(`${API}/chats/${chatId}/messages`).set(b.headers).send({ text: 'hi' });

    const before = await request(app).get(`${API}/chats/${chatId}/messages`).set(b.headers);
    expect(before.body.meta).toMatchObject({ blockedByMe: false, canMessage: true });

    await block(s, b);
    const blocker = await request(app).get(`${API}/chats/${chatId}/messages`).set(s.headers);
    expect(blocker.status).toBe(200);
    expect(blocker.body.data.map((m) => m.text)).toEqual(['hi']);
    expect(blocker.body.meta).toMatchObject({ blockedByMe: true, canMessage: false });

    const blocked = await request(app).get(`${API}/chats/${chatId}/messages`).set(b.headers);
    expect(blocked.status).toBe(200);
    expect(blocked.body.meta).toMatchObject({ blockedByMe: false, canMessage: false });
    // Legacy ?page= history gets the same meta.
    const legacy = await request(app).get(`${API}/chats/${chatId}/messages`).set(b.headers).query({ page: 1 });
    expect(legacy.body.meta).toMatchObject({ blockedByMe: false, canMessage: false });
  });
});

describe('GET /animals/blocks', () => {
  it('requires authentication', async () => {
    expect((await request(app).get(`${API}/blocks`)).status).toBe(401);
  });

  it('lists only the users I blocked, newest first, without phone numbers', async () => {
    const me = await createTestUser({ name: 'Me' });
    const older = await createTestUser({ name: 'Older', avatar: 'https://example.com/o.jpg' });
    const newer = await createTestUser({ name: 'Newer' });
    const blockedMe = await createTestUser({ name: 'Blocked me' });
    await prisma.userBlock.createMany({
      data: [
        { blockerId: me.user.id, blockedId: older.user.id, createdAt: new Date('2026-01-01T00:00:00Z') },
        { blockerId: me.user.id, blockedId: newer.user.id, createdAt: new Date('2026-02-01T00:00:00Z') },
        { blockerId: blockedMe.user.id, blockedId: me.user.id },
      ],
    });

    const res = await request(app).get(`${API}/blocks`).set(me.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: newer.user.id, name: 'Newer', avatar: null, blockedAt: '2026-02-01T00:00:00.000Z' },
      { id: older.user.id, name: 'Older', avatar: 'https://example.com/o.jpg', blockedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(newer.user.phone);
    expect(res.body.meta).toEqual({ limit: 50, hasMore: false, nextCursor: null });
  });

  it('is bounded by limit, capped at 100', async () => {
    const me = await createTestUser({ name: 'Me' });
    for (let i = 0; i < 3; i++) {
      const t = await createTestUser({ name: `T${i}` });
      await prisma.userBlock.create({ data: { blockerId: me.user.id, blockedId: t.user.id } });
    }

    const one = await request(app).get(`${API}/blocks`).set(me.headers).query({ limit: 2 });
    expect(one.body.data).toHaveLength(2);
    expect(one.body.meta).toEqual({ limit: 2, hasMore: true, nextCursor: expect.any(String) });

    const huge = await request(app).get(`${API}/blocks`).set(me.headers).query({ limit: 100000 });
    expect(huge.body.data).toHaveLength(3);
    expect(huge.body.meta.limit).toBe(100);

    // A page that exactly fits is the last one: no phantom empty page after it.
    const exact = await request(app).get(`${API}/blocks`).set(me.headers).query({ limit: 3 });
    expect(exact.body.data).toHaveLength(3);
    expect(exact.body.meta).toEqual({ limit: 3, hasMore: false, nextCursor: null });

    // Nonsense or out-of-range limits fall back to the default of 50.
    for (const limit of ['0', '-5', 'abc']) {
      const res = await request(app).get(`${API}/blocks`).set(me.headers).query({ limit });
      expect(res.status).toBe(200);
      expect(res.body.meta.limit).toBe(50);
    }
    const min = await request(app).get(`${API}/blocks`).set(me.headers).query({ limit: 1 });
    expect(min.body.data).toHaveLength(1);
    expect(min.body.meta).toMatchObject({ limit: 1, hasMore: true });
  });

  it('walks every page by cursor with no duplicates or gaps, ties included', async () => {
    const me = await createTestUser({ name: 'Me' });
    const stranger = await createTestUser({ name: 'Stranger' });
    // Seven blocks. Positions 2 and 3 (newest first) share a createdAt and sit
    // across the limit=3 page boundary, so only the id tie-break keeps the walk
    // exact; their ids are fixed so the expected order is known (id DESC).
    const same = new Date('2026-03-01T00:00:00Z');
    const spec = [
      { at: new Date('2026-03-05T00:00:00Z') },
      { at: new Date('2026-03-04T00:00:00Z'), name: null },
      { at: same, blockId: '22222222-2222-4222-8222-222222222222' },
      { at: same, blockId: '11111111-1111-4111-8111-111111111111' },
      { at: new Date('2026-02-01T00:00:00Z') },
      { at: new Date('2026-01-15T00:00:00Z') },
      { at: new Date('2026-01-01T00:00:00Z') },
    ];
    const expected = [];
    for (const [i, s] of spec.entries()) {
      const t = await createTestUser({ name: 'name' in s ? s.name : `T${i}` });
      await prisma.userBlock.create({
        data: { ...(s.blockId && { id: s.blockId }), blockerId: me.user.id, blockedId: t.user.id, createdAt: s.at },
      });
      expected.push(t.user.id);
    }
    // Someone else's block must never leak into my pages.
    await prisma.userBlock.create({ data: { blockerId: stranger.user.id, blockedId: me.user.id, createdAt: same } });

    const p1 = await request(app).get(`${API}/blocks`).set(me.headers).query({ limit: 3 });
    expect(p1.status).toBe(200);
    expect(p1.body.data.map((r) => r.id)).toEqual(expected.slice(0, 3));
    expect(p1.body.meta).toEqual({ limit: 3, hasMore: true, nextCursor: expect.any(String) });
    // A deleted-name user still lists, with name null for the app's fallback.
    expect(p1.body.data[1]).toMatchObject({ id: expected[1], name: null, blockedAt: '2026-03-04T00:00:00.000Z' });

    const p2 = await request(app).get(`${API}/blocks`).set(me.headers)
      .query({ limit: 3, cursor: p1.body.meta.nextCursor });
    expect(p2.status).toBe(200);
    expect(p2.body.data.map((r) => r.id)).toEqual(expected.slice(3, 6));
    expect(p2.body.data[0].blockedAt).toBe(same.toISOString()); // the tie, continued
    expect(p2.body.meta).toEqual({ limit: 3, hasMore: true, nextCursor: expect.any(String) });

    const p3 = await request(app).get(`${API}/blocks`).set(me.headers)
      .query({ limit: 3, cursor: p2.body.meta.nextCursor });
    expect(p3.status).toBe(200);
    expect(p3.body.data.map((r) => r.id)).toEqual(expected.slice(6));
    expect(p3.body.meta).toEqual({ limit: 3, hasMore: false, nextCursor: null });

    const walked = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((r) => r.id);
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(7);
  });

  it('rejects a malformed cursor with 400 and treats an empty one as page 1', async () => {
    const me = await createTestUser({ name: 'Me' });
    const t = await createTestUser({ name: 'T' });
    await prisma.userBlock.create({ data: { blockerId: me.user.id, blockedId: t.user.id } });
    const b64 = (s) => Buffer.from(s).toString('base64url');

    for (const cursor of [
      'not-a-cursor',
      b64('garbage'),
      b64('not-a-date|11111111-1111-4111-8111-111111111111'),
      b64('2026-01-01T00:00:00.000Z|not-a-uuid'),
      b64("2026-01-01T00:00:00.000Z|' OR 1=1 --"),
    ]) {
      const res = await request(app).get(`${API}/blocks`).set(me.headers).query({ cursor });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
    // A repeated ?cursor= arrives as an array, which is not a cursor either.
    const twice = await request(app).get(`${API}/blocks?cursor=a&cursor=b`).set(me.headers);
    expect(twice.status).toBe(400);

    const empty = await request(app).get(`${API}/blocks?cursor=`).set(me.headers);
    expect(empty.status).toBe(200);
    expect(empty.body.data.map((r) => r.id)).toEqual([t.user.id]);
  });
});

describe('unblock', () => {
  it('refuses self with 400', async () => {
    const me = await createTestUser({ name: 'Me' });
    expect((await unblock(me, me)).status).toBe(400);
  });

  it('is idempotent, including for someone never blocked', async () => {
    const me = await createTestUser({ name: 'Me' });
    const t = await createTestUser({ name: 'T' });
    await block(me, t);
    for (let i = 0; i < 2; i++) {
      const res = await unblock(me, t);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ blocked: false });
    }
    expect(await prisma.userBlock.count({ where: { blockerId: me.user.id } })).toBe(0);
  });

  it('still succeeds once the blocked user is gone', async () => {
    const me = await createTestUser({ name: 'Me' });
    const gone = await createTestUser({ name: 'Gone' });
    await block(me, gone);
    await prisma.user.delete({ where: { id: gone.user.id } });

    const res = await unblock(me, gone);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ blocked: false });
  });

  it('block → unblock → the chat works again, push included', async () => {
    const { s, b, chatId } = await openChat();
    await block(b, s);
    expect((await request(app).post(`${API}/chats/${chatId}/messages`).set(b.headers).send({ text: 'x' })).status).toBe(403);

    await unblock(b, s);
    const res = await request(app).post(`${API}/chats/${chatId}/messages`).set(b.headers).send({ text: 'back' });
    expect(res.status).toBe(201);
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(sendPushToUser.mock.calls[0][0]).toMatchObject({ userId: s.user.id, type: 'NEW_MESSAGE' });

    const meta = (await request(app).get(`${API}/chats/${chatId}/messages`).set(b.headers)).body.meta;
    expect(meta).toMatchObject({ blockedByMe: false, canMessage: true });
  });
});
