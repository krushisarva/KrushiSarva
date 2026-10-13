/**
 * PopupHost — draws the pop-ups raised with showPopup() (utils/popup.js).
 *
 * Mounted ONCE, at the root of the app (App.js). It is the app's replacement
 * for every system alert: a card in KrushiSarva's own style — the same card the
 * logout confirmation on the profile screen has always used — instead of the
 * phone's grey dialog, and it works in a browser, where Alert.alert does nothing.
 *
 * WHAT IT GUARANTEES
 *   - one pop-up at a time, oldest first (the queue lives in utils/popup.js)
 *   - exactly one filled button, so the action is obvious at arm's length;
 *     "cancel" is quiet and "destructive" is red AND says what it does in words
 *   - every button is at least 48dp tall and is announced as a button
 *   - a long message scrolls inside the card instead of pushing the buttons off
 *     a small screen — the buttons are the part that must always be reachable
 *   - Android back / browser Escape takes the "cancel" way out (see dismissPopup)
 *   - a tap outside does nothing unless the pop-up was raised as cancelable: a
 *     stray thumb must not answer a question, or dismiss a message unread
 *
 * It is a React Native <Modal>, not a view laid over the screen, so that it
 * also appears above a sheet or form that is itself a Modal — which is where
 * many of these are raised from (an address form's "enter a valid PIN code").
 *
 * The <Modal> is MOUNTED only while there is a pop-up, not kept mounted and
 * hidden. In a browser every Modal is a <div> added to the end of <body> when
 * it mounts, all at the same z-index, so the one mounted LAST is on top. A host
 * mounted once at app start would sit under every sheet opened after it: the
 * message hidden behind the form it is about, and unclickable. Mounting on
 * demand makes the pop-up the newest Modal each time it is raised.
 *
 * Each pop-up gets a Modal of its own (keyed by its id) for the same reason: a
 * pop-up that was waiting its turn must still come out on top of whatever was
 * opened while it waited, and the fade between two pop-ups is what tells the
 * farmer the words have changed.
 *
 * BEFORE AN iOS RELEASE — never run on an iPhone, and this WILL NOT hold there.
 * UIKit refuses to present a root-level Modal while another one is presented or
 * still animating away, and React Native marks it presented anyway. So a
 * pop-up raised (a) from inside an open sheet, (b) in the same moment another
 * Modal closes — the "Confirming your payment" overlay — or (c) within ~0.3s of
 * the previous pop-up closing never appears, stays at the head of the queue,
 * and every later pop-up is lost until the app is restarted. On iOS draw the
 * card in react-native-screens' <FullWindowOverlay> instead of a <Modal>, and
 * run a button's handler only after the card has gone (a handler that opens
 * the camera must not do it mid-dismissal). Android and web are not affected.
 */
import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import { KHET, KFONT, KSHADOW } from '@krushisarva/shared/constants/khetTheme';
import {
  buttonLooks, clearPopups, currentPopup, dismissPopup, pressPopupButton, subscribePopups,
} from '../utils/popup';

/**
 * A press this soon after a pop-up appears is not an answer to it.
 *
 * It is the second half of a double tap: on the button that opened the pop-up,
 * or on the pop-up before this one, whose buttons were in the same place. With
 * no gap, a double tap on "Delete" in the farm menu lands on "Delete" in the
 * "Delete farm?" question that replaces it — answered before it was read.
 * Nobody reads a question and answers it in a third of a second.
 */
export const POPUP_SETTLE_MS = 350;

const noPopup = () => null;

export default function PopupHost() {
  const { t } = useLanguage();
  const popup = useSyncExternalStore(subscribePopups, currentPopup, noPopup);
  const id = popup?.id ?? null;

  // When the pop-up now on screen got there.
  const shown = useRef({ id: null, at: 0 });
  if (shown.current.id !== id) shown.current = { id, at: Date.now() };
  const settled = useCallback(() => Date.now() - shown.current.at >= POPUP_SETTLE_MS, []);

  const handleBack = useCallback(() => {
    if (id != null && settled()) dismissPopup(id);
  }, [id, settled]);

  // The host only goes away when the error screen replaces the whole app; what
  // is still queued then belongs to screens that no longer exist.
  useEffect(() => clearPopups, []);

  // No pop-up, no Modal — see "MOUNTED only while there is a pop-up" above.
  if (!popup) return null;

  const { buttons } = popup;
  const looks = buttonLooks(buttons);
  // Two buttons sit side by side; three or more are stacked, because three
  // labels in one row leave none of them room to be read in Marathi.
  const stacked = buttons.length > 2;

  return (
    <Modal
      // One Modal per pop-up, except on iOS, where closing one Modal and
      // opening the next in the same moment is the very thing UIKit refuses.
      key={Platform.OS === 'ios' ? 'popup' : id}
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleBack}
    >
      <View style={s.backdrop}>
        {/* The dimmed area can be pressed only for a cancelable pop-up, so it
            is only there for one: in a browser an always-present pressable
            takes the first keyboard focus and shows a hand cursor over
            something that does nothing. Screen readers reach the buttons. */}
        {popup.cancelable ? (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={handleBack}
            focusable={false}
            accessible={false}
            importantForAccessibility="no"
            testID="popup-backdrop"
          />
        ) : null}

        <View
          style={s.card}
          accessibilityViewIsModal
          accessibilityRole="alert"
          accessibilityLabel={[popup.title, popup.message].filter(Boolean).join('. ')}
        >
          {popup.title ? (
            <Text style={s.title} accessibilityRole="header">{popup.title}</Text>
          ) : null}

          {popup.message ? (
            <ScrollView
              style={s.messageScroll}
              contentContainerStyle={s.messageContent}
              // The scrollbar is the only sign that a long message goes on.
              persistentScrollbar
            >
              <Text style={[s.message, !popup.title && s.messageAlone]}>{popup.message}</Text>
            </ScrollView>
          ) : null}

          <View style={[s.buttons, stacked ? s.buttonsStacked : s.buttonsRow]}>
            {buttons.map((button, index) => {
              const look = looks[index];
              const label = button.text || t('ok', 'OK');
              return (
                <TouchableOpacity
                  // Index is the identity: a pop-up's buttons never reorder.
                  key={`${popup.id}:${index}`}
                  style={[s.button, !stacked && s.buttonInRow, BUTTON_STYLE[look]]}
                  activeOpacity={0.85}
                  onPress={() => { if (settled()) pressPopupButton(popup.id, index); }}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  testID={`popup-button-${index}`}
                >
                  {/* Never clipped: at a large font size a clipped label loses
                      its last word, which in Marathi is the verb. A long label
                      makes a taller button instead. */}
                  <Text style={[s.buttonText, BUTTON_TEXT_STYLE[look]]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  // The same backdrop, card, title and message as the profile screen's logout
  // confirmation, so the app has one pop-up and not two that nearly match.
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center', alignItems: 'center', padding: 32,
  },
  card: {
    width: '100%', maxWidth: 360, maxHeight: '86%',
    backgroundColor: KHET.card, borderRadius: 24,
    paddingHorizontal: 24, paddingTop: 24, paddingBottom: 20,
    borderWidth: 1, borderColor: KHET.border,
    ...KSHADOW.elegant,
  },
  title: {
    fontSize: 20, fontFamily: KFONT.displaySemi, color: KHET.foreground,
    textAlign: 'center', letterSpacing: -0.3, marginBottom: 6,
  },
  // Gives up height before the buttons do — but never all of it: on a very
  // short screen (split-screen) one line stays, and it scrolls.
  messageScroll: { flexGrow: 0, flexShrink: 1, minHeight: 22 },
  messageContent: { flexGrow: 1 },
  message: {
    fontSize: 14, fontFamily: KFONT.sans, color: KHET.mutedForeground,
    textAlign: 'center', lineHeight: 20,
  },
  // With no title the message is the whole pop-up, so it is set as one.
  messageAlone: { fontSize: 15, color: KHET.foreground, lineHeight: 22 },

  buttons: { marginTop: 22, width: '100%' },
  buttonsRow: { flexDirection: 'row', gap: 12 },
  buttonsStacked: { flexDirection: 'column', gap: 10 },
  button: {
    minHeight: 48, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
  },
  // minWidth 0 lets a long label wrap inside its half instead of widening it.
  buttonInRow: { flex: 1, minWidth: 0 },
  buttonText: { fontSize: 15, textAlign: 'center' },

  cancel: { backgroundColor: KHET.muted, borderWidth: 1, borderColor: KHET.border },
  cancelText: { fontFamily: KFONT.sansSemi, color: KHET.foreground },
  secondary: { backgroundColor: KHET.card, borderWidth: 1.5, borderColor: KHET.primary },
  secondaryText: { fontFamily: KFONT.sansSemi, color: KHET.primary },
  primary: { backgroundColor: KHET.primary },
  primaryText: { fontFamily: KFONT.sansBold, color: KHET.white },
  destructive: { backgroundColor: KHET.destructive },
  destructiveText: { fontFamily: KFONT.sansBold, color: KHET.white },
  // A destructive choice in a menu: red, but not the button that asks to be hit.
  danger: { backgroundColor: KHET.card, borderWidth: 1.5, borderColor: KHET.destructive },
  dangerText: { fontFamily: KFONT.sansSemi, color: KHET.destructive },
});

const BUTTON_STYLE = {
  cancel: s.cancel, secondary: s.secondary, primary: s.primary, destructive: s.destructive,
  danger: s.danger,
};
const BUTTON_TEXT_STYLE = {
  cancel: s.cancelText, secondary: s.secondaryText, primary: s.primaryText, destructive: s.destructiveText,
  danger: s.dangerText,
};
