/**
 * PIN code lookup client — GET /location/pincode/:pincode.
 *
 * The backend caches India Post for 30 days, but a round trip on a village
 * connection still costs seconds, and one person meets the same pincode in
 * several forms (onboarding, farm, address, checkout). Results are kept for the
 * session in a small LRU; failures are not kept, so Retry always goes out.
 *
 * Failures are classified so a form can say something useful:
 *   'offline'       no response at all — the device has no connection
 *   'unavailable'   timeout, 5xx, or the backend reporting India Post is down
 *   'rate_limited'  429
 *   'invalid'       400 — the server does not consider it a pincode
 */
import api from './api';
import { isValidPincode, sanitizePincode } from '../utils/pincode';

const MAX_ENTRIES = 50;
const FOUND_TTL_MS = 12 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 10 * 60 * 1000;
// Above the backend's own worst case (~8 s with one retry).
const TIMEOUT_MS = 12_000;

const cache = new Map(); // pincode → { value, expires }

export class PincodeLookupError extends Error {
  constructor(kind, cause) {
    super(`PIN code lookup failed: ${kind}`);
    this.name = 'PincodeLookupError';
    this.kind = kind;
    this.cause = cause;
  }
}

function isCancel(err) {
  return err?.name === 'CanceledError' || err?.name === 'AbortError' || err?.code === 'ERR_CANCELED';
}

export function classifyLookupError(err) {
  const status = err?.response?.status;
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid';
  if (status != null) return 'unavailable';
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') return 'unavailable';
  return 'offline';
}

/** A cached result for `pincode`, or undefined. Synchronous — lets a form skip the spinner. */
export function peekPincode(pincode) {
  const entry = cache.get(pincode);
  if (!entry) return undefined;
  if (Date.now() >= entry.expires) {
    cache.delete(pincode);
    return undefined;
  }
  return entry.value;
}

function remember(pincode, value) {
  cache.delete(pincode);
  cache.set(pincode, { value, expires: Date.now() + (value.found ? FOUND_TTL_MS : NOT_FOUND_TTL_MS) });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

function asResult(pincode, data) {
  if (!data || typeof data !== 'object' || typeof data.found !== 'boolean') return null;
  return {
    pincode,
    found: data.found && Array.isArray(data.postOffices) && data.postOffices.length > 0,
    postOffices: Array.isArray(data.postOffices) ? data.postOffices : [],
  };
}

/**
 * @param {string} value  anything a PIN field might hold
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{pincode: string, found: boolean, postOffices: object[]}>}
 * @throws {PincodeLookupError} with `kind`; an abort rethrows the axios cancel
 */
export async function fetchPincode(value, { signal } = {}) {
  const pincode = sanitizePincode(value);
  if (!isValidPincode(pincode)) throw new PincodeLookupError('invalid');

  const hit = peekPincode(pincode);
  if (hit) return hit;

  let res;
  try {
    res = await api.get(`/location/pincode/${pincode}`, { signal, timeout: TIMEOUT_MS });
  } catch (err) {
    if (isCancel(err)) throw err;
    throw new PincodeLookupError(classifyLookupError(err), err);
  }

  const result = asResult(pincode, res?.data?.data);
  if (!result) throw new PincodeLookupError('unavailable');
  remember(pincode, result);
  return result;
}

export { isCancel as isPincodeLookupCancel };

/** Test-only. */
export function _clearPincodeCache() {
  cache.clear();
}
