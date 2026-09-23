/**
 * Backend logger with automatic PII redaction.
 *
 * Every logged argument is walked and known-sensitive object keys are masked
 * BEFORE anything reaches the console, so PII (phone, Aadhaar, PAN, bank, GST)
 * and secrets (passwords, OTPs, tokens, cookies) never land in logs even if a
 * caller passes a whole `user` / `req.body` / `{ err }` object.
 *
 * This module is intentionally dependency-free (no encrypt/env imports) to stay
 * at the bottom of the import graph and avoid cycles. Redaction is key-based:
 *   - secret-ish keys → '***REDACTED***'
 *   - phone-ish keys  → masked to last 4 digits (still useful to debug)
 * Error objects pass through untouched so stack traces are preserved (by
 * convention errors must not carry PII).
 */

import { format } from 'node:util';

const isDev = process.env.NODE_ENV !== 'production';

// Fully redacted — value is never useful and always sensitive.
const SENSITIVE_KEYS = new Set([
  'password', 'pass', 'pwd',
  'otp', 'otphash', 'otp_hash',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'csrftoken', 'jwt',
  'authorization', 'cookie', 'setcookie', 'set-cookie',
  'aadhaar', 'aadhaarnumber', 'aadharnumber', 'aadhaarlast4', 'aadharlast4',
  'pan', 'pannumber',
  'bankaccountnumber', 'bankaccount', 'accountnumber',
  'bankifsc', 'ifsc', 'ifsccode',
  'gst', 'gstnumber',
  'cvv', 'cardnumber', 'pin',
  'secret', 'apikey', 'api_key', 'clientsecret',
]);

// Partially masked — keep the last 4 digits for debuggability.
const PHONE_KEYS = new Set([
  'phone', 'mobile', 'phonenumber', 'contact', 'contactnumber', 'contactphone', 'ownerphone',
]);

const MAX_DEPTH = 6;

function maskPhoneValue(v) {
  const digits = String(v).replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `••••••${digits.slice(-4)}`;
}

/**
 * Return a redacted copy of `value` safe to log. Pure; exported for testing.
 * Primitives pass through; Errors pass through (preserve stack); objects/arrays
 * are deep-copied with sensitive keys masked. Handles circular refs + depth.
 */
export function redact(value, seen = new WeakSet(), depth = 0) {
  if (value == null) return value;
  const t = typeof value;
  if (t !== 'object') return value;          // string/number/boolean/bigint/symbol/function
  if (value instanceof Error) return value;  // keep message + stack intact
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen, depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    if (SENSITIVE_KEYS.has(key)) out[k] = '***REDACTED***';
    else if (PHONE_KEYS.has(key)) out[k] = v == null ? v : maskPhoneValue(v);
    else out[k] = redact(v, seen, depth + 1);
  }
  return out;
}

const scrub = (args) => args.map((a) => redact(a));

/**
 * The console arguments for one log call, with the level tag ON the message.
 *
 * Call sites use pino's two shapes:
 *   logger.warn('[Queue] redis connection error: %s', err.message)
 *   logger.error({ err, requestId }, '[LeaderLock] %s: job threw', jobName)
 *
 * Node's console only substitutes %s / %d / %o when the format string is its
 * FIRST argument. The tag used to be passed first on its own, so every
 * printf-style call (200+ of them) printed a literal "%s" and tacked the values
 * on the end — "[Worker] %s worker error: %s notifications". Prefixing the tag
 * onto the message puts the format string back in first position.
 *
 * Object-first calls print the message first and the object after it. The
 * message is formatted with its own arguments beforehand and any leftover `%` is
 * escaped, so an unfilled "%s" can never swallow the context object (which would
 * print "{ err: [Error] }" instead of the stack). Everything is redacted before
 * formatting, so PII in an object passed to %o/%j is masked too.
 *
 * Exported for tests.
 */
export function toConsoleArgs(tag, args) {
  const clean = scrub(args);
  if (typeof clean[0] === 'string') {
    return [`${tag} ${clean[0]}`, ...clean.slice(1)];
  }
  if (clean.length >= 2 && clean[0] !== null && typeof clean[0] === 'object' && typeof clean[1] === 'string') {
    const [context, message, ...rest] = clean;
    const text = format(`${tag} ${message}`, ...rest).replace(/%/g, '%%');
    return [text, context];
  }
  return [tag, ...clean];
}

const logger = {
  debug: (...args) => {
    if (isDev) console.log(...toConsoleArgs('[DEBUG]', args)); // eslint-disable-line no-console
  },
  info: (...args) => {
    console.log(...toConsoleArgs('[INFO]', args)); // eslint-disable-line no-console
  },
  warn: (...args) => {
    // Warnings ALWAYS log. This channel carries every fail-open degradation
    // notice in the backend — Redis fallbacks, leader-lock misses, queue jobs
    // running inline, cache failures, candidate-scan truncation. Gating it on
    // isDev meant production degraded silently and an operator only learned of
    // it through customer reports. Redaction still strips PII, as for errors.
    console.warn(...toConsoleArgs('[WARN]', args)); // eslint-disable-line no-console
  },
  error: (...args) => {
    // Errors always log; redaction still strips any PII passed alongside them.
    console.error(...toConsoleArgs('[ERROR]', args)); // eslint-disable-line no-console
  },
};

// ── Throttled warnings ────────────────────────────────────────────────────────
// Reconnecting clients (Redis subscribers, BullMQ queue/worker connections) emit
// an 'error' on EVERY retry attempt. With the backoff capped at 5s that is one
// warning per client every 5 seconds for the whole outage — four clients turned a
// stopped local Redis into a continuous wall of identical ECONNREFUSED lines that
// buries the request log. The signal ("this client can't reach Redis") is the same
// every time; only the first occurrence carries information. config/redis.js
// already de-dups its own [ALERT] this way — these clients did not.
//
// warnThrottled logs the FIRST occurrence of a key immediately, suppresses repeats
// for WARN_THROTTLE_MS, then logs again with a count of what was suppressed, so a
// sustained outage stays visible (and quantified) without flooding.
const WARN_THROTTLE_MS = 60_000;
// Keys are call-site tags plus an error code — a small constant set. The cap is a
// belt-and-braces bound so a caller keying by unbounded input can't leak memory.
const WARN_THROTTLE_MAX_KEYS = 200;
const _warnState = new Map(); // key -> { last: epochMs, suppressed: number }

/** Clear throttle state. Exported for tests. */
export function resetWarnThrottle() {
  _warnState.clear();
}

/**
 * logger.warn, de-duplicated per `key` over a 60s window.
 *
 * @param {string} key  throttle bucket; include the error code so a DIFFERENT
 *                      failure still surfaces immediately (e.g. `queue:ECONNREFUSED`).
 * @param {...any} args exactly what you would pass to logger.warn.
 * @returns {boolean} true if the line was emitted, false if suppressed.
 */
export function warnThrottled(key, ...args) {
  const now = Date.now();
  const entry = _warnState.get(key);

  if (entry && now - entry.last < WARN_THROTTLE_MS) {
    entry.suppressed += 1;
    return false;
  }

  // New key while at capacity: drop the whole table rather than grow unbounded.
  // Losing throttle state only costs one extra log line per key.
  if (!entry && _warnState.size >= WARN_THROTTLE_MAX_KEYS) _warnState.clear();

  const suppressed = entry ? entry.suppressed : 0;
  _warnState.set(key, { last: now, suppressed: 0 });

  // Append the suppressed count to the printf format string so it reads as one
  // line. Only valid for the string-first shape; object-first calls log as-is.
  if (suppressed > 0 && typeof args[0] === 'string') {
    logger.warn(
      `${args[0]} (+%d suppressed in the last %ds)`,
      ...args.slice(1),
      suppressed,
      Math.round(WARN_THROTTLE_MS / 1000),
    );
  } else {
    logger.warn(...args);
  }
  return true;
}

/**
 * Text for an error in a log line. Connection failures from ioredis on a
 * dual-stack host (localhost → ::1 and 127.0.0.1) arrive as an AggregateError
 * whose `message` is empty, which is why "redis connection error:" printed
 * nothing after the colon; its `code` (ECONNREFUSED) is the useful part.
 */
export function errorText(err) {
  if (err == null) return 'unknown error';
  if (typeof err !== 'object') return String(err);
  const parts = [err.code, err.message].filter((p) => typeof p === 'string' && p.length > 0);
  if (!parts.length && Array.isArray(err.errors) && err.errors.length) return errorText(err.errors[0]);
  return [...new Set(parts)].join(': ') || err.name || 'unknown error';
}

export default logger;
