/**
 * What an axios failure says about the device's connection — no React, no React
 * Native, so frontend/jest.config.js can test it without a renderer.
 *
 * The distinction this file exists to draw:
 *
 *   "this request did not reach the server"   →  isConnectivityError()
 *   "this DEVICE has no connection"           →  the offline detector below
 *
 * They are not the same thing, and treating them as one is what made a single
 * slow request look like an outage. `api` times out at 15 s; one endpoint that
 * is merely slow (a cold backend, a big page, a congested cell) aborts with
 * ECONNABORTED, and the app declared itself offline — banner, disabled Save,
 * and a probe backoff the seller then waited out (~17 s to the first retry)
 * while their connection was fine the whole time.
 *
 * So a timeout on its own no longer flips the state. It has to be corroborated:
 * either by a hard transport failure (the radio/DNS/socket said no, which is a
 * real connectivity signal) or by a SECOND, DIFFERENT request timing out inside
 * a short window — one stalled endpoint is a slow endpoint, two unrelated ones
 * are a dead link.
 *
 * isConnectivityError() keeps its old, broader meaning on purpose: the screens
 * use it to word an error ("you appear to be offline") for the request that
 * actually failed, which is correct for a timeout too.
 */

/** Distinct requests that must time out before we believe the device is offline. */
export const OFFLINE_TIMEOUT_THRESHOLD = 2;

/** How long a timeout stays relevant. Two of them further apart are coincidence. */
export const OFFLINE_TIMEOUT_WINDOW_MS = 20_000;

/**
 * Cap on tracked keys. The window prunes them, but a burst of requests inside
 * one window must not grow this without limit (§10: no unbounded process maps).
 */
const MAX_TRACKED = 32;

/** An axios error that was cancelled on purpose — never a network verdict. */
function isCanceled(error) {
  return error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError';
}

/** True when this axios error means "the request never reached the server". */
export function isConnectivityError(error) {
  if (!error) return false;
  if (error.response) return false;                       // server answered → not a connectivity issue
  if (isCanceled(error)) return false;
  return (
    error.message === 'Network Error' ||
    error.code === 'ERR_NETWORK' ||
    error.code === 'ECONNABORTED' ||
    error.code === 'ETIMEDOUT'
  );
}

/**
 * A transport failure the platform reported immediately: no route to host, DNS
 * failure, socket refused. Axios surfaces these as `Network Error` / ERR_NETWORK
 * with no response — the device, not the endpoint, is the problem.
 */
export function isHardNetworkError(error) {
  if (!error || error.response || isCanceled(error)) return false;
  return error.message === 'Network Error' || error.code === 'ERR_NETWORK';
}

/**
 * The request ran out of time. Says nothing by itself about the connection —
 * the server may simply be slow.
 */
export function isTimeoutError(error) {
  if (!error || error.response || isCanceled(error)) return false;
  return error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
}

/**
 * What makes two timeouts "different requests". Falls back to the message so
 * an error carrying no config still counts as its own key rather than silently
 * merging with every other one.
 */
export function requestKey(error) {
  const config = error?.config;
  if (config?.url) return `${String(config.method || 'get').toLowerCase()} ${config.url}`;
  return `unknown:${error?.message || 'error'}`;
}

/**
 * Tracks timeouts and answers one question: should the app now consider itself
 * offline?
 *
 * @param {object}   [opts]
 * @param {number}   [opts.threshold]  distinct timed-out requests required
 * @param {number}   [opts.windowMs]   how long a timeout counts for
 * @param {() => number} [opts.now]    injectable clock, for tests
 */
export function createOfflineDetector({
  threshold = OFFLINE_TIMEOUT_THRESHOLD,
  windowMs = OFFLINE_TIMEOUT_WINDOW_MS,
  now = Date.now,
} = {}) {
  /** requestKey → timestamp of its most recent timeout. */
  const timeouts = new Map();

  const prune = (at) => {
    for (const [key, at0] of timeouts) {
      if (at - at0 > windowMs) timeouts.delete(key);
    }
    // Still over the cap (a burst inside one window): drop the oldest first.
    // Map iterates in insertion order, and re-inserting on every record keeps
    // that order aligned with recency.
    while (timeouts.size > MAX_TRACKED) {
      const oldest = timeouts.keys().next().value;
      timeouts.delete(oldest);
    }
  };

  return {
    /**
     * Feed it every failed request. Returns true when the evidence now adds up
     * to "the device is offline".
     */
    record(error) {
      if (isHardNetworkError(error)) {
        timeouts.clear();
        return true;
      }
      if (!isTimeoutError(error)) return false;

      const at = now();
      const key = requestKey(error);
      timeouts.delete(key);          // re-insert so insertion order == recency
      timeouts.set(key, at);
      prune(at);

      if (timeouts.size >= threshold) {
        timeouts.clear();            // the verdict is in; start counting afresh
        return true;
      }
      return false;
    },

    /** Any successful response clears the doubt. */
    reset() {
      timeouts.clear();
    },

    /** Distinct requests currently counting toward the threshold (tests/metrics). */
    get pending() {
      return timeouts.size;
    },
  };
}
