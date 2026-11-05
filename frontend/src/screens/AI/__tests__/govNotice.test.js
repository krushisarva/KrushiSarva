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

  test('every scheme has an official source link', () => {
    const schemes = [...src.matchAll(/^\s*code:\s*'/gm)].length;
    expect(schemes).toBeGreaterThan(0);
    expect(urls).toHaveLength(schemes);
  });

  test('each card names its source in plain text', () => {
    expect(src).toMatch(/t\('govNotice\.source', \{ url: scheme\.url/);
  });

  test('the link button opens the scheme portal', () => {
    expect(src).toMatch(/Linking\.openURL\(scheme\.url\)/);
  });

  test('a link that cannot open shows the address instead of doing nothing', () => {
    expect(src).not.toMatch(/openURL\(scheme\.url\)\.catch\(\(\) => \{\}\)/);
    expect(src).toMatch(/t\('govNotice\.openFailed', \{ url: scheme\.url/);
  });
});

// Google rejected the app (Misleading Claims, "Insufficient Sources Provided")
// when the PM-KISAN button opened a site the store description did not list.
// Every government link the app opens must appear in the description's
// "SOURCES OF GOVERNMENT INFORMATION" list in docs/play-store/farmer-app.md.
describe('in-app government links match the Play store description', () => {
  const doc = fs.readFileSync(
    path.join(AI, '..', '..', '..', '..', 'docs', 'play-store', 'farmer-app.md'),
    'utf8',
  );
  const start = doc.indexOf('SOURCES OF GOVERNMENT INFORMATION');
  const sources = doc.slice(start, doc.indexOf('```', start));
  const appLinks = [
    ...[...read('SchemeScreen.js').matchAll(/^\s*url:\s*'([^']*)'/gm)].map((m) => m[1]),
    ...[...read(path.join('components', 'soilLab.js')).matchAll(/'(https:\/\/[^']+)'/g)].map((m) => m[1]),
  ];

  test('the description has a sources list', () => {
    expect(start).toBeGreaterThan(-1);
    expect(appLinks.length).toBeGreaterThan(1);
  });

  test.each(appLinks)('%s is listed as a source', (url) => {
    expect(sources).toContain(url);
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

  test('the alert list credits IMD only when an IMD alert is on screen', () => {
    expect(alertList).toMatch(/wxAlerts\.some\(\(a\) => a\.source === 'imd'\) && \(\s*<Text style=\{S\.govNote\}>\{t\('govNotice\.imdSource'\)\}/);
  });

  test('IMD warnings come before the app\'s own forecast alerts, so the 3-item cap cannot hide them', () => {
    const gen = src.slice(src.indexOf('function generateWeatherAlerts'), src.indexOf('return list.slice(0, 3)'));
    expect(gen.indexOf("source:   'imd'")).toBeGreaterThan(-1);
    expect(gen.indexOf("source:   'imd'")).toBeLessThan(gen.indexOf('for (const day of (daily'));
  });
});

describe('CropDetail market tips', () => {
  test('names the official MSP source under the market tips', () => {
    const src = fs.readFileSync(path.join(AI, '..', 'Weather', 'CropDetail.js'), 'utf8');
    const market = src.slice(src.indexOf('guide.marketTips}</Text>'), src.indexOf('guide.dosDonts?.length'));
    expect(market).toMatch(/t\('cropGuide\.marketSource',/);
  });
});
