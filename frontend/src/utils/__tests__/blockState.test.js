/**
 * The block helpers every animal-trade screen branches on (utils/blockState.js).
 * Pure functions, so they are tested directly.
 */
import {
  USER_BLOCKED, isUserBlockedError, readBlockFlags, chatBlockMode, NOT_BLOCKED,
  blockedUsersFrom, restoreRow, visibleBlockedRows, settleUnsent,
  nextBlocksCursor, mergeBlockedPage,
} from '../blockState';

const httpError = (status, code) => ({
  message: 'Request failed',
  response: { status, data: { success: false, error: { message: 'x', ...(code ? { code } : {}) } } },
});

describe('isUserBlockedError', () => {
  test('HTTP 403 with code USER_BLOCKED is a block', () => {
    expect(isUserBlockedError(httpError(403, USER_BLOCKED))).toBe(true);
  });

  test('a plain 403 is NOT a block (it can mean "not your chat")', () => {
    expect(isUserBlockedError(httpError(403))).toBe(false);
    expect(isUserBlockedError(httpError(403, 'FORBIDDEN'))).toBe(false);
  });

  test('the code on any other status is not a block', () => {
    expect(isUserBlockedError(httpError(404, USER_BLOCKED))).toBe(false);
    expect(isUserBlockedError(httpError(500, USER_BLOCKED))).toBe(false);
  });

  test('the socket error payload is a block', () => {
    expect(isUserBlockedError({ code: USER_BLOCKED, chatId: 'c1', clientMsgId: 'm1', message: 'x' })).toBe(true);
    expect(isUserBlockedError({ message: 'Chat not found' })).toBe(false);
  });

  test('an HTTP response wins over a stray top-level code', () => {
    expect(isUserBlockedError({ code: USER_BLOCKED, response: { status: 500, data: {} } })).toBe(false);
  });

  test('offline, timeouts and junk are not blocks', () => {
    expect(isUserBlockedError({ message: 'Network Error' })).toBe(false);
    expect(isUserBlockedError({ code: 'ECONNABORTED' })).toBe(false);
    for (const junk of [null, undefined, 0, '', 'USER_BLOCKED', []]) {
      expect(isUserBlockedError(junk)).toBe(false);
    }
  });
});

describe('readBlockFlags', () => {
  test('an older server (no flags) says nothing, so callers keep what they know', () => {
    expect(readBlockFlags({})).toBeNull();
    expect(readBlockFlags({ hasMore: true, nextCursor: 'x' })).toBeNull();
    expect(readBlockFlags(null)).toBeNull();
    expect(readBlockFlags(undefined)).toBeNull();
  });

  test('not blocked', () => {
    expect(readBlockFlags({ blockedByMe: false, canMessage: true })).toEqual(NOT_BLOCKED);
  });

  test('I blocked them', () => {
    expect(readBlockFlags({ blockedByMe: true, canMessage: false })).toEqual({ blockedByMe: true, canMessage: false });
  });

  test('they blocked me', () => {
    expect(readBlockFlags({ blockedByMe: false, canMessage: false })).toEqual({ blockedByMe: false, canMessage: false });
  });

  test('one flag alone defaults the other to "not blocked"', () => {
    expect(readBlockFlags({ canMessage: false })).toEqual({ blockedByMe: false, canMessage: false });
    expect(readBlockFlags({ canMessage: true })).toEqual(NOT_BLOCKED);
    expect(readBlockFlags({ blockedByMe: false })).toEqual(NOT_BLOCKED);
  });

  test('having blocked them always means no messaging, whatever canMessage says', () => {
    expect(readBlockFlags({ blockedByMe: true })).toEqual({ blockedByMe: true, canMessage: false });
    expect(readBlockFlags({ blockedByMe: true, canMessage: true })).toEqual({ blockedByMe: true, canMessage: false });
  });

  test('non-boolean values are ignored, not coerced', () => {
    expect(readBlockFlags({ blockedByMe: 'true', canMessage: 'false' })).toBeNull();
    expect(readBlockFlags({ blockedByMe: 1, canMessage: 0 })).toBeNull();
  });
});

describe('chatBlockMode', () => {
  test('maps flags to what replaces the composer', () => {
    expect(chatBlockMode(NOT_BLOCKED)).toBeNull();
    expect(chatBlockMode({ blockedByMe: true, canMessage: false })).toBe('byMe');
    expect(chatBlockMode({ blockedByMe: false, canMessage: false })).toBe('cannotReply');
    expect(chatBlockMode(null)).toBeNull();
  });

  test('NOT_BLOCKED cannot be mutated by accident', () => {
    expect(Object.isFrozen(NOT_BLOCKED)).toBe(true);
  });
});

describe('blockedUsersFrom', () => {
  const a = { id: 'u1', name: 'Ramesh', avatar: null, blockedAt: '2026-10-01T00:00:00Z' };
  const b = { id: 'u2', name: null, avatar: 'https://x/y.jpg', blockedAt: '2026-10-02T00:00:00Z' };

  test('reads the { success, data } envelope and a bare array', () => {
    expect(blockedUsersFrom({ success: true, data: [a, b] })).toEqual([a, b]);
    expect(blockedUsersFrom([a])).toEqual([a]);
  });

  test('anything else is an empty list, and rows without an id are dropped', () => {
    expect(blockedUsersFrom(null)).toEqual([]);
    expect(blockedUsersFrom({ data: { id: 'u1' } })).toEqual([]);
    expect(blockedUsersFrom({ data: [a, null, { name: 'no id' }, b] })).toEqual([a, b]);
  });
});

describe('nextBlocksCursor (paging GET /animals/blocks)', () => {
  test('the server cursor while there are more pages', () => {
    expect(nextBlocksCursor({ data: [], meta: { limit: 30, hasMore: true, nextCursor: 'abc' } })).toBe('abc');
  });

  test('null cursor, hasMore false, or an older server without one: no more pages', () => {
    expect(nextBlocksCursor({ data: [], meta: { limit: 30, hasMore: false, nextCursor: null } })).toBeNull();
    expect(nextBlocksCursor({ data: [], meta: { hasMore: false, nextCursor: 'stale' } })).toBeNull();
    expect(nextBlocksCursor({ data: [], meta: { limit: 50 } })).toBeNull();
    expect(nextBlocksCursor({ success: true, data: [] })).toBeNull();
    expect(nextBlocksCursor([{ id: 'u1' }])).toBeNull();
    for (const junk of [null, undefined, '', 0]) expect(nextBlocksCursor(junk)).toBeNull();
  });

  test('a non-string or empty cursor is not followed', () => {
    expect(nextBlocksCursor({ meta: { hasMore: true, nextCursor: '' } })).toBeNull();
    expect(nextBlocksCursor({ meta: { hasMore: true, nextCursor: 42 } })).toBeNull();
    expect(nextBlocksCursor({ meta: { hasMore: true, nextCursor: { id: 1 } } })).toBeNull();
  });
});

describe('mergeBlockedPage (appending the next page)', () => {
  const r = (id, name = `n${id}`) => ({ id, name });

  test('appends after the rows on screen, keeping the server\'s newest-first order', () => {
    expect(mergeBlockedPage([r(1), r(2)], [r(3), r(4)])).toEqual([r(1), r(2), r(3), r(4)]);
  });

  test('a row already on screen keeps its place; the page\'s copy is dropped', () => {
    const merged = mergeBlockedPage([r(1), r(2, 'mine')], [r(2, 'page'), r(3)]);
    expect(merged).toEqual([r(1), r(2, 'mine'), r(3)]);
  });

  test('a repeat inside the page itself is kept once', () => {
    expect(mergeBlockedPage([r(1)], [r(2), r(2), r(3)])).toEqual([r(1), r(2), r(3)]);
  });

  test('rows without an id are skipped', () => {
    expect(mergeBlockedPage([r(1)], [null, { name: 'x' }, r(2)])).toEqual([r(1), r(2)]);
  });

  test('a page that adds nothing returns the SAME array (no re-render)', () => {
    const list = [r(1), r(2)];
    expect(mergeBlockedPage(list, [r(2), r(1)])).toBe(list);
    expect(mergeBlockedPage(list, [])).toBe(list);
    expect(mergeBlockedPage(list, undefined)).toBe(list);
  });

  test('onto an empty list (every row on screen was unblocked)', () => {
    expect(mergeBlockedPage([], [r(5), r(6)])).toEqual([r(5), r(6)]);
  });

  test('a page filtered by visibleBlockedRows first never brings back a row unblocked meanwhile', () => {
    const page = visibleBlockedRows([r(3), r(4)], { pending: new Set([4]) });
    expect(mergeBlockedPage([r(1)], page)).toEqual([r(1), r(3)]);
  });
});

describe('restoreRow (rollback of an optimistic unblock)', () => {
  const r = (id) => ({ id });

  test('puts the row back where it was', () => {
    expect(restoreRow([r(1), r(3)], r(2), 1)).toEqual([r(1), r(2), r(3)]);
    expect(restoreRow([r(2), r(3)], r(1), 0)).toEqual([r(1), r(2), r(3)]);
    expect(restoreRow([r(1), r(2)], r(3), 2)).toEqual([r(1), r(2), r(3)]);
  });

  test('an out-of-range or unknown index clamps rather than throws', () => {
    expect(restoreRow([r(1)], r(2), 99)).toEqual([r(1), r(2)]);
    expect(restoreRow([r(1)], r(2), -1)).toEqual([r(2), r(1)]);
    expect(restoreRow([r(1)], r(2), undefined)).toEqual([r(1), r(2)]);
    expect(restoreRow([], r(2), 3)).toEqual([r(2)]);
  });

  test('never duplicates a row a refresh already brought back', () => {
    const list = [r(1), r(2)];
    expect(restoreRow(list, r(2), 0)).toBe(list);
  });

  test('a missing row is a no-op', () => {
    const list = [r(1)];
    expect(restoreRow(list, null, 0)).toBe(list);
  });
});

describe('visibleBlockedRows (a list read racing an unblock)', () => {
  const r = (id) => ({ id });

  test('a row whose unblock is in flight is hidden', () => {
    expect(visibleBlockedRows([r(1), r(2)], { pending: new Set([2]) })).toEqual([r(1)]);
  });

  test('a read sent BEFORE an unblock finished does not bring that row back', () => {
    const unblockedAt = new Map([[2, 1_000]]);
    expect(visibleBlockedRows([r(1), r(2)], { unblockedAt, requestedAt: 900 })).toEqual([r(1)]);
    expect(visibleBlockedRows([r(1), r(2)], { unblockedAt, requestedAt: 1_000 })).toEqual([r(1)]);
  });

  test('a read sent AFTER the unblock is the truth (blocked again elsewhere → shown)', () => {
    const unblockedAt = new Map([[2, 1_000]]);
    expect(visibleBlockedRows([r(1), r(2)], { unblockedAt, requestedAt: 1_001 })).toEqual([r(1), r(2)]);
  });

  test('no options: every row', () => {
    expect(visibleBlockedRows([r(1), r(2)])).toEqual([r(1), r(2)]);
  });
});

describe('settleUnsent (unsent bubbles across a block)', () => {
  const m = (clientMsgId, localStatus, extra = {}) => ({ id: `local-${clientMsgId}`, clientMsgId, localStatus, ...extra });
  const server = { id: 's1', clientMsgId: 'srv', text: 'hi' };

  test('blocked: queued and failed become "Not sent"; a send in flight is left to its reply', () => {
    const out = settleUnsent([server, m('q', 'queued'), m('f', 'failed'), m('s', 'sending')], false);
    expect(out[0]).toBe(server);
    expect(out[1]).toMatchObject({ localStatus: 'failed', blockedFail: true });
    expect(out[2]).toMatchObject({ localStatus: 'failed', blockedFail: true });
    expect(out[3]).toEqual(m('s', 'sending'));
  });

  test('blocked: the refused send itself (held) is "Not sent" even while marked sending', () => {
    const out = settleUnsent([m('s', 'sending')], false, new Set(['s']));
    expect(out[0]).toMatchObject({ localStatus: 'failed', blockedFail: true });
  });

  test('unblocked: a "Not sent" is an ordinary failed message again (retryable)', () => {
    const out = settleUnsent([m('f', 'failed', { blockedFail: true })], true);
    expect(out[0]).toMatchObject({ localStatus: 'failed', blockedFail: false });
  });

  test('nothing to change → the same array (a poll that learns nothing does not re-render)', () => {
    const settled = [server, m('f', 'failed', { blockedFail: true })];
    expect(settleUnsent(settled, false)).toBe(settled);
    const open = [server, m('s', 'sending'), m('f', 'failed')];
    expect(settleUnsent(open, true)).toBe(open);
    const empty = [];
    expect(settleUnsent(empty, false)).toBe(empty);
  });
});
