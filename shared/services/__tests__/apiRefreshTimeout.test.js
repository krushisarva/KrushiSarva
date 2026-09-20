/**
 * shared/services/api.js — a token refresh that never answers must still settle.
 *
 * The refresh posts go through plain axios, which has no timeout by default, and
 * React Native's Android client has none either. A 401 → refresh on a connection
 * that dropped mid-flight waited forever: isRefreshing stayed up, every later 401
 * queued behind it, and a cold start sat on the boot screen until the app was
 * killed. Logout goes through the same interceptor, so it hung with it.
 */

// Stands in for axios's own handling of `timeout`: reject with ECONNABORTED once
// it elapses. With no timeout — axios's default of 0 — a dead connection simply
// never answers, which is exactly what the old refresh post got.
function stalledTransport(url, body, config = {}) {
  return new Promise((resolve, reject) => {
    if (config.timeout > 0) {
      setTimeout(() => reject(Object.assign(
        new Error(`timeout of ${config.timeout}ms exceeded`),
        { code: 'ECONNABORTED', config },
      )), config.timeout);
    }
  });
}

jest.mock('axios', () => {
  // Each instance is callable (the 401 replay calls `instance(original)`) and
  // keeps its response-error interceptor so a test can hand it a 401.
  const create = jest.fn(() => {
    const instance = jest.fn();
    instance.interceptors = {
      request: { use: jest.fn() },
      response: { use: jest.fn((onOk, onError) => { instance.onResponseError = onError; }) },
    };
    return instance;
  });
  return { __esModule: true, default: { create, post: jest.fn() } };
});

jest.mock('../../utils/storage', () => {
  const store = new Map();
  const storage = {
    store,
    // When set, deleteItem waits on it — lets a test hold clearTokens() open.
    gate: null,
    getItem: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    setItem: jest.fn(async (k, v) => { store.set(k, v); }),
    deleteItem: jest.fn(async (k) => {
      if (storage.gate) await storage.gate;
      store.delete(k);
    }),
  };
  return storage;
});

jest.mock('../../constants/config', () => ({
  API_BASE_URL: 'https://api.test/api/v1',
  STORAGE_KEYS: {
    ACCESS_TOKEN: 'accessToken',
    REFRESH_TOKEN: 'refreshToken',
    USER_ID: 'userId',
    TOKEN_SAVED_AT: 'tokenSavedAt',
    LAST_ACTIVE_AT: 'lastActiveAt',
  },
}));

// api.js keeps the refresh lock, queue and cooldown at module level, so every
// test gets a fresh copy — and its own axios and storage mocks with it.
function load({ web = false } = {}) {
  const env = {};
  jest.isolateModules(() => {
    // Always set, so a web load cannot leak into a later native one.
    jest.doMock('react-native', () => ({ Platform: { OS: web ? 'web' : 'android' } }));
    env.axios = require('axios').default;
    env.storage = require('../../utils/storage');
    env.mod = require('../api');
  });
  env.api = env.mod.default;
  env.timeout = env.axios.create.mock.calls[0][0].timeout;
  env.storage.store.set('accessToken', 'stale-access');
  env.storage.store.set('refreshToken', 'refresh-1');
  env.storage.store.set('userId', 'u1');
  return env;
}

// A request the server refused with 401, as axios hands it to the interceptor.
const expired = (url = '/users/me') => ({ response: { status: 401 }, config: { url, headers: {} } });

function track(promise) {
  const s = { settled: false, value: undefined, error: undefined };
  promise.then(
    (v) => { s.settled = true; s.value = v; },
    (e) => { s.settled = true; s.error = e; },
  );
  return s;
}

afterEach(() => {
  jest.useRealTimers();
});

test('the refresh post carries the same deadline as the api instance', async () => {
  const env = load();
  env.axios.post.mockResolvedValue({ data: { data: { accessToken: 'fresh', refreshToken: 'refresh-2' } } });

  expect(env.timeout).toBeGreaterThan(0);
  expect(await env.mod.forceRefreshAccessToken()).toBe('fresh');

  const [url, body, config] = env.axios.post.mock.calls[0];
  expect(url).toBe('https://api.test/api/v1/auth/refresh');
  expect(body).toEqual({ userId: 'u1', refreshToken: 'refresh-1' });
  expect(config.timeout).toBe(env.timeout);
});

test('a refresh that never answers settles at the timeout — the 401, everything queued behind it, and the next refresh', async () => {
  jest.useFakeTimers();
  const env = load();
  env.axios.post.mockImplementation(stalledTransport);

  // Three callers, one refresh: the 401 that started it, a second screen's 401
  // (e.g. logout's POST /auth/logout), and the socket's forced refresh.
  const first = track(env.api.onResponseError(expired()));
  const logout = track(env.api.onResponseError(expired('/auth/logout')));
  const socket = track(env.mod.forceRefreshAccessToken());

  await jest.advanceTimersByTimeAsync(0);
  expect(env.axios.post).toHaveBeenCalledTimes(1);

  // Still honestly waiting just before the deadline…
  await jest.advanceTimersByTimeAsync(env.timeout - 1);
  expect([first.settled, logout.settled, socket.settled]).toEqual([false, false, false]);

  // …and every one of them settles at it. Before the fix none ever did.
  await jest.advanceTimersByTimeAsync(1);
  expect([first.settled, logout.settled, socket.settled]).toEqual([true, true, true]);

  expect(first.error).toMatchObject({ code: 'ECONNABORTED', refreshFailed: true, sessionExpired: false });
  expect(first.error.userMessage).toMatch(/timed out/i);
  expect(logout.error).toMatchObject({ code: 'ECONNABORTED', refreshFailed: true, sessionExpired: false });
  expect(socket.value).toBeNull();

  // A timeout is not a verdict on the token, so the session survives it.
  expect(env.storage.store.get('refreshToken')).toBe('refresh-1');
  expect(env.storage.deleteItem).not.toHaveBeenCalled();

  // The lock was released: once the (≤1 s) cooldown passes, the next 401 makes
  // a NEW refresh instead of queueing behind the dead one forever.
  await jest.advanceTimersByTimeAsync(1_000);
  env.axios.post.mockReset();
  env.axios.post.mockResolvedValue({ data: { data: { accessToken: 'fresh', refreshToken: 'refresh-2' } } });
  env.api.mockResolvedValue({ status: 200, data: { replayed: true } });

  const next = track(env.api.onResponseError(expired()));
  await jest.advanceTimersByTimeAsync(0);

  expect(env.axios.post).toHaveBeenCalledTimes(1);
  expect(next.error).toBeUndefined();
  expect(next.value).toEqual({ status: 200, data: { replayed: true } });
  expect(env.api.mock.calls[0][0].headers.Authorization).toBe('Bearer fresh');
});

test('a 401 that arrives while a rejected refresh is still clearing tokens is settled, not orphaned', async () => {
  const env = load();
  const flush = () => new Promise((r) => setImmediate(r));

  let openGate;
  env.storage.gate = new Promise((r) => { openGate = r; });
  env.axios.post.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), {
    response: { status: 401 },
  }));

  const first = track(env.api.onResponseError(expired()));
  await flush();
  // The refresh was refused and the leader is now inside clearTokens().
  expect(env.storage.deleteItem).toHaveBeenCalled();

  const late = track(env.api.onResponseError(expired('/orders')));
  await flush();

  openGate();
  await flush();

  expect(first.settled).toBe(true);
  expect(late.settled).toBe(true);
  expect(first.error).toMatchObject({ sessionExpired: true, refreshFailed: true });
  // The waiter sees the same verdict the leader acted on.
  expect(late.error).toMatchObject({ sessionExpired: true, refreshFailed: true });
  expect(env.axios.post).toHaveBeenCalledTimes(1);
  expect(env.storage.store.get('refreshToken')).toBeUndefined();
});

test('the web cookie refresh carries the deadline too', async () => {
  const env = load({ web: true });
  env.storage.store.delete('accessToken'); // web keeps it in memory only
  env.axios.post.mockResolvedValue({ data: { data: { accessToken: 'fresh' } } });

  expect(await env.mod.getValidAccessToken()).toBe('fresh');

  const config = env.axios.post.mock.calls[0][2];
  expect(config).toMatchObject({ withCredentials: true, timeout: env.timeout });
});
