/**
 * Every `deliveryAreas.*` and `sellerOrders.*` key the seller app uses exists in
 * the three languages a Maharashtra seller is most likely to read, and keeps
 * its placeholders.
 *
 * These are all called with an English fallback, so a missing key never shows
 * as a raw key — it shows as English, to a seller reading Marathi, at a farmer's
 * gate, being asked for a delivery code. That failure is silent on screen, so it
 * is caught here instead.
 *
 * The keys are read out of the source rather than listed: a string added to a
 * screen tomorrow is covered the moment it is written, and one that is never
 * translated fails this test by name. Same idea as sellerProfileI18n.test.js.
 */
import fs from 'fs';
import path from 'path';
import { translations } from '@krushisarva/shared/i18n/translations';

const SRC = path.join(__dirname, '..', '..');
// Any quote style: a formatter that rewrites 'key' as "key" must not make every
// key in that file invisible to this scan (it did — the count check below is
// what caught it).
const KEY_RE = /['"`]((?:deliveryAreas|sellerOrders)\.[A-Za-z0-9_]+)['"`]/g;
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

const KEYS = (() => {
  const keys = new Set();
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    KEY_RE.lastIndex = 0;
    while ((m = KEY_RE.exec(src)) !== null) keys.add(m[1]);
  }
  return [...keys].sort();
})();

const resolve = (dict, key) => {
  if (typeof dict?.[key] === 'string') return dict[key];
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);
};

const placeholders = (text) => {
  const found = new Set();
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(String(text ?? ''))) !== null) found.add(m[1]);
  return [...found].sort();
};

test('the scan finds the delivery keys (a broken scan must not pass by finding none)', () => {
  expect(KEYS.length).toBeGreaterThan(80);
  expect(KEYS).toContain('deliveryAreas.title');
  expect(KEYS).toContain('sellerOrders.codeTitle');
  expect(KEYS).toContain('sellerOrders.statusOutForDelivery');
});

describe.each(['en', 'hi', 'mr'])('seller delivery copy in %s', (lang) => {
  test('every key the app uses resolves to a string', () => {
    const missing = KEYS.filter((k) => typeof resolve(translations[lang], k) !== 'string');
    expect(missing).toEqual([]);
  });

  test('every placeholder in the English text is still in the translation', () => {
    const broken = KEYS.filter((k) => {
      const want = placeholders(resolve(translations.en, k));
      const have = placeholders(resolve(translations[lang], k));
      return want.join(',') !== have.join(',');
    });
    expect(broken).toEqual([]);
  });

  test('the new namespaces did not replace an existing string', () => {
    // A new `foo: { … }` namespace silently shadows a `foo: 'text'` string.
    expect(typeof translations[lang].deliveryAreas).toBe('object');
    expect(typeof translations[lang].sellerOrders).toBe('object');
    expect(typeof resolve(translations[lang], 'orders.statusShipped')).toBe('string');
    expect(typeof resolve(translations[lang], 'sellerProfile.pushLabel')).toBe('string');
  });
});

test('Hindi and Marathi are translated, not copies of the English', () => {
  const copied = KEYS.filter((k) => {
    const en = resolve(translations.en, k);
    return resolve(translations.hi, k) === en || resolve(translations.mr, k) === en;
  });
  expect(copied).toEqual([]);
});
