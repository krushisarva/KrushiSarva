/**
 * Where "Report" lives in the seller app, and that each one asks the server for
 * the right thing (Google Play's user-content rule: wherever an app shows
 * something another person made, it must be reportable in-app).
 *
 * The seller app shows two kinds of other people's content:
 *   - buyers' reviews of the shop          SellerReviewsScreen    PRODUCT_REVIEW
 *   - farmers' shared crop photos + notes  ReceivedReportDetail   CROP_REPORT_SHARE
 *
 * A STATIC audit, like the farmer app's reportWiring.test.js and for the same
 * reason: frontend/jest.config.js runs suites in node with a stub
 * `react-native`, so the screens cannot be mounted here. The sheet itself is
 * shared/components/ReportSheet.js — rendered and tapped through the farmer
 * app's wrapper in frontend/src/components/__tests__/ReportSheet.test.js.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..');
const REPO = path.join(SRC, '..', '..');
// Line endings normalised: the files are checked out with CRLF on Windows.
const readAt = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const read = (file) => readAt(path.join(SRC, file));

const SHARED_SHEET = path.join(REPO, 'shared', 'components', 'ReportSheet.js');
const FARMER_SHEET = path.join(REPO, 'frontend', 'src', 'components', 'ReportSheet.js');
const BACKEND_REPORTS = path.join(REPO, 'backend', 'src', 'services', 'userReport.service.js');

/** Every screen that opens the sheet, and the target types it may send. */
const SCREENS = {
  'screens/SellerReviewsScreen.js':        ['PRODUCT_REVIEW'],
  'screens/ReceivedReportDetailScreen.js': ['CROP_REPORT_SHARE'],
};

const targetTypesIn = (src) => [...src.matchAll(/targetType:\s*'([A-Z_]+)'/g)].map((m) => m[1]);

describe.each(Object.entries(SCREENS))('%s', (file, expected) => {
  const src = read(file);

  test('mounts the one ReportSheet, closed until something is picked', () => {
    expect(src).toMatch(/import ReportSheet from '\.\.\/components\/ReportSheet';/);
    expect(src).toMatch(/const \[reportTarget, setReportTarget\] = useState\(null\);/);
    expect(src).toMatch(/<ReportSheet target=\{reportTarget\} onClose=\{\(\) => setReportTarget\(null\)\} \/>/);
  });

  test(`reports as ${expected.join(', ')}`, () => {
    expect([...new Set(targetTypesIn(src))].sort()).toEqual([...expected].sort());
  });

  test('the Report control is a labelled button with a flag and a word, not an icon alone', () => {
    const control = src.slice(src.indexOf('<PressableRow', src.indexOf('flag-outline') - 400), src.indexOf('flag-outline') + 200);
    expect(control).toMatch(/accessibilityLabel=\{t\('report\.title[A-Za-z]+', '[^']+'\)\}/);
    expect(control).toMatch(/<Text style=\{[a-z]+\.report[A-Za-z]*Txt\}>\{t\('report\./);
  });
});

describe('one sheet, shared by both apps', () => {
  const seller = read('components/ReportSheet.js');

  test('the seller app wraps the shared sheet instead of copying it', () => {
    expect(seller).toMatch(/import SharedReportSheet from '@krushisarva\/shared\/components\/ReportSheet';/);
    expect(seller).not.toMatch(/REPORT_REASONS|api\.post/);
  });

  test('the seller is thanked with the app\'s toast — never a system alert', () => {
    expect(seller).toMatch(/const thank = useCallback\(\(title, message\) => toast\.success\(message\), \[toast\]\);/);
    expect(seller).toMatch(/<SharedReportSheet onThanks=\{thank\} \{\.\.\.props\} \/>/);
  });

  test('the farmer app wraps the very same sheet', () => {
    if (!fs.existsSync(FARMER_SHEET)) return; // the seller app shipped on its own
    expect(readAt(FARMER_SHEET)).toMatch(/from '@krushisarva\/shared\/components\/ReportSheet';/);
  });
});

describe('the contract with the server', () => {
  const sheet = readAt(SHARED_SHEET);
  const backend = fs.existsSync(BACKEND_REPORTS) ? readAt(BACKEND_REPORTS) : null;
  const list = (name) => {
    const m = backend.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/'([A-Za-z_]+)'/g)].map((x) => x[1]) : [];
  };

  test('every target type a seller screen sends is one the server accepts', () => {
    if (!backend) return;
    const accepted = list('REPORT_TARGET_TYPES');
    expect(accepted.length).toBeGreaterThan(0);
    for (const types of Object.values(SCREENS)) {
      for (const type of types) expect(accepted).toContain(type);
    }
  });

  test('a shared crop report needs its id on the server, so the screen always sends one', () => {
    if (!backend) return;
    expect(list('ID_REQUIRED_TYPES')).toEqual(expect.arrayContaining(['PRODUCT_REVIEW', 'CROP_REPORT_SHARE']));
  });

  test('the sheet offers exactly the reasons the server accepts', () => {
    if (!backend) return;
    const keys = [...sheet.matchAll(/\{ key: '([a-z_]+)',\s+tKey:/g)].map((m) => m[1]);
    expect(keys.length).toBe(6);
    expect([...keys].sort()).toEqual(list('REPORT_REASONS').sort());
  });

  test('the sheet has its own heading for every type the server accepts', () => {
    if (!backend) return;
    const titles = sheet.slice(sheet.indexOf('const TITLES = {'), sheet.indexOf('};', sheet.indexOf('const TITLES = {')));
    for (const type of list('REPORT_TARGET_TYPES')) expect(titles).toMatch(new RegExp(`\\b${type}:\\s+\\{ tKey: 'report\\.`));
  });
});

describe('reviews: every buyer review can be reported', () => {
  const src = read('screens/SellerReviewsScreen.js');

  test('by its id', () => {
    expect(src).toMatch(/setReportTarget\(\{ targetType: 'PRODUCT_REVIEW', targetId: String\(id\) \}\);/);
    expect(src).toMatch(/\{item\.id != null \? \(\s*<PressableRow\s+onPress=\{\(\) => onReport\(item\.id\)\}/);
    expect(src).toMatch(/onReport=\{openReport\}/);
  });

  test('Report sits outside the review\'s one screen-reader announcement, so it stays its own button', () => {
    expect(src).toMatch(/<Card style=\{s\.row\}>/);
    const row = src.slice(src.indexOf('const ReviewRow'), src.indexOf('// ── Screen'));
    // The accessible group is the inner body, and it closes before Report opens.
    expect(row).toMatch(/style=\{s\.rowBody\}\s+accessible/);
    const groupEnd = row.indexOf('</View>\n\n        {item.id != null ? (');
    expect(groupEnd).toBeGreaterThan(row.indexOf('style={s.rowBody}'));
    expect(row.indexOf('<PressableRow')).toBeGreaterThan(groupEnd);
  });
});

describe('shared crop reports: the farmer\'s photos and note can be reported', () => {
  const src = read('screens/ReceivedReportDetailScreen.js');

  test('by the share\'s id — the server reads the photos and note itself', () => {
    expect(src).toMatch(/const reportId = share\.data\?\.id \?\? shareId;/);
    expect(src).toMatch(/setReportTarget\(\{ targetType: 'CROP_REPORT_SHARE', targetId: String\(reportId\) \}\)/);
    // No client snapshot: what the moderator sees comes from the database.
    const open = src.slice(src.indexOf('const openReport'), src.indexOf('}, [reportId]);'));
    expect(open).not.toMatch(/snapshot/);
  });

  test('hidden on a report the seller shared themselves', () => {
    expect(src).toMatch(/const canReport = !!user\?\.id && !!reportId && farmer\.id !== user\.id;/);
    expect(src).toMatch(/\{canReport \? \(\s*<PressableRow\s+onPress=\{openReport\}/);
    expect(src).toMatch(/const \{ user \} = useAuth\(\);/);
  });

  test('the hooks run before the loading / not-found early returns', () => {
    const firstReturn = src.indexOf('if (share.isInitialLoading)');
    expect(src.indexOf('const [reportTarget, setReportTarget]')).toBeLessThan(firstReturn);
    expect(src.indexOf('const openReport')).toBeLessThan(firstReturn);
  });
});

describe('no 1:1 messaging in the seller app', () => {
  // The farmer app's animal-trade chat offers "Report user" and "Block user".
  // The seller app has no chat at all — the reply to a crop report is one-way
  // and calls go through the phone. If a chat is ever added here, it needs the
  // same Report + Block menu (POST /reports USER, POST /animals/sellers/:id/block)
  // before it ships; this test is the reminder.
  function sourceFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['__tests__', '__mocks__', 'node_modules'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  test('no seller source opens a socket or a chat endpoint', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(20);
    const found = files.filter((f) => /services\/socket|socket\.io-client|\/chats?\b[/`'"]/.test(readAt(f)));
    expect(found.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});

describe('copy', () => {
  // Translations are added separately; until then every string must still read
  // as English rather than as a raw key.
  test('every report.* string carries an English fallback', () => {
    const sources = [
      ...Object.keys(SCREENS).map((file) => [file, read(file)]),
      ['components/ReportSheet.js', read('components/ReportSheet.js')],
      ['shared/components/ReportSheet.js', readAt(SHARED_SHEET)],
    ];
    const bare = [];
    let found = 0;
    for (const [file, src] of sources) {
      for (const m of src.matchAll(/\bt\(\s*'(report\.[A-Za-z0-9_]+)'\s*(,\s*['"`])?/g)) {
        found += 1;
        if (!m[2]) bare.push(`${file}: ${m[1]}`);
      }
    }
    expect(found).toBeGreaterThan(10);
    expect(bare).toEqual([]);
  });
});
