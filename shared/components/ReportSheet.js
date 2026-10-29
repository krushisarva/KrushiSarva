/**
 * ReportSheet — tell KrushiSarva that something in the app is wrong or abusive.
 *
 * Google Play requires an in-app way to report AI-generated answers (AI chat,
 * the voice assistant, a crop scan result) and content other people post (a
 * user in chat, a rental listing, a product review, a crop report a farmer
 * shared with their Krushi Seva Kendra). This is the one sheet all of those
 * open, in both apps: pick a reason, optionally say more, send.
 *
 * Lives in shared/ because the seller app needs it too. Each app wraps it once
 * (frontend/src/components/ReportSheet.js, seller-app/src/components/ReportSheet.js)
 * to pass `onThanks(title, message)` — its own way of saying thank you (the
 * farmer app's pop-up, the seller app's toast). Neither app uses system alerts.
 *
 * WHAT IT GUARANTEES
 *   - nothing is sent without a reason (the button is off until one is picked)
 *   - one send at a time — a double tap on "Send report" is one report
 *   - it cannot be closed mid-send, so a slow network cannot leave the person
 *     wondering whether the report went
 *   - a failure is shown INSIDE the sheet with the reason and text kept, so
 *     "try again" is one tap; being rate limited (429) says so in words
 *   - success closes the sheet and thanks the person through `onThanks`
 *
 * `target` is `{ targetType, targetId?, snapshot?, title? }`, or null when the
 * sheet is closed. One sheet serves a whole screen. `targetType` is one of the
 * server's REPORT_TARGET_TYPES; `snapshot` is a copy of the reported text (the
 * server needs it when there is no id to look the content up by).
 *
 * Server contract: POST /reports { targetType, targetId?, reason, details?, snapshot? }
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
import api from '@krushisarva/shared/services/api';

export const REPORT_MAX_DETAILS = 1000;
export const REPORT_MAX_SNAPSHOT = 4000;

/** The reasons the server accepts, in the order the person sees them. */
export const REPORT_REASONS = [
  { key: 'offensive',            tKey: 'report.reasonOffensive',  fallback: 'Offensive or hateful' },
  { key: 'harmful_or_dangerous', tKey: 'report.reasonHarmful',    fallback: 'Harmful or dangerous' },
  { key: 'wrong_information',    tKey: 'report.reasonWrong',      fallback: 'Wrong or misleading information' },
  { key: 'spam_or_fraud',        tKey: 'report.reasonSpam',       fallback: 'Spam or fraud' },
  { key: 'harassment',           tKey: 'report.reasonHarassment', fallback: 'Harassment or bullying' },
  { key: 'other',                tKey: 'report.reasonOther',      fallback: 'Something else' },
];

const AI_TYPES = new Set(['AI_MESSAGE', 'AI_VOICE_MESSAGE', 'AI_DIAGNOSIS']);

/** The sheet's heading for each kind of thing reported. */
const TITLES = {
  AI_MESSAGE:        { tKey: 'report.titleAnswer',     fallback: 'Report this answer' },
  AI_VOICE_MESSAGE:  { tKey: 'report.titleAnswer',     fallback: 'Report this answer' },
  AI_DIAGNOSIS:      { tKey: 'report.titleResult',     fallback: 'Report this result' },
  USER:              { tKey: 'report.titleUser',       fallback: 'Report user' },
  CHAT_MESSAGE:      { tKey: 'report.titleMessage',    fallback: 'Report message' },
  MACHINERY_LISTING: { tKey: 'report.titleListing',    fallback: 'Report listing' },
  LABOUR_LISTING:    { tKey: 'report.titleListing',    fallback: 'Report listing' },
  PRODUCT_REVIEW:    { tKey: 'report.titleReview',     fallback: 'Report review' },
  CROP_REPORT_SHARE: { tKey: 'report.titleCropReport', fallback: 'Report this crop report' },
  CROP_REPORT_REPLY: { tKey: 'report.titleKendraReply', fallback: 'Report this reply' },
};

/**
 * The request body, or null when there is nothing the server could act on
 * (no reason, or neither an id nor a copy of the text).
 */
export function reportPayload(target, reason, details) {
  if (!target?.targetType || !REPORT_REASONS.some((r) => r.key === reason)) return null;
  const body = { targetType: target.targetType, reason };
  const id = target.targetId != null ? String(target.targetId).trim() : '';
  if (id) body.targetId = id;
  const snapshot = typeof target.snapshot === 'string' ? target.snapshot.trim() : '';
  if (snapshot) body.snapshot = snapshot.slice(0, REPORT_MAX_SNAPSHOT);
  if (!body.targetId && !body.snapshot) return null;
  const extra = typeof details === 'string' ? details.trim() : '';
  if (extra) body.details = extra.slice(0, REPORT_MAX_DETAILS);
  return body;
}

/** POST /reports. Any 2xx is a success; throws the API client's error otherwise. */
export async function submitReport(body) {
  const { data } = await api.post('/reports', body);
  return data?.data ?? null;
}

/**
 * What a failed send says. 404 / 400 are answers, not connection trouble: the
 * item is gone, or it is the person's own. "Check your connection" would send
 * them retrying. A timeout or no response at all is connection trouble.
 */
function failureMessage(err, t) {
  const status = err?.code === 'ECONNABORTED' ? null : err?.response?.status;
  if (status === 429) return t('report.tooMany', 'You have sent many reports in a short time. Please try again later.');
  if (status === 404) return t('report.notFound', 'This is no longer available, so it cannot be reported.');
  if (status === 400 || status === 422) return t('report.notAllowed', 'This cannot be reported.');
  return t('report.failed', 'Could not send your report. Check your connection and try again.');
}

export default function ReportSheet({ target, onClose, onReported, onThanks }) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const [reason, setReason] = useState(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  // A ref as well as state: two taps inside one frame both see `sending` false.
  const sendingRef = useRef(false);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // A different thing reported is a fresh form.
  const targetKey = target
    ? `${target.targetType}|${target.targetId ?? ''}|${target.snapshot ?? ''}`
    : null;
  useEffect(() => {
    if (!targetKey) return;
    setReason(null);
    setDetails('');
    setError(null);
    setSending(false);
    sendingRef.current = false;
  }, [targetKey]);

  const close = () => { if (!sendingRef.current) onClose?.(); };

  async function send() {
    if (sendingRef.current || !target) return;
    const body = reportPayload(target, reason, details);
    if (!body) {
      setError(t('report.failed', 'Could not send your report. Check your connection and try again.'));
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      await submitReport(body);
      if (!alive.current) return;
      sendingRef.current = false;
      setSending(false);
      onReported?.(target, body);
      onClose?.();
      onThanks?.(
        t('report.thanksTitle', 'Thank you'),
        t('report.thanksBody', 'Your report has been sent. Our team will review it.'),
      );
    } catch (err) {
      if (!alive.current) return;
      sendingRef.current = false;
      setSending(false);
      setError(failureMessage(err, t));
    }
  }

  const heading = TITLES[target?.targetType] || { tKey: 'report.title', fallback: 'Report' };
  const title = target?.title || t(heading.tKey, heading.fallback);
  const subtitle = AI_TYPES.has(target?.targetType)
    ? t('report.subtitleAi', 'This was written by AI and can be wrong. Tell us what is wrong so our team can check it.')
    : t('report.subtitle', 'Tell us what is wrong. Our team reviews every report.');

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
                <View style={s.headIcon}>
                  <Ionicons name="flag-outline" size={18} color={COLORS.error} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.title} accessibilityRole="header">{title}</Text>
                  <Text style={s.subtitle}>{subtitle}</Text>
                </View>
                <TouchableOpacity
                  onPress={close}
                  disabled={sending}
                  style={s.closeBtn}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('report.close', 'Close')}
                  testID="report-close"
                >
                  <Ionicons name="close" size={22} color={COLORS.textMedium} />
                </TouchableOpacity>
              </View>

              <View accessibilityRole="radiogroup" style={s.reasons}>
                {REPORT_REASONS.map((r) => {
                  const on = r.key === reason;
                  return (
                    <TouchableOpacity
                      key={r.key}
                      style={[s.reasonRow, on && s.reasonRowOn]}
                      onPress={() => { setReason(r.key); setError(null); }}
                      disabled={sending}
                      activeOpacity={0.7}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on, disabled: sending }}
                      // react-native-web ignores accessibilityState.checked.
                      aria-checked={on}
                      accessibilityLabel={t(r.tKey, r.fallback)}
                      testID={`report-reason-${r.key}`}
                    >
                      <Ionicons
                        name={on ? 'radio-button-on' : 'radio-button-off'}
                        size={22}
                        color={on ? COLORS.primary : COLORS.textLight}
                      />
                      <Text style={[s.reasonTxt, on && s.reasonTxtOn]}>{t(r.tKey, r.fallback)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={s.label}>{t('report.detailsLabel', 'More details (optional)')}</Text>
              <TextInput
                style={s.input}
                value={details}
                onChangeText={setDetails}
                editable={!sending}
                multiline
                maxLength={REPORT_MAX_DETAILS}
                placeholder={t('report.detailsPlaceholder', 'What happened?')}
                placeholderTextColor={COLORS.textLight}
                textAlignVertical="top"
                accessibilityLabel={t('report.detailsLabel', 'More details (optional)')}
                testID="report-details"
              />
              <Text style={s.counter}>{details.length}/{REPORT_MAX_DETAILS}</Text>

              {error ? (
                <View style={s.errorRow} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                  <Ionicons name="alert-circle" size={16} color={COLORS.error} />
                  <Text style={s.errorTxt}>{error}</Text>
                </View>
              ) : null}

              <TouchableOpacity
                style={[s.sendBtn, (!reason || sending) && s.sendBtnOff]}
                onPress={send}
                disabled={!reason || sending}
                accessibilityRole="button"
                accessibilityState={{ disabled: !reason || sending, busy: sending }}
                testID="report-send"
              >
                {sending
                  ? <ActivityIndicator size="small" color={COLORS.white} />
                  : <Text style={s.sendTxt}>{t('report.send', 'Send report')}</Text>}
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
    maxHeight: '90%',
  },

  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headIcon: {
    width: 36, height: 36, borderRadius: 18, marginTop: 2,
    backgroundColor: COLORS.error + '14', justifyContent: 'center', alignItems: 'center',
  },
  title: { fontSize: 18, fontWeight: '700', color: COLORS.textDark },
  subtitle: { fontSize: 13, color: COLORS.textMedium, marginTop: 4, lineHeight: 18 },
  closeBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },

  reasons: { marginTop: 12 },
  // 48dp rows: the reasons are what everyone must be able to hit.
  reasonRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    minHeight: 48, paddingVertical: 10, paddingHorizontal: 10,
    borderRadius: 12, borderWidth: 1, borderColor: 'transparent',
  },
  reasonRowOn: { backgroundColor: COLORS.primaryPale, borderColor: COLORS.primary + '55' },
  reasonTxt: { flex: 1, fontSize: 15, color: COLORS.textDark, fontWeight: '500' },
  reasonTxtOn: { fontWeight: '700' },

  label: { fontSize: 13, fontWeight: '600', color: COLORS.textBody, marginTop: 14, marginBottom: 6 },
  input: {
    minHeight: 80, maxHeight: 140,
    borderWidth: 1, borderColor: COLORS.borderMedium, borderRadius: 12,
    backgroundColor: COLORS.inputBg,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 15, lineHeight: 21, color: COLORS.textDark,
  },
  counter: { alignSelf: 'flex-end', fontSize: 11, color: COLORS.textMedium, marginTop: 4 },

  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 10 },
  errorTxt: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600', color: COLORS.error },

  sendBtn: {
    minHeight: 50, borderRadius: 14, marginTop: 14,
    backgroundColor: COLORS.primary, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 16,
  },
  sendBtnOff: { opacity: 0.45 },
  sendTxt: { fontSize: 16, fontWeight: '700', color: COLORS.white },
});
