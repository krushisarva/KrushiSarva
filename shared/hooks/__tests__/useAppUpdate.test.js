/**
 * shared/hooks/useAppUpdate.js — when the app asks for an update, when it
 * downloads one (only when asked), and when the banner shows.
 *
 * The hook keeps one module-level store, so every test loads a fresh copy of it
 * (and of React, which must be the same copy the renderer uses).
 */

// Mutable stand-ins the mocks below hand out; `mock` prefix so jest.mock's
// hoisting allows the factories to reference them.
let mockNative = {};
const mockUpdates = {
  isEnabled: true,
  isEmbeddedLaunch: true,
  updateId: null,
  channel: 'production',
  runtimeVersion: '1.0.0',
  createdAt: null,
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
  useUpdates: jest.fn(() => mockNative),
};
const mockAppState = {
  currentState: 'active',
  handlers: new Set(),
  addEventListener: jest.fn((type, fn) => {
    mockAppState.handlers.add(fn);
    return { remove: () => mockAppState.handlers.delete(fn) };
  }),
};

jest.mock('expo-updates', () => mockUpdates);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.0.0' } } }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: mockAppState }));

global.IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60 * 1000;
let now;
let env;
const mounted = [];

const AVAILABLE = (id = 'u-1') => ({ isAvailable: true, manifest: { id }, isRollBackToEmbedded: false });
const NONE = { isAvailable: false, manifest: undefined, isRollBackToEmbedded: false };
const NEW = (id = 'u-1') => ({ isNew: true, manifest: { id }, isRollBackToEmbedded: false });
const NOT_NEW = { isNew: false, manifest: undefined, isRollBackToEmbedded: false };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function load({ dev = false } = {}) {
  jest.resetModules();
  global.__DEV__ = dev;
  const React = require('react');
  const TestRenderer = require('react-test-renderer');
  const { useAppUpdate, describeUpdateRow } = require('../useAppUpdate');
  env = { React, TestRenderer, useAppUpdate, describeUpdateRow };
  return env;
}

// Mounts one consumer; `h.current` is the hook's latest return value.
function mount() {
  const h = { current: null, renderer: null };
  function Probe() {
    h.current = env.useAppUpdate();
    return null;
  }
  env.React.act(() => { h.renderer = env.TestRenderer.create(env.React.createElement(Probe)); });
  h.rerender = () => env.React.act(() => { h.renderer.update(env.React.createElement(Probe)); });
  h.unmount = () => env.React.act(() => { h.renderer.unmount(); });
  mounted.push(h);
  return h;
}

async function settle() {
  for (let i = 0; i < 4; i += 1) await env.React.act(async () => {});
}

async function foreground(state = 'active') {
  mockAppState.currentState = state;
  await env.React.act(async () => { mockAppState.handlers.forEach((fn) => fn(state)); });
  await settle();
}

// Replays the native state machine: changes the useUpdates() context, then
// re-renders every mounted consumer so their effects see it.
function nativeEvent(patch) {
  mockNative = { ...mockNative, ...patch };
  mounted.forEach((h) => h.rerender());
}

// Runs an action inside act and lets its promise settle; returns its result.
async function run(fn) {
  let out;
  await env.React.act(async () => { out = await fn(); });
  await settle();
  return out;
}

// react-test-renderer 19 logs a deprecation on every create(); it is still the
// lightest way to drive a hook under this node-only config.
const realConsoleError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((msg, ...rest) => {
    if (String(msg).includes('react-test-renderer is deprecated')) return;
    realConsoleError(msg, ...rest);
  });
});
afterAll(() => console.error.mockRestore());

beforeEach(() => {
  now = Date.parse('2026-10-14T09:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockNative = {
    isUpdatePending: false, downloadedUpdate: undefined, downloadProgress: undefined,
    isDownloading: false, isStartupProcedureRunning: false,
  };
  mockAppState.currentState = 'active';
  Object.assign(mockUpdates, {
    isEnabled: true, isEmbeddedLaunch: true, updateId: null, channel: 'production',
    runtimeVersion: '1.0.0', createdAt: null,
  });
  mockUpdates.checkForUpdateAsync.mockReset().mockResolvedValue(NONE);
  mockUpdates.fetchUpdateAsync.mockReset().mockResolvedValue(NEW());
  mockUpdates.reloadAsync.mockReset().mockResolvedValue(undefined);
  mockUpdates.useUpdates.mockClear();
  mockAppState.addEventListener.mockClear();
  mockAppState.handlers.clear();
});

afterEach(() => {
  while (mounted.length) {
    const h = mounted.pop();
    try { h.unmount(); } catch { /* already unmounted */ }
  }
  Date.now.mockRestore();
  delete global.__DEV__;
});

function expectNoUpdateCalls() {
  expect(mockUpdates.checkForUpdateAsync).not.toHaveBeenCalled();
  expect(mockUpdates.fetchUpdateAsync).not.toHaveBeenCalled();
  expect(mockUpdates.reloadAsync).not.toHaveBeenCalled();
}

describe('disabled', () => {
  test.each([
    ['in __DEV__', () => load({ dev: true })],
    ['when expo-updates is off', () => { mockUpdates.isEnabled = false; load(); }],
    // A development build running a published update: __DEV__ false,
    // isEnabled true, no channel, and every native call throws.
    ['with no EAS channel (dev client, Expo Go)', () => { mockUpdates.channel = null; load(); }],
  ])('%s: inert, makes no calls, still reports the version', async (_label, setup) => {
    setup();
    const h = mount();
    await settle();
    expect(h.current.status).toBe('disabled');
    expect(h.current.bannerVisible).toBe(false);
    expect(h.current.progress).toBeNull();
    expect(h.current.info.version).toBe('1.0.0');
    expect(await run(() => h.current.checkNow())).toBe('disabled');
    expect(await run(() => h.current.updateNow())).toBeUndefined();
    await foreground();
    expect(h.current.status).toBe('disabled');
    expectNoUpdateCalls();
    expect(mockUpdates.useUpdates).not.toHaveBeenCalled();
    expect(mockAppState.addEventListener).not.toHaveBeenCalled();
  });
});

describe('automatic check', () => {
  test('mounting checks once and never downloads on its own', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    load();
    const h = mount();
    expect(h.current.status).toBe('checking');
    await settle();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(h.current.status).toBe('available');
    expect(h.current.bannerVisible).toBe(true);
    expect(mockUpdates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(mockUpdates.reloadAsync).not.toHaveBeenCalled();
  });

  test('throttled to once per 30 minutes across foreground events', async () => {
    load();
    const h = mount();
    await settle();
    expect(h.current.status).toBe('upToDate');
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);

    now += 10 * MIN;
    await foreground();
    mount(); // a second consumer inside the window does not check either
    await settle();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);

    now += 21 * MIN; // 31 min since the first check
    await foreground('background');
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    await foreground('active');
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(2);

    now += 29 * MIN;
    await foreground();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
  });

  test('consumers share one store, one AppState listener and one in-flight check', async () => {
    const pending = deferred();
    mockUpdates.checkForUpdateAsync.mockReturnValue(pending.promise);
    load();
    const a = mount();
    const b = mount();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mockAppState.addEventListener).toHaveBeenCalledTimes(1);
    expect(b.current.status).toBe('checking');
    await env.React.act(async () => { pending.resolve(AVAILABLE()); });
    await settle();
    expect(a.current.status).toBe('available');
    expect(b.current.status).toBe('available');

    a.unmount();
    expect(mockAppState.handlers.size).toBe(1);
    b.unmount();
    expect(mockAppState.handlers.size).toBe(0);
  });

  test('a failed automatic check is silent and retried after 2 minutes, not 30', async () => {
    mockUpdates.checkForUpdateAsync.mockRejectedValue(new Error('offline'));
    load();
    const h = mount();
    await settle();
    expect(h.current.status).toBe('idle'); // not a red "Couldn't check" nobody asked for
    expect(h.current.errorKind).toBeNull();
    expect(h.current.bannerVisible).toBe(false);

    now += 1 * MIN;
    await foreground();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    now += 2 * MIN;
    await foreground();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
    expect(h.current.status).toBe('available');
  });

  test('a failed automatic check keeps the last answer', async () => {
    load();
    const h = mount();
    await settle();
    expect(h.current.status).toBe('upToDate');
    mockUpdates.checkForUpdateAsync.mockRejectedValue(new Error('offline'));
    now += 31 * MIN;
    await foreground();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
    expect(h.current.status).toBe('upToDate');
  });

  test('a manual check joining a failing automatic one reports the error', async () => {
    const pending = deferred();
    mockUpdates.checkForUpdateAsync.mockReturnValue(pending.promise);
    load();
    const h = mount();
    let result;
    env.React.act(() => { h.current.checkNow().then((r) => { result = r; }); });
    await env.React.act(async () => { pending.reject(new Error('offline')); });
    await settle();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(result).toBe('error');
    expect(h.current.status).toBe('error');
    expect(h.current.errorKind).toBe('check');
    expect(h.current.bannerVisible).toBe(false);
  });

  test('waits for the native launch check of older binaries instead of queueing behind it', async () => {
    mockNative = { ...mockNative, isStartupProcedureRunning: true };
    load();
    const h = mount();
    await settle();
    expect(mockUpdates.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(h.current.status).toBe('idle');

    // It downloaded an update in the background, then finished.
    nativeEvent({ isUpdatePending: true, downloadedUpdate: { type: 'new', updateId: 'u-bg' } });
    await settle();
    nativeEvent({ isStartupProcedureRunning: false });
    await settle();
    expect(h.current.status).toBe('ready');
    expect(mockUpdates.checkForUpdateAsync).not.toHaveBeenCalled();
  });

  test('checks once the native launch check ends with nothing downloaded', async () => {
    mockNative = { ...mockNative, isStartupProcedureRunning: true };
    load();
    mount();
    await settle();
    expect(mockUpdates.checkForUpdateAsync).not.toHaveBeenCalled();
    nativeEvent({ isStartupProcedureRunning: false });
    await settle();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });
});

describe('checkNow', () => {
  test.each([
    ['available', () => mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE()), true],
    ['upToDate', () => mockUpdates.checkForUpdateAsync.mockResolvedValue(NONE), false],
    ['error', () => mockUpdates.checkForUpdateAsync.mockRejectedValue(new Error('timeout')), false],
  ])('resolves %s and the status follows', async (expected, arrange, banner) => {
    load();
    const h = mount();
    await settle();
    arrange();
    const result = await run(() => h.current.checkNow()); // inside the 30-min window: ignores it
    expect(result).toBe(expected);
    expect(h.current.status).toBe(expected);
    expect(h.current.bannerVisible).toBe(banner);
    expect(h.current.errorKind).toBe(expected === 'error' ? 'check' : null);
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
    expect(mockUpdates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  test('a rollback directive counts as an update to apply', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, manifest: undefined, isRollBackToEmbedded: true });
    mockUpdates.fetchUpdateAsync.mockResolvedValue({ isNew: false, manifest: undefined, isRollBackToEmbedded: true });
    load();
    const h = mount();
    await settle();
    expect(h.current.status).toBe('available');
    await run(() => h.current.updateNow());
    expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
    expect(h.current.status).toBe('ready');
    expect(h.current.restarting).toBe(true);
  });
});

describe('updateNow', () => {
  test('downloads, then restarts into the update', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    const download = deferred();
    mockUpdates.fetchUpdateAsync.mockReturnValue(download.promise);
    load();
    const h = mount();
    await settle();

    let done;
    env.React.act(() => { done = h.current.updateNow(); });
    expect(h.current.status).toBe('downloading');
    expect(h.current.progress).toBe(0);
    expect(h.current.bannerVisible).toBe(true);
    mockNative = { ...mockNative, isDownloading: true, downloadProgress: 0.4 };
    h.rerender();
    expect(h.current.progress).toBe(0.4);
    expect(mockUpdates.reloadAsync).not.toHaveBeenCalled();

    await env.React.act(async () => { download.resolve(NEW()); await done; });
    expect(mockUpdates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdates.fetchUpdateAsync.mock.invocationCallOrder[0])
      .toBeLessThan(mockUpdates.reloadAsync.mock.invocationCallOrder[0]);
    expect(h.current.status).toBe('ready');
    expect(h.current.progress).toBeNull();
  });

  // Native FetchUpdateProcedure: no update -> DownloadComplete, which sets
  // isUpdatePending true with no downloaded manifest, then {isNew:false}.
  test.each([
    ['before the fetch resolves', true],
    ['after the fetch resolves', false],
  ])('isNew false with native pending raised %s: upToDate, no restart, later checks still run', async (_label, eventFirst) => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    const download = deferred();
    mockUpdates.fetchUpdateAsync.mockReturnValue(download.promise);
    load();
    const h = mount();
    await settle();
    let done;
    env.React.act(() => { done = h.current.updateNow(); });
    nativeEvent({ isDownloading: true, downloadProgress: 0 });
    const raise = () => nativeEvent({ isDownloading: false, isUpdatePending: true, downloadProgress: 1 });
    if (eventFirst) raise();
    await env.React.act(async () => { download.resolve(NOT_NEW); await done; });
    if (!eventFirst) raise();
    await settle();
    expect(h.current.status).toBe('upToDate');
    expect(h.current.bannerVisible).toBe(false);
    expect(mockUpdates.reloadAsync).not.toHaveBeenCalled();

    // Even a later native event that does name a download is not trusted now.
    nativeEvent({ downloadedUpdate: { type: 'rollback', updateId: undefined } });
    await settle();
    expect(h.current.status).toBe('upToDate');

    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE('u-2'));
    expect(await run(() => h.current.checkNow())).toBe('available');
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
    expect(h.current.bannerVisible).toBe(true);
  });

  test('a failed download sets error, keeps the banner for a retry, never throws', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    mockUpdates.fetchUpdateAsync.mockRejectedValueOnce(new Error('network'));
    load();
    const h = mount();
    await settle();
    await expect(run(() => h.current.updateNow())).resolves.toBeUndefined();
    expect(h.current.status).toBe('error');
    expect(h.current.errorKind).toBe('download');
    expect(h.current.bannerVisible).toBe(true);
    expect(mockUpdates.reloadAsync).not.toHaveBeenCalled();

    // Automatic checks leave an offered retry alone.
    now += 31 * MIN;
    await foreground();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);

    await run(() => h.current.updateNow()); // Try again
    expect(mockUpdates.fetchUpdateAsync).toHaveBeenCalledTimes(2);
    expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  test('a failed restart goes back to ready (not a network error); Restart retries without a download', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    mockUpdates.reloadAsync.mockRejectedValueOnce(new Error('reload failed'));
    load();
    const h = mount();
    await settle();
    await expect(run(() => h.current.updateNow())).resolves.toBeUndefined();
    expect(h.current.status).toBe('ready');
    expect(h.current.errorKind).toBeNull();
    expect(h.current.restarting).toBe(false);
    expect(h.current.bannerVisible).toBe(true);
    expect(await run(() => h.current.checkNow())).toBe('ready'); // nothing to ask: it is downloaded
    expect(h.current.status).toBe('ready');
    await run(() => h.current.updateNow());
    expect(mockUpdates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(2);
  });

  test('two taps start one download', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    load();
    const h = mount();
    await settle();
    await run(() => Promise.all([h.current.updateNow(), h.current.updateNow()]));
    expect(mockUpdates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  // reloadAsync resolves just before native posts the restart.
  test('a tap after reloadAsync resolved does not restart a second time', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    load();
    const h = mount();
    await settle();
    await run(() => h.current.updateNow());
    expect(h.current.restarting).toBe(true);
    await run(() => h.current.updateNow());
    await run(() => h.current.updateNow());
    expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  test('left the app during the download: waits as ready instead of restarting in the background', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    const download = deferred();
    mockUpdates.fetchUpdateAsync.mockReturnValue(download.promise);
    load();
    const h = mount();
    await settle();
    let done;
    env.React.act(() => { done = h.current.updateNow(); });
    await foreground('background');
    await env.React.act(async () => { download.resolve(NEW()); await done; });
    expect(mockUpdates.reloadAsync).not.toHaveBeenCalled();
    expect(h.current.status).toBe('ready');

    await foreground('active');
    expect(mockUpdates.reloadAsync).not.toHaveBeenCalled(); // no surprise restart on return
    expect(h.current.bannerVisible).toBe(true); // "Restart to update"
    await run(() => h.current.updateNow());
    expect(mockUpdates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  test('Later during the download: finishes, stays hidden, no restart', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    const download = deferred();
    mockUpdates.fetchUpdateAsync.mockReturnValue(download.promise);
    load();
    const h = mount();
    await settle();
    let done;
    env.React.act(() => { done = h.current.updateNow(); });
    env.React.act(() => h.current.dismiss());
    expect(h.current.bannerVisible).toBe(false);
    await env.React.act(async () => { download.resolve(NEW()); await done; });
    expect(mockUpdates.reloadAsync).not.toHaveBeenCalled();
    expect(h.current.status).toBe('ready');
    expect(h.current.bannerVisible).toBe(false);
  });

  test('Update now from Profile on an already dismissed update still restarts', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    load();
    const h = mount();
    await settle();
    env.React.act(() => h.current.dismiss());
    await run(() => h.current.updateNow());
    expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  test('progress ignores what a previous failed download left behind', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE());
    mockUpdates.fetchUpdateAsync.mockRejectedValueOnce(new Error('network'));
    load();
    const h = mount();
    await settle();
    await run(() => h.current.updateNow());
    nativeEvent({ isDownloading: false, downloadProgress: 0.85 }); // native DownloadError keeps it
    const download = deferred();
    mockUpdates.fetchUpdateAsync.mockReturnValue(download.promise);
    let done;
    env.React.act(() => { done = h.current.updateNow(); });
    expect(h.current.status).toBe('downloading');
    expect(h.current.progress).toBe(0);
    nativeEvent({ isDownloading: true, downloadProgress: 0.1 });
    expect(h.current.progress).toBe(0.1);
    await env.React.act(async () => { download.resolve(NEW()); await done; });
  });
});

describe('an update the native layer already downloaded', () => {
  test('shows as ready; updateNow only restarts; no check is needed', async () => {
    mockNative = { isUpdatePending: true, downloadedUpdate: { updateId: 'u-native' }, downloadProgress: 1 };
    load();
    const h = mount();
    await settle();
    expect(h.current.status).toBe('ready');
    expect(h.current.bannerVisible).toBe(true);
    expect(mockUpdates.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(await run(() => h.current.checkNow())).toBe('ready');
    expect(mockUpdates.checkForUpdateAsync).not.toHaveBeenCalled();

    await run(() => h.current.updateNow());
    expect(mockUpdates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  test('a download finishing after mount flips the status to ready', async () => {
    load();
    const h = mount();
    await settle();
    expect(h.current.status).toBe('upToDate');
    nativeEvent({ isUpdatePending: true, downloadedUpdate: { updateId: 'u-native' } });
    await settle();
    expect(h.current.status).toBe('ready');
    expect(h.current.bannerVisible).toBe(true);
  });

  test('a native rollback counts, and Later hides it', async () => {
    mockNative = { ...mockNative, isUpdatePending: true, downloadedUpdate: { type: 'rollback', updateId: undefined } };
    load();
    const h = mount();
    await settle();
    expect(h.current.status).toBe('ready');
    expect(h.current.bannerVisible).toBe(true);
    env.React.act(() => h.current.dismiss());
    expect(h.current.bannerVisible).toBe(false);
  });

  test('pending with nothing downloaded is not an update', async () => {
    mockNative = { ...mockNative, isUpdatePending: true, downloadedUpdate: undefined, downloadProgress: 1 };
    load();
    const h = mount();
    await settle();
    expect(h.current.status).toBe('upToDate');
    expect(h.current.bannerVisible).toBe(false);
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });
});

describe('dismiss', () => {
  test('hides the banner for that update only, for every consumer', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE('u-1'));
    load();
    const banner = mount();
    const profile = mount();
    await settle();
    expect(banner.current.bannerVisible).toBe(true);

    env.React.act(() => banner.current.dismiss());
    expect(banner.current.bannerVisible).toBe(false);
    expect(profile.current.bannerVisible).toBe(false);
    expect(banner.current.status).toBe('available'); // the profile row can still offer it

    await run(() => profile.current.checkNow()); // same update again: stays hidden
    expect(banner.current.bannerVisible).toBe(false);

    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE('u-2'));
    await run(() => profile.current.checkNow());
    expect(banner.current.bannerVisible).toBe(true);
  });

  test('automatic checks keep running after Later, so a newer update raises the banner again', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE('u-1'));
    load();
    const h = mount();
    await settle();
    env.React.act(() => h.current.dismiss());

    now += 31 * MIN;
    await foreground(); // same update: still hidden
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
    expect(h.current.bannerVisible).toBe(false);

    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE('u-2'));
    now += 31 * MIN;
    await foreground();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(3);
    expect(h.current.status).toBe('available');
    expect(h.current.bannerVisible).toBe(true);
  });

  test('an offered update whose banner is up is not re-checked behind it', async () => {
    mockUpdates.checkForUpdateAsync.mockResolvedValue(AVAILABLE('u-1'));
    load();
    const h = mount();
    await settle();
    now += 31 * MIN;
    await foreground();
    expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(h.current.bannerVisible).toBe(true);
  });
});

describe('describeUpdateRow (both Profile rows)', () => {
  const row = (state) => env.describeUpdateRow(state);
  beforeEach(() => { load(); });

  test.each([
    // status, errorKind, note key, action key, runs, busy, red note
    ['idle',        null,       null,                    'appUpdate.check',           'check',  false, false],
    ['checking',    null,       'appUpdate.checking',    'appUpdate.check',           'check',  true,  false],
    ['upToDate',    null,       'appUpdate.upToDate',    'appUpdate.check',           'check',  false, false],
    ['available',   null,       'appUpdate.available',   'appUpdate.updateNow',       'update', false, false],
    ['downloading', null,       'appUpdate.updating',    'appUpdate.updateNow',       'update', true,  false],
    ['ready',       null,       'appUpdate.available',   'appUpdate.restartToUpdate', 'update', false, false],
    ['error',       'check',    'appUpdate.checkFailed', 'appUpdate.check',           'check',  false, true],
    ['error',       'download', 'appUpdate.failed',      'appUpdate.retry',           'update', false, true],
  ])('%s / %s', (status, errorKind, noteKey, actionKey, runs, busy, red) => {
    const m = row({ status, errorKind });
    expect(m.note ? m.note[0] : null).toBe(noteKey);
    expect(m.action[0]).toBe(actionKey);
    expect(m.runs).toBe(runs);
    expect(m.busy).toBe(busy);
    expect(m.noteIsError).toBe(red);
    expect(m.showButton).toBe(true);
  });

  test('disabled shows no button; restarting is busy', () => {
    expect(row({ status: 'disabled' }).showButton).toBe(false);
    expect(row({ status: 'disabled' }).note).toBeNull();
    expect(row({ status: 'ready', restarting: true }).busy).toBe(true);
  });

  test('every key it names exists in all 10 languages', () => {
    const { translations } = require('../../i18n/translations');
    const keys = new Set();
    ['idle', 'checking', 'upToDate', 'available', 'downloading', 'ready'].forEach((status) => {
      const m = row({ status });
      if (m.note) keys.add(m.note[0]);
      keys.add(m.action[0]);
    });
    ['check', 'download'].forEach((errorKind) => {
      const m = row({ status: 'error', errorKind });
      keys.add(m.note[0]);
      keys.add(m.action[0]);
    });
    const langs = ['en', 'hi', 'mr', 'bn', 'gu', 'kn', 'ml', 'pa', 'ta', 'te'];
    langs.forEach((lang) => {
      // The language's own file, not the English backfill merged over it.
      const table = ['en', 'hi', 'mr'].includes(lang)
        ? translations[lang]
        : require('../../i18n/lang/' + lang).default;
      keys.forEach((k) => {
        const leaf = k.split('.').reduce((o, part) => (o == null ? o : o[part]), table);
        expect([lang, k, typeof leaf]).toEqual([lang, k, 'string']);
      });
    });
  });
});

describe('info', () => {
  test('the built-in bundle has no update id', async () => {
    load();
    const h = mount();
    await settle();
    expect(h.current.info).toEqual({
      version: '1.0.0', runtimeVersion: '1.0.0', updateId: null, isEmbedded: true, channel: 'production', createdAt: null,
    });
  });

  test('an OTA launch reports the first 8 characters of its id', async () => {
    const createdAt = new Date('2026-10-13T10:00:00Z');
    Object.assign(mockUpdates, { isEmbeddedLaunch: false, updateId: 'dc32749d-1b2c-4d5e-8f90-123456789abc', createdAt });
    load();
    const h = mount();
    await settle();
    expect(h.current.info).toMatchObject({ updateId: 'dc32749d', isEmbedded: false, createdAt });
  });
});
