/**
 * In-app pop-ups — what this app shows instead of a system alert.
 *
 * ── Why there is no Alert.alert in this app ──────────────────────────────────
 * Every message and every "are you sure?" used to be `Alert.alert(...)`: the
 * phone's own grey system dialog. It did not look like KrushiSarva, it could not
 * be styled or translated beyond its text, and in a browser it did nothing at
 * all (react-native-web ships Alert as an empty stub) — "Cancel order" asked
 * nothing and cancelled nothing.
 *
 * `showPopup` takes the SAME arguments Alert.alert did, so a call site reads as
 * it always has:
 *
 *     showPopup('Cancel this order?', 'No money has been taken.', [
 *       { text: 'Keep order', style: 'cancel' },
 *       { text: 'Cancel order', style: 'destructive', onPress: doCancel },
 *     ]);
 *
 * and <PopupHost /> (components/PopupHost.js), mounted once at the root of the
 * app, draws it as a card in the app's own style, on Android, iOS and web alike.
 *
 * ── How it works ─────────────────────────────────────────────────────────────
 * This file is only a queue. showPopup() can be called from anywhere — a screen,
 * a hook, a plain function, before the host has even mounted — and the host
 * shows one pop-up at a time, oldest first. A second pop-up raised while one is
 * open waits its turn instead of covering it (which is what two stacked system
 * dialogs did, with the one that mattered underneath). An exact repeat of one
 * already waiting is not queued at all — see showPopup.
 *
 * No React and no react-native import here, so the plain-node Jest config can
 * test all of it.
 */

const listeners = new Set();
let queue = [];
let nextId = 1;

function emit() {
  for (const listener of [...listeners]) listener();
}

const toText = (v) => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.trim();
};

/**
 * The buttons as the host draws them.
 *
 * No buttons means one "OK", as it did for Alert.alert — `text: null` lets the
 * host print the word in the farmer's language rather than fixing it to English
 * here. Styles other than 'cancel' and 'destructive' are treated as 'default'.
 */
export function normalizeButtons(buttons) {
  const list = (Array.isArray(buttons) ? buttons : [])
    .filter((b) => b && typeof b === 'object')
    .map((b) => ({
      text: toText(b.text) || null,
      style: b.style === 'cancel' || b.style === 'destructive' ? b.style : 'default',
      onPress: typeof b.onPress === 'function' ? b.onPress : null,
    }));
  return list.length ? list : [{ text: null, style: 'default', onPress: null }];
}

/**
 * How each button should LOOK, by position.
 *
 *   'cancel'       the way out — quiet
 *   'destructive'  red, filled
 *   'primary'      green, filled — the one action the pop-up is about
 *   'secondary'    outlined — any other choice
 *   'danger'       outlined in red — a destructive choice that is not the
 *                  pop-up's one action
 *
 * At most one button is filled. A pop-up with two solid buttons has no obvious
 * answer, and the farmer reading it in sunlight should be able to tell which is
 * the action without reading either.
 *
 *   one or two buttons (a row)     the last one that is not a cancel — the
 *                                  action sits on the right, red if destructive
 *   three or more (a stack)        it is a menu, read from the top: the first
 *                                  ordinary choice is filled, and a destructive
 *                                  one is only outlined. "Delete" must never be
 *                                  the easiest thing to hit in a list of
 *                                  "Set active / Edit / Delete".
 */
export function buttonLooks(buttons) {
  const list = Array.isArray(buttons) ? buttons : [];
  const choices = [];
  list.forEach((b, i) => { if (b?.style !== 'cancel') choices.push(i); });
  const ordinary = choices.filter((i) => list[i]?.style !== 'destructive');

  let main = choices.length ? choices[choices.length - 1] : -1;
  if (list.length > 2 && choices.length > 1 && ordinary.length) main = ordinary[0];

  return list.map((b, i) => {
    if (b?.style === 'cancel') return 'cancel';
    const destructive = b?.style === 'destructive';
    if (i !== main) return destructive ? 'danger' : 'secondary';
    return destructive ? 'destructive' : 'primary';
  });
}

/**
 * Raise a pop-up. Same arguments as React Native's Alert.alert.
 *
 * @param {string} title
 * @param {string} [message]
 * @param {Array<{text?: string, style?: 'default'|'cancel'|'destructive', onPress?: Function}>} [buttons]
 * @param {{cancelable?: boolean, onDismiss?: Function}} [options]
 * ── Where it differs from Alert.alert, on purpose ────────────────────────────
 * LEAVING WITHOUT CHOOSING (Android back, Escape, a tap outside a `cancelable`
 * pop-up) presses the 'cancel' button, or the only button — see dismissPopup.
 * `onDismiss` therefore runs ONLY for a cancelable pop-up that has two or more
 * buttons and no 'cancel'. So: `style: 'cancel'` must mean "change nothing".
 * Never put it on a button that does something ("Discard"), or a stray back
 * press will do that thing.
 *
 * A REPEAT IS NOT RAISED TWICE. A pop-up that says exactly what one already
 * waiting says does not join the queue: the one waiting takes the NEW handlers
 * and its id is returned. Tapping "+" five times on a bad connection is one
 * "could not update" message, not five in a row; a double tap on "Cancel order"
 * is one question, not a second one that appears the moment the first is
 * answered and looks as if the answer did not register. The newest handlers win
 * because that is what the Android system alert did — a new alert replaced the
 * one on screen — so two quick taps on two rows still act on the row tapped last.
 *
 * @returns {number} the pop-up's id
 */
export function showPopup(title, message, buttons, options) {
  const popup = {
    title: toText(title),
    message: toText(message),
    buttons: normalizeButtons(buttons),
    cancelable: options?.cancelable === true,
    onDismiss: typeof options?.onDismiss === 'function' ? options.onDismiss : null,
  };
  popup.signature = JSON.stringify([
    popup.title, popup.message, popup.cancelable, popup.buttons.map((b) => [b.text, b.style]),
  ]);

  const waiting = queue.find((p) => p.signature === popup.signature);
  if (waiting) {
    const latest = { ...waiting, buttons: popup.buttons, onDismiss: popup.onDismiss };
    queue = queue.map((p) => (p === waiting ? latest : p));
    emit();
    return waiting.id;
  }

  popup.id = nextId++;
  queue = [...queue, popup];
  emit();
  return popup.id;
}

/** The pop-up on screen now, or null. */
export function currentPopup() {
  return queue[0] || null;
}

/** How many are waiting, including the one on screen. */
export function popupCount() {
  return queue.length;
}

/** Subscribe to changes. Returns the unsubscribe function. */
export function subscribePopups(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function take(id) {
  const popup = queue.find((p) => p.id === id);
  if (!popup) return null;
  queue = queue.filter((p) => p.id !== id);
  emit();
  return popup;
}

/**
 * The farmer pressed button `index`.
 *
 * The pop-up is removed FIRST and the handler runs after — so a handler that
 * raises another pop-up ("Order cancelled") is not stuck behind the one that
 * raised it (it still waits behind any that were already queued), and a
 * handler that throws cannot leave a pop-up stuck on screen.
 * Pressing a pop-up that is already gone does nothing: a double tap cannot run
 * a handler twice.
 */
export function pressPopupButton(id, index) {
  const popup = take(id);
  if (!popup) return false;
  popup.buttons[index]?.onPress?.();
  return true;
}

/**
 * The farmer left without choosing: the Android back button, Escape in a
 * browser, or — only for a pop-up raised as `cancelable` — a tap outside.
 *
 *   a 'cancel' button exists   → it is pressed; that is what it is for
 *   one button (a notice)      → it is pressed; there was nothing else to choose
 *   two or more, no cancel     → nothing happens unless the pop-up is cancelable,
 *                                in which case it closes and `onDismiss` runs.
 *                                A question with no way out must be answered.
 *
 * @returns {boolean} whether the pop-up closed
 */
export function dismissPopup(id) {
  const popup = queue.find((p) => p.id === id);
  if (!popup) return false;

  const cancelIndex = popup.buttons.findIndex((b) => b.style === 'cancel');
  if (cancelIndex !== -1) return pressPopupButton(id, cancelIndex);
  if (popup.buttons.length === 1) return pressPopupButton(id, 0);
  if (!popup.cancelable) return false;

  take(id);
  popup.onDismiss?.();
  return true;
}

/**
 * Drop every pop-up, answered or not, running no handler.
 *
 * For the host going away (the error screen replaced the app): the pop-ups
 * left belong to screens that no longer exist, and must not be shown — with
 * handlers bound to those dead screens — when the app comes back.
 */
export function clearPopups() {
  if (!queue.length) return;
  queue = [];
  emit();
}

/** Tests only: empty the queue and forget every listener. */
export function __resetPopupsForTests() {
  queue = [];
  listeners.clear();
  nextId = 1;
}
