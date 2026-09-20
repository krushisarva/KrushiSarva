/**
 * Received crop report display logic — no React, no React Native.
 *
 * ReceivedReportsScreen and ReceivedReportDetailScreen both read this, so the
 * inbox row and the detail panel can no longer show two different confidence
 * figures for one report. Plain functions, which is what lets
 * frontend/jest.config.js test them without a renderer.
 */

/**
 * The model's confidence as a whole percent (0–100), or null when there is none.
 *
 * `CropDiseaseReport.confidenceScore` is stored as a 0–1 fraction — both write
 * paths in ai.routes.js divide the pipeline's percent by 100 before saving. The
 * screens used to `Math.round()` it as if it were already a percent, so every
 * report read as 0% or 1%. The farmer app multiplies by 100; so does this.
 *
 * A value above 1 cannot be a fraction, so it is taken as a percent written
 * without that division rather than multiplied into 8,700%. Exactly 1 is read
 * as a fraction (100%) — a real 1% is indistinguishable and far less likely.
 */
export function confidencePercent(score) {
  if (score == null || score === '') return null;
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  const pct = n > 1 ? n : n * 100;
  return Math.round(Math.min(100, Math.max(0, pct)));
}

/**
 * Placeholders the scan routes write when the farmer's real value is missing:
 * `growthStage` falls back to the literal 'unknown' and `pincode` to '000000'
 * (ai.routes.js, both save paths). Those are absences, not facts, and the seller
 * screens were printing them as data — "Tomato · unknown", "Pincode 000000".
 *
 * Returns the trimmed value, or null when there is nothing real to show, so a
 * caller can drop the row entirely.
 */
const REPORT_PLACEHOLDERS = new Set(['unknown', '000000']);

export function reportValue(value) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return null;
  return REPORT_PLACEHOLDERS.has(text.toLowerCase()) ? null : text;
}

/**
 * The scan's weather line. The stored snapshot comes from weather.service.js,
 * which writes `current.description`; both screens read `weatherDesc`, a key
 * nothing ever wrote, so the description never appeared. The old key is kept as
 * a fallback in case any report was saved with it.
 */
export function weatherDescription(weather) {
  return reportValue(weather?.description) || reportValue(weather?.weatherDesc);
}

// The first key holding usable text. Numbers count (a bare dose like 2.5);
// objects and blank strings do not, so they can never print as "[object Object]"
// or leave a dangling " — ".
function firstText(entry, keys) {
  for (const key of keys) {
    const v = entry[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

// Real keys first. The stored report comes from FastAPI (treatment.v1.md:
// product / active_ingredient / dosage / application_method; biologicals name an
// `agent`). The older keys are what the in-Express predictor emitted and what
// this screen used to read exclusively — which rendered every FastAPI entry as
// an empty bullet.
const NAME_KEYS = ['product', 'active_ingredient', 'agent', 'name', 'chemical', 'method'];
const DOSE_KEYS = ['dosage', 'dose', 'dosage_per_acre', 'dose_per_acre'];
const HOW_KEYS = ['application_method', 'timing'];

/**
 * One line for a treatment entry — "Mancozeb 75% WP — 2.5 g/L (Foliar spray)" —
 * or '' when the entry names no product. A dose with nothing to apply it to is
 * not advice a seller can act on, so it is dropped rather than shown bare.
 */
export function treatmentLabel(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (!entry || typeof entry !== 'object') return '';
  const name = firstText(entry, NAME_KEYS);
  if (!name) return '';
  const dose = firstText(entry, DOSE_KEYS);
  const how = firstText(entry, HOW_KEYS);
  return `${name}${dose ? ` — ${dose}` : ''}${how ? ` (${how})` : ''}`;
}

/**
 * Labels for a list of entries, capped at `max`. Empty entries are skipped
 * BEFORE the cap, so a blank one never renders as a bullet and never costs a
 * real entry its slot.
 */
export function treatmentLabels(list, max = Infinity) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (out.length >= max) break;
    const label = treatmentLabel(entry);
    if (label) out.push(label);
  }
  return out;
}

/**
 * HIGH and CRITICAL both mean "answer this farmer first". Stored levels are
 * LOW / MODERATE / HIGH / CRITICAL; checking only 'HIGH' left the worst reports
 * without the urgent banner.
 */
export function isHighRisk(level) {
  const l = String(level || '').toUpperCase();
  return l === 'HIGH' || l === 'CRITICAL';
}

/**
 * Why the reply route would drop this offer, or null when it keeps it. Mirrors
 * POST /crop-reports/seller/inbox/:shareId/reply: an APPROVED product with the
 * seller's ACTIVE, in-stock listing. `row` is one /agristore/seller/products
 * row — `status` is the product's, `isActive`/`stock` the listing's.
 */
export function offerUnavailableReason(row) {
  if (!row) return 'outOfStock';
  if (row.status && row.status !== 'APPROVED') return 'notApproved';
  if (!(Number(row.stock) > 0)) return 'outOfStock';
  if (row.isActive === false) return 'hidden';
  return null;
}

/**
 * One picker row per product, each carrying `unavailable` (a reason or null).
 * /seller/products returns one row per LISTING, and a reply records product
 * ids — so two packs of one product used to render as two rows sharing a key
 * and a checkbox. A product is recommendable when ANY of its packs is, and its
 * row shows the first pack that is. First-seen order is kept.
 */
export function pickerProducts(rows) {
  const byId = new Map();
  if (!Array.isArray(rows)) return [];
  for (const row of rows) {
    if (!row || row.id == null) continue;
    const reason = offerUnavailableReason(row);
    const have = byId.get(row.id);
    if (!have || (have.unavailable && !reason)) byId.set(row.id, { ...row, unavailable: reason });
  }
  return [...byId.values()];
}

/**
 * The share as the server now holds it, from the reply POST's response. The
 * screen reseeds its form from this instead of from the pre-send copy — which
 * snapped "in stock" and the ticked products back to their old values.
 */
export function mergeSavedReply(share, saved) {
  if (!share || !saved) return share;
  return {
    ...share,
    status: saved.status ?? share.status,
    sellerReply: saved.sellerReply ?? share.sellerReply,
    // null is a real value here: the seller cleared the SKU.
    recommendedSku: saved.recommendedSku !== undefined ? saved.recommendedSku : share.recommendedSku,
    recommendedProductIds: Array.isArray(saved.recommendedProductIds)
      ? saved.recommendedProductIds
      : share.recommendedProductIds,
    available: saved.available ?? share.available,
    repliedAt: saved.repliedAt ?? share.repliedAt,
  };
}

/** How many of the sent product ids the server left out (not live / out of stock). */
export function droppedProductCount(sentIds, saved) {
  if (!Array.isArray(saved?.recommendedProductIds)) return 0;
  const kept = new Set(saved.recommendedProductIds);
  return [...new Set(sentIds || [])].filter((id) => !kept.has(id)).length;
}
