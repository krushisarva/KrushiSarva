/**
 * BusinessProfileScreen — seller onboarding / KYC.
 *
 * The single most consequential form in the app: submitting it is the explicit
 * consent that promotes FARMER → SELLER, and it carries bank + Aadhaar + PAN.
 * The consent flag and the encrypted-field rule ("blank means keep what's on
 * file") are unchanged. The rules themselves live in utils/businessProfile.js,
 * where they are unit-tested; this file is layout and wiring.
 *
 * IT HAS TO FEEL LIKE A BANK COUNTER, NOT A SIGN-UP FORM
 * ------------------------------------------------------
 * A shop owner is being asked for an Aadhaar number and a bank account by an
 * app they installed last week. Everything visual here is spent on making that
 * feel calm and accountable:
 *
 *   - It opens on a statement of purpose, a security line, the completion meter
 *     and the KYC status — including an admin's rejection reason, which the
 *     seller previously had no way to see.
 *   - Five numbered sections, each with a one-line explanation of what it is
 *     for, so nothing is asked for without a reason attached.
 *   - Every encrypted field carries a lock chip on its label. A field whose
 *     value is already stored shows the masked value (••••••4321) as its
 *     placeholder and an "On file" badge, so "leave blank to keep" has
 *     something visible to keep.
 *
 * EDGE CASES THIS SCREEN NOW HANDLES
 *   - Straight after an OTP login AuthContext holds only id/phone/name/role.
 *     The form used to build itself from that, open blank, and overwrite the
 *     stored district, GST and bank details with blanks on save. It now waits
 *     for the full profile (useProfileSync) and offers retry if it can't load.
 *   - Only fields that change are sent, so saving a village edit no longer
 *     spends the API's five-per-hour budget for sensitive fields.
 *   - A new account number must be typed twice. Once saved it is only ever
 *     shown masked, so a typo would otherwise be invisible until a payout
 *     failed. An account on file still requires an IFSC and holder name.
 *   - Pasted Aadhaar / account numbers with spaces keep every digit; Aadhaar
 *     and GSTIN typos are caught by their check digits.
 *   - A stored district or taluka the picker can't show (a renamed district,
 *     a location set in the buyer app) no longer hides behind a placeholder
 *     while being resubmitted.
 *   - A 400 from the API marks the fields it names instead of "Invalid
 *     request".
 *   - Scrolling to the first error measures against the ScrollView. It used
 *     `onLayout` y, which is relative to the section card, so it scrolled to
 *     roughly the top of the form whichever field was wrong.
 *   - If the save succeeds but the account is not promoted (the API refuses
 *     minors, and never promotes labour or machinery accounts), the seller is
 *     told so instead of being sent to a dashboard where every request 403s.
 *   - Back is blocked while a save is in flight, so the save can't finish on an
 *     unmounted screen and pop the screen behind it.
 *   - An account that is not a seller yet has nothing behind this screen, so it
 *     offers a way to log out instead of trapping someone who signed in with
 *     the wrong number.
 *   - A stale offline flag is re-checked when Save is tapped.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@krushisarva/shared/context/AuthContext';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import api, { safeErrorMessage, saveTokens } from '@krushisarva/shared/services/api';
import { DISTRICT_LIST, getTalukas, BUSINESS_TYPES } from '@krushisarva/shared/constants/locations';
import { hasSellerRole } from '@krushisarva/shared/utils/roles';

import { C, E, R, SP, T, alpha, kycStatusMeta, useResponsive } from '../theme';
import { useNetwork } from '../hooks/useNetwork';
import useUnsavedChanges from '../hooks/useUnsavedChanges';
import useProfileSync, { noteProfileWrite } from '../hooks/useProfileSync';
import {
  FIELD_ORDER, ID_INPUT_MAX, NAME_MAX, TEXT_MAX,
  applyFieldChange, buildBusinessProfilePayload, completionFromForm, firstErrorKey,
  hasUnsavedChanges, initialFormFromUser, kycState, onFileFromUser,
  serverFieldErrorKeys, serverFieldMessage, validateBusinessProfile,
} from '../utils/businessProfile';
import {
  Screen, ActionBar, Button, Field, TextField, Chip, ChipGroup,
  CheckboxRow, FormSection, SelectSheet, ProgressBar, InlineNotice,
  Card, Badge, ErrorState, SkeletonList,
  useConfirm, useToast,
} from '../components/ui';

/** Sections in the form, in scroll order. Drives the "01 / 05" counters. */
const TOTAL_SECTIONS = 5;

// ── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Renders the form only once the account in context is the full profile. The
 * form's starting values are computed once, on mount, so mounting it early
 * would lock in the blanks it is waiting to replace.
 */
export default function BusinessProfileScreen({ navigation }) {
  const { t } = useLanguage();
  const { logout } = useAuth();
  const confirm = useConfirm();
  const { hydrated, error, retry } = useProfileSync();

  const handleLogout = useCallback(async () => {
    if (await confirmLogout(confirm, t)) logout();
  }, [confirm, logout, t]);

  if (hydrated) return <BusinessProfileForm navigation={navigation} />;

  return (
    <Screen edges={['left', 'right']} background={C.bgAlt}>
      {error ? (
        <ErrorState error={error} onRetry={retry} />
      ) : (
        <SkeletonList count={3} thumb={false} lines={4} />
      )}
      {!navigation.canGoBack() ? (
        <View style={b.gateExit}>
          <Button label={t('logout', 'Log out')} variant="ghost" size="sm" icon="log-out-outline" onPress={handleLogout} />
        </View>
      ) : null}
    </Screen>
  );
}

function confirmLogout(confirm, t) {
  return confirm({
    title: t('logout', 'Log out'),
    message: t('sellerBizProfile.logoutMsg', 'You can finish setting up your shop the next time you log in.'),
    confirmLabel: t('logout', 'Log out'),
    cancelLabel: t('cancel', 'Cancel'),
    destructive: true,
    icon: 'log-out-outline',
  });
}

// ── Form ─────────────────────────────────────────────────────────────────────

function BusinessProfileForm({ navigation }) {
  const { user, updateUser, logout } = useAuth();
  const { t } = useLanguage();
  const toast = useToast();
  const confirm = useConfirm();
  const { isOffline, recheck } = useNetwork();
  const { gutter, isExpanded, contentMaxWidth } = useResponsive();

  const onFile = useMemo(() => onFileFromUser(user), [user]);
  const kyc = useMemo(() => kycState(user), [user]);
  const isMinor = user?.isMinor === true;
  const canGoBack = navigation.canGoBack();

  const [initial, setInitial] = useState(() => initialFormFromUser(user));
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [serverErrors, setServerErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notPromoted, setNotPromoted] = useState(false);
  const [scrollTarget, setScrollTarget] = useState(null);

  const isDirty = useMemo(() => hasUnsavedChanges(form, initial), [form, initial]);
  const validationCtx = useMemo(() => ({ onFile, t }), [onFile, t]);

  // Event handlers read the latest values through refs so they can stay stable.
  const formRef = useRef(form);
  formRef.current = form;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  const ctxRef = useRef(validationCtx);
  ctxRef.current = validationCtx;
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // A fresher copy of the account arrived (a focus refresh). Take it as the new
  // starting point — unless the seller has started typing, which must never be
  // overwritten.
  const lastUserRef = useRef(user);
  useEffect(() => {
    if (user === lastUserRef.current) return;
    lastUserRef.current = user;
    if (dirtyRef.current || savingRef.current) return;
    const next = initialFormFromUser(user);
    setInitial(next);
    setForm(next);
  }, [user]);

  // Errors appear on blur (for fields with something typed) and on submit.
  // After that, a flagged field re-checks as it is edited, so the message
  // clears the moment the value is right — without flagging fields the seller
  // hasn't reached yet.
  useEffect(() => {
    setErrors((prev) => {
      const flagged = Object.keys(prev).filter((k) => prev[k]);
      if (!flagged.length) return prev;
      const all = validateBusinessProfile(form, validationCtx);
      let changed = false;
      const next = {};
      flagged.forEach((k) => {
        next[k] = all[k];
        if (all[k] !== prev[k]) changed = true;
      });
      return changed ? next : prev;
    });
  }, [form, validationCtx]);

  const set = useMemo(() => {
    const make = (key) => (value) => {
      setForm((prev) => applyFieldChange(prev, key, value, initialRef.current));
      setServerErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    };
    return Object.fromEntries([...FIELD_ORDER, 'gstOptOut'].map((k) => [k, make(k)]));
  }, []);

  const blur = useMemo(() => {
    const make = (key) => () => {
      if (!String(formRef.current[key] ?? '').trim()) return;
      const message = validateBusinessProfile(formRef.current, ctxRef.current)[key];
      setErrors((prev) => (prev[key] === message ? prev : { ...prev, [key]: message }));
    };
    return Object.fromEntries(FIELD_ORDER.map((k) => [k, make(k)]));
  }, []);

  const errorOf = (key) => errors[key] || serverErrors[key];
  const hasErrors = Object.values(errors).some(Boolean) || Object.values(serverErrors).some(Boolean);

  // ── Scroll to a field ──────────────────────────────────────────────────────
  const scrollRef = useRef(null);
  const fieldRefs = useRef({});
  const refFor = useMemo(() => {
    const cache = {};
    return (key) => {
      if (!cache[key]) cache[key] = (node) => { fieldRefs.current[key] = node; };
      return cache[key];
    };
  }, []);

  const scrollToField = useCallback((key) => {
    if (key) setScrollTarget({ key, at: Date.now() });
  }, []);

  // Runs after the errors (and the summary notice above the form) have
  // rendered, so the measurement includes the space they take.
  useEffect(() => {
    if (!scrollTarget) return undefined;
    const frame = requestAnimationFrame(() => {
      const node = fieldRefs.current[scrollTarget.key];
      if (!node) return;
      if (Platform.OS === 'web') {
        // The document scrolls on web (see App.js), not the ScrollView.
        node.scrollIntoView?.({ behavior: 'smooth', block: scrollTarget.key === 'top' ? 'start' : 'center' });
        return;
      }
      const scroller = scrollRef.current;
      const inner = scroller?.getInnerViewRef?.();
      if (!inner || typeof node.measureLayout !== 'function') return;
      node.measureLayout(
        inner,
        (_x, y) => scroller.scrollTo({ y: Math.max(0, y - SP.xxl), animated: true }),
        () => {},
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollTarget]);

  // ── Leaving ────────────────────────────────────────────────────────────────
  const confirmDiscard = useCallback(() => confirm({
    title: t('sellerBizProfile.discardTitle', 'Leave without saving?'),
    message: t('sellerBizProfile.discardMsg', 'Your business details will not be saved.'),
    confirmLabel: t('sellerBizProfile.discard', 'Discard'),
    cancelLabel: t('sellerBizProfile.keepEditing', 'Keep editing'),
    destructive: true,
  }), [confirm, t]);

  const { allowNext } = useUnsavedChanges(isDirty && !saving, confirmDiscard);

  useEffect(() => navigation.addListener('beforeRemove', (e) => {
    if (!savingRef.current) return;
    e.preventDefault();
    toast.info(t('sellerBizProfile.savingWait', 'Saving your details. Please wait.'));
  }), [navigation, toast, t]);

  const handleLogout = useCallback(async () => {
    if (savingRef.current) return;
    if (await confirmLogout(confirm, t)) logout();
  }, [confirm, logout, t]);

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (savingRef.current) return;
    const current = formRef.current;

    setSubmitted(true);
    setServerErrors({});
    const errs = validateBusinessProfile(current, ctxRef.current);
    setErrors(errs);
    const first = firstErrorKey(errs);
    if (first) {
      toast.error(t('sellerBizProfile.fixErrors', 'Please fix the highlighted fields.'));
      scrollToField(first);
      return;
    }

    // An existing seller tapping Save on an untouched form. A FARMER is always
    // let through: for them the save is the consent that promotes the account.
    if (hasSellerRole(user) && !hasUnsavedChanges(current, initialRef.current)) {
      toast.info(t('sellerBizProfile.noChanges', 'No changes to save'));
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setNotPromoted(false);
    try {
      if (isOffline && !(await recheck())) {
        toast.warning(t('sellerBizProfile.offline', 'You are offline. Your details are still here — save again when you are back online.'));
        return;
      }

      const { data } = await api.put('/users/me', buildBusinessProfilePayload(current, user));
      noteProfileWrite();
      // `tokens` must not end up inside the user object in context.
      const { tokens, ...fresh } = data?.data || {};

      // A role upgrade returns fresh tokens; persist them so the next request's
      // JWT carries SELLER. Without this, dashboard stats keep 403-ing.
      if (tokens?.accessToken && tokens?.refreshToken) {
        await saveTokens({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          userId: fresh.id,
        });
      }

      const saved = { ...user, ...fresh };
      updateUser(fresh);
      const next = initialFormFromUser(saved);
      setInitial(next);
      setForm(next);
      setErrors({});
      setSubmitted(false);

      if (!hasSellerRole(saved)) {
        setNotPromoted(true);
        toast.warning(t('sellerBizProfile.savedNotSeller', 'Details saved, but this account is not a seller account yet.'));
        scrollToField('top');
        return;
      }

      toast.success(t('sellerBizProfile.saved', 'Saved'));
      // Let the navigation below through both leave guards.
      savingRef.current = false;
      allowNext();
      if (!mountedRef.current) return;

      // Reached from the profile → go back to it. Reached as the app's first
      // screen (account not a seller until now) there is nothing behind this
      // one, so open the dashboard and drop the KYC form from the stack.
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.replace('SellerDashboard');
    } catch (e) {
      const keys = serverFieldErrorKeys(e);
      if (keys.length) {
        setServerErrors(Object.fromEntries(keys.map((k) => [k, serverFieldMessage(k, t)])));
        toast.error(t('sellerBizProfile.fixErrors', 'Please fix the highlighted fields.'));
        scrollToField(firstErrorKey(Object.fromEntries(keys.map((k) => [k, true]))));
      } else {
        toast.error(safeErrorMessage(e, t('sellerBizProfile.saveError', 'Could not save profile. Please try again.')));
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [user, t, toast, isOffline, recheck, scrollToField, updateUser, allowNext, navigation]);

  // ── Derived display ────────────────────────────────────────────────────────
  const percent = completionFromForm(form, onFile);
  const meterColor = percent >= 80 ? C.success : percent >= 50 ? C.warning : C.danger;
  const meterLabel = percent === 100
    ? t('sellerBizProfile.profileComplete', 'Profile Complete')
    : percent >= 50
      ? t('sellerBizProfile.almostDone', 'Almost Done')
      : t('sellerBizProfile.incomplete', 'Incomplete');

  const kycMeta = kycStatusMeta(kyc.key);
  const kycLabel = t(kycMeta.tKey, kycMeta.fallback);
  const kycBody = kyc.key === 'verified'
    ? t('sellerBizProfile.kycVerifiedBody', 'Your KYC is verified.')
    : kyc.key === 'pending'
      ? t('sellerBizProfile.kycPendingBody', 'Your details are saved and waiting for verification.')
      : kyc.key === 'rejected'
        ? (kyc.reason
          ? t('sellerBizProfile.kycRejectedBody', {
            reason: kyc.reason,
            defaultValue: 'Reason: {{reason}}. Correct your details below and save.',
          })
          : t('sellerBizProfile.kycRejectedNoReason', 'Correct your details below and save.'))
        : t('sellerBizProfile.kycNotStartedBody', 'Add your Aadhaar or PAN below to get your shop verified.');

  const talukaOptions = useMemo(() => getTalukas(form.district), [form.district]);
  const hasAccount = !!form.bankAccountNumber || !!onFile.bankAccount;
  const confirmMatches = !!form.bankAccountConfirm && form.bankAccountConfirm === form.bankAccountNumber;

  const onFileHint = t('sellerBizProfile.onFileHint', 'On file — leave blank to keep, enter a new number to replace');
  const onFileBadge = <Badge label={t('sellerBizProfile.onFile', 'On file')} color={C.success} icon="lock-closed" />;
  const encryptedLabel = t('sellerBizProfile.encrypted', 'Encrypted');

  return (
    <Screen edges={['left', 'right']} background={C.bgAlt}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[
            { padding: gutter, paddingBottom: SP.huge },
            isExpanded && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {/* ── Purpose, progress, KYC status. In that order: a percentage is
              meaningless until you know what it is a percentage of. ── */}
          <View ref={refFor('top')} collapsable={false}>
            <Card style={b.intro}>
              <View style={b.introHead}>
                <View style={b.introMark}>
                  <Ionicons name="shield-checkmark" size={20} color={C.success} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={b.introTitle} accessibilityRole="header">
                    {t('sellerProfile.bizProfileKyc', 'Business profile & KYC')}
                  </Text>
                  <Text style={b.introSub}>
                    {t('sellerBizProfile.securityNote')}
                  </Text>
                </View>
              </View>

              <View
                style={b.meter}
                accessible
                accessibilityLabel={`${t('sellerBizProfile.completion', 'Profile completion')}: ${percent}%. ${meterLabel}`}
              >
                <View style={b.meterTop}>
                  <Text style={[b.meterPct, { color: meterColor }]}>{percent}%</Text>
                  <Text style={b.meterLabel} numberOfLines={2}>{meterLabel}</Text>
                </View>
                <ProgressBar
                  value={percent}
                  color={meterColor}
                  label={t('sellerBizProfile.completion', 'Profile completion')}
                  style={{ marginTop: SP.md }}
                />
              </View>

              <View style={b.kyc}>
                <View
                  style={b.kycTop}
                  accessible
                  accessibilityLabel={`${t('sellerProfile.kycStatus', 'KYC status')}: ${kycLabel}`}
                >
                  <Text style={b.kycTitle}>{t('sellerProfile.kycStatus', 'KYC status')}</Text>
                  <Badge label={kycLabel} color={kycMeta.color} icon={kycMeta.icon} />
                </View>
                {kyc.key === 'rejected' ? (
                  <InlineNotice variant="error">{kycBody}</InlineNotice>
                ) : (
                  <Text style={b.kycBody}>{kycBody}</Text>
                )}
              </View>

              {!canGoBack ? (
                <View style={b.exit}>
                  <Text style={b.exitTxt}>
                    {t('sellerBizProfile.wrongAccount', 'Signed in with the wrong number?')}
                  </Text>
                  <Button
                    label={t('logout', 'Log out')}
                    variant="ghost"
                    size="sm"
                    icon="log-out-outline"
                    onPress={handleLogout}
                    disabled={saving}
                  />
                </View>
              ) : null}
            </Card>
          </View>

          {isMinor ? (
            <InlineNotice variant="warning" style={b.notice}>
              {t('sellerBizProfile.minorNotice', 'Seller accounts are only for people aged 18 or older, so this form cannot be submitted from this account.')}
            </InlineNotice>
          ) : null}

          {notPromoted ? (
            <InlineNotice variant="error" style={b.notice}>
              {t('sellerBizProfile.notPromoted', 'Your details were saved, but this account could not be switched to a seller account. Please contact KrushiSarva support.')}
            </InlineNotice>
          ) : null}

          {submitted && hasErrors ? (
            <InlineNotice variant="error" style={b.notice}>
              {t('sellerBizProfile.fixErrors', 'Please fix the highlighted fields.')}
            </InlineNotice>
          ) : null}

          {/* ── Business identity ── */}
          <FormSection
            icon="storefront-outline"
            title={t('sellerBizProfile.bizIdentity', 'Business Identity')}
            hint={t('sellerBizProfile.bizIdentityHint', 'How buyers will see your shop.')}
            step={1}
            total={TOTAL_SECTIONS}
          >
            <Field
              ref={refFor('name')}
              label={t('sellerProfile.displayName', 'Display Name')}
              required
              hint={t('sellerBizProfile.nameHint', 'Shown to buyers on your listings and orders')}
              error={errorOf('name')}
            >
              <TextField
                value={form.name}
                onChangeText={set.name}
                onBlur={blur.name}
                placeholder={t('sellerBizProfile.namePlaceholder', 'Your name or shop name')}
                autoCapitalize="words"
                maxLength={NAME_MAX}
                error={errorOf('name')}
                label={t('sellerProfile.displayName', 'Display Name')}
              />
            </Field>

            <Field
              ref={refFor('businessType')}
              label={t('sellerBizProfile.bizType', 'Business Type')}
              required
              error={errorOf('businessType')}
            >
              <ChipGroup accessibilityLabel={t('sellerBizProfile.bizType', 'Business Type')}>
                {BUSINESS_TYPES.map((bt) => (
                  <Chip
                    key={bt.key}
                    label={t('biz.' + bt.tKey, bt.label)}
                    icon={bt.icon}
                    selected={form.businessType === bt.key}
                    onPress={() => set.businessType(bt.key)}
                  />
                ))}
              </ChipGroup>
            </Field>
          </FormSection>

          {/* ── Location ── */}
          <FormSection
            icon="location-outline"
            title={t('sellerBizProfile.yourLocation', 'Your Location')}
            hint={t('sellerBizProfile.primaryLocation', 'Your primary selling location')}
            step={2}
            total={TOTAL_SECTIONS}
          >
            <Field label={t('sellerBizProfile.state', 'State')}>
              <TextField
                value={t('scope.state', 'Maharashtra')}
                editable={false}
                label={t('sellerBizProfile.state', 'State')}
                accessibilityHint={t('sellerBizProfile.stateFixed', 'Currently fixed to Maharashtra')}
              />
            </Field>

            <Field
              ref={refFor('district')}
              label={t('sellerBizProfile.district', 'District')}
              required
              error={errorOf('district')}
            >
              <SelectSheet
                title={t('sellerBizProfile.selectDistrictTitle', 'Select District')}
                placeholder={t('sellerBizProfile.selectDistrictPlaceholder', 'Select your district')}
                items={DISTRICT_LIST}
                value={form.district}
                onChange={set.district}
                accessibilityLabel={t('sellerBizProfile.district', 'District')}
              />
            </Field>

            <Field
              ref={refFor('taluka')}
              label={t('sellerBizProfile.taluka', 'Taluka')}
              required
              error={errorOf('taluka')}
            >
              <SelectSheet
                title={t('sellerBizProfile.selectTalukaTitle', 'Select Taluka')}
                placeholder={form.district
                  ? t('sellerBizProfile.selectTalukaPlaceholder', 'Select your taluka')
                  : t('sellerBizProfile.selectDistrictFirst', 'Select district first')}
                items={talukaOptions}
                value={form.taluka}
                onChange={set.taluka}
                disabled={!form.district}
                accessibilityLabel={t('sellerBizProfile.taluka', 'Taluka')}
              />
            </Field>

            <Field
              ref={refFor('village')}
              label={t('sellerBizProfile.villageTown', 'Village / Town')}
              required
              error={errorOf('village')}
            >
              <TextField
                value={form.village}
                onChangeText={set.village}
                onBlur={blur.village}
                placeholder={t('sellerBizProfile.villagePlaceholder', 'e.g. Kalamb, Wadgaon Sheri')}
                maxLength={TEXT_MAX}
                error={errorOf('village')}
                label={t('sellerBizProfile.villageTown', 'Village / Town')}
              />
            </Field>
          </FormSection>

          {/* ── GST ── */}
          <FormSection
            icon="document-text-outline"
            title={t('sellerBizProfile.gstDetails', 'GST Details')}
            hint={t('sellerBizProfile.gstHint')}
            step={3}
            total={TOTAL_SECTIONS}
          >
            <CheckboxRow
              checked={form.gstOptOut}
              onToggle={() => set.gstOptOut(!form.gstOptOut)}
              label={t('sellerBizProfile.noGst', "I don't have a GST number")}
              hint={t('sellerBizProfile.noGstHint')}
            />

            {!form.gstOptOut ? (
              <Field
                ref={refFor('gstNumber')}
                label={t('sellerBizProfile.gstNumber', 'GST Number')}
                required
                hint={t('sellerBizProfile.gstHint')}
                error={errorOf('gstNumber')}
                style={{ marginTop: SP.md }}
              >
                <TextField
                  value={form.gstNumber}
                  onChangeText={set.gstNumber}
                  onBlur={blur.gstNumber}
                  placeholder={t('sellerBizProfile.gstPlaceholder', '27ABCDE1234F1Z5')}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoComplete="off"
                  maxLength={ID_INPUT_MAX.gstNumber}
                  error={errorOf('gstNumber')}
                  label={t('sellerBizProfile.gstNumber', 'GST Number')}
                />
              </Field>
            ) : null}
          </FormSection>

          {/* ── Bank ── */}
          <FormSection
            icon="card-outline"
            title={t('sellerBizProfile.bankAccountSection', 'Bank Account (for Payments)')}
            hint={t('sellerBizProfile.bankHint')}
            step={4}
            total={TOTAL_SECTIONS}
          >
            <Field
              ref={refFor('bankHolderName')}
              label={t('sellerBizProfile.holderName', 'Account Holder Name')}
              required={hasAccount}
              error={errorOf('bankHolderName')}
            >
              <TextField
                value={form.bankHolderName}
                onChangeText={set.bankHolderName}
                onBlur={blur.bankHolderName}
                placeholder={t('sellerBizProfile.holderNamePlaceholder', 'Name as per bank records')}
                autoCapitalize="words"
                maxLength={TEXT_MAX}
                error={errorOf('bankHolderName')}
                label={t('sellerBizProfile.holderName', 'Account Holder Name')}
              />
            </Field>

            <Field
              ref={refFor('bankName')}
              label={t('sellerBizProfile.bankName', 'Bank Name')}
              error={errorOf('bankName')}
            >
              <TextField
                value={form.bankName}
                onChangeText={set.bankName}
                onBlur={blur.bankName}
                placeholder={t('sellerBizProfile.bankNamePlaceholder', 'e.g. State Bank of India')}
                autoCapitalize="words"
                maxLength={TEXT_MAX}
                error={errorOf('bankName')}
                label={t('sellerBizProfile.bankName', 'Bank Name')}
              />
            </Field>

            <Field
              ref={refFor('bankAccountNumber')}
              label={t('sellerBizProfile.accountNumber', 'Account Number')}
              secure
              secureLabel={encryptedLabel}
              hint={onFile.bankAccount ? onFileHint : undefined}
              error={errorOf('bankAccountNumber')}
            >
              <TextField
                value={form.bankAccountNumber}
                onChangeText={set.bankAccountNumber}
                onBlur={blur.bankAccountNumber}
                placeholder={onFile.bankAccount || t('sellerBizProfile.accountNumberPlaceholder', 'Enter bank account number')}
                keyboardType="number-pad"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                maxLength={ID_INPUT_MAX.bankAccountNumber}
                error={errorOf('bankAccountNumber')}
                label={t('sellerBizProfile.accountNumber', 'Account Number')}
                suffix={onFile.bankAccount && !form.bankAccountNumber ? onFileBadge : null}
              />
            </Field>

            {form.bankAccountNumber ? (
              <Field
                ref={refFor('bankAccountConfirm')}
                label={t('sellerBizProfile.confirmAccountNumber', 'Re-enter Account Number')}
                required
                secure
                secureLabel={encryptedLabel}
                error={errorOf('bankAccountConfirm')}
              >
                <TextField
                  value={form.bankAccountConfirm}
                  onChangeText={set.bankAccountConfirm}
                  onBlur={blur.bankAccountConfirm}
                  placeholder={t('sellerBizProfile.confirmAccountPlaceholder', 'Type the account number again')}
                  keyboardType="number-pad"
                  autoCorrect={false}
                  autoComplete="off"
                  importantForAutofill="no"
                  maxLength={ID_INPUT_MAX.bankAccountConfirm}
                  error={errorOf('bankAccountConfirm')}
                  label={t('sellerBizProfile.confirmAccountNumber', 'Re-enter Account Number')}
                  suffix={confirmMatches
                    ? <Ionicons name="checkmark-circle" size={20} color={C.success} />
                    : null}
                />
              </Field>
            ) : null}

            <Field
              ref={refFor('bankIfsc')}
              label={t('sellerBizProfile.ifscCode', 'IFSC Code')}
              required={hasAccount}
              hint={t('sellerBizProfile.ifscHint')}
              error={errorOf('bankIfsc')}
            >
              <TextField
                value={form.bankIfsc}
                onChangeText={set.bankIfsc}
                onBlur={blur.bankIfsc}
                placeholder={t('sellerBizProfile.ifscPlaceholder', 'e.g. SBIN0012345')}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                maxLength={ID_INPUT_MAX.bankIfsc}
                error={errorOf('bankIfsc')}
                label={t('sellerBizProfile.ifscCode', 'IFSC Code')}
              />
            </Field>
          </FormSection>

          {/* ── KYC ── */}
          <FormSection
            icon="shield-checkmark-outline"
            title={t('sellerBizProfile.kycDocs', 'KYC Documents')}
            hint={t('sellerBizProfile.kycHint')}
            step={5}
            total={TOTAL_SECTIONS}
          >
            <Field
              ref={refFor('aadharNumber')}
              label={t('sellerBizProfile.aadhaar', 'Aadhaar Number')}
              secure
              secureLabel={encryptedLabel}
              hint={onFile.aadhaar ? onFileHint : t('sellerBizProfile.aadhaarHint')}
              error={errorOf('aadharNumber')}
            >
              <TextField
                value={form.aadharNumber}
                onChangeText={set.aadharNumber}
                onBlur={blur.aadharNumber}
                placeholder={onFile.aadhaar || t('sellerBizProfile.aadhaarPlaceholder', 'XXXX XXXX XXXX')}
                keyboardType="number-pad"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                maxLength={ID_INPUT_MAX.aadharNumber}
                error={errorOf('aadharNumber')}
                label={t('sellerBizProfile.aadhaar', 'Aadhaar Number')}
                suffix={onFile.aadhaar && !form.aadharNumber ? onFileBadge : null}
              />
            </Field>

            <Field
              ref={refFor('panNumber')}
              label={t('sellerBizProfile.pan', 'PAN Number')}
              secure
              secureLabel={encryptedLabel}
              hint={onFile.pan ? onFileHint : t('sellerBizProfile.panHint')}
              error={errorOf('panNumber')}
            >
              <TextField
                value={form.panNumber}
                onChangeText={set.panNumber}
                onBlur={blur.panNumber}
                placeholder={onFile.pan || t('sellerBizProfile.panPlaceholder', 'e.g. ABCDE1234F')}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                maxLength={ID_INPUT_MAX.panNumber}
                error={errorOf('panNumber')}
                label={t('sellerBizProfile.pan', 'PAN Number')}
                suffix={onFile.pan && !form.panNumber ? onFileBadge : null}
              />
            </Field>
          </FormSection>

          {/* Repeated at the point of submission, not only at the top: this is
              the moment the seller is actually handing the data over. */}
          <InlineNotice variant="success" icon="lock-closed">
            {t('sellerBizProfile.securityNote')}
          </InlineNotice>
        </ScrollView>
      </KeyboardAvoidingView>

      <ActionBar>
        <Button
          label={t('sellerBizProfile.saveBizProfile', 'Save Business Profile')}
          icon="checkmark-circle-outline"
          size="lg"
          fullWidth
          loading={saving}
          disabled={saving || isMinor}
          onPress={handleSave}
          accessibilityHint={isOffline
            ? t('sellerBizProfile.offline', 'You are offline. Your details are still here — save again when you are back online.')
            : undefined}
        />
      </ActionBar>
    </Screen>
  );
}

const b = StyleSheet.create({
  gateExit: { alignItems: 'center', paddingBottom: SP.xxl },

  intro: { marginBottom: SP.lg, ...E.raised },
  introHead: { flexDirection: 'row', alignItems: 'flex-start', gap: SP.lg },
  introMark: {
    width: 42, height: 42, borderRadius: R.sm,
    backgroundColor: C.successPale,
    borderWidth: 1,
    borderColor: alpha(C.success, 0.22),
    alignItems: 'center', justifyContent: 'center',
  },
  introTitle: { ...T.subhead, color: C.text },
  introSub: { ...T.caption, color: C.textMuted, marginTop: SP.xs, lineHeight: 18 },

  meter: {
    marginTop: SP.xl,
    paddingTop: SP.lg,
    borderTopWidth: 1,
    borderTopColor: C.divider,
  },
  meterTop: { flexDirection: 'row', alignItems: 'center', gap: SP.md },
  meterPct: { ...T.figureMd },
  meterLabel: { ...T.label, color: C.textMuted, flex: 1 },

  kyc: {
    marginTop: SP.lg,
    paddingTop: SP.lg,
    borderTopWidth: 1,
    borderTopColor: C.divider,
    gap: SP.sm,
  },
  kycTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SP.md },
  kycTitle: { ...T.label, color: C.textBody, flexShrink: 1 },
  kycBody: { ...T.caption, color: C.textMuted },

  exit: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SP.sm,
    marginTop: SP.lg,
    paddingTop: SP.md,
    borderTopWidth: 1,
    borderTopColor: C.divider,
  },
  exitTxt: { ...T.caption, color: C.textMuted, flexShrink: 1 },

  notice: { marginBottom: SP.lg },
});
