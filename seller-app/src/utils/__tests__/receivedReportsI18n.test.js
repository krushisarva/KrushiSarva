/**
 * Crop-report inbox: CRITICAL risk has its own style and a translated label,
 * and the strings added for the inbox / picker fixes exist in en, hi and mr.
 */
import { translations } from '@krushisarva/shared/i18n/translations';
import { RISK, riskMeta, riskLabel } from '../../theme';

const resolve = (dict, key) => key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);

// A `t` that behaves like LanguageContext's for the (key, fallback) form.
const tFor = (lang) => (key, fallback) => {
  const v = resolve(translations[lang], key);
  return typeof v === 'string' ? v : fallback;
};

describe('risk levels', () => {
  test('CRITICAL is styled, not the grey "unknown" fallback', () => {
    const unknown = riskMeta('SOMETHING_ELSE');
    const critical = riskMeta('CRITICAL');
    expect(critical).toBe(RISK.CRITICAL);
    expect(critical).not.toBe(unknown);
    expect(critical.color).toBe(RISK.HIGH.color); // the deepest danger ink
    expect(critical.icon).not.toBe(RISK.HIGH.icon); // never told apart by colour alone
    expect(riskMeta('critical')).toBe(RISK.CRITICAL);
  });

  test.each(['en', 'hi', 'mr'])('every stored level has a translated label in %s', (lang) => {
    const t = tFor(lang);
    for (const level of ['LOW', 'MODERATE', 'HIGH', 'CRITICAL']) {
      const key = riskMeta(level).tKey;
      expect(typeof resolve(translations[lang], key)).toBe('string');
      expect(riskLabel(level, t)).toBe(resolve(translations[lang], key));
    }
  });

  test('an unmapped level is shown as-is, a missing one as Unknown', () => {
    const t = tFor('en');
    expect(riskLabel('SEVERE', t)).toBe('SEVERE');
    expect(riskLabel(null, t)).toBe('Unknown');
  });
});

describe('keys added for the inbox / picker fixes', () => {
  const REQUIRED = [
    'share.offerHidden', 'share.offerNotApproved', 'share.loadMoreProducts', 'share.productsDropped',
    'share.riskLow', 'share.riskModerate', 'share.riskHigh', 'share.riskCritical', 'share.criticalRiskNote',
    'share.outOfStock',
  ];

  test.each(['en', 'hi', 'mr'])('all present in %s', (lang) => {
    const missing = REQUIRED.filter((k) => typeof resolve(translations[lang], k) !== 'string');
    expect(missing).toEqual([]);
  });

  test.each(['en', 'hi', 'mr'])('productsDropped keeps its {{n}} placeholder in %s', (lang) => {
    expect(resolve(translations[lang], 'share.productsDropped')).toContain('{{n}}');
  });
});
