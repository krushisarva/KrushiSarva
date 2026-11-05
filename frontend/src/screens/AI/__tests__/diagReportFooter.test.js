/**
 * Play "Misleading Claims / Insufficient Sources Provided" rule, crop-scan PDF.
 *
 * The PDF report built in DiagnosisResultScreen.js may only name government
 * helplines and websites that the store description lists, and must not imply a
 * government body (a Krishi Vigyan Kendra) reviewed the report. Screens cannot
 * be rendered under this Jest config (see sourceParses.test.js), so the source
 * is read instead.
 */
import fs from 'fs';
import path from 'path';

const AI = path.join(__dirname, '..');
const REPO = path.join(AI, '..', '..', '..', '..');
const src = fs.readFileSync(path.join(AI, 'DiagnosisResultScreen.js'), 'utf8');
const footer = src.slice(src.indexOf('<!-- FOOTER -->'), src.indexOf('</footer>'));
const sigRow = footer.slice(footer.indexOf('class="sig-row"'), footer.indexOf('class="helpline"'));

const doc = fs.readFileSync(path.join(REPO, 'docs', 'play-store', 'farmer-app.md'), 'utf8');
const start = doc.indexOf('SOURCES OF GOVERNMENT INFORMATION');
const sources = doc.slice(start, doc.indexOf('```', start));

describe('crop-scan PDF footer', () => {
  test('the scan finds the footer (a broken scan must not pass by finding nothing)', () => {
    expect(footer).toMatch(/class="helpline"/);
    expect(sigRow).toMatch(/class="sig"/);
  });

  test('no unlisted government site or helpline', () => {
    expect(src).not.toContain('kvk.icar.gov.in');
    expect(footer).not.toMatch(/plantHelpline|Plant Helpline/);
    expect(footer).not.toMatch(/<b>1551<\/b>/);
  });

  test('shows the Kisan Call Centre and the ICAR Krishi Vigyan Kendra page', () => {
    expect(footer).toContain("t('diagReport.kisanCallCentre')} <b>1800-180-1551</b>");
    expect(footer).toContain("t('diagReport.kvkIcar')} <b>https://icar.org.in/en/krishi-vigyan-kendras</b>");
  });

  test('every website in the footer is on a host the store description lists', () => {
    const urls = [...footer.matchAll(/https:\/\/[^\s<'"]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(sources).toContain(`https://${new URL(url).hostname}`);
    }
    expect(sources).toContain('1800-180-1551');
  });

  test('the signature row never names a KVK as the reviewer', () => {
    expect(sigRow).not.toContain('KVK ${');
    expect(sigRow).toContain("t('diagReport.localAgronomist')");
    expect(sigRow).toContain("t('diagReport.reviewingAuthority')");
  });
});

describe('footer strings', () => {
  const en = fs.readFileSync(path.join(REPO, 'shared', 'i18n', 'lang', 'backfill', 'en.js'), 'utf8');

  test('the English labels exist and the dropped helpline key is gone', () => {
    expect(en).toContain('"diagReport.kvkIcar": "Krishi Vigyan Kendras (ICAR):"');
    expect(en).toContain('"diagReport.localAgronomist": "Local Agronomist"');
    expect(en).toContain('"diagReport.reviewingAuthority": "Suggested for review — not reviewed"');
    expect(en).not.toContain('diagReport.plantHelpline');
    expect(en).not.toContain('diagReport.kvkLocator');
  });
});
