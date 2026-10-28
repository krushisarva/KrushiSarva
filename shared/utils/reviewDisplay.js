/**
 * Product reviews — how a rating is SHOWN. Shared by the farmer app (the
 * product page, My Orders) and the seller app (the seller's own ratings), so
 * 4.4 stars is drawn the same way and "4 stars" is the same word in both.
 *
 * What a farmer may post, and against which order line, is the farmer app's own
 * business: frontend/src/screens/AgriStore/reviewUtils.js.
 *
 * Pure functions only — no React, no react-native — so the plain-node Jest
 * config tests all of it.
 */

export const STAR_VALUES = [1, 2, 3, 4, 5];

export const isRating = (v) => Number.isInteger(v) && v >= 1 && v <= 5;

const WORDS = {
  1: { key: 'reviews.word1', fallback: 'Very bad' },
  2: { key: 'reviews.word2', fallback: 'Bad' },
  3: { key: 'reviews.word3', fallback: 'Okay' },
  4: { key: 'reviews.word4', fallback: 'Good' },
  5: { key: 'reviews.word5', fallback: 'Very good' },
};

/** The word that goes with a star count — nobody should have to count stars. */
export function ratingWord(rating) {
  return WORDS[Number(rating)] || null;
}

/**
 * How to draw five stars for `value` — each 'full', 'half' or 'empty'.
 *
 * Rounded to the nearest half, so 4.3 is four stars and 4.4 is four and a half.
 * Anything that is not a number draws five empty stars rather than throwing.
 */
export function starKinds(value) {
  const n = Number(value);
  const halves = Number.isFinite(n) ? Math.round(Math.min(Math.max(n, 0), 5) * 2) : 0;
  return STAR_VALUES.map((star) => {
    if (halves >= star * 2) return 'full';
    if (halves === star * 2 - 1) return 'half';
    return 'empty';
  });
}

/**
 * The "how many gave 5, 4, 3…" rows, best first, from the server's summary.
 * `percent` is the share of all ratings, 0–100, for the width of the bar.
 */
export function distributionRows(summary) {
  const dist = summary?.distribution || {};
  const total = STAR_VALUES.reduce((n, star) => n + (Number(dist[star]) || 0), 0);
  return [...STAR_VALUES].reverse().map((stars) => {
    const count = Number(dist[stars]) || 0;
    return { stars, count, percent: total ? Math.round((count / total) * 100) : 0 };
  });
}

/** "12 Oct 2026", or '' for a date that cannot be read. */
export function reviewDay(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
