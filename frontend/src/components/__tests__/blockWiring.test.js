/**
 * The edge cases of "block user" in animal trade, as wired into the screens.
 *
 * Screens cannot be rendered under this Jest config (see sourceParses.test.js),
 * so — like reportWiring.test.js — the source is read. The decisions themselves
 * (is this a block? which side? where does a rolled-back row go?) live in
 * utils/blockState.js and are tested directly in blockState.test.js.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..');
// Line endings normalised: the screens are checked out with CRLF on Windows.
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n');
/** Every English fallback a file passes to t(). */
const fallbacks = (src) => [...src.matchAll(/\bt\(\s*'[A-Za-z0-9_.]+'\s*,\s*(['"])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
/** The text between two markers, so an assertion is about one function only. */
const between = (src, from, to) => {
  const start = src.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
};

const CHAT = 'screens/AnimalTrade/ChatScreen.js';
const INBOX = 'screens/AnimalTrade/MyAnimalChatsScreen.js';
const DETAIL = 'screens/AnimalTrade/AnimalDetail.js';
const BLOCKED = 'screens/AnimalTrade/BlockedUsersScreen.js';
const BACKEND_SOCKET = path.join(SRC, '..', '..', 'backend', 'src', 'socket', 'chat.socket.js');

describe('chat: a blocked conversation stays readable but cannot be written to', () => {
  const src = read(CHAT);

  test('flags come from the open-chat reply, the thread meta and every poll', () => {
    expect(src).toMatch(/applyBlockFlags\(readBlockFlags\(data\.data\)\);/);
    expect(src).toMatch(/applyBlockFlags\(readBlockFlags\(page\?\.meta\)\);/);
    expect(src).toMatch(/applyBlockFlags\(readBlockFlags\(data\?\.meta\)\);/);
  });

  test('an inbox row\'s flags are used before the thread loads', () => {
    expect(src).toMatch(/blockedByMe: initialBlockedByMe, canMessage: initialCanMessage,/);
    expect(src).toMatch(/readBlockFlags\(\{ blockedByMe: initialBlockedByMe, canMessage: initialCanMessage \}\) \|\| NOT_BLOCKED/);
    expect(read(INBOX)).toMatch(/blockedByMe: row\.blockedByMe,\s*canMessage: row\.canMessage,/);
  });

  test('the composer is replaced, not disabled, and the list is still rendered', () => {
    expect(src).toMatch(/const blockMode = chatBlockMode\(blockFlags\) \|\| \(openRefused \? 'unavailable' : null\);/);
    expect(src).toMatch(/\{blockMode \? \(\s*<View/);
    // The FlatList of messages is outside that branch.
    expect(src.indexOf('<FlatList')).toBeLessThan(src.indexOf('{blockMode ? ('));
    expect(src).toMatch(/ListEmptyComponent=\{blockMode \? null : \(/);
  });

  test('I blocked them: "You blocked this user." with an Unblock button', () => {
    const note = between(src, '{blockMode ? (', ') : (\n        <View style={[styles.composerWrap');
    expect(note).toMatch(/t\('block\.youBlocked', 'You blocked this user\.'\)/);
    expect(note).toMatch(/blockMode === 'byMe' \? \(\s*<TouchableOpacity/);
    expect(note).toMatch(/onPress=\{otherUserId \? confirmUnblock : \(\) => navigation\?\.navigate\?\.\('BlockedUsers'\)\}/);
    expect(note).toMatch(/disabled=\{unblocking\}/);
    expect(note).toMatch(/accessibilityLabel=\{t\('block\.unblockName'/);
  });

  test('they blocked me: a neutral line that never says so', () => {
    expect(src).toMatch(/t\('block\.cannotReply', "You can't reply to this conversation\."\)/);
    for (const file of [CHAT, INBOX]) {
      const shown = fallbacks(read(file));
      expect(shown.length).toBeGreaterThan(2);
      expect(shown.filter((s) => /blocked (you|me)|has blocked/i.test(s))).toEqual([]);
    }
  });

  test('the menu offers Unblock instead of Block once I have blocked them; Report stays', () => {
    const menu = between(src, 'const openSafetyMenu', '/** The one-line status bar');
    expect(menu).toMatch(/t\('report\.reportUser', 'Report user'\)/);
    expect(menu).toMatch(/blockFlags\.blockedByMe\s*\? \{ text: t\('block\.unblockUser', 'Unblock user'\), onPress: confirmUnblock \}\s*: \{ text: t\('report\.blockUser', 'Block user'\), style: 'destructive', onPress: confirmBlock \}/);
  });
});

describe('chat: a send refused because of a block is final', () => {
  const src = read(CHAT);
  const deliver = between(src, 'const deliver = useCallback', '// ── Outbox');

  test('HTTP 403 USER_BLOCKED is handled before the outbox could take the message', () => {
    const blockedAt = deliver.indexOf('if (isUserBlockedError(e)) { onBlockedRefusal(msg.clientMsgId, msg.chatId); return; }');
    expect(blockedAt).toBeGreaterThan(0);
    expect(deliver.indexOf('outboxRef.current.push(msg)')).toBeGreaterThan(blockedAt);
  });

  test('once blocked, nothing more is sent: deliver, send and retry all stop', () => {
    expect(deliver).toMatch(/if \(blockedRef\.current\) \{ markBlockedNotSent\(msg\.clientMsgId\); return; \}/);
    expect(between(src, 'const sendMessage', 'const retryFailed')).toMatch(/if \(!trimmed \|\| blockedRef\.current\) return;/);
    expect(between(src, 'const retryFailed', '// ── Key handling')).toMatch(/if \(msg\?\.blockedFail \|\| blockedRef\.current\) return;/);
  });

  test('the refused message and everything queued behind it is marked "Not sent", and the outbox emptied', () => {
    const mark = between(src, 'const markBlockedNotSent', 'const applyBlockFlags');
    expect(mark).toMatch(/outboxRef\.current = \[\];/);
    // The marking itself is settleUnsent (tested in blockState.test.js), which
    // spells the statuses as literals — they must be the screen's own.
    expect(mark).toMatch(/setMessages\(\(prev\) => settleUnsent\(prev, false, held\)\);/);
    expect(src).toMatch(/const SENDING = 'sending';\s*const QUEUED {2}= 'queued';\s*const FAILED {2}= 'failed';/);
  });

  test('flags read from the server settle unsent bubbles both ways', () => {
    const apply = between(src, 'const applyBlockFlags', 'const refreshBlockFlags');
    // Blocked: a queued / failed bubble must not keep promising a send or a retry.
    expect(apply).toMatch(/if \(!flags\.canMessage\) \{[\s\S]*markBlockedNotSent\(null\);[\s\S]*\} else \{/);
    // Unblocked (e.g. from the list): a "Not sent" can be retried again.
    expect(apply).toMatch(/setMessages\(\(prev\) => settleUnsent\(prev, true\)\);/);
    expect(apply).toMatch(/\}, \[markBlockedNotSent\]\);/);
    // Defined first: a useCallback dep read before its const would throw.
    expect(src.indexOf('const markBlockedNotSent')).toBeLessThan(src.indexOf('const applyBlockFlags'));
  });

  test('a send already in flight that fails for another reason after a block is not queued', () => {
    const catchPart = deliver.slice(deliver.indexOf('} catch (e) {'));
    const refusal = catchPart.indexOf('if (isUserBlockedError(e))');
    const guard = catchPart.indexOf('if (blockedRef.current) { markBlockedNotSent(msg.clientMsgId); return; }');
    expect(guard).toBeGreaterThan(refusal);
    expect(catchPart.indexOf('outboxRef.current.push(msg)')).toBeGreaterThan(guard);
  });

  test('a closed chat re-reads its block state on return (unblocked from the list meanwhile)', () => {
    expect(src).toMatch(/import useFocusRefresh, \{ invalidateFocusData \} from '\.\.\/\.\.\/hooks\/useFocusRefresh';/);
    const hook = between(src, 'useFocusRefresh(() => {', '// ── Open the chat');
    expect(hook).toMatch(/if \(chatId && blockedRef\.current\) refreshBlockFlags\(chatId\);/);
    // Keyed under 'animals', which the list's unblock invalidates; the mount
    // already loads, so the first focus does not repeat it.
    expect(hook).toMatch(/key: `animals:chat:\$\{chatId\}`, runOnFirstFocus: false/);
    expect(read(BLOCKED)).toMatch(/invalidateFocusData\('animals'\);/);
  });

  test('a "Not sent" bubble is not a retry button', () => {
    const bubble = between(src, 'const MessageBubble', '// Approximate native stack header');
    expect(bubble).toMatch(/const notSent = status === FAILED && !!message\.blockedFail;/);
    expect(bubble).toMatch(/const retryable = status === FAILED && !notSent;/);
    expect(bubble).toMatch(/onPress=\{\(\) => retryable && onRetry\?\.\(message\)\}/);
    expect(bubble).toMatch(/t\('block\.notSent', 'Not sent'\)/);
  });

  test('the screen then switches to the blocked state and re-reads which side it is', () => {
    const refusal = between(src, 'const onBlockedRefusal', '// ── Open the chat');
    expect(refusal).toMatch(/blockedRef\.current = true;/);
    expect(refusal).toMatch(/\{ blockedByMe: false, canMessage: false \}/);
    expect(refusal).toMatch(/markBlockedNotSent\(clientMsgId\);/);
    expect(refusal).toMatch(/refreshBlockFlags\(cid\)/);
    // One re-read for a burst of refusals.
    expect(refusal).toMatch(/if \(refusalRefreshRef\.current\) return;/);
  });

  test('the socket\'s USER_BLOCKED error is settled the same way', () => {
    expect(src).toMatch(/s\.on\('error', onSocketError\);/);
    expect(src).toMatch(/s\.off\('error', onSocketError\);/);
    const handler = between(src, 'onSocketError = (payload) => {', '};');
    expect(handler).toMatch(/isUserBlockedError\(payload\)/);
    expect(handler).toMatch(/payload\.chatId && payload\.chatId !== chatId/);
    expect(handler).toMatch(/onBlockedRefusal\(payload\.clientMsgId \|\| null, chatId\)/);
  });

  test('the server really sends that event name and payload', () => {
    if (!fs.existsSync(BACKEND_SOCKET)) return; // the farmer app shipped on its own
    const backend = fs.readFileSync(BACKEND_SOCKET, 'utf8');
    expect(backend).toMatch(/socket\.emit\('error', \{ code: USER_BLOCKED, message: [A-Z_]+, chatId, clientMsgId: cmid \}\)/);
  });

  test('opening a chat that a block refuses is not retried and says the seller is unavailable', () => {
    const open = between(src, 'const open = useCallback', 'useEffect(() => { open(); }');
    const blockedAt = open.indexOf('if (isUserBlockedError(e)) {');
    expect(blockedAt).toBeGreaterThan(0);
    const branch = open.slice(blockedAt, open.indexOf('return;', blockedAt));
    expect(branch).toMatch(/setOpenRefused\(true\)/);
    expect(branch).toMatch(/markBlockedNotSent\(null\)/);
    // The retry timer is scheduled only after that early return.
    expect(open.indexOf('retryTimerRef.current = setTimeout')).toBeGreaterThan(blockedAt);
    expect(src).toMatch(/: t\('chat\.sellerUnavailable', 'This seller is not available\.'\)\}/);
  });
});

describe('chat: block and unblock from the menu', () => {
  const src = read(CHAT);

  test('after blocking: the screen closes itself and the lists are told to refresh', () => {
    const block = between(src, 'const blockUser', 'const confirmBlock');
    expect(block).toMatch(/invalidateFocusData\('animals'\);/);
    expect(block).toMatch(/applyBlockFlags\(\{ blockedByMe: true, canMessage: false \}\)/);
    expect(block).toMatch(/navigation\?\.goBack\?\.\(\)/);
  });

  test('unblock asks first, guards double taps, and changes nothing on failure', () => {
    const confirm = between(src, 'const confirmUnblock', 'const openSafetyMenu');
    expect(confirm).toMatch(/style: 'cancel'/);
    expect(confirm).toMatch(/onPress: unblockUser/);
    const unblock = between(src, 'const unblockUser', 'const confirmUnblock');
    expect(unblock).toMatch(/if \(!otherUserId \|\| unblockingRef\.current\) return;/);
    expect(unblock).toMatch(/await api\.delete\(`\/animals\/sellers\/\$\{otherUserId\}\/block`\);/);
    expect(unblock).toMatch(/invalidateFocusData\('animals'\);/);
    // State changes only after the DELETE resolved; the catch only reports.
    const tryPart = unblock.slice(0, unblock.indexOf('} catch (e) {'));
    expect(tryPart.indexOf('api.delete')).toBeLessThan(tryPart.indexOf('applyBlockFlags(next)'));
    const catchPart = unblock.slice(unblock.indexOf('} catch (e) {'), unblock.indexOf('} finally {'));
    expect(catchPart).toMatch(/showPopup\(/);
    expect(catchPart).not.toMatch(/set[A-Z]\w*\(/);
  });

  test('the menu button is guarded while either request is in flight', () => {
    expect(src).toMatch(/onPress=\{openSafetyMenu\}\s*disabled=\{blocking \|\| unblocking\}/);
  });
});

describe('inbox', () => {
  const src = read(INBOX);

  test('only rows I blocked carry a "Blocked" label, and they stay openable', () => {
    expect(src).toMatch(/const blockedByMe = row\.blockedByMe === true;/);
    expect(src).toMatch(/\{blockedByMe \? \(\s*<View style=\{s\.blockedPill\}/);
    expect(src).not.toMatch(/canMessage === false/);
    expect(src).toMatch(/<TouchableOpacity\s+style=\{s\.row\}\s+onPress=\{\(\) => onPress\(row\)\}/);
  });

  test('the header leads to Blocked users', () => {
    expect(src).toMatch(/onPress=\{\(\) => navigation\.navigate\('BlockedUsers'\)\}/);
    expect(src).toMatch(/accessibilityLabel=\{t\('block\.blockedUsers', 'Blocked users'\)\}/);
  });

  test('it refetches on every focus, so a block or unblock elsewhere shows on return', () => {
    expect(src).toMatch(/useFocusEffect\(useCallback\(\(\) => \{ fetchChats\(\); \}, \[fetchChats\]\)\);/);
  });
});

describe('listing detail', () => {
  const src = read(DETAIL);

  test('no Block on your own listing, even from a preview that only has seller.id', () => {
    expect(src).toMatch(/const listingSellerId = listing\?\.sellerId \|\| listing\?\.seller\?\.id \|\| null;/);
    expect(src).toMatch(/const isOwner = !!\(user\?\.id && listingSellerId && user\.id === listingSellerId\);/);
    const row = between(src, '{!isOwner ? (\n              <View style={styles.reportRow}>', ') : null}\n\n            {/* Listing id');
    expect(row).toMatch(/onPress=\{confirmBlock\}/);
  });

  test('Block is one request however often it is tapped, and an error changes nothing', () => {
    const block = between(src, 'const blockSeller', 'const confirmBlock');
    expect(block).toMatch(/if \(!listingSellerId \|\| isOwner \|\| blockingRef\.current\) return;/);
    expect(block).toMatch(/api\.post\(`\/animals\/sellers\/\$\{listingSellerId\}\/block`, \{\}\)/);
    const catchPart = block.slice(block.indexOf('} catch (e) {'), block.indexOf('} finally {'));
    expect(catchPart).toMatch(/showPopup\(/);
    expect(catchPart).not.toMatch(/setListing|invalidateFocusData|goBack/);
  });

  test('a listing across a block (or gone) shows the plain "not available" page', () => {
    const load = between(src, 'const load = useCallback', 'useEffect(() => { load(); }, [load]);');
    expect(load).toMatch(/if \(classified\.code === ERROR_CODES\.NOT_FOUND \|\| isUserBlockedError\(e\)\) \{\s*setListing\(null\);/);
    expect(src).toMatch(/t\('animalDetail\.notFound', 'This listing is no longer available\.'\)/);
  });

  test('returning after a block elsewhere re-reads the row', () => {
    expect(src).toMatch(/useFocusRefresh\(load, \{ key: `animals:detail:\$\{listingId\}`/);
  });
});

describe('Blocked users screen', () => {
  const src = read(BLOCKED);

  test('is registered in the animal-trade stack', () => {
    const nav = read('navigation/AppNavigator.js');
    expect(nav).toMatch(/import BlockedUsersScreen from '\.\.\/screens\/AnimalTrade\/BlockedUsersScreen';/);
    expect(nav).toMatch(/<AnimalStack\.Screen name="BlockedUsers"\s+component=\{BlockedUsersScreen\}/);
  });

  test('lists GET /animals/blocks with avatar, name and date', () => {
    expect(src).toMatch(/api\.get\('\/animals\/blocks', \{/);
    expect(src).toMatch(/blockedUsersFrom\(data\)/);
    expect(src).toMatch(/<Image source=\{\{ uri: avatarUri \}\}/);
    expect(src).toMatch(/t\('block\.blockedOn', 'Blocked on \{\{date\}\}'\)/);
  });

  test('unblock: confirm, optimistic remove, rollback on failure, double-tap guard', () => {
    const confirm = between(src, 'const confirmUnblock', 'return (');
    expect(confirm).toMatch(/style: 'cancel'/);
    expect(confirm).toMatch(/onPress: \(\) => unblock\(row\)/);
    const unblock = between(src, 'const unblock = async', 'const confirmUnblock');
    expect(unblock).toMatch(/if \(pendingRef\.current\.has\(row\.id\)\) return;/);
    expect(unblock.indexOf('prev.filter((r) => r.id !== row.id)')).toBeLessThan(unblock.indexOf('api.delete'));
    expect(unblock).toMatch(/await api\.delete\(`\/animals\/sellers\/\$\{row\.id\}\/block`\);/);
    expect(unblock).toMatch(/invalidateFocusData\('animals'\);/);
    const catchPart = unblock.slice(unblock.indexOf('} catch (e) {'), unblock.indexOf('} finally {'));
    expect(catchPart).toMatch(/restoreRow\(prev, row, index\)/);
    expect(catchPart).toMatch(/showPopup\(/);
    expect(unblock).toMatch(/\} finally \{\s*setRowPending\(row\.id, false\);/);
  });

  test('a list read already on its way back when an unblock finished does not restore the row', () => {
    const fetch = between(src, 'const fetchBlocks', 'useFocusEffect(');
    // The time is taken BEFORE the request goes out.
    expect(fetch.indexOf('const requestedAt = Date.now();')).toBeGreaterThan(0);
    expect(fetch.indexOf('const requestedAt = Date.now();')).toBeLessThan(fetch.indexOf("api.get('/animals/blocks'"));
    // Every page — first or later — goes through the same race filter.
    expect(fetch).toMatch(/const page = visibleBlockedRows\(blockedUsersFrom\(data\), \{\s*pending: pendingRef\.current, unblockedAt: unblockedAtRef\.current, requestedAt,\s*\}\);/);
    expect(fetch).toMatch(/setRows\(\(prev\) => \(first \? page : mergeBlockedPage\(prev, page\)\)\);/);
    const unblock = between(src, 'const unblock = async', 'const confirmUnblock');
    const tryPart = unblock.slice(0, unblock.indexOf('} catch (e) {'));
    // Recorded only once the server said yes.
    expect(tryPart.indexOf('unblockedAtRef.current.set(row.id, Date.now());')).toBeGreaterThan(tryPart.indexOf('await api.delete'));
  });

  test('the alive flag is set on mount, not only cleared on unmount', () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*aliveRef\.current = true;\s*return \(\) => \{ aliveRef\.current = false; \};\s*\}, \[\]\);/);
  });

  test('each Unblock button names who it unblocks and shows it is busy', () => {
    expect(src).toMatch(/accessibilityLabel=\{t\('block\.unblockName', 'Unblock \{\{name\}\}'\)\.replace\('\{\{name\}\}', name\)\}/);
    expect(src).toMatch(/disabled=\{busy\}/);
    expect(src).toMatch(/accessibilityState=\{\{ disabled: busy, busy \}\}/);
  });

  test('empty state', () => {
    expect(src).toMatch(/t\('block\.emptyTitle', "You haven't blocked anyone\."\)/);
  });

  describe('paging', () => {
    const fetch = between(src, 'const fetchBlocks', 'useFocusEffect(');

    test('the first page asks for a limit; a later page also passes the server cursor', () => {
      expect(fetch).toMatch(/const fetchBlocks = useCallback\(async \(cursor = null\) => \{/);
      expect(fetch).toMatch(/params: first \? \{ limit: PAGE_SIZE \} : \{ limit: PAGE_SIZE, cursor \},/);
      expect(src).toMatch(/const PAGE_SIZE = \d+;/);
      expect(Number(src.match(/const PAGE_SIZE = (\d+);/)[1])).toBeLessThanOrEqual(100);
      // The next cursor comes from the reply (null = no more, also for an older server).
      expect(fetch).toMatch(/setNextCursor\(nextBlocksCursor\(data\)\);/);
      const more = between(src, 'const loadMore = useCallback', '}, [nextCursor, fetchBlocks]);');
      expect(more).toMatch(/if \(nextCursor\) fetchBlocks\(nextCursor\);/);
    });

    test('never two page loads at once, and none while the first page is reloading', () => {
      expect(fetch).toMatch(/if \(!first && \(loadingMoreRef\.current \|\| firstLoadRef\.current\)\) return;/);
      // The guard is taken before the request goes out and released in finally.
      expect(fetch.indexOf('loadingMoreRef.current = true;')).toBeLessThan(fetch.indexOf("api.get('/animals/blocks'"));
      const fin = fetch.slice(fetch.indexOf('} finally {'));
      expect(fin).toMatch(/loadingMoreRef\.current = false;/);
      expect(fin).toMatch(/firstLoadRef\.current = 0;/);
    });

    test('pull-to-refresh and focus restart from page one and drop a later page still in flight', () => {
      expect(src).toMatch(/useFocusEffect\(useCallback\(\(\) => \{ fetchBlocks\(\); \}, \[fetchBlocks\]\)\);/);
      expect(src).toMatch(/onRefresh=\{\(\) => \{ setRefreshing\(true\); fetchBlocks\(\); \}\}/);
      expect(fetch).toMatch(/const gen = first \? \+\+genRef\.current : genRef\.current;/);
      expect(fetch).toMatch(/if \(!aliveRef\.current \|\| gen !== genRef\.current\) return;/);
    });

    test('a failed later page keeps the rows and offers a tap to retry; only page one blanks the screen', () => {
      expect(fetch).toMatch(/if \(first\) setError\(classified\.message\); else setLoadMoreFailed\(true\);/);
      const footer = between(src, 'const footer = loadingMore ? (', ') : null;');
      expect(footer).toMatch(/<ActivityIndicator/);
      expect(footer).toMatch(/onPress=\{loadMore\}/);
      expect(footer).toMatch(/t\('block\.loadMoreFailed', 'Could not load more\. Tap to retry\.'\)/);
      // Scrolling does not keep retrying a failed page on its own.
      expect(src).toMatch(/const onEndReached = useCallback\(\(\) => \{\s*if \(!loadMoreFailed\) loadMore\(\);/);
      expect(src).toMatch(/onEndReached=\{onEndReached\}/);
      expect(src).toMatch(/ListFooterComponent=\{footer\}/);
    });

    test('"nobody blocked" is not shown while more pages wait', () => {
      expect(src).toMatch(/ListEmptyComponent=\{nextCursor \? null : \(/);
      expect(src).toMatch(/if \(!loading && rows\.length === 0 && nextCursor && !loadMoreFailed\) loadMore\(\);/);
    });

    test('list tuned for low-end phones: stable key, row and separator; memoised rows', () => {
      expect(src).toMatch(/keyExtractor=\{keyOf\}/);
      expect(src).toMatch(/renderItem=\{renderItem\}/);
      expect(src).toMatch(/ItemSeparatorComponent=\{Separator\}/);
      expect(src).toMatch(/initialNumToRender=\{\d+\}/);
      expect(src).toMatch(/windowSize=\{\d+\}/);
      expect(src).toMatch(/const BlockedRow = memo\(function BlockedRow/);
      expect(src).toMatch(/const onUnblockRow = useCallback\(\(row\) => confirmRef\.current\(row\), \[\]\);/);
    });
  });
});

describe('copy', () => {
  const files = [CHAT, INBOX, DETAIL, BLOCKED];

  test('every block.* string carries an English fallback', () => {
    const bare = [];
    let found = 0;
    for (const file of files) {
      for (const m of read(file).matchAll(/\bt\(\s*'(block\.[A-Za-z0-9_]+)'\s*(,\s*['"`])?/g)) {
        found += 1;
        if (!m[2]) bare.push(`${file}: ${m[1]}`);
      }
    }
    expect(found).toBeGreaterThan(15);
    expect(bare).toEqual([]);
  });

  test('one key, one English sentence, everywhere it is used', () => {
    const seen = new Map();
    const clashes = [];
    for (const file of files) {
      for (const m of read(file).matchAll(/\bt\(\s*'(block\.[A-Za-z0-9_]+)'\s*,\s*(['"])((?:(?!\2).)*)\2/g)) {
        const [, key, , text] = m;
        if (seen.has(key) && seen.get(key) !== text) clashes.push(`${key}: "${seen.get(key)}" vs "${text}"`);
        seen.set(key, text);
      }
    }
    expect(clashes).toEqual([]);
  });
});
