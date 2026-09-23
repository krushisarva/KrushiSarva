/**
 * Reconnecting Redis clients must not flood the log.
 *
 * ioredis emits an 'error' on EVERY reconnect attempt. With the backoff capped
 * at 5s and four independent clients (queue producer, each BullMQ worker, the
 * auth-cache subscriber, the feature-flag subscriber), an unreachable Redis
 * produced a continuous wall of identical ECONNREFUSED warnings that buried the
 * request log. `warnThrottled` keeps the first line (the one that carries the
 * information) and suppresses the identical repeats.
 *
 * What must NOT regress: suppression is per key, the first occurrence is never
 * swallowed, a DIFFERENT failure still surfaces immediately, and the table
 * cannot grow without bound.
 */
import { jest } from '@jest/globals';
import { warnThrottled, resetWarnThrottle } from '../../../src/utils/logger.js';

describe('warnThrottled', () => {
  let warnSpy;
  beforeEach(() => {
    resetWarnThrottle();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
    resetWarnThrottle();
  });

  test('emits the first occurrence — an outage must still be visible', () => {
    expect(warnThrottled('k', '[Queue] redis connection error: %s', 'ECONNREFUSED')).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[Queue] redis connection error');
  });

  test('suppresses identical repeats inside the window', () => {
    warnThrottled('k', 'boom');
    for (let i = 0; i < 50; i += 1) {
      expect(warnThrottled('k', 'boom')).toBe(false);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('different keys are throttled independently — a new failure is not hidden', () => {
    warnThrottled('queue:ECONNREFUSED', 'a');
    warnThrottled('queue:ETIMEDOUT', 'b');
    warnThrottled('queue:ECONNREFUSED', 'a');
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('re-emits after the window with the suppressed count appended', () => {
    jest.useFakeTimers();
    warnThrottled('k', 'redis error: %s', 'ECONNREFUSED');
    warnThrottled('k', 'redis error: %s', 'ECONNREFUSED');
    warnThrottled('k', 'redis error: %s', 'ECONNREFUSED');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(61_000);
    expect(warnThrottled('k', 'redis error: %s', 'ECONNREFUSED')).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    // console.warn does the printf substitution, so assert on the raw args:
    // format string carries the placeholders, the count rides after them.
    const [fmt, ...args] = warnSpy.mock.calls[1];
    expect(fmt).toContain('suppressed in the last');
    expect(args).toEqual(['ECONNREFUSED', 2, 60]);
  });

  test('object-first calls pass through unchanged', () => {
    warnThrottled('k', { err: 'x' }, 'context shape');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('key table stays bounded under unbounded keys', () => {
    for (let i = 0; i < 1000; i += 1) warnThrottled(`k${i}`, 'x');
    // Every distinct key logs once; the point is that memory is capped, which we
    // assert indirectly: after the reset-at-capacity, an early key logs again.
    warnSpy.mockClear();
    expect(warnThrottled('k0', 'x')).toBe(true);
  });
});
