/**
 * Log lines must show the values their format string asks for.
 *
 * The level tag used to be console's first argument, so Node never treated the
 * message as a format string and every printf-style call printed a literal "%s":
 *
 *   [WARN] [Queue] redis connection error: %s
 *   [WARN] [Worker] %s worker error: %s notifications
 *
 * These tests run the real console formatting (util.format, which is what
 * console uses) over toConsoleArgs() so they check the text an operator reads,
 * not just the argument shape.
 */
import { format } from 'node:util';

const { toConsoleArgs, errorText } = await import('../../../src/utils/logger.js');

const line = (tag, ...args) => format(...toConsoleArgs(tag, args));

describe('printf-style calls', () => {
  test('substitutes %s instead of printing it', () => {
    expect(line('[WARN]', '[Queue] redis connection error: %s', 'ECONNREFUSED'))
      .toBe('[WARN] [Queue] redis connection error: ECONNREFUSED');
  });

  test('multiple specifiers land in order', () => {
    expect(line('[WARN]', '[Worker] %s worker error: %s', 'notifications', 'ECONNREFUSED'))
      .toBe('[WARN] [Worker] notifications worker error: ECONNREFUSED');
    expect(line('[INFO]', '[Worker] Started %d queue worker(s) (concurrency=%d)', 4, 5))
      .toBe('[INFO] [Worker] Started 4 queue worker(s) (concurrency=5)');
  });

  test('a message without specifiers still appends extra values', () => {
    expect(line('[INFO]', '[Redis] Connected')).toBe('[INFO] [Redis] Connected');
    expect(line('[WARN]', '[X] failed', 'reason')).toBe('[WARN] [X] failed reason');
  });

  test('a literal percent sign in a plain message survives', () => {
    expect(line('[INFO]', 'disk at 95% full')).toBe('[INFO] disk at 95% full');
  });

  test('an object passed to %o is redacted before it is formatted', () => {
    const text = line('[WARN]', '[Auth] payload %o', { phone: '9876543210', token: 'eyJabc' });
    expect(text).not.toContain('9876543210');
    expect(text).not.toContain('eyJabc');
    expect(text).toContain('3210');
  });
});

describe('object-first calls (pino style)', () => {
  test('message first, formatted, with the context after it', () => {
    const [text, context] = toConsoleArgs('[ERROR]', [{ requestId: 'r1' }, '[LeaderLock] %s: job threw', 'mandi-refresh']);
    expect(text).toBe('[ERROR] [LeaderLock] mandi-refresh: job threw');
    expect(context).toEqual({ requestId: 'r1' });
  });

  test('an unfilled %s cannot swallow the context object', () => {
    const err = new Error('boom');
    const args = toConsoleArgs('[ERROR]', [{ err }, '[Route] failed %s']);
    const text = format(...args);
    expect(text.startsWith('[ERROR] [Route] failed %s')).toBe(true);
    // The Error is still printed with its stack, not collapsed by %s.
    expect(text).toContain('Error: boom');
    expect(text).toContain('at ');
  });

  test('context is redacted', () => {
    const [, context] = toConsoleArgs('[ERROR]', [{ user: { phone: '9876543210', otp: '123456' } }, '[Auth] failed']);
    expect(context.user.phone).toBe('••••••3210');
    expect(context.user.otp).toBe('***REDACTED***');
  });
});

describe('other shapes are left alone', () => {
  test('a lone object or Error follows the tag', () => {
    const err = new Error('boom');
    expect(toConsoleArgs('[ERROR]', [err])).toEqual(['[ERROR]', err]);
    expect(toConsoleArgs('[INFO]', [{ a: 1 }])).toEqual(['[INFO]', { a: 1 }]);
  });

  test('no arguments', () => {
    expect(toConsoleArgs('[INFO]', [])).toEqual(['[INFO]']);
  });

  test('null first argument does not throw', () => {
    expect(toConsoleArgs('[WARN]', [null, 'x'])).toEqual(['[WARN]', null, 'x']);
  });
});

describe('errorText', () => {
  test('an ioredis ECONNREFUSED AggregateError has an empty message but a code', () => {
    const agg = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:6379'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' }),
    ], '');
    agg.code = 'ECONNREFUSED';
    expect(agg.message).toBe('');
    expect(errorText(agg)).toBe('ECONNREFUSED');
  });

  test('an AggregateError without a code falls back to its first inner error', () => {
    const agg = new AggregateError([Object.assign(new Error('connect ECONNREFUSED ::1:6379'), { code: 'ECONNREFUSED' })], '');
    expect(errorText(agg)).toBe('ECONNREFUSED: connect ECONNREFUSED ::1:6379');
  });

  test('ordinary errors keep their message', () => {
    expect(errorText(new Error('timeout'))).toBe('timeout');
    expect(errorText('plain string')).toBe('plain string');
    expect(errorText(null)).toBe('unknown error');
  });
});
