/**
 * Every `reviews.*` key the farmer app uses exists in English, Hindi and
 * Marathi, and keeps its placeholders.
 *
 * All of them are called with an English fallback, so a missing key never shows
 * as a raw key — it shows as English, to a farmer reading Marathi. That failure
 * is silent on screen, so it is caught here instead.
 *
 * The keys are read out of the source rather than listed, in any quote style:
 * a string added to a screen tomorrow is covered the moment it is written.
 */
import fs from 'fs';
import path from 'path';
import { translations } from '@krushisarva/shared/i18n/translations';

const SRC = path.join(__dirname, '..', '..', '..');
const FILES = [
  // The star words live with the code both apps share.
  '../../shared/utils/reviewDisplay.js',
  'screens/AgriStore/reviewUtils.js',
  'screens/AgriStore/ProductReviews.js',
  'screens/Profile/MyOrdersScreen.js',
  'components/ReviewSheet.js',
];
const KEY_RE = /['"`](reviews\.[A-Za-z0-9_]+)['"`]/g;
const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;

const KEYS = (() => {
  const keys = new Set();
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    let m;
    KEY_RE.lastIndex = 0;
    while ((m = KEY_RE.exec(src)) !== null) keys.add(m[1]);
  }
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

test('the scan finds the review keys (a broken scan must not pass by finding none)', () => {
  expect(KEYS.length).toBeGreaterThanOrEqual(28);
  expect(KEYS).toContain('reviews.rateThis');
  expect(KEYS).toContain('reviews.word5');
  expect(KEYS).toContain('reviews.sectionTitle');
});

describe.each(['en', 'hi', 'mr'])('review copy in %s', (lang) => {
  test('every key the app uses resolves to a string', () => {
    const missing = KEYS.filter((k) => typeof resolve(translations[lang], k) !== 'string');
    expect(missing).toEqual([]);
  });

  test('every placeholder in the English text is still in the translation', () => {
    const broken = KEYS.filter((k) => placeholders(resolve(translations.en, k)).join(',')
      !== placeholders(resolve(translations[lang], k)).join(','));
    expect(broken).toEqual([]);
  });

  test('nothing is in the translations that no screen uses', () => {
    const unused = Object.keys(translations[lang].reviews).map((k) => `reviews.${k}`).filter((k) => !KEYS.includes(k));
    expect(unused).toEqual([]);
  });

  test('the new namespace did not replace an existing string', () => {
    expect(typeof translations[lang].reviews).toBe('object');
    expect(typeof resolve(translations[lang], 'orders.statusShipped')).toBe('string');
    expect(typeof resolve(translations[lang], 'a11y.rated')).toBe('string');
  });
});

test('the rating count reuses the label the product page already has, in all ten languages', () => {
  // `product.ratingsLabel` lives in the lazy backfill (shared/i18n/lang/backfill),
  // not in translations.js — so it is translated for every language the app
  // ships, where a new `reviews.*` key would be English for seven of them.
  const src = fs.readFileSync(path.join(SRC, 'screens/AgriStore/ProductReviews.js'), 'utf8');
  expect(src).toMatch(/t\('product\.ratingsLabel'/);
  const backfill = path.join(SRC, '..', '..', 'shared', 'i18n', 'lang', 'backfill');
  for (const lang of ['en', 'hi', 'mr', 'te', 'ta', 'kn', 'ml', 'gu', 'pa', 'bn']) {
    expect(fs.readFileSync(path.join(backfill, `${lang}.js`), 'utf8')).toMatch(/"product\.ratingsLabel":\s*"[^"]*\{\{count\}\}/);
  }
});

test('Hindi and Marathi are translated, not copies of the English', () => {
  const copied = KEYS.filter((k) => {
    const en = resolve(translations.en, k);
    return resolve(translations.hi, k) === en || resolve(translations.mr, k) === en;
  });
  expect(copied).toEqual([]);
});

test('the fallback written in the code is the English in the translations', () => {
  // A fallback that drifts from the real English means the screen says one
  // thing while the language file is loading and another once it has.
  const drifted = [];
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const re = /t\(\s*'(reviews\.[A-Za-z0-9_]+)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
    for (let m; (m = re.exec(src)) !== null;) {
      const en = resolve(translations.en, m[1]);
      if (en !== m[2].replace(/\\'/g, "'")) drifted.push(`${file}: ${m[1]} — code says "${m[2]}", translations say "${en}"`);
    }
  }
  expect(drifted).toEqual([]);
});
