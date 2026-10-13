/**
 * ProductReviews — what other buyers said, on the product page.
 *
 * The product page showed "4.2 ★ (37 ratings)" and nothing behind it: the list
 * of reviews was fetchable (shopClient.fetchReviews) and no screen ever asked.
 * A number with no words is not much to go on when the choice is which
 * fungicide to put on a crop.
 *
 *   - the average, how many rated, and how the stars split
 *   - the reviews themselves, five at a time, newest first, with "Show more"
 *   - every one is a verified purchase — the server only accepts a review
 *     against a delivered order line
 *
 * NO REQUEST when the product has no ratings. Today that is almost every
 * product, and the page already knows (`ratingCount` rides on the product), so
 * the common case costs nothing and shows one line saying how reviews appear.
 *
 * Writing a review is not here. It is on My Orders, against the delivered
 * line — that is the only place the server will accept one from.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SHADOWS } from '@krushisarva/shared/constants/colors';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import Stars from '@krushisarva/shared/components/Stars';
import { classifyError } from './shopUtils';
import { fetchReviews } from './shopClient';
import {
  distributionRows, mergeReviewPages, ratingWord, reviewDay, reviewerFirstName,
} from './reviewUtils';

const PAGE = 5;

export default function ProductReviews({ productId, ratingCount }) {
  const { t } = useLanguage();
  const hasAny = Number(ratingCount) > 0;

  const [reviews, setReviews] = useState([]);
  const [summary, setSummary] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(hasAny);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);

  // The request this component last issued. A newer one, or leaving the page,
  // aborts it — so a slow first page can never land on top of another product.
  const inFlight = useRef(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const load = useCallback(async (from) => {
    inFlight.current?.abort();
    const ctl = new AbortController();
    inFlight.current = ctl;
    if (from) setLoadingMore(true); else { setLoading(true); setFailed(false); }
    try {
      const page = await fetchReviews(productId, { cursor: from, limit: PAGE }, ctl.signal);
      if (ctl.signal.aborted) return;
      setReviews((prev) => (from ? mergeReviewPages(prev, page.reviews) : mergeReviewPages([], page.reviews)));
      if (page.summary) setSummary(page.summary);
      setCursor(page.meta?.hasMore ? page.meta?.nextCursor || null : null);
    } catch (err) {
      // classifyError answers null for a request this component aborted itself.
      if (ctl.signal.aborted || !classifyError(err)) return;
      // A failed "show more" leaves what is already on screen alone.
      if (!from) setFailed(true);
    } finally {
      if (!ctl.signal.aborted) { setLoading(false); setLoadingMore(false); }
    }
  }, [productId]);

  useEffect(() => {
    setReviews([]); setSummary(null); setCursor(null); setFailed(false);
    if (!productId || !hasAny) { setLoading(false); return; }
    load(null);
  }, [productId, hasAny, load]);

  const average = Number(summary?.average) || 0;
  const count = Number(summary?.count) || 0;

  return (
    <View style={s.card}>
      <View style={s.head}>
        <View style={s.iconCircle}>
          <Ionicons name="star-outline" size={16} color={COLORS.primary} />
        </View>
        <Text style={s.title} accessibilityRole="header">{t('reviews.sectionTitle', 'Ratings & reviews')}</Text>
      </View>

      {!hasAny ? (
        <Text style={s.empty}>
          {t('reviews.noReviews', 'No reviews yet. Buyers can rate this product after it is delivered.')}
        </Text>
      ) : loading ? (
        <ActivityIndicator color={COLORS.primary} style={s.spinner} accessibilityLabel={t('loading', 'Loading...')} />
      ) : failed ? (
        <View style={s.failed}>
          <Text style={s.empty}>{t('reviews.loadFailed', 'Could not load the reviews.')}</Text>
          <TouchableOpacity style={s.moreBtn} onPress={() => load(null)} accessibilityRole="button">
            <Text style={s.moreTxt}>{t('reviews.retry', 'Try again')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {count > 0 ? (
            <View
              style={s.summary}
              accessible
              accessibilityLabel={t('reviews.a11ySummary', {
                rating: average.toFixed(1), count,
                defaultValue: 'Rated {{rating}} out of 5 by {{count}} buyers',
              })}
            >
              <View style={s.avgCol}>
                <Text style={s.avg}>{average.toFixed(1)}</Text>
                <Stars value={average} size={14} />
                <Text style={s.avgCount}>
                  {t('product.ratingsLabel', { count, defaultValue: '{{count}} ratings' })}
                </Text>
              </View>
              <View style={s.bars}>
                {distributionRows(summary).map((row) => (
                  <View key={row.stars} style={s.barRow}>
                    <Text style={s.barStar}>{row.stars}</Text>
                    <Ionicons name="star" size={10} color={COLORS.gold} />
                    <View style={s.barTrack}>
                      <View style={[s.barFill, { width: `${row.percent}%` }]} />
                    </View>
                    <Text style={s.barCount}>{row.count}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {reviews.map((r) => {
            const word = ratingWord(r.rating);
            const who = reviewerFirstName(r.user) || t('reviews.anonymous', 'A farmer');
            const day = reviewDay(r.createdAt);
            return (
              <View
                key={r.id}
                style={s.review}
                accessible
                accessibilityLabel={[
                  who,
                  t('reviews.starLabel', { count: r.rating, defaultValue: '{{count}} of 5 stars' }),
                  r.comment,
                ].filter(Boolean).join('. ')}
              >
                <View style={s.reviewHead}>
                  <Stars value={r.rating} size={13} />
                  {word ? <Text style={s.reviewWord}>{t(word.key, word.fallback)}</Text> : null}
                </View>
                {r.comment ? <Text style={s.comment}>{r.comment}</Text> : null}
                <View style={s.byRow}>
                  <Text style={s.by} numberOfLines={1}>{[who, day].filter(Boolean).join(' · ')}</Text>
                  {r.verifiedPurchase ? (
                    <View style={s.verified}>
                      <Ionicons name="checkmark-circle" size={12} color={COLORS.primary} />
                      <Text style={s.verifiedTxt}>{t('reviews.verified', 'Verified purchase')}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            );
          })}

          {cursor ? (
            <TouchableOpacity
              style={s.moreBtn}
              onPress={() => load(cursor)}
              disabled={loadingMore}
              accessibilityRole="button"
              accessibilityState={{ busy: loadingMore }}
            >
              {loadingMore
                ? <ActivityIndicator size="small" color={COLORS.primary} />
                : <Text style={s.moreTxt}>{t('reviews.showMore', 'Show more reviews')}</Text>}
            </TouchableOpacity>
          ) : null}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  // The same card as the collapsible sections it sits under on ProductDetail.
  card: {
    backgroundColor: COLORS.surface, borderRadius: 14, padding: 14,
    ...SHADOWS.small,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  iconCircle: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: COLORS.primaryPale, justifyContent: 'center', alignItems: 'center',
  },
  title: { fontSize: 15, fontWeight: '700', color: COLORS.textDark },

  empty: { fontSize: 13, lineHeight: 19, color: COLORS.textMedium },
  spinner: { marginVertical: 16 },
  failed: { gap: 10 },

  summary: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    paddingBottom: 12, marginBottom: 4,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  avgCol: { alignItems: 'center', gap: 3, minWidth: 76 },
  avg: { fontSize: 30, fontWeight: '800', color: COLORS.textDark, lineHeight: 34 },
  avgCount: { fontSize: 11, color: COLORS.textMedium, marginTop: 1 },
  bars: { flex: 1, gap: 4 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  barStar: { width: 10, fontSize: 11, fontWeight: '600', color: COLORS.textBody, textAlign: 'right' },
  barTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: COLORS.grayBg, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3, backgroundColor: COLORS.gold },
  barCount: { minWidth: 22, fontSize: 11, color: COLORS.textMedium, textAlign: 'right' },

  review: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 5 },
  reviewHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reviewWord: { fontSize: 13, fontWeight: '700', color: COLORS.textDark },
  comment: { fontSize: 14, lineHeight: 20, color: COLORS.textBody },
  byRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  by: { flex: 1, fontSize: 12, color: COLORS.textMedium },
  verified: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  verifiedTxt: { fontSize: 11, fontWeight: '600', color: COLORS.primary },

  moreBtn: {
    minHeight: 44, marginTop: 10, borderRadius: 10,
    borderWidth: 1, borderColor: COLORS.primary,
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14,
  },
  moreTxt: { fontSize: 13, fontWeight: '700', color: COLORS.primary },
});
