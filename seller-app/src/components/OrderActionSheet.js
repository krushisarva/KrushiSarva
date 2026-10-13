/**
 * OrderActionSheet — the questions a delivery can end on.
 *
 * Opened by OrdersScreen when a status change needs more than yes/no
 * (utils/orderDelivery.js statusPrompt decides which):
 *
 *   'code'          the 4-digit code the farmer reads out at the door
 *   'noCodeReason'  why the order is being delivered without that code
 *   'failedReason'  why the goods could not be delivered
 *
 * WHY A SHEET AND NOT A PANEL ON THE CARD
 * ---------------------------------------
 * The code is typed, and this app builds edge-to-edge: the window is not resized
 * for the keyboard (see ui/KeyboardAwareScroll.js). A field inside a card in the
 * order FlatList would sit under the keyboard unless the list were padded and
 * scrolled to it by hand. A sheet is lifted clear of the keyboard by the same
 * `SheetLayer` the pickers use, so that arithmetic exists once. Everything below
 * the title scrolls, so on a short phone with the keypad up the buttons are
 * reachable rather than cut off.
 *
 * NOTHING IS ASSUMED TO HAVE WORKED
 * ---------------------------------
 * A wrong code is an ordinary outcome, so the sheet does not close and the card
 * behind it does not move until the server accepts. A refusal is shown HERE, in
 * the sheet: a toast is drawn by the app's root view, which is underneath a
 * Modal, so the seller would be looking at a dimmed message behind the scrim.
 *
 *   - wrong code  → the field is emptied, stays focused, and says how many
 *                   tries are left
 *   - locked      → the field is switched off until the lock ends, with the
 *                   time; "Deliver without code" stays available
 *   - anything else → the reason, under the field or above the button
 *
 * The seller is never shown the code — the server only ever sends it to the
 * farmer — so there is nothing here to compare against, only the answer.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import { Haptics } from '@krushisarva/shared/utils/haptics';

import { C, E, HIT, R, SP, T, orderStatusLabel } from '../theme';
import {
  FAILED_REASONS, cleanDeliveryCode, isCompleteCode, lockEndsAt, lockedText, noCodeReasonOptions,
} from '../utils/orderDelivery';
import { Button, Field, IconButton, InlineNotice, OptionRow, TextField } from './ui';
import { SheetLayer } from './ui/SelectSheet';

// Every reason carries an icon as well as its sentence: a selected row is told
// apart by its radio mark and fill, never by colour alone.
const NO_CODE_COPY = {
  FARMER_PHONE_OFF:  { icon: 'phone-portrait-outline', tKey: 'sellerOrders.noCodePhoneOff', fallback: 'The farmer’s phone is off or not with them' },
  RECEIVED_BY_OTHER: { icon: 'people-outline', tKey: 'sellerOrders.noCodeReceivedByOther', fallback: 'Someone else received it for the farmer' },
  HANDED_AT_SHOP:    { icon: 'storefront-outline', tKey: 'sellerOrders.noCodeHandedAtShop', fallback: 'Handed over at my shop' },
  OTHER:             { icon: 'ellipsis-horizontal-circle-outline', tKey: 'sellerOrders.noCodeOther', fallback: 'Another reason' },
};

const FAILED_COPY = {
  REFUSED:           { icon: 'hand-left-outline', tKey: 'sellerOrders.failedRefused', fallback: 'The farmer refused the order' },
  UNREACHABLE:       { icon: 'call-outline', tKey: 'sellerOrders.failedUnreachable', fallback: 'Could not reach the farmer' },
  ADDRESS_NOT_FOUND: { icon: 'location-outline', tKey: 'sellerOrders.failedAddressNotFound', fallback: 'Could not find the address' },
};

// A field focused the instant a Modal reports itself shown can lose the
// keyboard on Android: the dialog window is up but not yet taking input.
const FOCUS_DELAY_MS = 120;

/**
 * @param request   null (closed) or `{ key, orderId, to, step, hasCode, lockedUntil }`
 * @param busy      the status request for this order is in flight
 * @param offline   no connection — nothing can be sent
 * @param onSubmit  (request, sent) => Promise<{ ok, refusal?, message? }>. `sent`
 *                  is `{ deliveryCode }`, `{ noCodeReason }` or `{ failedReason }`.
 *                  The owner closes the sheet when it resolves ok.
 */
export default function OrderActionSheet({ request, busy = false, offline = false, onClose, onSubmit }) {
  const inputRef = useRef(null);
  const focusTimer = useRef(null);
  useEffect(() => () => clearTimeout(focusTimer.current), []);

  // iOS keeps a Modal's children mounted while it slides away; the last request
  // is held so the sheet leaves with its content instead of emptying first.
  const shownRef = useRef(request);
  if (request) shownRef.current = request;
  const shown = request || shownRef.current;

  // Not while a request is in flight: the answer would arrive with nowhere to
  // be shown, and the seller would not know whether the order was delivered.
  const close = useCallback(() => { if (!busy) onClose?.(); }, [busy, onClose]);

  const handleShow = useCallback(() => {
    clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => inputRef.current?.focus?.(), FOCUS_DELAY_MS);
  }, []);

  return (
    <Modal
      visible={!!request}
      transparent
      animationType="slide"
      statusBarTranslucent
      // Android hardware back.
      onRequestClose={close}
      onShow={handleShow}
    >
      {shown ? (
        <SheetLayer>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={close}
            accessible={false}
            importantForAccessibility="no"
          >
            <View style={s.backdrop} />
          </Pressable>

          {/* Keyed per opening, so a code typed for one order — or a refusal
              shown for it — is never still there when the next one opens. */}
          <SheetBody
            key={shown.key ?? `${shown.orderId}:${shown.to}`}
            request={shown}
            busy={busy}
            offline={offline}
            inputRef={inputRef}
            onClose={close}
            onSubmit={onSubmit}
          />
        </SheetLayer>
      ) : null}
    </Modal>
  );
}

function SheetBody({ request, busy, offline, inputRef, onClose, onSubmit }) {
  const { t } = useLanguage();

  const [step, setStep] = useState(request.step);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState(null);
  const [error, setError] = useState(null);
  const [lockedUntil, setLockedUntil] = useState(request.lockedUntil ?? null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // The lock ends on its own. One timer at that moment re-renders the sheet so
  // the field comes back; nothing ticks while the seller waits.
  const [, setUnlockedAt] = useState(0);
  const lockEnd = lockEndsAt(lockedUntil, Date.now());
  useEffect(() => {
    if (!lockEnd) return undefined;
    const timer = setTimeout(() => setUnlockedAt(Date.now()), Math.max(0, lockEnd - Date.now()) + 250);
    return () => clearTimeout(timer);
  }, [lockEnd]);
  const locked = !!lockEnd;

  const failed = step === 'failedReason';
  const title = step === 'code'
    ? t('sellerOrders.codeTitle', 'Enter the delivery code')
    : failed
      ? t('sellerOrders.couldNotDeliver', 'Could not deliver')
      : t('sellerOrders.noCodeTitle', 'Deliver without code');

  // A Modal opening is silent to a screen reader unless it is announced.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility?.(title);
  }, [title]);

  // One request at a time. Button guards its own taps, but the keypad's "done"
  // key submits too, and a second code attempt sent while the first is in
  // flight would spend a try the seller never meant to make.
  const sending = useRef(false);
  const submit = useCallback(async (sent) => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    let result;
    try {
      result = await onSubmit(request, sent);
    } finally {
      sending.current = false;
    }
    if (!mounted.current || !result || result.ok) return;

    Haptics.error();
    const refusal = result.refusal;
    if (refusal?.lockedUntil) setLockedUntil(refusal.lockedUntil);
    // The digits were wrong; leaving them means four backspaces before the
    // farmer can be asked again.
    if (refusal?.code === 'DELIVERY_CODE_WRONG' || refusal?.code === 'DELIVERY_CODE_LOCKED') setCode('');
    // A lock that is still running is said by its own notice, with the time.
    setError(lockEndsAt(refusal?.lockedUntil, Date.now())
      ? null
      : result.message || t('orders.updateStatusError', 'Could not update this order.'));
  }, [onSubmit, request, t]);

  // Both return the request's promise, which is what holds Button's own
  // double-tap guard shut until the server has answered.
  const submitCode = useCallback(() => {
    // The keypad's "done" key reaches here even when the button is disabled.
    if (offline || locked) return undefined;
    if (!isCompleteCode(code)) {
      setError(t('sellerOrders.codeIncomplete', 'Enter all 4 digits of the code.'));
      return undefined;
    }
    return submit({ deliveryCode: code });
  }, [code, locked, offline, submit, t]);

  const submitReason = useCallback(() => {
    if (!reason) {
      // Said in words rather than by a greyed-out button that explains nothing.
      setError(t('sellerOrders.reasonMissing', 'Choose a reason first.'));
      return undefined;
    }
    return submit(failed ? { failedReason: reason } : { noCodeReason: reason });
  }, [failed, reason, submit, t]);

  const goNoCode = useCallback(() => {
    Keyboard.dismiss();
    setError(null);
    setReason(null);
    setStep('noCodeReason');
  }, []);

  const goCode = useCallback(() => {
    setError(null);
    setStep('code');
  }, []);

  const deliveredLabel = t('orders.markAs', { status: orderStatusLabel('DELIVERED', t) });
  const codeLabel = t('sellerOrders.codeLabel', 'Delivery code');
  const codeHint = t('sellerOrders.codeHint', 'Ask the farmer for the 4-digit code shown on their order in the app.');

  const options = failed ? FAILED_REASONS : noCodeReasonOptions(request.hasCode);
  const optionCopy = failed ? FAILED_COPY : NO_CODE_COPY;
  const reasonsLabel = failed
    ? t('sellerOrders.failedReasonsLabel', 'Why could it not be delivered?')
    : t('sellerOrders.noCodeReasonsLabel', 'Why is there no code?');

  return (
    <View style={s.sheet} accessibilityViewIsModal>
      <View style={s.handle} />
      <View style={s.head}>
        <Text style={s.title} accessibilityRole="header">{title}</Text>
        {/* The backdrop is hidden from screen readers, so closing needs a
            control of its own. */}
        <IconButton
          icon="close"
          size={20}
          color={C.textBody}
          background={C.surfaceSunken}
          onPress={onClose}
          disabled={busy}
          accessibilityLabel={t('sellerOrders.close', 'Close')}
          buttonStyle={s.closeBtn}
        />
      </View>
      <View style={s.rule} />

      <ScrollView
        style={s.body}
        contentContainerStyle={s.bodyContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {offline ? (
          <InlineNotice variant="warning" style={s.notice}>
            {t('common.offlineAction', 'You are offline. Reconnect to save this.')}
          </InlineNotice>
        ) : null}

        {step === 'code' ? (
          <>
            {locked ? (
              <InlineNotice variant="warning" icon="lock-closed" style={s.notice}>
                {lockedText(lockedUntil, t)}
              </InlineNotice>
            ) : null}

            <Field label={codeLabel} error={error} hint={codeHint}>
              <TextField
                ref={inputRef}
                value={code}
                onChangeText={(v) => { setCode(cleanDeliveryCode(v)); if (error) setError(null); }}
                keyboardType="number-pad"
                // Longer than 4: Android cuts a paste to maxLength before
                // onChangeText sees it, so "12 34" would arrive as "12 3".
                maxLength={8}
                // Stays editable while the request is in flight: switching it
                // off drops the keyboard, and the sheet would fall and rise
                // again around every wrong code.
                editable={!locked}
                autoCapitalize="none"
                autoCorrect={false}
                // Not a one-time password: the keyboard must not offer to fill
                // it from an SMS or remember it.
                autoComplete="off"
                importantForAutofill="no"
                returnKeyType="done"
                onSubmitEditing={submitCode}
                error={error}
                label={codeLabel}
                accessibilityHint={codeHint}
                inputStyle={s.codeInput}
                testID="delivery-code-input"
              />
            </Field>

            <Button
              label={deliveredLabel}
              icon="bag-check-outline"
              size="lg"
              fullWidth
              loading={busy}
              disabled={offline || locked}
              onPress={submitCode}
              testID="delivery-code-submit"
            />
            <Button
              label={t('sellerOrders.deliverWithoutCode', 'Deliver without code')}
              variant="ghost"
              size="md"
              fullWidth
              disabled={busy}
              onPress={goNoCode}
              accessibilityHint={t('sellerOrders.deliverWithoutCodeHint', 'Asks why the farmer cannot give the code')}
              style={s.second}
              testID="delivery-no-code"
            />
          </>
        ) : (
          <>
            <InlineNotice variant={failed ? 'warning' : 'info'} style={s.notice}>
              {failed
                ? t('sellerOrders.failedExplain', 'This cancels the order. The stock goes back to your shop, and any online payment is refunded to the farmer. It cannot be undone.')
                : t('sellerOrders.noCodeExplain', 'Choose why there is no code. Deliveries without a code are recorded.')}
            </InlineNotice>

            <View style={s.options} accessibilityRole="radiogroup" accessibilityLabel={reasonsLabel}>
              {options.map((value) => (
                <OptionRow
                  key={value}
                  icon={optionCopy[value].icon}
                  title={t(optionCopy[value].tKey, optionCopy[value].fallback)}
                  selected={reason === value}
                  disabled={busy}
                  onPress={() => { setReason(value); setError(null); }}
                  testID={`delivery-reason-${value}`}
                />
              ))}
            </View>

            {error ? <InlineNotice variant="error" style={s.notice}>{error}</InlineNotice> : null}

            <Button
              label={failed ? t('sellerOrders.markUndelivered', 'Mark as not delivered') : deliveredLabel}
              icon={failed ? 'close-circle-outline' : 'bag-check-outline'}
              variant={failed ? 'danger' : 'primary'}
              haptic={failed ? 'warning' : 'light'}
              size="lg"
              fullWidth
              loading={busy}
              disabled={offline}
              onPress={submitReason}
              testID="delivery-reason-submit"
            />
            {/* Only when this step was reached from the code: an order that
                never had a code has nothing to go back to. */}
            {!failed && request.step === 'code' ? (
              <Button
                label={t('sellerOrders.enterCodeInstead', 'Enter the code instead')}
                variant="ghost"
                size="md"
                fullWidth
                disabled={busy}
                onPress={goCode}
                style={s.second}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: C.overlay },

  // The same sheet chrome as ui/SelectSheet: the app's deepest radius, a handle,
  // a left-aligned Fraunces title over a rule.
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: R.xxl,
    borderTopRightRadius: R.xxl,
    borderTopWidth: 1,
    borderColor: C.border,
    maxHeight: '85%',
    // Shrinks into the room above the keyboard; SheetLayer adds the bottom inset.
    flexShrink: 1,
    paddingBottom: SP.lg,
    ...E.float,
  },
  handle: {
    width: 48, height: 5, borderRadius: R.pill,
    backgroundColor: C.borderStrong,
    alignSelf: 'center', marginTop: SP.md,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP.md,
    paddingHorizontal: SP.xl,
    paddingTop: SP.md,
  },
  title: { ...T.heading, flex: 1, color: C.text },
  closeBtn: { width: HIT.min, height: HIT.min, borderRadius: R.md },
  rule: { height: 1, backgroundColor: C.border, marginHorizontal: SP.xl, marginTop: SP.md },

  // The body gives up height first, so it scrolls above the keyboard instead of
  // pushing the title off the top.
  body: { flexShrink: 1 },
  bodyContent: { paddingHorizontal: SP.xl, paddingTop: SP.lg, paddingBottom: SP.xs },
  notice: { marginBottom: SP.lg },
  options: { gap: SP.sm, marginBottom: SP.lg },
  second: { marginTop: SP.sm },

  // Four digits read back to a farmer across a doorway: the figure face, large,
  // spaced so each digit is its own shape. The left padding balances the
  // tracking, which Android adds after the last digit too.
  codeInput: {
    ...T.figureMd,
    color: C.text,
    textAlign: 'center',
    letterSpacing: 10,
    paddingLeft: 10,
  },
});
