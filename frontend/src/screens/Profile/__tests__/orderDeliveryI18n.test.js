/**
 * The delivery copy on the farmer's order card exists in the three languages a
 * Maharashtra farmer is most likely to read, and keeps its placeholders.
 *
 * Every one of these is called with an English fallback, so a missing key does
 * not show as a raw key — it shows as English, to a farmer reading Marathi,
 * standing at their door with the delivery code on screen. Same approach as
 * accountI18n.test.js.
 */
import { translations } from '@krushisarva/shared/i18n/translations';

const resolve = (dict, key) => {
  if (typeof dict?.[key] === 'string') return dict[key];
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);
};

// key → the {{placeholders}} the screen passes to it.
const KEYS = {
  'orders.statusOutForDelivery': [],
  'orders.arrivingBy': ['date'],
  'orders.expectedLate': ['date'],
  'orders.deliveryCode': [],
  'orders.deliveryCodeFor': ['shop'],
  'orders.deliveryCodeHint': [],
  'orders.callShop': [],
  'orders.callShopNamed': ['shop'],
  'orders.callFailedTitle': [],
  'orders.callFailedMsg': ['phone', 'shop'],
  'orders.shopFallback': [],
  'orders.shopNumbered': ['n'],
  // What "Delivery charges" is made of — cart, checkout and the order detail.
  'cart.deliveryStandard': [],
  'cart.deliveryArea': [],
  'cart.deliveryHeavy': [],
  'cart.deliveryCod': [],
};

describe.each(['en', 'hi', 'mr'])('order delivery copy in %s', (lang) => {
  test('every key resolves to a string', () => {
    const missing = Object.keys(KEYS).filter((k) => typeof resolve(translations[lang], k) !== 'string');
    expect(missing).toEqual([]);
  });

  test('every placeholder the screen fills is still in the text', () => {
    const broken = [];
    for (const [key, vars] of Object.entries(KEYS)) {
      const text = resolve(translations[lang], key) || '';
      for (const v of vars) if (!text.includes(`{{${v}}}`)) broken.push(`${key} → {{${v}}}`);
    }
    expect(broken).toEqual([]);
  });

  test('the older keys these sit beside were not disturbed', () => {
    // `statusShipped` is still read by older builds; a new namespace or a
    // duplicate key in the literal would silently replace its neighbours.
    for (const k of ['orders.statusShipped', 'orders.statusDelivered', 'orders.moreItem', 'orders.cancelTitle']) {
      expect(typeof resolve(translations[lang], k)).toBe('string');
    }
  });
});

test('Hindi and Marathi are translated, not copies of the English', () => {
  for (const key of Object.keys(KEYS)) {
    const en = resolve(translations.en, key);
    expect(resolve(translations.hi, key)).not.toBe(en);
    expect(resolve(translations.mr, key)).not.toBe(en);
  }
});
