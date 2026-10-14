/**
 * WEB ONLY — the CSS that stops a text field from showing two borders.
 *
 * A text input is `:focus-visible` on EVERY focus — a mouse click and a tap
 * included, not just the Tab key. So whatever ring is drawn for keyboard focus
 * is drawn on a text field every time someone types in it, on top of the
 * border the field already has:
 *
 *   - the browser's own ring (black in Chrome) round the bare <input> that
 *     react-native-web renders — INSIDE the rounded search bar or field shell
 *     that holds it, or hugging the input's own border;
 *   - in the seller app, the ember ring App.js gives every keyboard-focused
 *     control, drawn the same way.
 *
 * Either way one field showed two borders. The fix is one rule, in one place,
 * injected by both apps: a text field never draws a ring of its own. Its focus
 * is shown by the field itself — the caret, and the field's own focus look
 * where the screen gives it one (the seller app's TextField, the sign-in
 * phone box, the store search bar) — which is exactly what the Android app
 * shows, where there has never been a ring.
 *
 * Only text-entry controls. A checkbox, radio or slider is not `:focus-visible`
 * on a click, has no border of ours to double, and keeps its keyboard ring.
 *
 * No React, no react-native: plain strings, so the node Jest config tests them.
 */

/** <input> types that are NOT text entry — they keep the keyboard ring. */
const NON_TEXT_INPUT_TYPES = ['checkbox', 'radio', 'range'];

const notNonText = NON_TEXT_INPUT_TYPES.map((type) => `:not([type="${type}"])`).join('');

/** Matches a focused text field: every text-like <input>, and <textarea>. */
export const TEXT_FIELD_FOCUS_SELECTOR = `input${notNonText}:focus, textarea:focus`;

/**
 * The rule itself. Both apps append it to the stylesheet they already inject
 * at start-up (frontend/App.js, seller-app/App.js).
 */
export const TEXT_FIELD_NO_RING_CSS = `${TEXT_FIELD_FOCUS_SELECTOR} { outline: none; }`;

/**
 * Everything that SHOULD get an app-drawn keyboard ring: any keyboard-focused
 * element that is not a text field. For an app that draws its own ring (the
 * seller app) — so the ring's other declarations, such as its corner radius,
 * never touch a text field either.
 */
export const KEYBOARD_RING_SELECTOR = [
  ':focus-visible:not(input):not(textarea)',
  ...NON_TEXT_INPUT_TYPES.map((type) => `input[type="${type}"]:focus-visible`),
].join(', ');
