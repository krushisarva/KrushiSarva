/**
 * @jest-environment jsdom
 */
/**
 * OrderTimeline, rendered for real (react-native-web in jsdom — the same setup
 * as ReviewSheet.test.js).
 *
 * orderTracking.test.js pins which steps an order gets. This pins what a farmer
 * is actually shown and what a screen reader says:
 *   - every step is on screen with its time, in order
 *   - a step that has not happened says so in words, not only in grey
 *   - one shop → no shop heading; several → each delivery under its shop's name
 *   - a delivery that came back says why
 *   - the words come from the language file (Marathi stays Marathi)
 *
 * `t` here reads the REAL translations, so a key the component asks for that
 * the language file does not have shows up as English in the Marathi test.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import OrderTimeline from '../OrderTimeline';
import { formatTrackTime } from '../../screens/AgriStore/orderTracking';
import { translations } from '@krushisarva/shared/i18n/translations';

jest.mock('react-native', () => jest.requireActual('react-native-web/dist/cjs/index.js'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@krushisarva/shared/context/LanguageContext', () => {
  const { translations: dict } = jest.requireActual('@krushisarva/shared/i18n/translations');
  const state = { lang: 'en' };
  // One function for the life of the test file, as the real context gives.
  const t = (key, fallbackOrVars) => {
    const found = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict[state.lang]);
    const vars = fallbackOrVars && typeof fallbackOrVars === 'object' ? fallbackOrVars : {};
    const fallback = typeof fallbackOrVars === 'string' ? fallbackOrVars : vars.defaultValue;
    const text = typeof found === 'string' ? found : (fallback ?? key);
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => String(vars[name] ?? ''));
  };
  return { useLanguage: () => ({ t }), __setLanguage: (lang) => { state.lang = lang; } };
});

const { __setLanguage } = jest.requireMock('@krushisarva/shared/context/LanguageContext');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const KRUSHNA = 'seller-krushna';
const SHREE = 'seller-shree';
const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

/** Out for delivery from one shop, promised well ahead of today. */
const shippedOrder = () => ({
  id: 'order-shipped', status: 'SHIPPED', createdAt: at(-2), expectedBy: at(3),
  paymentMethod: 'cod', paymentStatus: 'pending',
  items: [{ id: 'i1', sellerId: KRUSHNA, status: 'SHIPPED', confirmedAt: at(-1.5), shippedAt: at(-0.2) }],
  deliveries: [{ sellerId: KRUSHNA, sellerName: 'Krushna Krishi Bhandar', status: 'SHIPPED', failedReason: null }],
});

let container;
let root;

beforeEach(() => {
  __setLanguage('en');
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => { act(() => root.unmount()); });

const show = (order) => act(() => { root.render(<OrderTimeline order={order} />); });
/** What a screen reader says, one entry per step, top to bottom. */
const spoken = () => [...container.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'));
const text = () => container.textContent;
const en = translations.en.orders;

test('an order with nothing to track draws nothing', () => {
  show(null);
  expect(container.innerHTML).toBe('');
});

test('out for delivery: every step in order, each with its time, and the one ahead says "not yet"', () => {
  const order = shippedOrder();
  show(order);

  expect(text()).toContain(en.trackTitle);
  expect(spoken()).toEqual([
    `${en.trackPlaced}, ${formatTrackTime(order.createdAt)}`,
    `${en.trackConfirmed}, ${formatTrackTime(order.items[0].confirmedAt)}`,
    `${en.statusOutForDelivery}, ${formatTrackTime(order.items[0].shippedAt)}`,
    // No time, "Not yet" in words, and the day it was promised for.
    expect.stringMatching(new RegExp(`^${en.statusDelivered}, ${en.trackNotYet}\\. .+`)),
  ]);
  // Not "running late": the promised day is still ahead.
  expect(spoken()[3]).not.toMatch(/late/i);
});

test('one shop: no shop heading — the card above already names it', () => {
  show(shippedOrder());
  expect(text()).not.toContain('Krushna Krishi Bhandar');
});

test('two shops: each delivery sits under its own shop, and a shop with no name is numbered', () => {
  show({
    id: 'order-two', status: 'SHIPPED', createdAt: at(-2), expectedBy: at(3),
    paymentMethod: 'cod', paymentStatus: 'pending',
    items: [
      { id: 'i1', sellerId: KRUSHNA, status: 'SHIPPED', confirmedAt: at(-1.5), shippedAt: at(-0.2) },
      { id: 'i2', sellerId: SHREE, status: 'PENDING' },
    ],
    deliveries: [
      { sellerId: KRUSHNA, sellerName: 'Krushna Krishi Bhandar', status: 'SHIPPED', failedReason: null },
      { sellerId: SHREE, sellerName: null, status: 'PENDING', failedReason: null },
    ],
  });

  expect(text()).toContain('Krushna Krishi Bhandar');
  expect(text()).toContain('Shop 2');
  // Four steps for each shop, and the second shop is still at the first one.
  expect(spoken()).toHaveLength(8);
  expect(spoken()[4]).toContain(en.trackWaitingShop);
  expect(spoken()[5]).toBe(`${en.trackConfirmed}, ${en.trackNotYet}`);
});

test('a delivery that came back says why, and a cash order says nothing about a refund', () => {
  show({
    id: 'order-failed', status: 'CANCELLED', createdAt: at(-4),
    paymentMethod: 'cod', paymentStatus: 'pending',
    items: [{ id: 'i1', sellerId: KRUSHNA, status: 'CANCELLED', confirmedAt: at(-3.8), shippedAt: at(-3.1), cancelledAt: at(-2.9) }],
    deliveries: [{ sellerId: KRUSHNA, sellerName: 'Krushna Krishi Bhandar', status: 'CANCELLED', failedReason: 'UNREACHABLE' }],
  });

  const steps = spoken();
  expect(steps).toHaveLength(4);
  expect(steps[2]).toMatch(new RegExp(`^${en.statusOutForDelivery}, `));
  expect(steps[3]).toMatch(new RegExp(`^${en.trackFailed}, .+\\. ${en.trackFailedUnreachable.replace(/\./g, '\\.')}$`));
  expect(text()).not.toMatch(/refund/i);
});

test('cancelled after paying online: only what happened, then where the money is', () => {
  show({
    id: 'order-refund', status: 'CANCELLED', createdAt: at(-3),
    paymentMethod: 'online', paymentStatus: 'refund_pending',
    items: [{ id: 'i1', sellerId: SHREE, status: 'CANCELLED', cancelledAt: at(-2.8) }],
    deliveries: [{ sellerId: SHREE, sellerName: 'Shree Agro Center', status: 'CANCELLED', failedReason: null }],
  });

  const steps = spoken();
  // Never confirmed, never shipped: neither step is drawn on the way to "Cancelled".
  expect(steps).toHaveLength(3);
  expect(steps[0]).toMatch(new RegExp(`^${en.trackPlaced}, `));
  expect(steps[1]).toMatch(new RegExp(`^${en.statusCancelled}, `));
  expect(steps[2]).toBe(en.refundPending);
  expect(text()).not.toContain(en.trackConfirmed);
});

test('some lines of a delivery cancelled, the rest still coming: the timeline carries on and says so', () => {
  show({
    id: 'order-part', status: 'CONFIRMED', createdAt: at(-1), expectedBy: at(4),
    paymentMethod: 'cod', paymentStatus: 'pending',
    items: [
      { id: 'i1', sellerId: KRUSHNA, status: 'CONFIRMED', confirmedAt: at(-0.5) },
      { id: 'i2', sellerId: KRUSHNA, status: 'CANCELLED', cancelledAt: at(-0.4) },
    ],
    deliveries: [{ sellerId: KRUSHNA, sellerName: 'Krushna Krishi Bhandar', status: 'CONFIRMED', failedReason: null }],
  });

  expect(spoken()).toHaveLength(4);
  expect(text()).toContain(en.trackSomeCancelled);
  expect(text()).not.toContain(en.statusCancelled);
});

test.each(['hi', 'mr'])('in %s every word of the timeline comes from the language file', (lang) => {
  __setLanguage(lang);
  const words = translations[lang].orders;
  show(shippedOrder());

  for (const key of ['trackTitle', 'trackPlaced', 'trackConfirmed', 'statusOutForDelivery', 'statusDelivered']) {
    expect(text()).toContain(words[key]);
  }
  expect(spoken()[3]).toContain(words.trackNotYet);
  // Nothing fell back to the English written in the code.
  for (const key of ['trackTitle', 'trackPlaced', 'trackConfirmed', 'statusOutForDelivery', 'trackNotYet']) {
    expect(text()).not.toContain(en[key]);
    expect(spoken().join(' ')).not.toContain(en[key]);
  }
});
