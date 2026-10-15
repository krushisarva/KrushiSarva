/**
 * SSL Certificate Pinning Configuration
 *
 * Prevents MITM attacks by verifying the server's TLS certificate chain against
 * known public-key hashes (SPKI pins). A request is allowed only if at least one
 * certificate in the verified chain matches one of the pins below.
 *
 * ── Current production pins (srv2061596.hstgr.cloud) ───────────────────────────
 * Caddy on the VPS serves a Let's Encrypt (ECDSA) chain:
 *     leaf CN=srv2061596.hstgr.cloud → intermediate CN=YE1 → CN=Root YE
 *       → ISRG Root X2 (cross-signed by ISRG Root X1)
 * The LEAF is not pinned: Caddy generates a new key at every renewal (~every 60
 * days), so a leaf pin would go stale with no app update. We pin the CA levels,
 * so renewals do NOT brick the app while any chain outside this CA path is
 * rejected:
 *
 *   1. INTERMEDIATE — sha256/brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4=
 *              Let's Encrypt YE1, expires 2028-09-02. Let's Encrypt may issue
 *              from a sibling intermediate (YE2, …), so never rely on it alone.
 *   2. ROOT YE — sha256/sCkq5UWXjg+7mKu9lMhhYF5bGLsy7VI/UNW3tccdR7w=
 *              ISRG Root YE, cross-signed copy sent by the server, exp 2032-09-02.
 *   3. ISRG ROOT X2 — sha256/diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=
 *              Same key in the self-signed root (exp 2040-09-17) and the
 *              X1-cross-signed copy the server sends.
 *   4. BACKUP (ISRG ROOT X1) — sha256/C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=
 *              Expires 2035-06-04. The long-lived safety net for devices whose
 *              trust store ends the chain at X1.
 *
 * Extracted from the live endpoint on 2026-10-15 (leaf then expired 2027-01-12).
 *
 * ── Re-extracting / rotating the pins ─────────────────────────────────────────
 *   Chain (what the server sends):
 *     openssl s_client -connect srv2061596.hstgr.cloud:443 \
 *       -servername srv2061596.hstgr.cloud -showcerts \
 *       </dev/null 2>/dev/null > chain.pem
 *     # then for each cert block:
 *     openssl x509 -in cert.pem -pubkey -noout \
 *       | openssl pkey -pubin -outform DER \
 *       | openssl dgst -sha256 -binary | openssl base64   # → prefix with "sha256/"
 *
 *   Roots (backup), independent of the server:
 *     curl -s https://letsencrypt.org/certs/isrgrootx1.pem | \
 *       openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER | \
 *       openssl dgst -sha256 -binary | openssl base64
 *     (same for isrg-root-x2.pem)
 *
 * IMPORTANT:
 *   - Refresh the INTERMEDIATE pin BEFORE 2028-09-02 and ROOT YE BEFORE
 *     2032-09-02. The ISRG root pins give slack, but re-check the chain whenever
 *     the production host or its CA changes.
 *   - Always keep ≥2 valid pins live at once (rotate the new one in, ship, THEN
 *     drop the old) so a renewal mid-deploy never leaves users unable to connect.
 *   - Test pin validation against staging before shipping to production.
 *   - Pinning is skipped in __DEV__ so Charles/Proxyman debugging still works.
 *
 * NOTE: This file supplies the pin VALUES. Enforcement (FE-1) must wire
 * getSSLConfig() into the native networking layer — until that lands, these
 * pins are inert. See the enforcement notes in services/api.js.
 */

export const SSL_PINS = {
  // Production API host — must match API_BASE_URL's host in shared/constants/config.js.
  'srv2061596.hstgr.cloud': {
    includeSubdomains: false,
    pins: [
      // Intermediate — Let's Encrypt YE1, exp 2028-09-02
      'sha256/brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4=',
      // ISRG Root YE, exp 2032-09-02
      'sha256/sCkq5UWXjg+7mKu9lMhhYF5bGLsy7VI/UNW3tccdR7w=',
      // ISRG Root X2, exp 2040-09-17
      'sha256/diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=',
      // Backup — ISRG Root X1, exp 2035-06-04
      'sha256/C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=',
    ],
  },
};

/**
 * Return the pin config for a hostname, or null when pinning should not apply.
 *
 * Enforcement (FE-1) is expected to wire this into the native networking layer,
 * e.g. with react-native-ssl-pinning's public-key pinning:
 *
 *   import { fetch as pinnedFetch } from 'react-native-ssl-pinning';
 *   const cfg = getSSLConfig(hostname);
 *   await pinnedFetch(url, {
 *     method, headers, body,
 *     pkPinning: true,
 *     sslPinning: { certs: cfg.pins.map(p => p.replace(/^sha256\//, '')) },
 *     timeoutInterval: 10000,
 *   });
 */
export function getSSLConfig(hostname) {
  if (__DEV__) {
    // Skip pinning in development to allow proxy debugging
    return null;
  }
  return SSL_PINS[hostname] || null;
}

/**
 * Validate that the SSL pins look usable. Call at app startup. Logs an error if
 * any pin is still a placeholder or malformed so a misconfigured build is loud.
 * Returns true when every configured pin is a well-formed sha256 SPKI pin.
 */
export function validateSSLPins() {
  if (__DEV__) return true; // Skip in dev

  // A valid SPKI pin is "sha256/" + base64 of a 32-byte hash (44 chars, '=' pad).
  const PIN_RE = /^sha256\/[A-Za-z0-9+/]{43}=$/;
  let ok = true;

  for (const [host, config] of Object.entries(SSL_PINS)) {
    if (!config.pins?.length) {
      console.error(`[SSL Pinning] No pins configured for ${host}.`);
      ok = false;
      continue;
    }
    for (const pin of config.pins) {
      if (pin.includes('REPLACE_WITH') || !PIN_RE.test(pin)) {
        console.error(
          `[SSL Pinning] Invalid/placeholder pin for ${host}: "${pin}". ` +
          'Re-extract real pins (see sslPinning.js).'
        );
        ok = false;
      }
    }
  }
  return ok;
}
