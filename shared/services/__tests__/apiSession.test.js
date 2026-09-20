/**
 * shared/services/api.js — how a session ends.
 *
 *   #35  performRefresh() cleared the tokens when the server refused a refresh,
 *        but told nobody: AuthContext kept isLoggedIn true and every screen
 *        failed. onSessionExpired() now broadcasts exactly that moment.
 *   #36  Logout posted an empty body, so the server had no refresh token to
 *        revoke. revokeSessionOnServer() sends it (plus this device's push
 *        token, #37) and is bounded: local logout never waits on the network.
 */

jest.mock('axios', () => {
  const create = jest.fn(() => {
    const instance = jest.fn();
    instance.post = jest.fn();
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
  return {
    store,
    getItem: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    setItem: jest.fn(async (k, v) => { store.set(k, v); }),
    deleteItem: jest.fn(async (k) => { store.delete(k); }),
  };
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

// Fresh module state (listeners, refresh lock, cooldown, generation) per test.
function load() {
  const env = {};
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
    env.axios = require('axios').default;
    env.storage = require('../../utils/storage');
    env.mod = require('../api');
  });
  env.api = env.mod.default;
  env.storage.store.clear();
  env.storage.store.set('accessToken', 'access-1');
  env.storage.store.set('refreshToken', 'refresh-1');
  env.storage.store.set('userId', 'u1');
  return env;
}

const expired = (url = '/users/me') => ({ response: { status: 401 }, config: { url, headers: {} } });
const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`), {
  response: { status },
});

afterEach(() => { jest.useRealTimers(); });

describe('onSessionExpired (#35)', () => {
  test('fires once when the server refuses the refresh, after the tokens are gone', async () => {
    const env = load();
    const seen = [];
    env.mod.onSessionExpired(() => seen.push(env.storage.store.get('refreshToken')));
    env.axios.post.mockRejectedValue(httpError(401));

    // Two screens 401 at once — one refresh, one broadcast.
    const results = await Promise.allSettled([
      env.api.onResponseError(expired()),
      env.api.onResponseError(expired('/orders')),
    ]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(results[0].reason).toMatchObject({ sessionExpired: true });
    expect(seen).toEqual([undefined]); // exactly once, and the token was already cleared
  });

  test('fires when a 5xx may have spent the token', async () => {
    const env = load();
    const listener = jest.fn();
    env.mod.onSessionExpired(listener);
    env.axios.post.mockRejectedValue(httpError(502));

    await expect(env.api.onResponseError(expired())).rejects.toMatchObject({ sessionExpired: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('does NOT fire when the refresh never reached the server — the session is kept', async () => {
    const env = load();
    const listener = jest.fn();
    env.mod.onSessionExpired(listener);
    env.axios.post.mockRejectedValue(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));

    await expect(env.api.onResponseError(expired())).rejects.toMatchObject({ sessionExpired: false });
    expect(listener).not.toHaveBeenCalled();
    expect(env.storage.store.get('refreshToken')).toBe('refresh-1');
  });

  test('unsubscribe stops delivery, and a throwing listener cannot break the refresh path', async () => {
    const env = load();
    const kept = jest.fn();
    const dropped = jest.fn();
    env.mod.onSessionExpired(() => { throw new Error('bad listener'); });
    env.mod.onSessionExpired(kept);
    env.mod.onSessionExpired(dropped)();
    env.axios.post.mockRejectedValue(httpError(401));

    await expect(env.api.onResponseError(expired())).rejects.toMatchObject({ sessionExpired: true });
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });
});

describe('a refresh still in flight when the session is cleared', () => {
  test('does not write its tokens back, and does not announce an expiry', async () => {
    const env = load();
    const listener = jest.fn();
    env.mod.onSessionExpired(listener);
    let answer;
    env.axios.post.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));

    const pending = env.mod.forceRefreshAccessToken();
    await new Promise((r) => setImmediate(r));

    // Logout gave up waiting and cleared the session…
    await env.mod.clearTokens();
    // …then the refresh answers.
    answer({ data: { data: { accessToken: 'late-access', refreshToken: 'late-refresh' } } });

    expect(await pending).toBeNull();
    expect(env.storage.store.get('accessToken')).toBeUndefined();
    expect(env.storage.store.get('refreshToken')).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  test('a late refusal does not clear a session started after the logout', async () => {
    const env = load();
    let refuse;
    env.axios.post.mockImplementation(() => new Promise((_, reject) => { refuse = reject; }));

    const pending = env.mod.forceRefreshAccessToken();
    await new Promise((r) => setImmediate(r));
    await env.mod.clearTokens();
    await env.mod.saveTokens({ accessToken: 'next-access', refreshToken: 'next-refresh', userId: 'u2' });

    refuse(httpError(401));
    expect(await pending).toBeNull();
    expect(env.storage.store.get('refreshToken')).toBe('next-refresh');
  });
});

describe('revokeSessionOnServer (#36, #37)', () => {
  test('sends the stored refresh token and this device\'s push token', async () => {
    const env = load();
    env.api.post.mockResolvedValue({ status: 200 });

    expect(await env.mod.revokeSessionOnServer({ pushToken: 'ExponentPushToken[abc]' })).toBe(true);

    const [url, body, config] = env.api.post.mock.calls[0];
    expect(url).toBe('/auth/logout');
    expect(body).toEqual({ refreshToken: 'refresh-1', pushToken: 'ExponentPushToken[abc]' });
    expect(config.timeout).toBeGreaterThan(0);
  });

  test('omits what it does not have', async () => {
    const env = load();
    env.storage.store.delete('refreshToken');
    env.api.post.mockResolvedValue({ status: 200 });

    await env.mod.revokeSessionOnServer();
    expect(env.api.post.mock.calls[0][1]).toEqual({});
  });

  test('a failed call resolves false instead of throwing', async () => {
    const env = load();
    env.api.post.mockRejectedValue(httpError(500));
    await expect(env.mod.revokeSessionOnServer()).resolves.toBe(false);
  });

  test('a call that never answers is abandoned at the deadline', async () => {
    jest.useFakeTimers();
    const env = load();
    env.api.post.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const done = env.mod.revokeSessionOnServer().then((v) => { settled = true; return v; });

    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await done).toBe(false);
  });
});

describe('safeErrorMessage', () => {
  test('surfaces the deactivated-account message from login', () => {
    const env = load();
    const err = { response: { status: 403, data: { error: {
      message: 'This account has been deactivated. Please contact KrushiSarva support.',
      details: { code: 'ACCOUNT_INACTIVE' },
    } } } };
    expect(env.mod.safeErrorMessage(err)).toMatch(/deactivated/);
  });

  test('any other 403 stays generic', () => {
    const env = load();
    const err = { response: { status: 403, data: { error: { message: 'internal detail' } } } };
    expect(env.mod.safeErrorMessage(err)).toBe('You do not have permission to perform this action.');
  });

  test.each([
    [403, 'KYC_REQUIRED', 'Your KYC must be verified before you can sell. Complete it in Business Profile.'],
    [409, 'PAYMENT_IN_PROGRESS', 'A buyer is paying for this offer right now — try again in about 12 minutes.'],
    [409, 'OFFER_HAS_OPEN_ORDERS', 'This offer has 2 open orders. Deliver or cancel them first, or pause the offer instead of deleting it.'],
    [409, 'LISTING_AMBIGUOUS', 'You sell more than one pack size of this product. Update the app to edit it.'],
  ])('a %i with %s shows the reason the server gave', (status, code, message) => {
    const env = load();
    const err = { response: { status, data: { error: { message, details: { code } } } } };
    expect(env.mod.safeErrorMessage(err)).toBe(message);
  });

  test('any other 409 stays generic, even with a message', () => {
    const env = load();
    const err = { response: { status: 409, data: { error: { message: 'P2002 unique constraint', details: { code: 'OTHER' } } } } };
    expect(env.mod.safeErrorMessage(err)).toBe('A conflict occurred. Please refresh and try again.');
  });

  test('a listed code on a 500 is not trusted', () => {
    const env = load();
    const err = { response: { status: 500, data: { error: { message: 'stack trace', details: { code: 'KYC_REQUIRED' } } } } };
    expect(env.mod.safeErrorMessage(err)).toBe('Server error. Please try again later.');
  });
});
