import fs from 'fs';
import path from 'path';
import {
  _resetFocusOwner, blurField, focusField, getFocusOwner, nextFieldId, subscribeFocusOwner,
} from '../fieldFocus';

beforeEach(() => _resetFocusOwner());

test('ids are unique per field instance', () => {
  expect(nextFieldId()).not.toBe(nextFieldId());
});

test('focus takes the ring, blur gives it back', () => {
  const a = nextFieldId();
  focusField(a);
  expect(getFocusOwner()).toBe(a);
  blurField(a);
  expect(getFocusOwner()).toBeNull();
});

test('only one field owns the ring at a time', () => {
  const a = nextFieldId();
  const b = nextFieldId();
  focusField(a);
  focusField(b);
  expect(getFocusOwner()).toBe(b);
});

test('a late blur from the field just left does not take the ring off the new one', () => {
  // Android can deliver A's blur after B's focus. Before the single owner, that
  // switched off the ring the user was actually typing in.
  const a = nextFieldId();
  const b = nextFieldId();
  focusField(a);
  focusField(b);
  blurField(a);
  expect(getFocusOwner()).toBe(b);
});

test('subscribers are told when the owner changes, and not when it does not', () => {
  const a = nextFieldId();
  const seen = [];
  const stop = subscribeFocusOwner(() => seen.push(getFocusOwner()));

  focusField(a);
  focusField(a);          // already the owner — no second notification
  blurField(nextFieldId()); // someone else's blur — ignored
  blurField(a);
  stop();
  focusField(a);          // after unsubscribing

  expect(seen).toEqual([a, null]);
});

test('an empty id is ignored rather than becoming the owner', () => {
  const a = nextFieldId();
  focusField(a);
  focusField(null);
  expect(getFocusOwner()).toBe(a);
  blurField(undefined);
  expect(getFocusOwner()).toBe(a);
});

// The TextField's <input> (../Form.js) is a flex child of the bordered shell.
// On the web an <input> will not shrink below the width of 20 characters in its
// own font, so the delivery code's large, widely spaced digits made it wider
// than a phone-width shell: the input stuck out of its own border, the centred
// digits sat off-centre and the sheet scrolled sideways.
test('the text field input may shrink to its shell', () => {
  const form = fs.readFileSync(path.join(__dirname, '../Form.js'), 'utf8');
  const input = /\n  input: \{([\s\S]*?)\n  \},/.exec(form);
  expect(input).not.toBeNull();
  expect(input[1]).toMatch(/\bflex: 1,/);
  expect(input[1]).toMatch(/\bminWidth: 0,/);
});
