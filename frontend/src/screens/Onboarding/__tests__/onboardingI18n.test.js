/**
 * No onboarding string may render as a raw translation key.
 *
 * Onboarding is the first thing a new farmer reads, in the language they just
 * picked. `t()` returns the KEY when a lookup misses, so a typo shows
 * "onboarding.fillNameDistrict" on the main button. See accountI18n.test.js for
 * the same guard on the Account tab.
 *
 * Checked: `t('key')` and `t('key', { vars })` — neither carries its own text.
 * `t('key', 'Fallback')` degrades to real English and is skipped.
 */
import fs from 'fs';
import path from 'path';
import { translations } from '@krushisarva/shared/i18n/translations';

const FRONTEND = path.resolve(__dirname, '../../../..');

// OnboardingIntroScreen is not listed: every t() call there passes English
// fallback text.
const FILES = [
  'src/screens/Onboarding/OnboardingLanguageScreen.js',
  'src/screens/Onboarding/OnboardingProfileScreen.js',
  '../shared/components/LocationPicker.js',
  '../shared/components/PincodeLocationStatus.js',
];

// t('key') or t("key") with no second argument, or with an object literal.
const NO_FALLBACK_T = /\bt\(\s*(['"])([a-zA-Z][a-zA-Z0-9_.]*)\1\s*(?:\)|,\s*\{)/g;

// Mirrors LanguageContext: a flat dotted key first (the lang/_backfill files
// store them that way), then the nested path.
const lookup = (dict, key) => {
  if (!dict) return undefined;
  if (typeof dict[key] === 'string') return dict[key];
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);
};

function keysIn(relPath) {
  const src = fs.readFileSync(path.join(FRONTEND, relPath), 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(NO_FALLBACK_T)) keys.add(m[2]);
  return [...keys];
}

describe.each(FILES)('%s', (file) => {
  const keys = keysIn(file);

  test('uses translation keys at all (the pattern still matches this file)', () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  test('every key without fallback text resolves to a string in English', () => {
    const broken = keys.filter((k) => typeof lookup(translations.en, k) !== 'string');
    expect(broken).toEqual([]);
  });
});
