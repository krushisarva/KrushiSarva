/**
 * PIN code → locality lookup, backed by the India Post directory at
 * https://api.postalpincode.in/pincode/{pincode}.
 *
 * Every location form in both mobile apps autofills state / district / taluka /
 * village from this one endpoint, so the upstream's behaviour shapes the design:
 *
 *   - It answers HTTP 200 for EVERYTHING. The outcome lives in body[0].Status:
 *     "Success" (post offices listed), "Error" + "No records found" (unknown
 *     pincode), or "404" (malformed path). Anything else is a broken upstream.
 *   - It is slow (~2 s per call) and occasionally down, so results are cached
 *     in Redis for 30 days (PIN data changes on the order of years) behind a
 *     small in-process LRU, concurrent misses are coalesced, and a breaker
 *     fails fast while it is unhealthy.
 *   - One pincode lists MANY post offices, and they can span districts
 *     (110001 → Central Delhi | New Delhi) and even states (396230 → Gujarat |
 *     Dadra & Nagar Haveli). This service returns the whole cleaned list; the
 *     caller decides what is unambiguous enough to autofill.
 *   - Names are India Post's, not the MHA list the app uses ("Raigarh(MH)",
 *     "Daman & Diu", Leh under "Jammu & Kashmir"). Mapping onto the app's
 *     canonical names happens client-side in shared/utils/pincode.js, next to
 *     the district list it has to match against.
 *
 * An unknown pincode is a RESULT ({ found: false }), cached for a few hours.
 * An unreachable upstream is an ERROR (PincodeLookupUnavailableError, 503) and
 * is never cached, so it cannot stick a valid pincode as "not found".
 */
import axios from 'axios';
import redis from '../config/redis.js';
import logger, { errorText } from '../utils/logger.js';
import { BoundedMap } from '../utils/boundedMap.js';
import { singleFlight } from '../utils/singleFlight.js';
import { recordCacheHit, recordCacheMiss } from '../utils/cacheMetrics.js';
import { postalPincodeBreaker, httpFailure } from '../resilience/breakers.js';

const BASE_URL = 'https://api.postalpincode.in/pincode';

// Indian PIN codes are six digits and never start with 0.
export const PINCODE_RE = /^[1-9]\d{5}$/;

// Upstream takes ~2 s when healthy. One retry, and only for a transient
// connection failure or 5xx — a timeout means "slow", and retrying it just
// doubles the wait. Worst case 4 s + 300 ms + 4 s stays under the breaker's
// 10 s backstop.
const TIMEOUT_MS = 4_000;
const RETRY_DELAY_MS = 300;
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND']);

// The biggest real pincodes list well under 100 offices; the cap only bounds a
// misbehaving upstream.
const MAX_POST_OFFICES = 150;
const MAX_BODY_BYTES = 1_000_000;

const CACHE_PREFIX = 'pincode:v1:';
const FOUND_TTL_SEC = 30 * 24 * 60 * 60;
// Short enough that a pincode India Post adds later starts resolving the same
// day; long enough that a farmer retyping the same wrong number costs nothing.
const NOT_FOUND_TTL_SEC = 6 * 60 * 60;
// Spread expiries so pincodes cached together don't all refetch together.
const TTL_JITTER = 0.1;

// L1 in front of Redis: saves the round trip for hot village pincodes and keeps
// lookups working through a Redis outage. ~2 KB per entry → ~1 MB at the cap.
const local = new BoundedMap({ maxSize: 500, ttlMs: 60 * 60 * 1000 });

export class PincodeLookupUnavailableError extends Error {
  constructor(cause) {
    super('PIN code lookup is temporarily unavailable');
    this.name = 'PincodeLookupUnavailableError';
    this.code = 'PINCODE_LOOKUP_UNAVAILABLE';
    this.status = 503;
    this.cause = cause;
  }
}

/** Upstream answered, but not with anything we recognise. */
class MalformedUpstreamError extends Error {
  constructor(detail) {
    super(`Unexpected response from India Post: ${detail}`);
    this.name = 'MalformedUpstreamError';
  }
}

export function isLookupablePincode(value) {
  return typeof value === 'string' && PINCODE_RE.test(value);
}

// India Post fills unknown blocks with "NA" and some with "N.A.".
const PLACEHOLDER_RE = /^(?:na|n\.?\s?a\.?|n\/a|null|none|nil|-+)$/i;

function cleanText(value, max = 100) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (!s || PLACEHOLDER_RE.test(s)) return null;
  return s.slice(0, max);
}

// "Tlangnuam (Part)" — the suffix says the block is split across pincodes,
// which is noise in a taluka field.
function cleanBlock(value) {
  const s = cleanText(value);
  if (!s) return null;
  return s.replace(/\s*\(\s*part\s*\)\s*$/i, '').trim() || null;
}

function normaliseOffices(pincode, list) {
  const seen = new Set();
  const offices = [];
  for (const po of list) {
    if (!po || typeof po !== 'object') continue;
    // Defensive: an office filed under another pincode is not an answer here.
    if (po.Pincode != null && String(po.Pincode).trim() !== pincode) continue;
    if (typeof po.Country === 'string' && po.Country.trim() && !/^india$/i.test(po.Country.trim())) continue;

    const name = cleanText(po.Name);
    const district = cleanText(po.District);
    const state = cleanText(po.State);
    if (!name || !district || !state) continue;

    const block = cleanBlock(po.Block);
    const key = `${name}|${block ?? ''}|${district}|${state}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    offices.push({
      name,
      block,
      district,
      state,
      delivery: po.DeliveryStatus === 'Delivery',
      branchType: cleanText(po.BranchType, 40),
    });
  }
  // Delivery offices first: those are the places people actually live.
  offices.sort((a, b) => (Number(b.delivery) - Number(a.delivery)) || a.name.localeCompare(b.name));
  return offices.slice(0, MAX_POST_OFFICES);
}

/**
 * Turn the upstream body into `{ pincode, found, postOffices }`. Throws
 * MalformedUpstreamError for anything that is neither a result nor a clean
 * "no records".
 */
export function parsePostalResponse(pincode, body) {
  const entry = Array.isArray(body) ? body[0] : null;
  if (!entry || typeof entry !== 'object') {
    throw new MalformedUpstreamError(typeof body === 'string' ? 'non-JSON body' : 'missing result entry');
  }
  const status = String(entry.Status ?? '');
  const notFound = { pincode, found: false, postOffices: [] };

  if (status === 'Success') {
    if (!Array.isArray(entry.PostOffice)) return notFound;
    const postOffices = normaliseOffices(pincode, entry.PostOffice);
    return postOffices.length ? { pincode, found: true, postOffices } : notFound;
  }
  if (status === 'Error' && /no records/i.test(String(entry.Message ?? ''))) return notFound;
  // "404" is the upstream's reply to a path that isn't a pincode at all.
  if (status === '404') return notFound;
  throw new MalformedUpstreamError(`status "${status.slice(0, 40)}"`);
}

function isRetryable(err) {
  if (err instanceof MalformedUpstreamError) return false;
  if (err?.code && RETRYABLE_CODES.has(err.code)) return true;
  const status = err?.response?.status;
  return status != null && status >= 500;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFromIndiaPost(pincode) {
  return postalPincodeBreaker().execute(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await axios.get(`${BASE_URL}/${pincode}`, {
          timeout: TIMEOUT_MS,
          maxContentLength: MAX_BODY_BYTES,
          headers: { Accept: 'application/json' },
        });
        return parsePostalResponse(pincode, res.data);
      } catch (err) {
        if (attempt >= 1 || !isRetryable(err)) throw err;
        await sleep(RETRY_DELAY_MS);
      }
    }
  }, { isFailure: httpFailure });
}

function ttlWithJitter(base) {
  return Math.round(base * (1 - TTL_JITTER + Math.random() * TTL_JITTER));
}

async function readCache(pincode) {
  if (redis?.status !== 'ready') return null;
  try {
    const raw = await redis.get(`${CACHE_PREFIX}${pincode}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.pincode === pincode && Array.isArray(parsed.postOffices) ? parsed : null;
  } catch (err) {
    logger.warn('[Pincode] cache read failed: %s', errorText(err));
    return null;
  }
}

async function writeCache(pincode, result) {
  if (redis?.status !== 'ready') return;
  try {
    const ttl = ttlWithJitter(result.found ? FOUND_TTL_SEC : NOT_FOUND_TTL_SEC);
    await redis.set(`${CACHE_PREFIX}${pincode}`, JSON.stringify(result), 'EX', ttl);
  } catch (err) {
    logger.warn('[Pincode] cache write failed: %s', errorText(err));
  }
}

/**
 * Resolve a pincode to its post offices.
 *
 * @param {string} pincode
 * @returns {Promise<{pincode: string, found: boolean, postOffices: Array<{
 *   name: string, block: ?string, district: string, state: string,
 *   delivery: boolean, branchType: ?string }>}>}
 * @throws {PincodeLookupUnavailableError} when India Post can't be reached and
 *   nothing is cached.
 */
export async function lookupPincode(pincode) {
  const pin = typeof pincode === 'string' ? pincode.trim() : String(pincode ?? '');
  // Never spend an upstream call on something that can't be a pincode.
  if (!PINCODE_RE.test(pin)) return { pincode: pin, found: false, postOffices: [] };

  const hot = local.get(pin);
  if (hot) {
    recordCacheHit('pincode');
    return hot;
  }

  return singleFlight(`pincode:${pin}`, async () => {
    const cached = await readCache(pin);
    if (cached) {
      local.set(pin, cached);
      recordCacheHit('pincode');
      return cached;
    }
    recordCacheMiss('pincode');

    let result;
    try {
      result = await fetchFromIndiaPost(pin);
    } catch (err) {
      logger.warn('[Pincode] India Post lookup failed for %s: %s', pin, errorText(err));
      throw new PincodeLookupUnavailableError(err);
    }
    local.set(pin, result);
    await writeCache(pin, result);
    return result;
  });
}

/** Test-only: forget the in-process cache. */
export function _resetPincodeCacheForTests() {
  local.clear();
}
