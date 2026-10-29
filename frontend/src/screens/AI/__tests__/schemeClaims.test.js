/**
 * Play "misleading claims" rule for the government schemes screen.
 *
 * The app holds no data about a farmer's eligibility, so it must not tell
 * every farmer they are "Eligible", and it must not show rupee amounts that no
 * scheme guideline fixes. Screens cannot be rendered under this Jest config
 * (see sourceParses.test.js), so the source is read instead.
 */
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', 'SchemeScreen.js'), 'utf8');
const benefits = [...src.matchAll(/^\s*benefit:\s*'([^']*)'/gm)].map((m) => m[1]);

const OFFICIAL_AMOUNTS = ['₹6,000/year', '₹50,000/hectare for 3 yrs'];

describe('SchemeScreen claims', () => {
  test('no scheme carries a hard-coded eligibility status', () => {
    expect(src).not.toMatch(/status:\s*'eligible'/);
    expect(src).not.toMatch(/statusEligible/);
    expect(src).not.toMatch(/t\('scheme\.eligible'\)/);
  });

  test('the invented totals and coverage figures are gone', () => {
    expect(src).not.toMatch(/59,000/);
    expect(src).not.toMatch(/maxAnnualBenefit/);
    expect(src).not.toMatch(/Up to ₹50,000 coverage/);
    expect(src).not.toMatch(/₹3 lakh/);
    expect(src).not.toMatch(/>\s*₹[\d,]+/);
  });

  test('the scan finds the benefit lines (a broken scan must not pass by finding none)', () => {
    expect(benefits.length).toBeGreaterThan(0);
  });

  test('a benefit line names a rupee amount only where the scheme guidelines fix one', () => {
    for (const benefit of benefits) {
      if (benefit.includes('₹')) expect(OFFICIAL_AMOUNTS).toContain(benefit);
    }
  });

  test('keeps the not-affiliated notice and the official website button', () => {
    expect(src).toMatch(/t\('govNotice\.schemes',/);
    expect(src).toMatch(/t\('govNotice\.officialWebsite', 'Official website'\)/);
  });
});
