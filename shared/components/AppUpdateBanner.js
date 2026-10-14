/**
 * AppUpdateBanner — the "new version available" strip at the top of the app.
 *
 * Mount it ONCE per app, as the last child of the provider tree (inside
 * SafeAreaProvider + LanguageProvider) so it floats over every screen. All
 * state comes from useAppUpdate(), the same store the Profile → App version row
 * reads, so the two can never disagree. It renders nothing unless that store
 * says bannerVisible.
 *
 * Variants, by status:
 *   available    "New version available"   [Update now]        [Later]
 *   ready        "New version available"   [Restart to update] [Later]
 *                (already downloaded; one restart applies it)
 *   downloading  spinner + "Updating… 42%"                     [Later]
 *                (restarts when done, unless Later was tapped)
 *   error        "Couldn't update…"        [Try again]         [Later]
 *
 * Every variant has Later, so the card never sits over a screen's header with
 * no way to move it. Only the card takes taps: the full-width wrapper is
 * pointerEvents="box-none".
 *
 * Stacking: zIndex only, NO elevation. On Android elevation outranks zIndex
 * between siblings, so an elevated wrapper would draw over the seller app's
 * toasts (zIndex 9999, no elevation) while they still took the taps. With
 * zIndex 9000 a transient heads-up (those toasts, the farmer InAppChatBanner)
 * slides over this persistent strip, not under it.
 *
 * Props (both optional, for an app with its own look — the seller app):
 *   palette       { accent, card, border, warn } colours
 *   ActionButton  component taking { title, primary, loading, onPress }
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, AccessibilityInfo } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KHET, KSPACE, KRADIUS, KELEV, KICON, KBORDER } from '../constants/khetTheme';
import { useLanguage } from '../context/LanguageContext';
import { useAppUpdate } from '../hooks/useAppUpdate';
import Button from './ui/Button';
import Text from './ui/Text';

const KHET_PALETTE = { accent: KHET.primary, card: KHET.card, border: KHET.border, warn: KHET.warningInk };

// md = 44dp, the shared Button's tap minimum. Labels may take two lines.
function KhetActionButton({ title, primary, loading, onPress }) {
  return (
    <Button title={title} size="md" tone={primary ? 'primary' : 'ghost'} loading={loading} onPress={onPress} style={s.action} />
  );
}

export default function AppUpdateBanner({ palette, ActionButton = KhetActionButton }) {
  const { status, progress, restarting, bannerVisible, updateNow, dismiss } = useAppUpdate();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const p = palette ? { ...KHET_PALETTE, ...palette } : KHET_PALETTE;
  // Guards the gap between the tap and the store moving on (two taps landing
  // before a re-render would both read busy=false). The store itself refuses a
  // second restart once reloadAsync has been accepted.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const onUpdate = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    // updateNow never throws by contract; the catch is belt and braces so a
    // broken store cannot surface as an unhandled rejection from a banner.
    Promise.resolve()
      .then(updateNow)
      .catch(() => {})
      .finally(() => { inFlight.current = false; setBusy(false); });
  }, [updateNow]);

  let message = null;
  let announce = null;
  if (status === 'available' || status === 'ready') {
    message = t('appUpdate.available', 'New version available');
    announce = t('appUpdate.bannerA11y', 'A new version of the app is available');
  } else if (status === 'downloading') {
    message = t('appUpdate.updating', 'Updating…');
    announce = message;
  } else if (status === 'error') {
    message = t('appUpdate.failed', "Couldn't update. Check your internet.");
    announce = message;
  }

  // A live region announces changes to a node that already exists, not one
  // that just mounted, and iOS ignores it. Say each variant once, as it
  // appears, and never the percentage (it changes on every progress tick).
  const said = bannerVisible ? announce : null;
  useEffect(() => {
    if (!said) return;
    try { AccessibilityInfo.announceForAccessibility?.(said); } catch { /* no screen reader API */ }
  }, [said]);

  if (!bannerVisible || !message) return null; // only ever visible for the four statuses above

  const later = t('appUpdate.later', 'Later');
  let icon;
  let action = null;
  let shown = message;
  if (status === 'available' || status === 'ready') {
    icon = <Ionicons name="arrow-up-circle" size={KICON.lg} color={p.accent} />;
    action = status === 'ready'
      ? t('appUpdate.restartToUpdate', 'Restart to update')
      : t('appUpdate.updateNow', 'Update now');
  } else if (status === 'downloading') {
    icon = <ActivityIndicator size="small" color={p.accent} />;
    const pct = typeof progress === 'number' && Number.isFinite(progress)
      ? Math.max(0, Math.min(100, Math.round(progress * 100)))
      : null;
    if (pct != null) shown = `${message} ${pct}%`;
  } else {
    icon = <Ionicons name="warning-outline" size={KICON.lg} color={p.warn} />;
    action = t('appUpdate.retry', 'Try again');
  }

  return (
    <View pointerEvents="box-none" style={[s.wrap, { paddingTop: insets.top + KSPACE.s6 }]}>
      <View style={[s.card, { backgroundColor: p.card, borderColor: p.border }]}>
        {/* The label stays fixed while the percentage moves. */}
        <View style={s.row} accessible accessibilityRole="alert" accessibilityLabel={announce}>
          <View style={s.icon}>{icon}</View>
          <Text role="bodyBold" lead tone="default" numberOfLines={2} style={s.message}>
            {shown}
          </Text>
        </View>
        <View style={s.actions}>
          {action ? (
            <ActionButton title={action} primary loading={busy || !!restarting} onPress={onUpdate} />
          ) : null}
          <ActionButton title={later} primary={false} loading={false} onPress={dismiss} />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute', top: 0, left: 0, right: 0,
    paddingHorizontal: KSPACE.s10, zIndex: 9000,
  },
  card: {
    borderRadius: KRADIUS.r14,
    borderWidth: KBORDER.hairline,
    paddingVertical: KSPACE.s10, paddingHorizontal: KSPACE.s12,
    gap: KSPACE.s8,
    ...KELEV.e3,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: KSPACE.s10 },
  icon: { width: KICON.lg, alignItems: 'center' },
  message: { flex: 1 },
  // Indented under the message, past the icon, as in the approved mock. Wraps,
  // so a long label or a large OS font size cannot push Later off the card.
  actions: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
    columnGap: KSPACE.s8, rowGap: KSPACE.s6, paddingLeft: KICON.lg + KSPACE.s10,
  },
  action: { maxWidth: '100%' },
});
