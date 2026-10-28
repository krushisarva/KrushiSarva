/**
 * Blocking, as the animal-trade screens read it from the server.
 *
 * The server refuses anything a block forbids with HTTP 403 and
 * `error.code: 'USER_BLOCKED'` (and, on the socket, an `error` event carrying
 * the same code). Chat rows and the messages meta say which side the block is
 * on through two flags:
 *
 *   blockedByMe   I blocked them             → "You blocked this user." + Unblock
 *   canMessage    false if blocked either way → no composer
 *
 * A server older than these flags sends neither, and that must read as "not
 * blocked": `blockedByMe` false, `canMessage` true.
 *
 * No React and no react-native import here, so the plain-node Jest config can
 * test all of it.
 */

export const USER_BLOCKED = 'USER_BLOCKED';

/**
 * True when a failure is the server refusing because of a block.
 *
 * Accepts an axios error (HTTP 403 + body code) or a socket error payload
 * (`{ code: 'USER_BLOCKED', ... }`). A plain 403 without the code is NOT a
 * block: it can mean "not your chat", and treating it as one would show the
 * wrong screen.
 */
export function isUserBlockedError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.response) {
    return err.response.status === 403 && err.response.data?.error?.code === USER_BLOCKED;
  }
  return err.code === USER_BLOCKED;
}

/**
 * The block flags from a chat row, a messages `meta`, or an open-chat reply.
 *
 * Returns null when the object carries neither flag (an older server, or a
 * reply that simply does not speak about blocking) so the caller can keep what
 * it already knows instead of resetting a block it learnt a moment ago.
 */
export function readBlockFlags(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const hasMine = typeof obj.blockedByMe === 'boolean';
  const hasCan = typeof obj.canMessage === 'boolean';
  if (!hasMine && !hasCan) return null;
  const blockedByMe = obj.blockedByMe === true;
  // Having blocked someone always means you cannot message them, whatever an
  // inconsistent payload says.
  const canMessage = blockedByMe ? false : obj.canMessage !== false;
  return { blockedByMe, canMessage };
}

/** What an unknown / older server means: nobody is blocked. */
export const NOT_BLOCKED = Object.freeze({ blockedByMe: false, canMessage: true });

/**
 * Which closed state a chat screen shows in place of its composer.
 *
 *   'byMe'        I blocked them — offer Unblock
 *   'cannotReply' they blocked me — say only that replying is not possible
 *   null          the composer is live
 *
 * The second case deliberately never says "they blocked you".
 */
export function chatBlockMode(flags) {
  if (!flags) return null;
  if (flags.blockedByMe) return 'byMe';
  if (flags.canMessage === false) return 'cannotReply';
  return null;
}

/** Rows of GET /animals/blocks, whichever envelope the server used. */
export function blockedUsersFrom(body) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return rows.filter((r) => r && r.id != null);
}

/**
 * The cursor for the next page of GET /animals/blocks, or null when there is
 * none. A server older than paging sends no `nextCursor` (and returns the whole
 * list), which reads as "no more pages".
 */
export function nextBlocksCursor(body) {
  const meta = body && typeof body === 'object' && !Array.isArray(body) ? body.meta : null;
  if (!meta || meta.hasMore === false) return null;
  const c = meta.nextCursor;
  return typeof c === 'string' && c ? c : null;
}

/**
 * The list with a further page appended (the server sends newest first, so
 * appending keeps that order). A row already on screen keeps its place and the
 * page's copy is dropped, as is a repeat inside the page itself. Returns the
 * SAME array when the page adds nothing, so FlatList does not re-render.
 */
export function mergeBlockedPage(list, page) {
  if (!Array.isArray(page) || page.length === 0) return list;
  const seen = new Set(list.map((r) => r.id));
  const added = [];
  for (const r of page) {
    if (!r || r.id == null || seen.has(r.id)) continue;
    seen.add(r.id);
    added.push(r);
  }
  return added.length ? [...list, ...added] : list;
}

/**
 * The rows of a GET /animals/blocks reply that may be shown.
 *
 * Hides a row whose unblock is still in flight (`pending`), and a row whose
 * unblock finished at or after `requestedAt` (`unblockedAt`: id → ms): that
 * reply may have been read before the unblock and would put the person back on
 * the list.
 */
export function visibleBlockedRows(rows, { pending, unblockedAt, requestedAt = 0 } = {}) {
  return rows.filter((r) => {
    if (pending && pending.has(r.id)) return false;
    const done = unblockedAt ? unblockedAt.get(r.id) : undefined;
    return !(done != null && done >= requestedAt);
  });
}

/**
 * A chat's own unsent messages, once we know whether sending is possible.
 *
 *   canMessage false → every message still waiting (queued, failed, or one of
 *                      `held`) is final: failed + `blockedFail` ("Not sent",
 *                      no retry). One mid-send and not in `held` is left to
 *                      its own reply.
 *   canMessage true  → a "Not sent" left by an earlier block is an ordinary
 *                      failed message again, so it can be retried.
 *
 * Returns the SAME array when nothing changes, so a poll that learns nothing
 * new does not re-render the thread or rewrite its cache.
 */
export function settleUnsent(messages, canMessage, held) {
  let changed = false;
  const next = messages.map((m) => {
    if (!m || !m.localStatus) return m;
    if (canMessage) {
      if (!m.blockedFail) return m;
      changed = true;
      return { ...m, blockedFail: false };
    }
    if (m.blockedFail) return m;
    const waiting = m.localStatus === 'queued' || m.localStatus === 'failed'
      || !!(held && held.has(m.clientMsgId));
    if (!waiting) return m;
    changed = true;
    return { ...m, localStatus: 'failed', blockedFail: true };
  });
  return changed ? next : messages;
}

/**
 * Put a row back where it was after a failed optimistic remove.
 * Never duplicates: a row already present (a refresh landed meanwhile) wins.
 */
export function restoreRow(list, row, index) {
  if (!row || list.some((r) => r.id === row.id)) return list;
  const at = Math.max(0, Math.min(Number.isInteger(index) ? index : list.length, list.length));
  return [...list.slice(0, at), row, ...list.slice(at)];
}
