/**
 * The seller's own ratings — what SellerReviewsScreen shows, worked out with no
 * React in it so the plain-node Jest config tests all of it.
 *
 * Source: GET /agristore/seller/reviews. `data` is the page of reviews and
 * `meta.summary` (first page only) is `{ average, count, distribution }`.
 */
import { distributionRows } from '@krushisarva/shared/utils/reviewDisplay';

/**
 * The header card: the average, how many rated, and how the stars split.
 *
 * Null when nobody has rated yet — the screen then shows its empty state, not
 * a card that says "0.0" as if the seller had been rated badly.
 */
export function summaryView(summary) {
  const count = Number(summary?.count) || 0;
  if (count <= 0) return null;
  const average = Math.min(Math.max(Number(summary.average) || 0, 0), 5);
  return {
    average,
    // One decimal, always: "4.0", not "4" — it is a score, and reads as one.
    averageText: average.toFixed(1),
    count,
    rows: distributionRows(summary),
  };
}

/**
 * The product a review is about, in the seller's language where the catalogue
 * has it. Null when the product has since been removed — the review is still
 * the seller's, and is shown without a name rather than hidden.
 */
export function reviewProductName(review, language) {
  const p = review?.product;
  if (!p) return null;
  const local = (language === 'mr' && p.nameMr) || (language === 'hi' && p.nameHi) || null;
  const name = local || p.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** The buyer's first name — all the server sends — or null. */
export function reviewBuyerName(review) {
  const name = review?.buyer?.firstName;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * Pull `meta.summary` out of a page response, if it carries one.
 *
 * Only the first page does. A later page answers `undefined` here, which the
 * screen must treat as "keep what you have", never as "no ratings".
 */
export function summaryFromResponse(res) {
  const s = res?.data?.meta?.summary;
  return s && typeof s === 'object' ? s : undefined;
}
