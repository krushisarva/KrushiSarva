/**
 * No string on the business profile / KYC screens may render as a raw key, and
 * the copy they depend on exists in the three languages a Maharashtra seller is
 * most likely to read.
 *
 * Same approach as frontend/src/screens/Profile/__tests__/accountI18n.test.js:
 * a bare `t('key')` has no fallback, so a missing key shows the key itself.
 * Calls with a fallback still degrade to English, which is why the second
 * block checks the keys this pass added in hi and mr as well.
 */
import fs from 'fs';
import path from 'path';
import { translations } from '@krushisarva/shared/i18n/translations';
import { kycStatusMeta } from '../../theme';

const SCREENS = [
  'screens/BusinessProfileScreen.js',
  'screens/SellerProfileScreen.js',
];

const BARE_T = /\bt\(\s*'([a-zA-Z][a-zA-Z0-9_.]*)'\s*\)/g;

const resolve = (dict, key) => {
  if (typeof dict?.[key] === 'string') return dict[key];
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);
};

function bareKeysIn(relPath) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
  const keys = new Set();
  let m;
  while ((m = BARE_T.exec(src)) !== null) keys.add(m[1]);
  return [...keys];
}

describe.each(SCREENS)('%s', (screen) => {
  const keys = bareKeysIn(screen);

  test.each(['en', 'hi', 'mr'])('every bare t() key resolves to a string in %s', (lang) => {
    const broken = keys.filter((k) => typeof resolve(translations[lang], k) !== 'string');
    expect(broken).toEqual([]);
  });
});

describe('keys added for the KYC edge cases', () => {
  const REQUIRED = [
    'sellerBizProfile.nameHint', 'sellerBizProfile.nameRequired', 'sellerBizProfile.selectBizTypeMsg',
    'sellerBizProfile.gstRequired', 'sellerBizProfile.gstChecksumMsg',
    'sellerBizProfile.invalidAccountMsg', 'sellerBizProfile.confirmAccountNumber',
    'sellerBizProfile.accountMismatch', 'sellerBizProfile.accountRequired',
    'sellerBizProfile.ifscRequiredWithAcct', 'sellerBizProfile.holderRequired',
    'sellerBizProfile.aadhaarChecksumMsg', 'sellerBizProfile.checkField',
    'sellerBizProfile.onFile', 'sellerBizProfile.encrypted', 'sellerBizProfile.fixErrors',
    'sellerBizProfile.noChanges', 'sellerBizProfile.savingWait', 'sellerBizProfile.offline',
    'sellerBizProfile.discardTitle', 'sellerBizProfile.discard', 'sellerBizProfile.keepEditing',
    'sellerBizProfile.savedNotSeller', 'sellerBizProfile.notPromoted', 'sellerBizProfile.minorNotice',
    'sellerBizProfile.wrongAccount', 'sellerBizProfile.logoutMsg',
    'sellerBizProfile.kycVerifiedBody', 'sellerBizProfile.kycPendingBody',
    'sellerBizProfile.kycRejectedBody', 'sellerBizProfile.kycRejectedNoReason',
    'sellerBizProfile.kycNotStartedBody',
    'sellerProfile.nameTooShort', 'sellerProfile.kycRejected', 'sellerProfile.kycNotSubmitted',
    'sellerProfile.kycRejectedValue', 'sellerProfile.kycRejectedNoReason',
    'sellerProfile.kycNotSubmittedValue', 'sellerProfile.loadError', 'sellerProfile.loadErrorOffline',
  ];

  test.each(['en', 'hi', 'mr'])('%s has all of them', (lang) => {
    const missing = REQUIRED.filter((k) => typeof resolve(translations[lang], k) !== 'string');
    expect(missing).toEqual([]);
  });

  test('the rejection copy keeps its {{reason}} placeholder in every language', () => {
    for (const lang of ['en', 'hi', 'mr']) {
      expect(resolve(translations[lang], 'sellerBizProfile.kycRejectedBody')).toContain('{{reason}}');
      expect(resolve(translations[lang], 'sellerProfile.kycRejectedValue')).toContain('{{reason}}');
    }
  });

  test.each(['verified', 'pending', 'rejected', 'notStarted'])('KYC state %s has a label', (key) => {
    const { tKey } = kycStatusMeta(key);
    for (const lang of ['en', 'hi', 'mr']) {
      expect(typeof resolve(translations[lang], tKey)).toBe('string');
    }
  });

  test('adding keys did not turn an existing string into an object', () => {
    // A new `foo: { … }` namespace silently shadows a `foo: 'text'` string.
    for (const lang of ['en', 'hi', 'mr']) {
      expect(typeof translations[lang].sellerBizProfile).toBe('object');
      expect(typeof translations[lang].sellerProfile).toBe('object');
      expect(typeof translations[lang].logout).toBe('string');
    }
  });
});
