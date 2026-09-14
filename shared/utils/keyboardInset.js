// ─────────────────────────────────────────────────────────────────────────────
// Keyboard room for full-height form screens (login, onboarding profile) — pure
// geometry, no React Native import, so it runs under the node-environment jest
// config. The React side is shared/hooks/useKeyboardRoom.js.
//
// WHY THE LOGIN SCREEN MAKES ITS OWN ROOM ON ANDROID
// ─────────────────────────────────────────────────
// Expo SDK 54 builds Android edge-to-edge (gradle `edgeToEdgeEnabled=true`; RN's
// ReactActivityDelegate then calls WindowCompat.setDecorFitsSystemWindows(false)).
// In that mode the window is not resized for the soft keyboard, so
// `adjustResize` moves nothing and a field in the lower half of the screen sits
// under the keyboard. That is the bug.
//
// The history here matters, because it went wrong twice:
//   - A version that padded the scroll CONTENT by the keyboard height and then
//     called scrollToEnd() did move things, but on a short screen scrollToEnd
//     pushed the phone field off the TOP. That was read as "the window already
//     resized, so the padding counted the keyboard twice", and the padding was
//     removed — which put the field back under the keyboard.
//   - So this version (a) shrinks the scroll VIEWPORT rather than growing the
//     content, and (b) scrolls to the focused block instead of to the end.
//
// It still guards against a window that does resize: the root view's height is
// remembered while the keyboard is closed, and whatever the window gave back is
// subtracted, so the keyboard can never be counted twice.
//
// Inputs come from RN's `keyboardDidShow`: on Android `endCoordinates.height` is
// `imeInsets.bottom - systemBarInsets.bottom` (ReactRootView.checkForKeyboardEvents),
// i.e. the keyboard measured ABOVE the navigation bar. The navigation bar is
// under the keyboard too, so the covered strip is that height plus the bottom
// safe-area inset.
// ─────────────────────────────────────────────────────────────────────────────

const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Bottom padding (dp) that keeps a full-height view clear of the keyboard.
 *
 * @param keyboardHeight  keyboardDidShow endCoordinates.height (0 when hidden)
 * @param bottomInset     bottom safe-area inset (the navigation bar)
 * @param restHeight      root view height last measured with the keyboard closed
 * @param height          root view height now
 */
export function androidKeyboardInset({ keyboardHeight, bottomInset, restHeight, height }) {
  const kb = Math.max(0, num(keyboardHeight));
  if (kb === 0) return 0;
  const covered = kb + Math.max(0, num(bottomInset));
  const windowGaveBack = Math.max(0, num(restHeight) - num(height));
  return Math.max(0, Math.round(covered - windowGaveBack));
}

/**
 * Scroll offset that brings a block (the field plus its button) into view, or
 * null when it is already fully visible and nothing should move.
 *
 * A block taller than the viewport is aligned by its TOP: the field the user is
 * typing into matters more than the button under it.
 */
export function revealScrollOffset({ blockTop, blockHeight, viewportHeight, scrollY = 0, margin = 16 }) {
  if (![blockTop, blockHeight, viewportHeight].every(Number.isFinite) || viewportHeight <= 0) return null;
  const top = blockTop - margin;
  const bottom = blockTop + blockHeight + margin;
  const y = num(scrollY);

  if (top >= y && bottom <= y + viewportHeight) return null;
  if (bottom - top > viewportHeight) return Math.max(0, top);
  if (bottom > y + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return Math.max(0, top);
}
