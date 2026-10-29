/**
 * Google Play rejects apps that show placeholder or wrong contact details, and a
 * link to a domain nobody owns can be taken over. These read the source (screens
 * cannot render under this Jest config) so the fake numbers, the dead
 * cropsetu.app links and the wrong seller package cannot come back.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const EMAIL = 'krushisarva@gmail.com';
const LANGS = ['bn', 'gu', 'kn', 'ml', 'pa', 'ta', 'te'];

describe('support contact shown in the apps', () => {
  test('the farmer Help popup gives the real support email in every language', () => {
    const main = [...read('shared/i18n/translations.js').matchAll(/callUs:\s*'([^']*)'/g)].map((m) => m[1]);
    const others = LANGS.map((l) => read(`shared/i18n/lang/${l}.js`).match(/callUs:\s*'([^']*)'/)[1]);
    const all = [...main, ...others];
    expect(main).toHaveLength(3); // en, hi, mr
    for (const s of all) {
      expect(s).toContain(EMAIL);
      expect(s).not.toMatch(/X{3}/);
    }
  });

  test('the seller Help popup gives the real support email, no made-up number', () => {
    const msgs = [...read('shared/i18n/translations.js').matchAll(/helpMsg:\s*'([^']*)'/g)].map((m) => m[1]);
    expect(msgs).toHaveLength(3);
    for (const s of msgs) {
      expect(s).toContain(EMAIL);
      expect(s).not.toContain('cropsetu');
      expect(s).not.toContain('8000 123 456');
    }
  });

  test('no profile row opens the unregistered cropsetu.app domain', () => {
    expect(read('frontend/src/screens/Profile/ProfileScreen.js')).not.toContain('cropsetu.app');
  });
});

describe('links to the seller app', () => {
  test('the Play fallback names the seller app that actually exists', () => {
    const pkg = read('frontend/src/utils/sellerApp.js').match(/SELLER_ANDROID_PACKAGE\s*=\s*'([^']+)'/)[1];
    const sellerPkg = JSON.parse(read('seller-app/app.json')).expo.android.package;
    expect(pkg).toBe(sellerPkg);
  });
});

describe('permissions blocked in both apps', () => {
  test.each(['frontend/app.json', 'seller-app/app.json'])('%s blocks the advertising ID and draw-over-apps', (rel) => {
    const blocked = JSON.parse(read(rel)).expo.android.blockedPermissions;
    expect(blocked).toEqual(expect.arrayContaining([
      'com.google.android.gms.permission.AD_ID',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
    ]));
  });
});
