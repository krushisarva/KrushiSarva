/**
 * BusinessProfileScreen — an account that has not finished setting up its shop
 * can delete itself, not only log out.
 *
 * Such an account opens on this screen and never reaches SellerProfileScreen,
 * where the seller app's usual "Delete my account" entry lives. Google Play
 * requires every app that creates accounts to let them be deleted from inside
 * the app, so wherever this screen offers Log out it must offer Delete too.
 *
 * A STATIC audit, like addProductSaveLock.test.js and for the same reason:
 * frontend/jest.config.js runs suites in node with a stub `react-native`, so
 * the screen cannot be mounted here.
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const FILE = path.join(__dirname, '..', 'BusinessProfileScreen.js');
const ast = parse(fs.readFileSync(FILE, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });

/** Visit every node with its chain of ancestors, without @babel/traverse. */
function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit, ancestors));
    return;
  }
  if (typeof node.type === 'string') visit(node, ancestors);
  const next = typeof node.type === 'string' ? [...ancestors, node] : ancestors;
  Object.keys(node).forEach((key) => {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') return;
    const child = node[key];
    if (child && typeof child === 'object') walk(child, visit, next);
  });
}

const attr = (el, name) => el.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === name);

/** The identifier an element's onPress points at, if it is a bare identifier. */
const onPressName = (el) => attr(el, 'onPress')?.value?.expression?.name;

/** True for label={t('deleteAccount.entry', …)}. */
const isDeleteLabel = (el) => {
  const call = attr(el, 'label')?.value?.expression;
  return call?.type === 'CallExpression' && call.arguments[0]?.value === 'deleteAccount.entry';
};

/** Every <Button> opening element inside `root`. */
function buttonsIn(root) {
  const found = [];
  walk(root, (n) => {
    if (n.type === 'JSXOpeningElement' && n.name.name === 'Button') found.push(n);
  });
  return found;
}

test('imports the same shared DeleteAccountModal the seller profile uses', () => {
  const imp = ast.program.body.find(
    (n) => n.type === 'ImportDeclaration' && n.source.value === '@krushisarva/shared/components/DeleteAccountModal',
  );
  expect(imp).toBeDefined();
  expect(imp.specifiers[0]).toMatchObject({ type: 'ImportDefaultSpecifier', local: { name: 'DeleteAccountModal' } });
});

test('every place that offers Log out also offers Delete my account', () => {
  // The element that holds each Log out button: the delete entry must be in the
  // same conditional block, so it shows exactly when Log out does.
  const blocks = [];
  walk(ast, (n, ancestors) => {
    if (n.type !== 'JSXOpeningElement' || n.name.name !== 'Button' || onPressName(n) !== 'handleLogout') return;
    const block = [...ancestors].reverse().find((a) => a.type === 'ConditionalExpression');
    blocks.push(block);
  });

  expect(blocks).toHaveLength(2); // the loading/error gate and the form
  blocks.forEach((block) => {
    expect(block).toBeDefined();
    const del = buttonsIn(block.consequent).filter(isDeleteLabel);
    expect(del).toHaveLength(1);
    // The form's entry is a prop from the screen; both open the one modal.
    expect(['openDeleteAccount', 'onDeleteAccount']).toContain(onPressName(del[0]));
  });
});

test('the delete entry is locked while a save is in flight, like Log out', () => {
  const del = buttonsIn(ast).filter(isDeleteLabel).find((el) => onPressName(el) === 'onDeleteAccount');
  expect(attr(del, 'disabled')?.value?.expression?.name).toBe('saving');
});

test('the modal is mounted once, outside the loading/form switch', () => {
  // Inside either branch, the profile finishing loading would unmount it in
  // the middle of the SMS step and throw away the code being typed.
  const mounts = [];
  walk(ast, (n, ancestors) => {
    if (n.type === 'JSXOpeningElement' && n.name.name === 'DeleteAccountModal') mounts.push(ancestors);
  });

  expect(mounts).toHaveLength(1);
  const ancestors = mounts[0];
  expect(ancestors.some((a) => a.type === 'ConditionalExpression')).toBe(false);
  const fn = ancestors.find((a) => a.type === 'FunctionDeclaration');
  expect(fn.id.name).toBe('BusinessProfileScreen');
});
