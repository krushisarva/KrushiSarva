/**
 * Every review string the seller app shows exists in English, Hindi and
 * Marathi, and keeps its placeholders.
 *
 * Two namespaces: `sellerReviews.*` is the seller's own screen; `reviews.*` is
 * shared with the farmer app (the word for each star count, "N of 5 stars"), so
 * a rating reads the same on both sides of a sale.
 *
 * All are called with an English fallback, so a missing key never shows as a
 * raw key — it shows as English, to a seller reading Marathi. That is silent on
 * screen, so it is caught here. Keys are read out of the source, in any quote
 * style (a formatter that rewrites 'key' as "key" must not hide them).
 */
import fs from 'fs';
import path from 'path';
import { translations } from '@krushisarva/shared/i18n/translations';

const SRC = path.join(__dirname, '..', '..');
const SHARED = path.join(SRC, '..', '..', 'shared');
const KEY_RE = /['"`]((?:sellerReviews|reviews)\.[A-Za-z0-9_]+)['"`]/g;
const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const keysIn = (files) => {
  const keys = new Set();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    KEY_RE.lastIndex = 0;
    while ((m = KEY_RE.exec(src)) !== null) keys.add(m[1]);
  }
  return [...keys].sort();
};

// The seller app's own source, plus the shared star helpers it draws with.
const KEYS = keysIn([...sourceFiles(SRC), path.join(SHARED, 'utils', 'reviewDisplay.js')]);
const OWN = KEYS.filter((k) => k.startsWith('sellerReviews.'));

const resolve = (dict, key) => key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);

const placeholders = (text) => {
  const found = new Set();
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(String(text ?? ''))) !== null) found.add(m[1]);
  return [...found].sort();
};

test('the scan finds the keys (a broken scan must not pass by finding none)', () => {
  expect(OWN.length).toBeGreaterThanOrEqual(8);
  expect(KEYS).toContain('sellerReviews.title');
  expect(KEYS).toContain('sellerReviews.emptyBody');
  expect(KEYS).toContain('reviews.starLabel');
  expect(KEYS).toContain('reviews.word5');
});

describe.each(['en', 'hi', 'mr'])('seller review copy in %s', (lang) => {
  test('every key the app uses resolves to a string', () => {
    const missing = KEYS.filter((k) => typeof resolve(translations[lang], k) !== 'string');
    expect(missing).toEqual([]);
  });

  test('every placeholder in the English text is still in the translation', () => {
    const broken = KEYS.filter((k) => placeholders(resolve(translations.en, k)).join(',')
      !== placeholders(resolve(translations[lang], k)).join(','));
    expect(broken).toEqual([]);
  });

  test('nothing is in the seller namespace that no screen uses', () => {
    const unused = Object.keys(translations[lang].sellerReviews)
      .map((k) => `sellerReviews.${k}`).filter((k) => !OWN.includes(k));
    expect(unused).toEqual([]);
  });

  test('the new namespace did not replace an existing string', () => {
    expect(typeof translations[lang].sellerReviews).toBe('object');
    expect(typeof translations[lang].reviews).toBe('object');
    expect(typeof resolve(translations[lang], 'deliveryAreas.title')).toBe('string');
    expect(typeof resolve(translations[lang], 'sellerOrders.codeTitle')).toBe('string');
  });
});

test('Hindi and Marathi are translated, not copies of the English', () => {
  const copied = OWN.filter((k) => {
    const en = resolve(translations.en, k);
    return resolve(translations.hi, k) === en || resolve(translations.mr, k) === en;
  });
  expect(copied).toEqual([]);
});

test('the fallback written in the code is the English in the translations', () => {
  // A fallback that drifts from the real English means the screen says one thing
  // while the language file is loading and another once it has.
  const drifted = [];
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /t\(\s*(['"])(sellerReviews\.[A-Za-z0-9_]+)\1\s*,\s*(['"])((?:(?!\3)[^\\]|\\.)*)\3\s*,?\s*\)/g;
    for (let m; (m = re.exec(src)) !== null;) {
      const en = resolve(translations.en, m[2]);
      if (en !== m[4]) drifted.push(`${path.basename(file)}: ${m[2]} — code says "${m[4]}", translations say "${en}"`);
    }
  }
  expect(drifted).toEqual([]);
});
