/**
 * There is no system alert anywhere in the apps.
 *
 * Every message and every "are you sure?" is an in-app pop-up:
 *   farmer app   showPopup()            frontend/src/utils/popup.js + PopupHost
 *   seller app   useConfirm / useToast   seller-app/src/components/ui/Feedback.js
 *
 * `Alert.alert` is the phone's own grey dialog — it does not look like
 * KrushiSarva, and in a browser it does nothing at all (react-native-web ships
 * it as an empty stub), which is how "Cancel order" came to ask nothing and
 * cancel nothing. `window.alert` / `window.confirm` are the browser's version of
 * the same thing.
 *
 * This fails, naming the file and line, the moment one is added back — so the
 * rule does not depend on anyone remembering it.
 */
import fs from 'fs';
import path from 'path';

const REPO = path.join(__dirname, '..', '..', '..');
const ROOTS = ['frontend/src', 'frontend/App.js', 'shared', 'seller-app/src', 'seller-app/App.js'];

function sourceFiles(target, out = []) {
  const full = path.join(REPO, target);
  if (!fs.existsSync(full)) return out;
  if (fs.statSync(full).isFile()) { out.push(full); return out; }
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (['__tests__', '__mocks__', 'node_modules'].includes(entry.name)) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) sourceFiles(child, out);
    else if (entry.name.endsWith('.js')) out.push(path.join(REPO, child));
  }
  return out;
}

/** The lines of a file that are code — comments are allowed to TALK about alerts. */
function codeLines(src) {
  const out = [];
  let inBlock = false;
  src.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      return;
    }
    if (t.startsWith('//')) return;
    if (t.startsWith('/*') || t.startsWith('{/*') || t.startsWith('*')) {
      const open = t.lastIndexOf('/*');
      if (open !== -1 && !t.slice(open).includes('*/')) inBlock = true;
      return;
    }
    out.push({ n: i + 1, text: line });
  });
  return out;
}

const FILES = ROOTS.flatMap((r) => sourceFiles(r));
const rel = (file) => path.relative(REPO, file).split(path.sep).join('/');

function offenders(pattern) {
  const found = [];
  for (const file of FILES) {
    for (const { n, text } of codeLines(fs.readFileSync(file, 'utf8'))) {
      if (pattern.test(text)) found.push(`${rel(file)}:${n}  ${text.trim().slice(0, 90)}`);
    }
  }
  return found;
}

test('the scan is looking at real files (a broken scan must not pass by finding none)', () => {
  expect(FILES.length).toBeGreaterThan(200);
  expect(FILES.map(rel)).toContain('frontend/src/screens/Profile/MyOrdersScreen.js');
  expect(FILES.map(rel)).toContain('seller-app/src/screens/OrdersScreen.js');
});

test('no Alert.alert in the farmer app, the seller app or the shared code', () => {
  expect(offenders(/\bAlert\s*\.\s*alert\s*\(/)).toEqual([]);
});

test('no browser alert() / confirm() / prompt() either', () => {
  expect(offenders(/\bwindow\s*\.\s*(alert|confirm|prompt)\s*\(/)).toEqual([]);
  expect(offenders(/(^|[^.\w$])(alert|confirm|prompt)\s*\(\s*['"`]/)).toEqual([]);
});

test('nothing imports Alert from react-native any more', () => {
  const importing = [];
  for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /import\s*\{([^}]*)\}\s*from\s*['"]react-native['"]/g;
    for (let m; (m = re.exec(src)) !== null;) {
      if (/\bAlert\b/.test(m[1])) importing.push(rel(file));
    }
  }
  expect(importing).toEqual([]);
});

test('every farmer-app file that raises a pop-up imports showPopup', () => {
  const missing = [];
  for (const file of FILES) {
    const name = rel(file);
    if (!name.startsWith('frontend/') || name.endsWith('utils/popup.js')) continue;
    const src = fs.readFileSync(file, 'utf8');
    const calls = codeLines(src).some(({ text }) => /\bshowPopup\s*\(/.test(text));
    if (calls && !/import\s*\{[^}]*\bshowPopup\b[^}]*\}\s*from\s*['"][./]+utils\/popup['"]/.test(src)) missing.push(name);
  }
  expect(missing).toEqual([]);
});

test('the pop-up host is mounted at the root of the farmer app', () => {
  const app = fs.readFileSync(path.join(REPO, 'frontend', 'App.js'), 'utf8');
  expect(app).toMatch(/import PopupHost from ['"]\.\/src\/components\/PopupHost['"]/);
  expect(app).toMatch(/<PopupHost\s*\/>/);
});

test('the pop-up Modal is mounted on demand, never kept mounted and hidden', () => {
  // In a browser the Modal mounted LAST is the one on top. A host that keeps
  // its Modal mounted from app start is drawn UNDER every sheet opened later —
  // the message hidden behind the form it is about. See PopupHost.js.
  const host = fs.readFileSync(path.join(REPO, 'frontend', 'src', 'components', 'PopupHost.js'), 'utf8');
  const code = codeLines(host).map(({ text }) => text).join('\n');
  expect(code).toMatch(/if\s*\(\s*!popup\s*\)\s*return null/);
  expect(code).not.toMatch(/visible=\{\s*!!\s*popup\s*\}/);
  expect(code.indexOf('return null')).toBeLessThan(code.indexOf('<Modal'));
});
