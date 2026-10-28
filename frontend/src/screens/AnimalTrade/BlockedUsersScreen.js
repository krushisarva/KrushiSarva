/**
 * BlockedUsersScreen — the people this user blocked in animal trade, with a way
 * back out.
 *
 * Blocking from a listing promised "You can undo this later"; until this screen
 * there was nowhere to do it. Reached from the Animal chats inbox header.
 *
 *   GET    /animals/blocks?limit&cursor   → [{ id, name, avatar, blockedAt }],
 *                                           meta { limit, hasMore, nextCursor }
 *   DELETE /animals/sellers/:id/block     → unblock
 *
 * Paged, newest first: reaching the end loads the next page with the server's
 * cursor, one page at a time. Pull-to-refresh and coming back to the screen
 * start again from the first page. An older server sends no cursor, which
 * means its one reply was the whole list.
 *
 * Unblock asks first, then removes the row at once and puts it back where it
 * was if the server refuses or the phone is offline. A second tap on the same
 * row while its request is in flight does nothing.
 */
import React, { useState, useCallback, useRef, useEffect, memo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image,
  RefreshControl, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '@krushisarva/shared/constants/colors';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import api from '@krushisarva/shared/services/api';
import { SkeletonList } from '../../components/ui/Skeleton';
import { showPopup } from '../../utils/popup';
import { classifyError, ERROR_CODES } from '../../utils/apiError';
import { invalidateFocusData } from '../../hooks/useFocusRefresh';
import {
  blockedUsersFrom, restoreRow, visibleBlockedRows, nextBlocksCursor, mergeBlockedPage,
} from '../../utils/blockState';

const PAGE_SIZE = 30;

const keyOf = (r) => String(r.id);
const Separator = () => <View style={s.sep} />;

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Memoised: appending a page or toggling one row's spinner leaves the others alone.
const BlockedRow = memo(function BlockedRow({ row, onUnblock, busy, t }) {
  const name = (row.name && String(row.name).trim()) || t('block.unknownUser', 'KrushiSarva user');
  const avatarUri = typeof row.avatar === 'string' && /^https?:\/\//i.test(row.avatar) ? row.avatar : null;
  const when = formatDate(row.blockedAt);
  return (
    <View style={s.row}>
      <View style={s.avatar}>
        {avatarUri ? (
          <Image source={{ uri: avatarUri }} style={s.avatarImg} accessibilityIgnoresInvertColors />
        ) : row.name ? (
          <Text style={s.avatarTxt}>{name.charAt(0).toUpperCase()}</Text>
        ) : (
          <Ionicons name="person" size={22} color={COLORS.textWhite} />
        )}
      </View>
      <View style={s.body}>
        <Text style={s.name} numberOfLines={1}>{name}</Text>
        {when ? (
          <Text style={s.meta} numberOfLines={1}>
            {t('block.blockedOn', 'Blocked on {{date}}').replace('{{date}}', when)}
          </Text>
        ) : null}
      </View>
      <TouchableOpacity
        style={[s.unblockBtn, busy && s.unblockBtnBusy]}
        onPress={() => onUnblock(row)}
        disabled={busy}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={t('block.unblockName', 'Unblock {{name}}').replace('{{name}}', name)}
        accessibilityState={{ disabled: busy, busy }}
        testID={`unblock-${row.id}`}
      >
        {busy
          ? <ActivityIndicator size="small" color={COLORS.primary} />
          : <Text style={s.unblockTxt}>{t('block.unblock', 'Unblock')}</Text>}
      </TouchableOpacity>
    </View>
  );
});

export default function BlockedUsersScreen({ navigation }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // ids whose unblock is in flight — the double-tap guard (ref: no render lag)
  // and what the row's spinner reads (state).
  const pendingRef = useRef(new Set());
  const [pending, setPending] = useState(() => new Set());
  // id → when its unblock succeeded here. A list read that was already on its
  // way back when an unblock finished still has that row; this keeps it out.
  const unblockedAtRef = useRef(new Map());
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Paging. `nextCursor` null = no more pages. One later page at a time:
  // FlatList fires onEndReached repeatedly during a fast flick, and without the
  // ref guard the same page would be fetched twice. `genRef` counts first-page
  // loads — a later page that lands after a refresh started belongs to the old
  // list and is dropped; `firstLoadRef` holds later pages off until it is back.
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const loadingMoreRef = useRef(false);
  const firstLoadRef = useRef(0);
  const genRef = useRef(0);

  /** No cursor: the first page, replacing the list. A cursor: the next page, appended. */
  const fetchBlocks = useCallback(async (cursor = null) => {
    const first = !cursor;
    if (!first && (loadingMoreRef.current || firstLoadRef.current)) return;
    const gen = first ? ++genRef.current : genRef.current;
    if (first) {
      firstLoadRef.current = gen;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setError(null);
    } else {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    }
    setLoadMoreFailed(false);
    try {
      const requestedAt = Date.now();
      const { data } = await api.get('/animals/blocks', {
        params: first ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor },
      });
      if (!aliveRef.current || gen !== genRef.current) return;
      // A row whose unblock is still in flight — or finished after this read
      // was sent — stays hidden.
      const page = visibleBlockedRows(blockedUsersFrom(data), {
        pending: pendingRef.current, unblockedAt: unblockedAtRef.current, requestedAt,
      });
      setRows((prev) => (first ? page : mergeBlockedPage(prev, page)));
      setNextCursor(nextBlocksCursor(data));
    } catch (e) {
      if (!aliveRef.current || gen !== genRef.current) return;
      const classified = classifyError(e, t('block.loadFailed', 'Could not load blocked users.'));
      if (classified.code === ERROR_CODES.CANCELED) return;
      // Only a failed first page may blank the screen. A failed later page
      // keeps the rows already loaded and offers a retry under them.
      if (first) setError(classified.message); else setLoadMoreFailed(true);
    } finally {
      if (aliveRef.current && gen === genRef.current) {
        if (first) {
          firstLoadRef.current = 0;
          setLoading(false);
          setRefreshing(false);
        } else {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }
      }
    }
  }, [t]);

  useFocusEffect(useCallback(() => { fetchBlocks(); }, [fetchBlocks]));

  const loadMore = useCallback(() => {
    if (nextCursor) fetchBlocks(nextCursor);
  }, [nextCursor, fetchBlocks]);

  // After a failed page, scrolling does not retry on its own (a weak network
  // would be hit on every flick); the footer's tap does.
  const onEndReached = useCallback(() => {
    if (!loadMoreFailed) loadMore();
  }, [loadMoreFailed, loadMore]);

  // Every row on screen unblocked while more pages wait: fetch the next one
  // instead of saying the list is empty.
  useEffect(() => {
    if (!loading && rows.length === 0 && nextCursor && !loadMoreFailed) loadMore();
  }, [loading, rows.length, nextCursor, loadMoreFailed, loadMore]);

  const setRowPending = (id, on) => {
    if (on) pendingRef.current.add(id); else pendingRef.current.delete(id);
    if (aliveRef.current) setPending(new Set(pendingRef.current));
  };

  const unblock = async (row) => {
    if (pendingRef.current.has(row.id)) return;
    setRowPending(row.id, true);
    // Optimistic: the row goes now, and comes back where it was on failure.
    const index = rows.findIndex((r) => r.id === row.id);
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    try {
      await api.delete(`/animals/sellers/${row.id}/block`);
      unblockedAtRef.current.set(row.id, Date.now());
      // Their listings and the chat composer come back on next focus.
      invalidateFocusData('animals');
    } catch (e) {
      if (aliveRef.current) setRows((prev) => restoreRow(prev, row, index));
      showPopup(
        t('block.unblockFailed', 'Could not unblock this user'),
        classifyError(e, t('report.tryAgain', 'Please try again.')).message,
      );
    } finally {
      setRowPending(row.id, false);
    }
  };

  const confirmUnblock = (row) => {
    if (pendingRef.current.has(row.id)) return;
    const name = (row.name && String(row.name).trim()) || t('block.unknownUser', 'KrushiSarva user');
    showPopup(
      t('block.unblockConfirmTitleName', 'Unblock {{name}}?').replace('{{name}}', name),
      t('block.unblockConfirmBody', 'They will be able to message you again, and you will see their animal listings.'),
      [
        { text: t('cancel', 'Cancel'), style: 'cancel' },
        { text: t('block.unblock', 'Unblock'), onPress: () => unblock(row) },
      ],
    );
  };

  // One function for every row across renders (it calls the latest
  // confirmUnblock), so the memoised rows are not re-rendered for nothing.
  const confirmRef = useRef(confirmUnblock);
  confirmRef.current = confirmUnblock;
  const onUnblockRow = useCallback((row) => confirmRef.current(row), []);
  const renderItem = useCallback(({ item }) => (
    <BlockedRow row={item} onUnblock={onUnblockRow} busy={pending.has(item.id)} t={t} />
  ), [onUnblockRow, pending, t]);

  const footer = loadingMore ? (
    <ActivityIndicator style={s.footer} color={COLORS.primary} accessibilityLabel={t('loading')} />
  ) : loadMoreFailed ? (
    <TouchableOpacity style={s.footer} onPress={loadMore} accessibilityRole="button">
      <Text style={s.footerTxt}>{t('block.loadMoreFailed', 'Could not load more. Tap to retry.')}</Text>
    </TouchableOpacity>
  ) : null;

  return (
    <SafeAreaView style={s.root} edges={['bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.goBack', 'Go back')}>
          <Ionicons name="arrow-back" size={24} color={COLORS.textDark} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1} accessibilityRole="header">
          {t('block.blockedUsers', 'Blocked users')}
        </Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <SkeletonList
          rows={4}
          thumb="circle"
          thumbSize={48}
          lines={2}
          showMeta={false}
          label={t('loading')}
          style={s.skeleton}
        />
      ) : error && rows.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={48} color={COLORS.error} />
          <Text style={s.errorTxt}>{error}</Text>
          <TouchableOpacity
            style={s.retryBtn}
            onPress={() => { setLoading(true); fetchBlocks(); }}
            accessibilityRole="button"
          >
            <Text style={s.retryTxt}>{t('retry', 'Retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={keyOf}
          renderItem={renderItem}
          ItemSeparatorComponent={Separator}
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          ListFooterComponent={footer}
          contentContainerStyle={rows.length === 0 ? { flexGrow: 1 } : { paddingBottom: 32 }}
          ListHeaderComponent={rows.length ? (
            <Text style={s.hint}>
              {t('block.listHint', "Blocked people can't message you, and you won't see their animal listings.")}
            </Text>
          ) : null}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchBlocks(); }} colors={[COLORS.primary]} />
          }
          ListEmptyComponent={nextCursor ? null : (
            <View style={s.center}>
              <Ionicons name="shield-checkmark-outline" size={56} color={COLORS.gray175 || COLORS.grayLightMid} />
              <Text style={s.emptyTitle}>{t('block.emptyTitle', "You haven't blocked anyone.")}</Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:   { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 10 },
  skeleton: { paddingTop: 8 },

  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surface, paddingHorizontal: 12, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    paddingTop: Platform.OS === 'android' ? 44 : 12,
  },
  backBtn:     { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: COLORS.textDark },

  hint: { fontSize: 12.5, color: COLORS.textMedium, paddingHorizontal: 16, paddingVertical: 10, lineHeight: 18 },

  row:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, backgroundColor: COLORS.surface, gap: 12 },
  avatar:    { width: 48, height: 48, borderRadius: 24, backgroundColor: COLORS.primary, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  avatarImg: { width: 48, height: 48, borderRadius: 24 },
  avatarTxt: { fontSize: 18, fontWeight: '800', color: COLORS.textWhite },
  body:      { flex: 1, minWidth: 0 },
  name:      { fontSize: 15, fontWeight: '700', color: COLORS.textDark },
  meta:      { fontSize: 12, color: COLORS.textMedium, marginTop: 2 },
  unblockBtn:     { minHeight: 40, minWidth: 88, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1.5, borderColor: COLORS.primary, justifyContent: 'center', alignItems: 'center' },
  unblockBtnBusy: { opacity: 0.6 },
  unblockTxt:     { fontSize: 14, fontWeight: '800', color: COLORS.primary },
  sep:       { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.border },
  footer:    { minHeight: 48, paddingVertical: 14, paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center' },
  footerTxt: { fontSize: 13.5, fontWeight: '600', color: COLORS.primary, textAlign: 'center' },

  errorTxt:   { fontSize: 15, color: COLORS.error, textAlign: 'center' },
  retryBtn:   { backgroundColor: COLORS.primary, borderRadius: 10, paddingHorizontal: 24, paddingVertical: 10 },
  retryTxt:   { color: COLORS.white, fontWeight: '700', fontSize: 15 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: COLORS.textDark, marginTop: 8, textAlign: 'center' },
});
