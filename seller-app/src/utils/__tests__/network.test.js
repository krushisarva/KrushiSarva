/**
 * seller-app/src/utils/network.js — what a failed request says about the
 * connection (L9).
 *
 * The bug: one request timing out flipped the whole app to offline — banner up,
 * Save refused, and a probe backoff the seller waited out (~17 s) while their
 * connection was fine. `api` times out at 15 s, so any slow endpoint did it.
 */
const {
  isConnectivityError, isHardNetworkError, isTimeoutError, requestKey,
  createOfflineDetector, OFFLINE_TIMEOUT_THRESHOLD,
} = require('../network');

const timeout = (url = '/seller/orders') => Object.assign(new Error(`timeout of 15000ms exceeded`), {
  code: 'ECONNABORTED',
  config: { method: 'get', url },
});
const etimedout = (url = '/seller/stats') => Object.assign(new Error('timeout'), {
  code: 'ETIMEDOUT',
  config: { method: 'get', url },
});
const netError = () => Object.assign(new Error('Network Error'), {
  code: 'ERR_NETWORK',
  config: { method: 'get', url: '/seller/products' },
});
const canceled = () => Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
const http500 = () => Object.assign(new Error('Request failed'), {
  response: { status: 500 },
  config: { method: 'get', url: '/seller/orders' },
});

describe('classifying an axios failure', () => {
  test('a timeout is a connectivity error for MESSAGING, but not a hard one', () => {
    // The screens still say "we couldn't reach the server" for this request —
    // that part was never wrong and must not regress.
    expect(isConnectivityError(timeout())).toBe(true);
    expect(isTimeoutError(timeout())).toBe(true);
    expect(isHardNetworkError(timeout())).toBe(false);
  });

  test('a transport failure is hard evidence', () => {
    expect(isHardNetworkError(netError())).toBe(true);
    expect(isTimeoutError(netError())).toBe(false);
  });

  test('a server answer and a deliberate cancel are neither', () => {
    [http500(), canceled(), null, undefined].forEach((e) => {
      expect(isConnectivityError(e)).toBe(false);
      expect(isHardNetworkError(e)).toBe(false);
      expect(isTimeoutError(e)).toBe(false);
    });
  });

  test('requests are told apart by method + url', () => {
    expect(requestKey(timeout('/a'))).not.toBe(requestKey(timeout('/b')));
    expect(requestKey(timeout('/a'))).toBe(requestKey(timeout('/a')));
    // No config at all still gets its own key rather than merging with others.
    expect(requestKey({ message: 'boom' })).toContain('unknown');
  });
});

describe('deciding the device is offline', () => {
  test('ONE timeout is not enough — this is the regression', () => {
    const d = createOfflineDetector();
    expect(d.record(timeout('/seller/orders'))).toBe(false);
    expect(d.pending).toBe(1);
  });

  test('the same request timing out again is still one slow endpoint', () => {
    const d = createOfflineDetector();
    expect(d.record(timeout('/seller/orders'))).toBe(false);
    expect(d.record(timeout('/seller/orders'))).toBe(false);
    expect(d.record(timeout('/seller/orders'))).toBe(false);
    expect(d.pending).toBe(1);
  });

  test('two DIFFERENT requests timing out in the window is a dead link', () => {
    const d = createOfflineDetector();
    expect(d.record(timeout('/seller/orders'))).toBe(false);
    expect(d.record(etimedout('/seller/stats'))).toBe(true);
    // The verdict resets the evidence, so the next lone timeout is lone again.
    expect(d.record(timeout('/seller/orders'))).toBe(false);
  });

  test('timeouts far apart are coincidence, not an outage', () => {
    let clock = 0;
    const d = createOfflineDetector({ now: () => clock, windowMs: 20_000 });
    expect(d.record(timeout('/a'))).toBe(false);
    clock = 25_000;
    expect(d.record(timeout('/b'))).toBe(false);
    expect(d.pending).toBe(1);
  });

  test('a hard transport failure flips offline immediately', () => {
    const d = createOfflineDetector();
    expect(d.record(netError())).toBe(true);
  });

  test('a successful response clears the accumulated doubt', () => {
    const d = createOfflineDetector();
    d.record(timeout('/a'));
    d.reset();
    expect(d.record(timeout('/b'))).toBe(false);
  });

  test('an answered request and a cancel never count', () => {
    const d = createOfflineDetector();
    expect(d.record(http500())).toBe(false);
    expect(d.record(canceled())).toBe(false);
    expect(d.pending).toBe(0);
  });

  test('the threshold is small and configurable', () => {
    expect(OFFLINE_TIMEOUT_THRESHOLD).toBe(2);
    const d = createOfflineDetector({ threshold: 3 });
    expect(d.record(timeout('/a'))).toBe(false);
    expect(d.record(timeout('/b'))).toBe(false);
    expect(d.record(timeout('/c'))).toBe(true);
  });

  test('tracking stays bounded under a burst of distinct requests', () => {
    // §10: no process map may grow with the number of request keys seen.
    const d = createOfflineDetector({ threshold: 1_000_000 });
    for (let i = 0; i < 500; i += 1) d.record(timeout(`/req/${i}`));
    expect(d.pending).toBeLessThanOrEqual(32);
  });
});
