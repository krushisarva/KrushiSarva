/**
 * SellerProfileScreen — account overview and settings.
 *
 * Same endpoint (`PUT /users/me` with the display name) and same navigation
 * targets.
 *
 * THE COMPOSITION
 * ---------------
 * The old screen led with a full-bleed orange gradient, a pulsing halo around
 * the avatar and a centred name — the visual language of a social profile,
 * applied to what is actually a business account page. It now leads the way a
 * letterhead does: identity on the left, ruled off from the content below,
 * with the completion meter as the first thing under the rule because it is
 * the only thing on this screen that has an action attached to it.
 *
 * Settings are grouped into ruled cards under tracked eyebrows rather than
 * floating in a single long list, so "account", "business" and "legal" are
 * separable at a glance — which matters because the business group is the one
 * that gates getting paid.
 *
 * WHAT THE BEHAVIOUR STILL GUARANTEES
 *   - The Terms and Privacy rows had `onPress={() => {}}`. They looked
 *     tappable, had a chevron, and did nothing. They open the real documents
 *     (and say so when there is no browser to open them in).
 *   - The avatar's halo ran an unbounded `Animated.loop` for the lifetime of
 *     the screen, foreground or not. The halo is gone entirely: it was
 *     decoration around a static initial, and deleting it is cheaper than
 *     making it correct.
 *   - The completion figure double-counted: it read `user.bankAccountNumber`,
 *     which is never present (bank fields live under `user.sellerProfile`), so
 *     a fully-onboarded seller was permanently shown as incomplete.
 *   - Name editing has a length limit, trim feedback, and reports failures
 *     through a toast rather than an Alert that is invisible on web.
 *   - KYC status read `user.kycStatus === 'verified'`, but the API sends the
 *     uppercase enum, so every seller — verified or not — was shown "Pending".
 *     A rejected seller also saw "Pending", with no reason and no way to act.
 *     The row now shows all four states and opens the form to fix a rejection.
 *   - A GST number showed a "Verified" badge. Nobody verifies GST numbers; it
 *     says "Added", like the bank row.
 *   - Straight after an OTP login this screen had only the login response to
 *     read, so a fully set-up seller saw "Not added" everywhere. Business rows
 *     now wait for the full profile (useProfileSync) instead of guessing.
 *   - Completion is the same ten-field figure the business profile form and
 *     the API compute; this screen counted eight, so the two screens disagreed.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@krushisarva/shared/context/AuthContext';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import api, { safeErrorMessage } from '@krushisarva/shared/services/api';
import { BUSINESS_TYPES } from '@krushisarva/shared/constants/locations';

import { C, E, HIT, R, SP, T, alpha, kycStatusMeta, useResponsive } from '../theme';
import { useNetwork } from '../hooks/useNetwork';
import useProfileSync, { noteProfileWrite } from '../hooks/useProfileSync';
import { NAME_MAX, NAME_MIN, completionFromUser, kycState } from '../utils/businessProfile';
import {
  Screen, Button, IconButton, PressableRow, TextField, Rule,
  Card, Avatar, Badge, ProgressBar, Skeleton, InlineNotice, useConfirm, useToast,
} from '../components/ui';

const TERMS_URL = 'https://cropsetu.app/terms';
const PRIVACY_URL = 'https://cropsetu.app/privacy';

// ── Row ──────────────────────────────────────────────────────────────────────

/** `loading` holds the row's place while the full profile is still arriving. */
function Row({ icon, label, value, onPress, badge, hint, last, loading }) {
  return (
    <PressableRow
      onPress={loading ? undefined : onPress}
      accessibilityLabel={value && !loading ? `${label}: ${value}` : label}
      accessibilityHint={hint}
      style={[r.row, !last && r.rowRuled]}
    >
      <View style={r.rowIcon}>
        <Ionicons name={icon} size={18} color={C.brandInk} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={r.rowLabel} numberOfLines={1}>{label}</Text>
        {loading ? (
          <Skeleton width="55%" height={12} style={{ marginTop: SP.xs }} />
        ) : value ? (
          <Text style={r.rowValue} numberOfLines={3}>{value}</Text>
        ) : null}
      </View>
      {loading ? null : badge ? (
        <Badge label={badge.text} color={badge.color} icon={badge.icon} />
      ) : onPress ? (
        <Ionicons name="chevron-forward" size={18} color={C.textFaint} />
      ) : null}
    </PressableRow>
  );
}

function SectionCard({ title, children }) {
  return (
    <View style={r.section}>
      <Text style={r.sectionTitle} accessibilityRole="header">{title}</Text>
      <Card padded={false}>{children}</Card>
    </View>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function SellerProfileScreen({ navigation }) {
  const { user, logout, updateUser } = useAuth();
  const { t } = useLanguage();
  const toast = useToast();
  const confirm = useConfirm();
  const { isOffline, recheck } = useNetwork();
  const { gutter, isExpanded, contentMaxWidth } = useResponsive();
  const { hydrated, syncing, error: syncError, retry: retrySync } = useProfileSync();
  const loading = !hydrated;

  const [editMode, setEditMode] = useState(false);
  const [name, setName] = useState(user?.name || '');
  const [nameError, setNameError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Tapping "edit" should put the cursor in the box, not make the seller tap
  // a second time to find it.
  const nameInputRef = useRef(null);
  useEffect(() => {
    if (editMode) nameInputRef.current?.focus?.();
  }, [editMode]);

  const completion = completionFromUser(user);
  const completionColor = completion >= 80 ? C.success : completion >= 50 ? C.warning : C.danger;

  const bizType = useMemo(
    () => BUSINESS_TYPES.find((b) => b.key === user?.businessType),
    [user?.businessType],
  );
  const bizTypeLabel = bizType ? t('biz.' + bizType.tKey, bizType.label) : t('notSet', 'Not set');

  const locationStr = [user?.village, user?.taluka, user?.district].filter(Boolean).join(', ') || null;

  const kyc = kycState(user);
  const kycMeta = kycStatusMeta(kyc.key);
  const kycValue = kyc.key === 'verified'
    ? t('sellerProfile.verified', 'Verified')
    : kyc.key === 'pending'
      ? t('sellerProfile.pendingVerification', 'Pending verification')
      : kyc.key === 'rejected'
        ? (kyc.reason
          ? t('sellerProfile.kycRejectedValue', { reason: kyc.reason, defaultValue: 'Rejected: {{reason}}' })
          : t('sellerProfile.kycRejectedNoReason', 'Rejected — tap to update your details'))
        : t('sellerProfile.kycNotSubmittedValue', 'Not submitted — tap to add Aadhaar or PAN');

  const startEdit = useCallback(() => {
    setName(user?.name || '');
    setNameError(null);
    setEditMode(true);
  }, [user?.name]);

  const cancelEdit = useCallback(() => {
    setName(user?.name || '');
    setNameError(null);
    setEditMode(false);
  }, [user?.name]);

  const handleSaveName = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t('sellerProfile.nameRequired', 'Please enter your name.'));
      return;
    }
    // The API refuses a one-letter name with a generic "Invalid request".
    if (trimmed.length < NAME_MIN) {
      setNameError(t('sellerProfile.nameTooShort', 'Name must have at least 2 letters.'));
      return;
    }
    if (trimmed === (user?.name || '')) {
      setEditMode(false);
      return;
    }
    setSaving(true);
    try {
      if (isOffline && !(await recheck())) {
        toast.warning(t('common.offlineAction', 'You are offline. Reconnect to save this.'));
        return;
      }
      const { data } = await api.put('/users/me', { name: trimmed });
      noteProfileWrite();
      updateUser(data.data);
      setEditMode(false);
      toast.success(t('sellerProfile.nameUpdated', 'Name updated'));
    } catch (e) {
      const message = safeErrorMessage(e, t('sellerProfile.updateError', 'Could not update your name.'));
      setNameError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [name, user?.name, isOffline, recheck, toast, t, updateUser]);

  const handleLogout = useCallback(async () => {
    const ok = await confirm({
      title: t('logout', 'Log out'),
      message: t('logoutConfirm', 'Are you sure you want to log out?'),
      confirmLabel: t('logout', 'Log out'),
      cancelLabel: t('cancel', 'Cancel'),
      destructive: true,
      icon: 'log-out-outline',
    });
    if (ok) logout();
  }, [confirm, logout, t]);

  // A URL that can't be opened (no browser, blocked scheme) should say so
  // rather than doing nothing — the failure mode the old empty handlers had.
  const openUrl = useCallback(async (url) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (!supported) throw new Error('unsupported');
      await Linking.openURL(url);
    } catch {
      toast.error(t('common.linkFailed', 'Could not open the link on this device.'));
    }
  }, [toast, t]);

  const showHelp = useCallback(() => {
    confirm({
      title: t('sellerProfile.helpCenter', 'Help centre'),
      message: t('sellerProfile.helpMsg'),
      confirmLabel: t('common.gotIt', 'Got it'),
      cancelLabel: t('cancel', 'Cancel'),
      icon: 'help-circle-outline',
    });
  }, [confirm, t]);

  const constrain = isExpanded && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' };

  return (
    <Screen edges={['top', 'left', 'right']} background={C.bgAlt}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: SP.huge }}
      >
        <View style={[{ paddingHorizontal: gutter }, constrain]}>
          {/* ── Identity ── */}
          <View style={sp.header}>
            {editMode ? (
              <View style={sp.editWrap}>
                <TextField
                  ref={nameInputRef}
                  value={name}
                  onChangeText={(v) => { setName(v); if (nameError) setNameError(null); }}
                  placeholder={t('sellerProfile.yourName', 'Your name')}
                  label={t('sellerProfile.displayName', 'Display name')}
                  maxLength={NAME_MAX}
                  autoCapitalize="words"
                  error={nameError}
                  returnKeyType="done"
                  onSubmitEditing={handleSaveName}
                />
                {nameError ? (
                  <Text style={sp.nameError} accessibilityLiveRegion="polite">{nameError}</Text>
                ) : null}
                <View style={sp.editBtns}>
                  <Button
                    label={t('cancel', 'Cancel')}
                    variant="neutral"
                    size="md"
                    onPress={cancelEdit}
                    disabled={saving}
                    style={{ flex: 1 }}
                  />
                  <Button
                    label={t('save', 'Save')}
                    size="md"
                    loading={saving}
                    onPress={handleSaveName}
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            ) : (
              <View style={sp.identity}>
                <Avatar name={user?.name} size={68} />
                <View style={{ flex: 1 }}>
                  <Text style={sp.name} numberOfLines={2} accessibilityRole="header">
                    {user?.name?.trim() || t('seller', 'Seller')}
                  </Text>
                  {user?.phone ? <Text style={sp.phone}>+91 {user.phone}</Text> : null}
                  {bizType ? (
                    <Badge
                      label={bizTypeLabel}
                      icon="storefront-outline"
                      style={{ marginTop: SP.sm }}
                    />
                  ) : null}
                </View>
                <IconButton
                  icon="pencil"
                  size={17}
                  color={C.brandInk}
                  background={C.surface}
                  onPress={startEdit}
                  accessibilityLabel={t('sellerProfile.editName', 'Edit name')}
                  buttonStyle={sp.editIcon}
                />
              </View>
            )}
          </View>

          <Rule />

          {/* ── Completion ── */}
          {syncError && loading ? (
            <View style={sp.syncError}>
              <InlineNotice variant="warning">
                {syncError.isOffline
                  ? t('sellerProfile.loadErrorOffline', 'You are offline. Your business details will appear when you reconnect.')
                  : t('sellerProfile.loadError', 'Could not load your business details.')}
              </InlineNotice>
              <Button
                label={t('retry', 'Retry')}
                icon="refresh"
                variant="secondary"
                size="sm"
                loading={syncing}
                onPress={retrySync}
                style={sp.syncRetry}
              />
            </View>
          ) : null}

          <PressableRow
            onPress={() => navigation.navigate('BusinessProfile')}
            accessibilityLabel={loading
              ? t('sellerProfile.completion', 'Profile completion')
              : `${t('sellerProfile.completion', 'Profile completion')}: ${completion}%`}
            accessibilityHint={t('sellerProfile.completionHint', 'Opens your business profile to fill in what is missing')}
            style={sp.completionWrap}
          >
            <Card style={sp.completionCard}>
              <View style={sp.completionTop}>
                <View style={{ flex: 1 }}>
                  <Text style={sp.completionTitle}>{t('sellerProfile.completion', 'Profile completion')}</Text>
                  <Text style={sp.completionSub} numberOfLines={2}>
                    {completion < 100
                      ? t('sellerProfile.completionSub')
                      : t('sellerProfile.completionDone')}
                  </Text>
                </View>
                {loading ? (
                  <Skeleton width={52} height={26} />
                ) : (
                  <Text style={[sp.completionPct, { color: completionColor }]}>{completion}%</Text>
                )}
                <Ionicons name="chevron-forward" size={18} color={C.textFaint} />
              </View>
              <ProgressBar
                value={loading ? 0 : completion}
                color={completionColor}
                label={t('sellerProfile.completion', 'Profile completion')}
                style={{ marginTop: SP.lg }}
              />
            </Card>
          </PressableRow>

          {/* ── Account ── */}
          <SectionCard title={t('sellerProfile.account', 'Account')}>
            <Row
              icon="call-outline"
              label={t('sellerProfile.phoneNumber', 'Phone number')}
              value={user?.phone ? `+91 ${user.phone}` : t('notSet', 'Not set')}
            />
            <Row
              icon="person-outline"
              label={t('sellerProfile.displayName', 'Display name')}
              value={user?.name || t('notSet', 'Not set')}
              onPress={startEdit}
            />
            <Row
              icon="location-outline"
              label={t('sellerProfile.location', 'Location')}
              value={locationStr || t('sellerProfile.notSetTap')}
              onPress={() => navigation.navigate('BusinessProfile')}
              loading={loading}
              last
            />
          </SectionCard>

          {/* ── Business ── */}
          <SectionCard title={t('sellerProfile.businessInfo', 'Business')}>
            <Row
              icon="storefront-outline"
              label={t('sellerProfile.businessType', 'Business type')}
              value={bizTypeLabel}
              onPress={() => navigation.navigate('BusinessProfile')}
              loading={loading}
            />
            {/* Opt-out is checked first: it is what the business profile form
                shows when both are set, and the API clears the number on
                opt-out. */}
            <Row
              icon="document-text-outline"
              label={t('sellerProfile.gstNumber', 'GST number')}
              value={
                user?.gstOptOut ? t('sellerProfile.notApplicable', 'Not applicable')
                  : user?.gstNumber ? user.gstNumber
                    : t('sellerProfile.notAdded', 'Not added')
              }
              onPress={() => navigation.navigate('BusinessProfile')}
              loading={loading}
              badge={
                user?.gstOptOut
                  ? { text: t('sellerProfile.exempt', 'Exempt'), color: C.warning, icon: 'remove-circle-outline' }
                  : user?.gstNumber
                    ? { text: t('sellerProfile.added', 'Added'), color: C.success, icon: 'checkmark-circle' }
                    : null
              }
            />
            <Row
              icon="card-outline"
              label={t('sellerProfile.bankAccount', 'Bank account')}
              value={
                user?.sellerProfile?.bankAccountNumber
                  ? [
                      `••••${String(user.sellerProfile.bankAccountNumber).slice(-4)}`,
                      user.sellerProfile.bankName,
                    ].filter(Boolean).join(' · ')
                  : t('sellerProfile.notAdded', 'Not added')
              }
              onPress={() => navigation.navigate('BusinessProfile')}
              loading={loading}
              badge={
                user?.sellerProfile?.bankAccountNumber
                  ? { text: t('sellerProfile.added', 'Added'), color: C.success, icon: 'lock-closed' }
                  : null
              }
            />
            <Row
              icon="shield-checkmark-outline"
              label={t('sellerProfile.kycStatus', 'KYC status')}
              value={kycValue}
              onPress={() => navigation.navigate('BusinessProfile')}
              loading={loading}
              badge={{ text: t(kycMeta.tKey, kycMeta.fallback), color: kycMeta.color, icon: kycMeta.icon }}
              last
            />
          </SectionCard>

          {/* ── Seller info ── */}
          <SectionCard title={t('sellerProfile.sellerInfo', 'Seller')}>
            <Row
              icon="calendar-outline"
              label={t('sellerProfile.sellerSince', 'Seller since')}
              loading={loading}
              value={(() => {
                const created = user?.createdAt ? new Date(user.createdAt) : null;
                return created && !Number.isNaN(created.getTime())
                  ? created.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
                  : '—';
              })()}
            />
            <Row
              icon="pulse-outline"
              label={t('sellerProfile.accountStatus', 'Account status')}
              value={t('sellerProfile.active', 'Active')}
              badge={{ text: t('sellerProfile.active', 'Active'), color: C.success, icon: 'ellipse' }}
              last
            />
          </SectionCard>

          {/* ── Actions ── */}
          <SectionCard title={t('sellerProfile.quickActions', 'More')}>
            <Row
              icon="briefcase-outline"
              label={t('sellerProfile.bizProfileKyc', 'Business profile & KYC')}
              value={t('sellerProfile.bizProfileSub')}
              onPress={() => navigation.navigate('BusinessProfile')}
            />
            <Row
              icon="help-circle-outline"
              label={t('sellerProfile.helpCenter', 'Help centre')}
              onPress={showHelp}
            />
            <Row
              icon="document-text-outline"
              label={t('sellerProfile.terms', 'Terms of service')}
              onPress={() => openUrl(TERMS_URL)}
              hint={t('common.opensBrowser', 'Opens in your browser')}
            />
            <Row
              icon="lock-closed-outline"
              label={t('sellerProfile.privacy', 'Privacy policy')}
              onPress={() => openUrl(PRIVACY_URL)}
              hint={t('common.opensBrowser', 'Opens in your browser')}
              last
            />
          </SectionCard>

          <Button
            label={t('logout', 'Log out')}
            icon="log-out-outline"
            variant="dangerSoft"
            size="lg"
            fullWidth
            haptic="warning"
            onPress={handleLogout}
            style={{ marginTop: SP.xxl }}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const sp = StyleSheet.create({
  header: { paddingTop: SP.xl, paddingBottom: SP.xl },
  identity: { flexDirection: 'row', alignItems: 'center', gap: SP.lg },
  name: { ...T.title, color: C.text },
  phone: { ...T.body, color: C.textMuted, marginTop: 2 },
  editIcon: {
    width: HIT.minCompact,
    height: HIT.minCompact,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.border,
  },

  editWrap: { gap: SP.md },
  nameError: { ...T.captionBold, color: C.danger, textAlign: 'center' },
  editBtns: { flexDirection: 'row', gap: SP.md },

  syncError: { marginTop: SP.xl, gap: SP.sm },
  syncRetry: { alignSelf: 'flex-end' },

  completionWrap: { marginTop: SP.xl, borderRadius: R.xl },
  completionCard: { ...E.raised },
  completionTop: { flexDirection: 'row', alignItems: 'center', gap: SP.md },
  completionTitle: { ...T.bodyBold, color: C.text },
  completionSub: { ...T.caption, color: C.textMuted, marginTop: 2 },
  completionPct: { ...T.figureMd },
});

const r = StyleSheet.create({
  section: { marginTop: SP.xxl },
  sectionTitle: {
    ...T.section,
    color: C.textMuted,
    textTransform: 'uppercase',
    marginBottom: SP.md,
    marginLeft: SP.xs,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP.lg,
    paddingHorizontal: SP.xl,
    paddingVertical: SP.lg,
    minHeight: HIT.min + 8,
  },
  rowRuled: { borderBottomWidth: 1, borderBottomColor: C.divider },
  rowIcon: {
    width: 38, height: 38, borderRadius: R.sm,
    backgroundColor: C.brandPale,
    borderWidth: 1,
    borderColor: alpha(C.brand, 0.18),
    alignItems: 'center', justifyContent: 'center',
  },
  rowLabel: { ...T.bodyBold, color: C.text },
  rowValue: { ...T.caption, color: C.textMuted, marginTop: 2 },
});
