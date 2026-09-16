/**
 * Which field owns the focus ring — one at a time, for the whole app.
 *
 * WHY THIS IS NOT PER-FIELD STATE: every TextField used to keep its own
 * `focused` boolean, set in its onFocus and cleared in its onBlur. Two fields
 * could therefore both believe they were focused. On Android the blur of the
 * field you are leaving can arrive after the focus of the field you are
 * entering (and, when the keyboard is dismissed by the system, sometimes not at
 * all), so the ring stayed lit on the previous field while the caret sat in the
 * next one.
 *
 * One owner fixes both halves:
 *   - focus(id) takes ownership, so a second ring cannot appear;
 *   - blur(id) releases it ONLY if that field is still the owner, so a late
 *     blur from the field you just left cannot switch off the ring you moved to.
 *
 * Module state rather than a context: focus is a device-wide fact (exactly one
 * field can hold it), and a store needs no provider around every form.
 */

let owner = null;
let seq = 0;
const listeners = new Set();

/** A stable id for one field instance. */
export function nextFieldId() {
  seq += 1;
  return `field-${seq}`;
}

export function getFocusOwner() {
  return owner;
}

export function subscribeFocusOwner(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(next) {
  if (owner === next) return;
  owner = next;
  listeners.forEach((l) => l());
}

/** This field just took focus. */
export function focusField(id) {
  if (id) set(id);
}

/** This field lost focus — ignored if focus has already moved on. */
export function blurField(id) {
  if (id && owner === id) set(null);
}

/** Test seam: forget the current owner. */
export function _resetFocusOwner() {
  owner = null;
}
