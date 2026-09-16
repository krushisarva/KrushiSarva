/**
 * KeyboardAwareScroll — the scroll container every seller form sits in.
 *
 * WHY: Expo SDK 54 builds Android edge-to-edge, so the window is NOT resized
 * when the keyboard opens, and the forms' KeyboardAvoidingView was switched off
 * on Android. Every field in the lower half of a form (bank account, IFSC,
 * Aadhaar, PAN, price, stock…) sat under the keyboard, and the form had no room
 * to scroll it out. The login and onboarding screens had the same bug; this uses
 * the same fix (shared/hooks/useKeyboardRoom.js):
 *
 *   - Android: the scroll viewport is padded by the strip the keyboard covers,
 *     so the whole form stays scrollable above it.
 *   - iOS: KeyboardAvoidingView pads, as before.
 *   - The focused field is scrolled into view when the keyboard opens and when
 *     focus moves with the keyboard already open (TextField calls reveal()).
 *   - Dragging does not dismiss the keyboard on Android: a tap that moved a few
 *     pixels counted as a drag and blurred the field being tapped.
 *
 * Accepts ScrollView props; the ref is the ScrollView (scrollTo, getInnerViewRef).
 */
import React, { createContext, forwardRef, useCallback, useContext, useRef } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardRoom } from '@krushisarva/shared/hooks/useKeyboardRoom';
import { revealScrollOffset } from '@krushisarva/shared/utils/keyboardInset';

const IS_ANDROID = Platform.OS === 'android';
const IS_WEB = Platform.OS === 'web';
// Space kept between the focused field and the keyboard.
const REVEAL_MARGIN = 24;

const RevealContext = createContext(null);

/** () => void that scrolls the focused field into view, or null outside a form. */
export function useRevealFocusedField() {
  return useContext(RevealContext);
}

const KeyboardAwareScroll = forwardRef(function KeyboardAwareScroll({
  children,
  style,
  keyboardVerticalOffset = 0,
  onLayout,
  onScroll,
  ...scrollProps
}, ref) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardRoom(insets.bottom);
  const scrollRef = useRef(null);
  const viewportRef = useRef(0);
  const scrollYRef = useRef(0);

  const setScrollRef = useCallback((node) => {
    scrollRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  const reveal = useCallback(() => {
    if (IS_WEB) return;
    requestAnimationFrame(() => {
      const field = TextInput.State?.currentlyFocusedInput?.();
      const scroller = scrollRef.current;
      if (!field || !scroller || !keyboard.visibleRef.current) return;
      const inner = scroller.getInnerViewRef?.();
      if (!inner || typeof field.measureLayout !== 'function') return;
      field.measureLayout(
        inner,
        (_x, y, _w, h) => {
          const target = revealScrollOffset({
            blockTop: y,
            blockHeight: h,
            viewportHeight: viewportRef.current,
            scrollY: scrollYRef.current,
            margin: REVEAL_MARGIN,
          });
          if (target != null) scroller.scrollTo({ y: target, animated: true });
        },
        () => {},
      );
    });
  }, [keyboard.visibleRef]);

  // The viewport shrinks when room is made for the keyboard — that is when a
  // field the keyboard just covered can be brought back into view.
  const handleLayout = useCallback((e) => {
    const h = e.nativeEvent.layout.height;
    const shrank = viewportRef.current > 0 && h < viewportRef.current - 1;
    viewportRef.current = h;
    if (shrank) reveal();
    onLayout?.(e);
  }, [reveal, onLayout]);

  const handleScroll = useCallback((e) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y;
    onScroll?.(e);
  }, [onScroll]);

  return (
    <View style={[{ flex: 1 }, style]} onLayout={keyboard.onRootLayout}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardVerticalOffset}
        style={[{ flex: 1 }, IS_ANDROID ? { paddingBottom: keyboard.inset } : null]}
      >
        <RevealContext.Provider value={reveal}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
            {...scrollProps}
            ref={setScrollRef}
            onLayout={handleLayout}
            onScroll={handleScroll}
            scrollEventThrottle={32}
          >
            {children}
          </ScrollView>
        </RevealContext.Provider>
      </KeyboardAvoidingView>
    </View>
  );
});

export default KeyboardAwareScroll;
