/**
 * shared/components/AppUpdateBanner.js — what each status renders, which
 * buttons it offers, what a screen reader is told, and that a double tap
 * starts one update.
 *
 * useAppUpdate is mocked per test (its own suite covers the store). The
 * react-native pieces the banner uses are plain host components here, so
 * react-test-renderer can render it under this node-only config.
 */
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';

jest.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles) => styles },
  AccessibilityInfo: { announceForAccessibility: jest.fn() },
  Platform: { OS: 'android', select: (spec) => spec.android ?? spec.default },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
// t() returns the key, so the assertions name the i18n keys the banner asks for.
jest.mock('../../context/LanguageContext', () => ({ useLanguage: () => ({ t: (key) => key }) }));
jest.mock('../../hooks/useAppUpdate', () => ({ useAppUpdate: jest.fn() }));
jest.mock('../ui/Button', () => {
  const R = require('react');
  return { __esModule: true, default: (props) => R.createElement('Button', props) };
});
jest.mock('../ui/Text', () => {
  const R = require('react');
  return { __esModule: true, default: (props) => R.createElement('Text', props) };
});

const { AccessibilityInfo } = require('react-native');
const { useAppUpdate } = require('../../hooks/useAppUpdate');
const AppUpdateBanner = require('../AppUpdateBanner').default;

global.IS_REACT_ACT_ENVIRONMENT = true;

const realConsoleError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((msg, ...rest) => {
    if (String(msg).includes('react-test-renderer is deprecated')) return;
    realConsoleError(msg, ...rest);
  });
});
afterAll(() => console.error.mockRestore());

let store;
function setStore(patch) {
  store = { ...store, ...patch };
  useAppUpdate.mockImplementation(() => store);
}

beforeEach(() => {
  AccessibilityInfo.announceForAccessibility.mockClear();
  store = {
    status: 'idle', errorKind: null, restarting: false, progress: null, bannerVisible: false,
    updateNow: jest.fn(() => Promise.resolve()), dismiss: jest.fn(),
  };
  setStore({});
});

function render(props = {}) {
  let tree;
  act(() => { tree = TestRenderer.create(<AppUpdateBanner {...props} />); });
  return {
    tree,
    rerender: () => act(() => { tree.update(<AppUpdateBanner {...props} />); }),
    buttons: () => tree.root.findAll((n) => n.type === 'Button').map((n) => n.props),
    message: () => tree.root.findAll((n) => n.type === 'Text').map((n) => n.props.children).join(''),
    alert: () => tree.root.find((n) => n.type === 'View' && n.props.accessibilityRole === 'alert').props,
  };
}

test('renders nothing unless the store says bannerVisible', () => {
  setStore({ status: 'available', bannerVisible: false });
  const r = render();
  expect(r.tree.toJSON()).toBeNull();
  expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
});

test.each([
  ['available',   {},                        'appUpdate.available',    ['appUpdate.updateNow', 'appUpdate.later']],
  ['ready',       {},                        'appUpdate.available',    ['appUpdate.restartToUpdate', 'appUpdate.later']],
  ['downloading', { progress: 0.42 },        'appUpdate.updating 42%', ['appUpdate.later']],
  ['error',       { errorKind: 'download' }, 'appUpdate.failed',       ['appUpdate.retry', 'appUpdate.later']],
])('%s: message and buttons, and Later is always there', (status, extra, message, titles) => {
  setStore({ status, bannerVisible: true, ...extra });
  const r = render();
  expect(r.message()).toBe(message);
  expect(r.buttons().map((b) => b.title)).toEqual(titles);
  // 44dp buttons that may take two lines, so a long label cannot push Later off.
  r.buttons().forEach((b) => {
    expect(b.size).toBe('md');
    expect(b.titleLines).toBeUndefined();
  });
});

test('the action row wraps', () => {
  setStore({ status: 'available', bannerVisible: true });
  const r = render();
  const rows = r.tree.root.findAll((n) => n.type === 'View' && n.props.style && n.props.style.flexWrap === 'wrap');
  expect(rows).toHaveLength(1);
});

test('no elevation on the wrapper, and a zIndex under the 9999 toasts use', () => {
  setStore({ status: 'available', bannerVisible: true });
  const r = render();
  const wrap = r.tree.root.find((n) => n.type === 'View' && n.props.pointerEvents === 'box-none');
  const style = Object.assign({}, ...[].concat(wrap.props.style));
  expect(style.elevation).toBeUndefined();
  expect(style.zIndex).toBeLessThan(9999);
});

test('the screen-reader label does not change with the download percentage, and is said once', () => {
  setStore({ status: 'downloading', bannerVisible: true, progress: 0.1 });
  const r = render();
  const first = r.alert().accessibilityLabel;
  expect(first).toBe('appUpdate.updating');
  expect(r.alert().accessibilityLiveRegion).toBeUndefined();
  setStore({ progress: 0.43 });
  r.rerender();
  setStore({ progress: 0.44 });
  r.rerender();
  expect(r.message()).toBe('appUpdate.updating 44%');
  expect(r.alert().accessibilityLabel).toBe(first);
  expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
  expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('appUpdate.updating');
});

test('appearing announces it; each new variant is announced once', () => {
  setStore({ status: 'available', bannerVisible: false });
  const r = render();
  setStore({ bannerVisible: true });
  r.rerender();
  expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith('appUpdate.bannerA11y');
  r.rerender();
  expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
  setStore({ status: 'error', errorKind: 'download' });
  r.rerender();
  expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith('appUpdate.failed');
  expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(2);
});

test('two fast taps call updateNow once; the button shows busy meanwhile', async () => {
  let finish;
  const updateNow = jest.fn(() => new Promise((res) => { finish = res; }));
  setStore({ status: 'available', bannerVisible: true, updateNow });
  const r = render();
  await act(async () => {
    r.buttons()[0].onPress();
    r.buttons()[0].onPress();
  });
  expect(updateNow).toHaveBeenCalledTimes(1);
  expect(r.buttons()[0].loading).toBe(true);
  await act(async () => { finish(); });
  expect(r.buttons()[0].loading).toBe(false);
});

test('stays busy while the store says the app is restarting', () => {
  setStore({ status: 'ready', bannerVisible: true, restarting: true });
  const r = render();
  expect(r.buttons()[0].loading).toBe(true);
});

test('Later calls dismiss', () => {
  setStore({ status: 'downloading', bannerVisible: true, progress: 0 });
  const r = render();
  act(() => { r.buttons()[0].onPress(); });
  expect(store.dismiss).toHaveBeenCalledTimes(1);
});

test('an app can supply its own button and colours (the seller app)', () => {
  const Seller = jest.fn(() => null);
  setStore({ status: 'ready', bannerVisible: true });
  const r = render({ ActionButton: Seller, palette: { accent: '#E65100', card: '#FFFDF8', border: '#E8DCC8' } });
  const calls = Seller.mock.calls.map(([props]) => [props.title, props.primary]);
  expect(calls).toEqual([['appUpdate.restartToUpdate', true], ['appUpdate.later', false]]);
  const card = r.tree.root.find((n) => n.type === 'View' && [].concat(n.props.style).some((x) => x && x.backgroundColor === '#FFFDF8'));
  expect(card).toBeTruthy();
  const icon = r.tree.root.find((n) => n.type === 'Ionicons');
  expect(icon.props.color).toBe('#E65100');
});
