/**
 * ReviewSheet — rate a product you have received.
 *
 * Opened from My Orders on a delivered line. Five big stars, an optional
 * comment, one button. That is the whole job: a farmer who taps four stars and
 * "Post" has left a useful review without typing a word.
 *
 * WHAT IT GUARANTEES
 *   - nothing is posted without a star rating (the button is off until one is
 *     tapped), and nothing longer than the server accepts can be typed
 *   - one save at a time — a double tap on "Post" is one review
 *   - it cannot be closed mid-save, so a slow network cannot leave the farmer
 *     wondering whether the review went
 *   - a failure is shown INSIDE the sheet, with what was typed still there. Not
 *     as a pop-up: the thing to fix (or retry) is right here
 *   - opening it for a line already rated shows that rating and comment, and
 *     saving EDITS the review — the server keeps one review per order line
 *
 * `target` is `{ orderId, orderItemId, productId, name, review }`, or null when
 * the sheet is closed. One sheet serves the whole orders list.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '@krushisarva/shared/constants/colors';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import { submitReview } from '../screens/AgriStore/shopClient';
import {
  REVIEW_MAX_COMMENT, STAR_VALUES, ratingWord, reviewPayload,
} from '../screens/AgriStore/reviewUtils';

export default function ReviewSheet({ target, onClose, onSaved }) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // A different line is a fresh form, opened on what that line already has.
  const lineId = target?.orderItemId || null;
  useEffect(() => {
    if (!lineId) return;
    setRating(target?.review?.rating || 0);
    setComment(target?.review?.comment || '');
    setError(null);
    setSaving(false);
    // Keyed on the line alone: `target` is a new object on every open, and
    // re-running on it would wipe what the farmer is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId]);

  const editing = !!target?.review;
  const word = ratingWord(rating);
  const close = () => { if (!saving) onClose?.(); };

  async function save() {
    if (saving || !target) return;
    const payload = reviewPayload({ rating, comment, orderItemId: target.orderItemId });
    if (!payload) {
      setError(t('reviews.pickStars', 'Tap a star to give your rating.'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await submitReview(target.productId, payload);
      if (!alive.current) return;
      // The SERVER's copy where it sent one — it strips markup from the comment.
      onSaved?.(target, {
        rating: saved?.rating ?? payload.rating,
        comment: saved ? saved.comment ?? null : payload.comment ?? null,
      });
    } catch (err) {
      if (!alive.current) return;
      // `userMessage` is the API client's sanitised text — e.g. the server's
      // "You can only review a product you have received."
      setError(err?.userMessage || t('reviews.failed', 'Could not save your review. Check your connection and try again.'));
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  return (
    <Modal
      visible={!!target}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={close}
    >
      <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable
          style={s.backdrop}
          onPress={close}
          accessible={false}
          importantForAccessibility="no"
        />

        {target ? (
          <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]} accessibilityViewIsModal>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={s.head}>
                <View style={{ flex: 1 }}>
                  <Text style={s.title} accessibilityRole="header">
                    {editing ? t('reviews.sheetEditTitle', 'Change your rating') : t('reviews.sheetTitle', 'Rate this product')}
                  </Text>
                  {target.name ? <Text style={s.product} numberOfLines={2}>{target.name}</Text> : null}
                </View>
                <TouchableOpacity
                  onPress={close}
                  disabled={saving}
                  style={s.closeBtn}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('reviews.close', 'Close')}
                >
                  <Ionicons name="close" size={22} color={COLORS.textMedium} />
                </TouchableOpacity>
              </View>

              <View style={s.stars} accessibilityRole="radiogroup">
                {STAR_VALUES.map((star) => {
                  const on = star <= rating;
                  const starWord = ratingWord(star);
                  return (
                    <TouchableOpacity
                      key={star}
                      style={s.starBtn}
                      onPress={() => { setRating(star); setError(null); }}
                      disabled={saving}
                      activeOpacity={0.7}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: star === rating, disabled: saving }}
                      // react-native-web ignores accessibilityState.checked, so a
                      // browser's screen reader would never hear which star is on.
                      aria-checked={star === rating}
                      accessibilityLabel={`${t('reviews.starLabel', { count: star, defaultValue: '{{count}} of 5 stars' })}, ${t(starWord.key, starWord.fallback)}`}
                      testID={`review-star-${star}`}
                    >
                      <Ionicons name={on ? 'star' : 'star-outline'} size={38} color={on ? COLORS.gold : COLORS.textLight} />
                    </TouchableOpacity>
                  );
                })}
              </View>
              {/* The word for the stars: nobody should have to count them. */}
              <Text style={[s.word, !word && s.wordHint]} accessibilityLiveRegion="polite">
                {word ? t(word.key, word.fallback) : t('reviews.tapStars', 'Tap a star to rate')}
              </Text>

              <Text style={s.label}>{t('reviews.commentLabel', 'Tell other farmers about it (optional)')}</Text>
              <TextInput
                style={s.input}
                value={comment}
                onChangeText={setComment}
                editable={!saving}
                multiline
                maxLength={REVIEW_MAX_COMMENT}
                placeholder={t('reviews.commentPlaceholder', 'How was the quality? Did it work in your field?')}
                placeholderTextColor={COLORS.textLight}
                textAlignVertical="top"
                accessibilityLabel={t('reviews.commentLabel', 'Tell other farmers about it (optional)')}
                testID="review-comment"
              />
              <Text style={s.counter}>{comment.length}/{REVIEW_MAX_COMMENT}</Text>

              {error ? (
                <View style={s.errorRow} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                  <Ionicons name="alert-circle" size={16} color={COLORS.error} />
                  <Text style={s.errorTxt}>{error}</Text>
                </View>
              ) : null}

              <TouchableOpacity
                style={[s.saveBtn, (!rating || saving) && s.saveBtnOff]}
                onPress={save}
                disabled={!rating || saving}
                accessibilityRole="button"
                accessibilityState={{ disabled: !rating || saving, busy: saving }}
                testID="review-save"
              >
                {saving
                  ? <ActivityIndicator size="small" color={COLORS.white} />
                  : (
                    <Text style={s.saveTxt}>
                      {editing ? t('reviews.update', 'Save changes') : t('reviews.submit', 'Post review')}
                    </Text>
                  )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 18, paddingTop: 16,
    maxHeight: '88%',
  },

  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  title: { fontSize: 18, fontWeight: '700', color: COLORS.textDark },
  product: { fontSize: 13, color: COLORS.textMedium, marginTop: 4, lineHeight: 18 },
  closeBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },

  // 56dp squares: the stars are the one thing on this sheet everyone must hit.
  stars: { flexDirection: 'row', justifyContent: 'center', marginTop: 14 },
  starBtn: { width: 56, height: 56, justifyContent: 'center', alignItems: 'center' },
  word: { textAlign: 'center', fontSize: 15, fontWeight: '700', color: COLORS.textDark, marginTop: 2, minHeight: 22 },
  wordHint: { fontWeight: '500', color: COLORS.textMedium },

  label: { fontSize: 13, fontWeight: '600', color: COLORS.textBody, marginTop: 16, marginBottom: 6 },
  input: {
    minHeight: 96, maxHeight: 160,
    borderWidth: 1, borderColor: COLORS.borderMedium, borderRadius: 12,
    backgroundColor: COLORS.inputBg,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 15, lineHeight: 21, color: COLORS.textDark,
  },
  counter: { alignSelf: 'flex-end', fontSize: 11, color: COLORS.textMedium, marginTop: 4 },

  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 10 },
  errorTxt: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600', color: COLORS.error },

  saveBtn: {
    minHeight: 50, borderRadius: 14, marginTop: 14,
    backgroundColor: COLORS.primary, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 16,
  },
  saveBtnOff: { opacity: 0.45 },
  saveTxt: { fontSize: 16, fontWeight: '700', color: COLORS.white },
});
