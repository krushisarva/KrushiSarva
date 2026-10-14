/**
 * shared/components/RootErrorBoundary.js — Reload must reach a fix.
 *
 * The apps never check for updates on launch (checkAutomatically NEVER), and
 * this fallback replaces the whole tree, update banner included. So when a
 * published update crashes on render, Reload has to fetch the newer update
 * before restarting, or the user is stuck until they reinstall.
 */
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';

const mockUpdates = {
  isEnabled: true,
  channel: 'preview',
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
};
jest.mock('expo-updates', () => mockUpdates);
jest.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  Image: 'Image',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles) => styles },
  Platform: { OS: 'android', select: (spec) => spec.android ?? spec.default },
}));
jest.mock('../../services/crashReporter', () => ({ captureException: jest.fn() }));
jest.mock('../../assets/state/error.webp', () => 1);

const RootErrorBoundary = require('../RootErrorBoundary').default;

global.IS_REACT_ACT_ENVIRONMENT = true;

// React reports every caught render error, and react-test-renderer 19 logs a
// deprecation on create(); neither is what these tests are about.
beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => console.error.mockRestore());

let crash;
function Screen() {
  if (crash) throw new Error('bad update');
  return 'home';
}

function render() {
  let tree;
  act(() => { tree = TestRenderer.create(<RootErrorBoundary><Screen /></RootErrorBoundary>); });
  const button = () => tree.root.find((n) => n.type === 'TouchableOpacity');
  return {
    tree,
    button,
    press: () => act(async () => { await button().props.onPress(); }),
  };
}

beforeEach(() => {
  crash = true;
  global.__DEV__ = false;
  Object.assign(mockUpdates, { isEnabled: true, channel: 'preview' });
  mockUpdates.checkForUpdateAsync.mockReset().mockResolvedValue({ isAvailable: true, manifest: { id: 'fix' }, isRollBackToEmbedded: false });
  mockUpdates.fetchUpdateAsync.mockReset().mockResolvedValue({ isNew: true, manifest: { id: 'fix' } });
  mockUpdates.reloadAsync.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { delete global.__DEV__; });

test('Reload fetches a published fix before restarting', async () => {
  const r = render();
  await r.press();
  expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  expect(mockUpdates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
  expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
  expect(mockUpdates.fetchUpdateAsync.mock.invocationCallOrder[0])
    .toBeLessThan(mockUpdates.reloadAsync.mock.invocationCallOrder[0]);
  // Busy until the restart lands, so a second tap does nothing.
  expect(r.button().props.disabled).toBe(true);
});

test('a rollback directive is fetched too', async () => {
  mockUpdates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: true });
  const r = render();
  await r.press();
  expect(mockUpdates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
  expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
});

test('nothing newer: no download, just the restart', async () => {
  mockUpdates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: false });
  const r = render();
  await r.press();
  expect(mockUpdates.fetchUpdateAsync).not.toHaveBeenCalled();
  expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
});

test('offline: still restarts', async () => {
  mockUpdates.checkForUpdateAsync.mockRejectedValue(new Error('offline'));
  const r = render();
  await r.press();
  expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
});

test.each([
  ['in __DEV__', () => { global.__DEV__ = true; }],
  ['with no channel (dev client)', () => { mockUpdates.channel = null; }],
  ['with expo-updates off', () => { mockUpdates.isEnabled = false; }],
])('%s: no check, only the restart', async (_label, arrange) => {
  arrange();
  const r = render();
  await r.press();
  expect(mockUpdates.checkForUpdateAsync).not.toHaveBeenCalled();
  expect(mockUpdates.fetchUpdateAsync).not.toHaveBeenCalled();
  expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
});

test('two taps run one check', async () => {
  let finish;
  mockUpdates.checkForUpdateAsync.mockReturnValue(new Promise((res) => { finish = res; }));
  const r = render();
  const onPress = r.button().props.onPress;
  await act(async () => { onPress(); onPress(); });
  await act(async () => { finish({ isAvailable: false }); });
  expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
});

test('a failed restart re-renders the app', async () => {
  mockUpdates.reloadAsync.mockRejectedValue(new Error('no restart'));
  const r = render();
  crash = false;
  await r.press();
  expect(r.tree.toJSON()).toBe('home');
});
