/**
 * AddProductScreen — the form is locked for the whole save (L4).
 *
 * A save reads the values and photos that existed when Save was tapped, and on
 * a village connection five uploads take minutes. Anything the seller changes
 * meanwhile is silently dropped, a photo they remove is published anyway, and a
 * second tap on Save uploads and POSTs the product twice.
 *
 * The screen dims the form and sets `pointerEvents="none"` while saving, but
 * that alone is not the lock: on web it does not stop a keyboard-focused input
 * or a tabbed-to button, an already-focused TextInput keeps taking text, and a
 * screen reader can still activate a child. Each control has to say no itself.
 *
 * This suite is a STATIC audit rather than a render: frontend/jest.config.js
 * runs these suites in node with a stub `react-native` (see
 * frontend/src/__mocks__/react-native.js), so the screen — expo-image-picker,
 * Animated, the theme, image assets — cannot be mounted here. A render test
 * belongs under a jest-expo config, which this repo does not have yet. What the
 * audit does catch is the regression that produced this bug: a control added to
 * the form without a guard.
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const FILE = path.join(__dirname, '..', 'AddProductScreen.js');
const source = fs.readFileSync(FILE, 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });

/** Every component on this screen that a tap or a keystroke can reach. */
const INTERACTIVE = new Set([
  'TextField', 'TextInput', 'SelectSheet', 'Chip', 'OptionRow',
  'IconButton', 'Button', 'Pressable', 'TouchableOpacity', 'ImageTile',
  'PincodeLocationStatus',
]);

/** The screen component's own body — where `saving` is in scope. */
function screenBody() {
  for (const node of ast.program.body) {
    const decl = node.type === 'ExportDefaultDeclaration' ? node.declaration : node;
    if (decl?.type === 'FunctionDeclaration' && decl.id?.name === 'AddProductScreen') return decl;
  }
  throw new Error('AddProductScreen function not found');
}

/** Every JSX opening element under `node`, with no @babel/traverse dependency. */
function jsxElements(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    node.forEach((n) => jsxElements(n, found));
    return found;
  }
  if (node.type === 'JSXOpeningElement') found.push(node);
  Object.keys(node).forEach((key) => {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') return;
    const child = node[key];
    if (child && typeof child === 'object') jsxElements(child, found);
  });
  return found;
}

const tagName = (el) => (el.name.type === 'JSXIdentifier' ? el.name.name : null);
const lineOf = (el) => source.slice(0, el.start).split('\n').length;

const controls = jsxElements(screenBody())
  .filter((el) => INTERACTIVE.has(tagName(el)))
  .map((el) => ({
    tag: tagName(el),
    line: lineOf(el),
    attrs: el.attributes
      .filter((a) => a.type === 'JSXAttribute')
      .map((a) => source.slice(a.start, a.end)),
  }));

describe('every control on the form', () => {
  test('there are controls to check (the audit itself still works)', () => {
    expect(controls.length).toBeGreaterThan(20);
  });

  test('refuses input while a save is in flight', () => {
    const unguarded = controls
      .filter(({ attrs }) => !attrs.some((a) => /\bsaving\b/.test(a)))
      .map(({ tag, line }) => `${tag} at AddProductScreen.js:${line}`);

    expect(unguarded).toEqual([]);
  });

  test('text inputs are made read-only, not merely untappable', () => {
    // `pointerEvents: none` does not stop typing into an input that already has
    // focus, nor a hardware/web keyboard. `editable` does.
    controls
      .filter(({ tag }) => tag === 'TextField' || tag === 'TextInput')
      .forEach(({ line, attrs }) => {
        expect(`${line}: ${attrs.join(' ')}`).toMatch(/editable=\{!saving\}/);
      });
  });

  test('both photo buttons and the photo remove button are covered', () => {
    const photoButtons = controls.filter(({ tag }) => tag === 'Pressable');
    expect(photoButtons.length).toBeGreaterThanOrEqual(2);     // library + camera
    photoButtons.forEach(({ attrs }) => {
      expect(attrs.join(' ')).toMatch(/disabled=\{saving\}/);
    });

    const tiles = controls.filter(({ tag }) => tag === 'ImageTile');
    expect(tiles).not.toHaveLength(0);
    tiles.forEach(({ attrs }) => {
      expect(attrs.join(' ')).toMatch(/removeDisabled=\{saving\}/);
    });
  });
});

describe('the save handler', () => {
  test('is re-entrant-safe on its own, not just via the disabled button', () => {
    // Two taps inside one frame both read the pre-render `saving` state; only a
    // ref flips in time to stop the second.
    expect(source).toMatch(
      /const handleSave = useCallback\(async \(\) => \{\s*\n\s*if \(savingRef\.current\) return;/,
    );
    // …and it is released on every exit path, success or failure.
    expect(source).toMatch(/\} finally \{\s*\n\s*savingRef\.current = false;\s*\n\s*setSaving\(false\);/);
  });

  test('freezes the form body as well, for taps outside a named control', () => {
    expect(source).toMatch(/pointerEvents=\{saving \? 'none' : 'auto'\}/);
    expect(source).toContain('Keyboard.dismiss();');
  });
});
