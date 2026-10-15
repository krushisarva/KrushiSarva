/**
 * SellerReviewsScreen — what buyers said about this shop.
 *
 * Endpoint: GET /api/v1/agristore/seller/reviews  (cursor-paged; the average,
 * count and star split ride in `meta.summary` on the first page).
 *
 * A farmer rates a product after the Kendra delivers it, and that rating is
 * stamped with the seller. The marketplace already ranks offers on it. Until
 * now the seller could not see it at all — not the score, not one comment.
 *
 * THE SCORE FIRST, THEN THE WORDS
 * -------------------------------
 * The card at the top answers "how am I doing" in one look: the average, how
 * many buyers that is, and how the stars split. Below it each review reads top
 * to bottom as product (what), stars and the word for them (how good), the
 * comment (why), then who and when.
 *
 * Stars are never the only carrier of the rating: every star row sits beside
 * the number or the word, and each row is announced as one sentence.
 *
 * The buyer is a first name. The server sends nothing else on purpose — see
 * backend/src/services/sellerReviews.service.js.
 *
 * Every review has a "Report" link (Google Play's user-content rule) that opens
 * the shared report sheet. A review here is always a BUYER's — the seller has
 * no own content on this screen to hide it from — and the server refuses a
 * report on one's own review anyway.
 */
import React, { useCallback, useState } from 'react';
import { Animated, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import api from '@krushisarva/shared/services/api';
import Stars from '@krushisarva/shared/components/Stars';
import { ratingWord, reviewDay } from '@krushisarva/shared/utils/reviewDisplay';

import { C, HIT, R, SP, T, useResponsive } from '../theme';
import usePagedList from '../hooks/usePagedList';
import { useEntrance } from '../hooks/useMotion';
import {
  reviewBuyerName, reviewProductName, summaryFromResponse, summaryView,
} from '../utils/sellerReviews';
import {
  Screen, AppHeader, Card, PressableRow, ProgressBar, EmptyState, ErrorState, ListFooter, SkeletonList,
} from '../components/ui';
import ReportSheet from '../components/ReportSheet';

const PAGE_SIZE = 20;

// ── Summary ──────────────────────────────────────────────────────────────────

function SummaryCard({ view, t }) {
  return (
    <Card
      style={s.summary}
      accessible
      accessibilityLabel={t('sellerReviews.a11ySummary', {
        rating: view.averageText, count: view.count,
        defaultValue: 'Your rating is {{rating}} out of 5, from {{count}} buyers',
      })}
    >
      <View style={s.avgCol}>
        <Text style={s.avg}>{view.averageText}</Text>
        <Stars value={view.average} size={16} color={C.accent} />
        <Text style={s.avgCount}>
          {t('product.ratingsLabel', { count: view.count, defaultValue: '{{count}} ratings' })}
        </Text>
      </View>

      <View style={s.bars}>
        {view.rows.map((row) => (
          <View key={row.stars} style={s.barRow}>
            <Text style={s.barStar}>{row.stars}</Text>
            <Ionicons name="star" size={11} color={C.accent} />
            <ProgressBar value={row.percent} color={C.accent} height={6} style={s.bar} />
            <Text style={s.barCount}>{row.count}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

const ReviewRow = React.memo(function ReviewRow({ item, index, t, language, onReport }) {
  const entrance = useEntrance({ index, distance: 16 });

  const product = reviewProductName(item, language) || t('sellerReviews.productGone', 'A product you sold');
  const who = reviewBuyerName(item) || t('reviews.anonymous', 'A farmer');
  const word = ratingWord(item.rating);
  const day = reviewDay(item.createdAt);
  const stars = t('reviews.starLabel', { count: item.rating, defaultValue: '{{count}} of 5 stars' });

  return (
    <Animated.View style={entrance}>
      <Card style={s.row}>
        {/* The review reads as one item to a screen reader; Report sits
            outside it so it stays its own button. */}
        <View
          style={s.rowBody}
          accessible
          // One sentence per review instead of six fragments.
          accessibilityLabel={[product, stars, item.comment, who, day].filter(Boolean).join('. ')}
        >
          <Text style={s.product} numberOfLines={2}>{product}</Text>

          <View style={s.starRow}>
            <Stars value={item.rating} size={15} color={C.accent} />
            {word ? <Text style={s.word}>{t(word.key, word.fallback)}</Text> : null}
          </View>

          {item.comment
            ? <Text style={s.comment}>{item.comment}</Text>
            : <Text style={s.noComment}>{t('sellerReviews.noComment', 'No comment written')}</Text>}

          <View style={s.byRow}>
            <Ionicons name="person-circle-outline" size={15} color={C.textFaint} />
            <Text style={s.by} numberOfLines={1}>{[who, day].filter(Boolean).join(' · ')}</Text>
          </View>
        </View>

        {item.id != null ? (
          <PressableRow
            onPress={() => onReport(item.id)}
            accessibilityLabel={t('report.titleReview', 'Report review')}
            style={s.reportBtn}
          >
            <Ionicons name="flag-outline" size={14} color={C.textMuted} />
            <Text style={s.reportTxt}>{t('report.action', 'Report')}</Text>
          </PressableRow>
        ) : null}
      </Card>
    </Animated.View>
  );
});

// ── Screen ───────────────────────────────────────────────────────────────────

export default function SellerReviewsScreen({ navigation }) {
  const { t, language } = useLanguage();
  const { gutter, isExpanded, contentMaxWidth } = useResponsive();

  // Arrives with the first page only. A later page carries none, and must not
  // blank the card — see summaryFromResponse.
  const [summary, setSummary] = useState(null);

  const list = usePagedList({
    mode: 'cursor',
    limit: PAGE_SIZE,
    refetchOnFocus: true,
    errorFallback: t('sellerReviews.loadFailed', 'Could not load your reviews.'),
    fetchPage: useCallback(async ({ cursor, limit, signal }) => {
      const res = await api.get('/agristore/seller/reviews', {
        params: cursor ? { cursor, limit } : { limit },
        signal,
      });
      const fresh = summaryFromResponse(res);
      if (fresh) setSummary(fresh);
      return res;
    }, []),
  });

  const items = list.items;
  const view = summaryView(summary);

  // The review being reported (ReportSheet target), or null.
  const [reportTarget, setReportTarget] = useState(null);
  const openReport = useCallback((id) => {
    setReportTarget({ targetType: 'PRODUCT_REVIEW', targetId: String(id) });
  }, []);

  const renderItem = useCallback(({ item, index }) => (
    <ReviewRow item={item} index={index} t={t} language={language} onReport={openReport} />
  ), [t, language, openReport]);

  const keyExtractor = useCallback(
    (item, index) => (item?.id != null ? String(item.id) : `review-${index}`),
    [],
  );

  return (
    <Screen edges={['top', 'left', 'right']}>
      <AppHeader
        title={t('sellerReviews.title', 'Ratings & reviews')}
        subtitle={t('sellerReviews.subtitle', 'What buyers said after you delivered')}
        onBack={() => navigation.goBack()}
      />

      {list.isInitialLoading ? (
        <SkeletonList count={4} thumb={false} />
      ) : list.error && items.length === 0 ? (
        <ErrorState error={list.error} onRetry={list.retry} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={[
            { padding: gutter, flexGrow: 1, paddingBottom: SP.huge },
            isExpanded && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' },
          ]}
          refreshControl={
            <RefreshControl
              refreshing={list.refreshing}
              onRefresh={list.refresh}
              tintColor={C.brand}
              colors={[C.brand]}
            />
          }
          onEndReached={list.loadMore}
          onEndReachedThreshold={0.4}
          ListHeaderComponent={view ? <SummaryCard view={view} t={t} /> : null}
          ListFooterComponent={
            <ListFooter
              loading={list.loadingMore}
              error={list.moreError}
              onRetry={list.retryMore}
              hasMore={list.hasMore}
              itemCount={items.length}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="star-outline"
              title={t('sellerReviews.emptyTitle', 'No ratings yet')}
              body={t('sellerReviews.emptyBody', 'A buyer can rate you once you mark their order delivered. Their ratings will appear here.')}
            />
          }
          initialNumToRender={7}
          maxToRenderPerBatch={9}
          windowSize={9}
        />
      )}

      <ReportSheet target={reportTarget} onClose={() => setReportTarget(null)} />
    </Screen>
  );
}

const s = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'center', gap: SP.xl, marginBottom: SP.lg },
  avgCol: { alignItems: 'center', gap: SP.xs, minWidth: 84 },
  avg: { ...T.figure, color: C.text },
  avgCount: { ...T.caption, color: C.textMuted },
  bars: { flex: 1, gap: SP.xs },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: SP.xs },
  barStar: { ...T.captionBold, width: 12, color: C.textBody, textAlign: 'right' },
  bar: { flex: 1 },
  barCount: { ...T.caption, minWidth: 24, color: C.textMuted, textAlign: 'right' },

  row: { marginBottom: SP.lg, gap: SP.sm, borderRadius: R.xl },
  product: { ...T.subhead, color: C.text },
  starRow: { flexDirection: 'row', alignItems: 'center', gap: SP.sm },
  word: { ...T.labelBold, color: C.text },
  comment: { ...T.body, color: C.textBody },
  // Said, not left blank: an empty card reads as a review that failed to load.
  noComment: { ...T.caption, color: C.textFaint, fontStyle: 'italic' },
  byRow: { flexDirection: 'row', alignItems: 'center', gap: SP.xs },
  by: { ...T.caption, flex: 1, color: C.textFaint },

  rowBody: { gap: SP.sm },
  // Quiet on purpose — it is there when needed, not competing with the review.
  reportBtn: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', gap: SP.xs,
    minHeight: HIT.minCompact, paddingHorizontal: SP.md, borderRadius: R.pill,
  },
  reportTxt: { ...T.captionBold, color: C.textMuted },
});
