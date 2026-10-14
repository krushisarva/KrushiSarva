/**
 * Every sentence the seller's order card can say about money exists in English,
 * Hindi and Marathi, and keeps its placeholders.
 *
 * These are instructions — "collect ₹609", "do not collect cash". All are
 * called with an English fallback, so a missing key never shows as a raw key:
 * it shows as English to a shopkeeper reading Marathi, at the door, with the
 * farmer waiting. That failure is silent on screen, so it is caught here. The
 * keys are read out of the source: a sentence added tomorrow is covered the
 * moment it is written.
 */
import fs from 'fs';
import path from 'path';
import { translations } from '@krushisarva/shared/i18n/translations';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'orderPayment.js'), 'utf8');
// text('sellerOrders.payX', 'English')  — the second argument may be on the next line.
const PAIR_RE = /text\(\s*'(sellerOrders\.pay[A-Za-z0-9_]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g;
const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;

const PAIRS = (() => {
  const found = new Map();
  for (let m; (m = PAIR_RE.exec(SRC)) !== null;) found.set(m[1], m[2].replace(/\\'/g, "'"));
  return found;
})();
const KEYS = [...PAIRS.keys()].sort();

const resolve = (dict, key) => key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);
const placeholders = (text) => {
  const found = new Set();
  PLACEHOLDER_RE.lastIndex = 0;
  for (let m; (m = PLACEHOLDER_RE.exec(String(text ?? ''))) !== null;) found.add(m[1]);
  return [...found].sort();
};

test('the scan finds the payment sentences (a broken scan must not pass by finding none)', () => {
  expect(KEYS.length).toBeGreaterThanOrEqual(20);
  for (const k of ['sellerOrders.payCollect', 'sellerOrders.payCollectHintMany', 'sellerOrders.payPaidHint',
    'sellerOrders.payUnpaidOnline', 'sellerOrders.payRefundPending', 'sellerOrders.payNothingDue']) {
    expect(KEYS).toContain(k);
  }
  // Nothing in the file names a payment key the scan cannot see.
  const named = new Set(SRC.match(/sellerOrders\.pay[A-Za-z0-9_]+/g));
  expect([...named].sort()).toEqual(KEYS);
});

describe.each(['en', 'hi', 'mr'])('payment sentences in %s', (lang) => {
  test('every key resolves to a string', () => {
    expect(KEYS.filter((k) => typeof resolve(translations[lang], k) !== 'string')).toEqual([]);
  });

  test('every placeholder in the English text is still in the translation', () => {
    const broken = KEYS.filter((k) => placeholders(resolve(translations.en, k)).join(',')
      !== placeholders(resolve(translations[lang], k)).join(','));
    expect(broken).toEqual([]);
  });
});

test('Hindi and Marathi are translated, not copies of the English', () => {
  const copied = KEYS.filter((k) => {
    const en = resolve(translations.en, k);
    return resolve(translations.hi, k) === en || resolve(translations.mr, k) === en;
  });
  expect(copied).toEqual([]);
});

test('the fallback written in the code is the English in the translations', () => {
  // A fallback that drifts from the real English means the card says one thing
  // while the language file is loading and another once it has.
  const drifted = KEYS
    .filter((k) => resolve(translations.en, k) !== PAIRS.get(k))
    .map((k) => `${k} — code says "${PAIRS.get(k)}", translations say "${resolve(translations.en, k)}"`);
  expect(drifted).toEqual([]);
});

test('an amount is only ever promised by a sentence that has somewhere to put it', () => {
  // The sentences that name a figure, and no others: three about cash, the two
  // "paid" titles, and the five parts an amount can be made of.
  const withAmount = KEYS.filter((k) => placeholders(resolve(translations.en, k)).includes('amount'));
  expect(withAmount).toEqual([
    'sellerOrders.payCashDelivered', 'sellerOrders.payCollect',
    'sellerOrders.payPaidAmount', 'sellerOrders.payPaidOnlineAmount',
    'sellerOrders.payPartCodFee', 'sellerOrders.payPartDelivery', 'sellerOrders.payPartDiscount',
    'sellerOrders.payPartItems', 'sellerOrders.payPartTax',
    'sellerOrders.payUnpaidOnline',
  ]);
});

test('only "collect" sentences tell the seller to take money — a paid title never does', () => {
  // The amount beside "Paid online" is information. If its wording ever grew a
  // verb like "collect" or "take", a seller could read it as an instruction.
  for (const key of ['sellerOrders.payPaidAmount', 'sellerOrders.payPaidOnlineAmount']) {
    expect(resolve(translations.en, key)).toMatch(/paid/i);
    expect(resolve(translations.en, key)).not.toMatch(/collect|take|cash/i);
  }
});
