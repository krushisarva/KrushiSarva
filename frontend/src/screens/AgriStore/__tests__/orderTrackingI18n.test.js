/**
 * Every key the order tracking timeline can show exists in English, Hindi and
 * Marathi, and keeps its placeholders.
 *
 * All are called with an English fallback, so a missing key never shows as a
 * raw key — it shows as English, to a farmer reading Marathi who is trying to
 * find out where their order is. That failure is silent on screen, so it is
 * caught here. The keys are read out of the source (any quote style): a step
 * added tomorrow is covered the moment it is written.
 */
import fs from 'fs';
import path from 'path';
import { translations } from '@krushisarva/shared/i18n/translations';

const SRC = path.join(__dirname, '..', '..', '..');
const FILES = [
  'screens/AgriStore/orderTracking.js',
  'components/OrderTimeline.js',
];
// Tracking draws on the wider `orders.*` family too (the status words, the
// arriving-by line, the refund lines), so every `orders.*` key in these two
// files is checked — plus the "Track order" button, which lives on the screen.
const KEY_RE = /['"`](orders\.[A-Za-z0-9_]+)['"`]/g;
const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;

const KEYS = (() => {
  const keys = new Set(['orders.trackOrder']);
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    let m;
    KEY_RE.lastIndex = 0;
    while ((m = KEY_RE.exec(src)) !== null) keys.add(m[1]);
  }
  // The refund and arriving-by lines are named in shopUtils.js, which
  // orderTracking.js calls for them.
  for (const k of ['orders.arrivingBy', 'orders.expectedLate', 'orders.refundPending', 'orders.partiallyRefunded', 'orders.refunded']) keys.add(k);
  return [...keys].sort();
})();

const resolve = (dict, key) => key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);

const placeholders = (text) => {
  const found = new Set();
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(String(text ?? ''))) !== null) found.add(m[1]);
  return [...found].sort();
};

test('the scan finds the tracking keys (a broken scan must not pass by finding none)', () => {
  expect(KEYS.length).toBeGreaterThanOrEqual(18);
  for (const k of ['orders.trackPlaced', 'orders.trackConfirmed', 'orders.trackFailed', 'orders.trackTitle',
    'orders.trackNotYet', 'orders.statusOutForDelivery', 'orders.statusDelivered', 'orders.shopNumbered']) {
    expect(KEYS).toContain(k);
  }
});

test('"Track order" is the label the screen actually uses', () => {
  const screen = fs.readFileSync(path.join(SRC, 'screens/Profile/MyOrdersScreen.js'), 'utf8');
  expect(screen).toMatch(/t\(\s*['"]orders\.trackOrder['"]\s*,\s*['"]Track order['"]\s*\)/);
});

describe.each(['en', 'hi', 'mr'])('tracking copy in %s', (lang) => {
  test('every key resolves to a string', () => {
    const missing = KEYS.filter((k) => typeof resolve(translations[lang], k) !== 'string');
    expect(missing).toEqual([]);
  });

  test('every placeholder in the English text is still in the translation', () => {
    const broken = KEYS.filter((k) => placeholders(resolve(translations.en, k)).join(',')
      !== placeholders(resolve(translations[lang], k)).join(','));
    expect(broken).toEqual([]);
  });
});

test('the new tracking strings are translated, not copies of the English', () => {
  const copied = KEYS.filter((k) => k.startsWith('orders.track')).filter((k) => {
    const en = resolve(translations.en, k);
    return resolve(translations.hi, k) === en || resolve(translations.mr, k) === en;
  });
  expect(copied).toEqual([]);
});

test('the fallback written in the code is the English in the translations', () => {
  // A fallback that drifts from the real English means the timeline says one
  // thing while the language file is loading and another once it has.
  const drifted = [];
  const src = fs.readFileSync(path.join(SRC, 'screens/AgriStore/orderTracking.js'), 'utf8');
  const re = /key:\s*'(orders\.track[A-Za-z0-9_]+)'\s*,\s*fallback:\s*'((?:[^'\\]|\\.)*)'/g;
  for (let m; (m = re.exec(src)) !== null;) {
    const en = resolve(translations.en, m[1]);
    if (en !== m[2].replace(/\\'/g, "'")) drifted.push(`${m[1]} — code says "${m[2]}", translations say "${en}"`);
  }
  expect(drifted).toEqual([]);
  expect(re.lastIndex).toBe(0);
});
