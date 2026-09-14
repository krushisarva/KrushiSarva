// ─────────────────────────────────────────────────────────────────────────────
// useKeyboardRoom — how much of a full-height screen the soft keyboard covers.
//
// iOS: pair with <KeyboardAvoidingView behavior="padding">; `inset` stays 0.
// Android: Expo SDK 54 is edge-to-edge, so the window is not resized for the
// keyboard and `adjustResize` moves nothing. Pad the screen by `inset` — the
// strip the keyboard covers, net of anything the window itself gave back (see
// shared/utils/keyboardInset.js). Web: the browser handles it; nothing fires.
//
// Put `onRootLayout` on the screen's outermost view: its height with the
// keyboard closed is the reference for "did the window resize after all".
//
// Inputs inside a <Modal> are not covered: Android reports keyboard changes from
// the activity's root view, not from the dialog window a Modal opens.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { androidKeyboardInset } from '../utils/keyboardInset';

const IS_ANDROID = Platform.OS === 'android';
const IS_WEB = Platform.OS === 'web';

function initialKeyboardHeight() {
  if (IS_WEB || !Keyboard.isVisible?.()) return 0;
  const h = Keyboard.metrics?.()?.height;
  return Number.isFinite(h) ? h : 0;
}

/**
 * @param bottomInset bottom safe-area inset (the navigation bar)
 * @returns {{ inset: number, visible: boolean, visibleRef: { current: boolean }, onRootLayout: Function }}
 */
export function useKeyboardRoom(bottomInset) {
  const [keyboard, setKeyboard] = useState(() => {
    const height = initialKeyboardHeight();
    return { visible: height > 0, height };
  });
  const visibleRef = useRef(keyboard.visible);
  const [root, setRoot] = useState({ rest: 0, current: 0 });

  useEffect(() => {
    if (IS_WEB) return undefined;
    // iOS fires *Will* in step with the keyboard animation; Android only has
    // *Did*, which it emits from the layout pass that follows the IME change.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subs = [
      Keyboard.addListener(showEvent, (e) => {
        visibleRef.current = true;
        const h = e?.endCoordinates?.height;
        setKeyboard({ visible: true, height: Number.isFinite(h) ? h : 0 });
      }),
      Keyboard.addListener(hideEvent, () => {
        visibleRef.current = false;
        setKeyboard({ visible: false, height: 0 });
      }),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, []);

  // The root view's height with the keyboard closed is the reference: if the
  // window shrinks while it is open, that shrink is room already made.
  const onRootLayout = useCallback((e) => {
    const h = e.nativeEvent.layout.height;
    setRoot((prev) => {
      const rest = !visibleRef.current || prev.rest === 0 ? h : prev.rest;
      return prev.rest === rest && prev.current === h ? prev : { rest, current: h };
    });
  }, []);

  const inset = IS_ANDROID
    ? androidKeyboardInset({
      keyboardHeight: keyboard.height,
      bottomInset,
      restHeight: root.rest,
      height: root.current,
    })
    : 0;

  return { inset, visible: keyboard.visible, visibleRef, onRootLayout };
}
