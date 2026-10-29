/**
 * Play "misrepresentation / government affiliation" rule.
 *
 * The farmer app shows government schemes and official mandi prices, so the
 * screens that show them must say KrushiSarva is not a government app, and the
 * scheme links must only ever point at official government portals. Screens
 * cannot be rendered under this Jest config (see sourceParses.test.js), so the
 * source is read instead.
 */
import fs from 'fs';
import path from 'path';

const AI = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(AI, file), 'utf8');

describe('SchemeScreen', () => {
  const src = read('SchemeScreen.js');
  const urls = [...src.matchAll(/^\s*url:\s*'([^']*)'/gm)].map((m) => m[1]);

  test('shows the not-affiliated notice', () => {
    expect(src).toMatch(/t\('govNotice\.schemes',/);
  });

  test('the scan finds the scheme links (a broken scan must not pass by finding none)', () => {
    expect(urls.length).toBeGreaterThan(0);
  });

  test('every scheme link is an official https .gov.in portal', () => {
    for (const url of urls) {
      expect(new URL(url).protocol).toBe('https:');
      expect(new URL(url).hostname).toMatch(/\.gov\.in$/);
    }
  });

  test('the link button opens the scheme portal', () => {
    expect(src).toMatch(/Linking\.openURL\(scheme\.url\)/);
  });

  test('a link that cannot open shows the address instead of doing nothing', () => {
    expect(src).not.toMatch(/openURL\(scheme\.url\)\.catch\(\(\) => \{\}\)/);
    expect(src).toMatch(/t\('govNotice\.openFailed', \{ url: scheme\.url/);
  });
});

describe('MarketScreen', () => {
  test('names the price source and says it is not a government app', () => {
    expect(read('MarketScreen.js')).toMatch(/t\('govNotice\.mandiSource',/);
  });
});

describe('MandiGlanceCard', () => {
  const src = fs.readFileSync(
    path.join(AI, '..', 'FarmProfile', 'components', 'MandiGlanceCard.js'),
    'utf8',
  );

  test('names the price source and says it is not a government app', () => {
    expect(src).toMatch(/t\('govNotice\.mandiSource',/);
  });

  test('the notice sits in the card that shows prices, not only in the loading skeleton', () => {
    const shown = src.slice(src.indexOf('if (!best) return null;'));
    expect(shown).toMatch(/t\('govNotice\.mandiSource',/);
  });
});

describe('WeatherHome IMD alerts', () => {
  const src = fs.readFileSync(path.join(AI, '..', 'Weather', 'WeatherHome.js'), 'utf8');
  const banner = src.slice(src.indexOf('2. IMD ALERT BANNER'), src.indexOf('3. FARMING ADVISORIES'));
  const alertList = src.slice(src.indexOf('6. WEATHER ALERTS'), src.indexOf('7. SOIL DASHBOARD'));

  test('the alert banner names IMD and says KrushiSarva is not a government app', () => {
    expect(banner).toMatch(/t\('govNotice\.imdSource'\)/);
  });

  test('the alert list carries the same notice when it holds IMD alerts', () => {
    expect(alertList).toMatch(/alerts\.length > 0 && \(\s*<Text style=\{S\.govNote\}>\{t\('govNotice\.imdSource'\)\}/);
  });
});
