/**
 * One border per text field on the web (shared/utils/webFocusCss.js).
 *
 * A text input is :focus-visible on EVERY focus, a mouse click included, so any
 * ring drawn for keyboard focus was drawn on a text field each time someone
 * typed in it — inside the bordered box the field already had. It was reported
 * as "double border" on the seller's delivery code, and it was on every one of
 * the ~60 text inputs in both apps.
 *
 * Whether a browser paints a ring cannot be asked of jsdom. What is pinned here
 * is everything short of that: what the rule matches, that BOTH apps inject it,
 * and that the seller app's own keyboard ring cannot reach a text field.
 */
import fs from 'fs';
import path from 'path';
import { KEYBOARD_RING_SELECTOR, TEXT_FIELD_FOCUS_SELECTOR, TEXT_FIELD_NO_RING_CSS } from '../webFocusCss';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The CSS an app injects at start-up: the template literal given to style.innerHTML. */
const injectedCss = (appFile) => {
  const m = /style\.innerHTML = `([\s\S]*?)`;/.exec(read(appFile));
  if (!m) throw new Error(`${appFile}: the injected stylesheet was not found`);
  return m[1];
};

describe('the rule', () => {
  test('switches the ring off for a focused text input and a focused textarea', () => {
    expect(TEXT_FIELD_NO_RING_CSS).toBe(`${TEXT_FIELD_FOCUS_SELECTOR} { outline: none; }`);
    const [input, textarea, ...rest] = TEXT_FIELD_FOCUS_SELECTOR.split(',').map((s) => s.trim());
    expect(rest).toEqual([]);
    expect(input).toMatch(/^input(:not\(\[type="[a-z]+"\]\))+:focus$/);
    expect(textarea).toBe('textarea:focus');
  });

  test('on :focus, not only :focus-visible — a ring must not come back for a browser that tells them apart', () => {
    expect(TEXT_FIELD_FOCUS_SELECTOR).not.toMatch(/focus-visible/);
  });

  test('leaves a checkbox, a radio button and a slider alone: they keep their keyboard ring', () => {
    for (const type of ['checkbox', 'radio', 'range']) {
      expect(TEXT_FIELD_FOCUS_SELECTOR).toContain(`:not([type="${type}"])`);
      expect(KEYBOARD_RING_SELECTOR).toContain(`input[type="${type}"]:focus-visible`);
    }
  });

  test('every kind of text input is covered — none is listed as an exception', () => {
    for (const type of ['text', 'tel', 'number', 'email', 'password', 'search', 'url']) {
      expect(TEXT_FIELD_FOCUS_SELECTOR).not.toContain(`[type="${type}"]`);
    }
  });
});

describe('the keyboard ring an app draws itself', () => {
  test('is for everything that is NOT a text field', () => {
    const [first] = KEYBOARD_RING_SELECTOR.split(',').map((s) => s.trim());
    expect(first).toBe(':focus-visible:not(input):not(textarea)');
  });

  test('no part of it can match a text input or a textarea', () => {
    for (const part of KEYBOARD_RING_SELECTOR.split(',').map((s) => s.trim())) {
      const skipsFields = part.includes(':not(input)') && part.includes(':not(textarea)');
      const namesNonText = /^input\[type="(checkbox|radio|range)"\]:focus-visible$/.test(part);
      expect(skipsFields || namesNonText).toBe(true);
    }
  });
});

describe.each(['frontend/App.js', 'seller-app/App.js'])('%s', (appFile) => {
  test('injects the rule, from the shared constant', () => {
    expect(injectedCss(appFile)).toContain('${TEXT_FIELD_NO_RING_CSS}');
    expect(read(appFile)).toMatch(/import \{[^}]*\bTEXT_FIELD_NO_RING_CSS\b[^}]*\} from '@krushisarva\/shared\/utils\/webFocusCss';/);
  });

  test('draws no focus ring of its own that could land on a text field', () => {
    // Any rule there that styles focus must go through the shared selectors: a
    // bare `:focus-visible { outline … }` is exactly what drew the second border.
    const rules = injectedCss(appFile).split('\n')
      .filter((line) => line.includes('{') && /:focus/.test(line.replace(/\$\{[A-Z_]+\}/g, '')));
    expect(rules).toEqual([]);
  });
});

test('the seller app draws its keyboard ring through the shared selector', () => {
  const css = injectedCss('seller-app/App.js');
  expect(css).toMatch(/\$\{KEYBOARD_RING_SELECTOR\} \{[^}]*outline:/);
  // …and the text-field rule comes after it in the stylesheet.
  expect(css.indexOf('${TEXT_FIELD_NO_RING_CSS}')).toBeGreaterThan(css.indexOf('${KEYBOARD_RING_SELECTOR}'));
});
