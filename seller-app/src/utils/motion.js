/**
 * Motion maths for hooks/useMotion.js, kept here so it can be tested without a
 * renderer or an animation frame.
 */

/**
 * How long a row's entrance waits before it starts.
 *
 * The stagger exists to make the FIRST SCREENFUL arrive as a cascade. It was
 * applied to every row and merely clamped at `maxDelay`, so every row from the
 * sixth onwards sat at opacity 0 for the full 260ms — a screen of blank rows
 * when a seller scrolls quickly (FlatList mounts those rows as they come into
 * view) and again on every "load more" page. Rows past the first screenful now
 * start immediately and just fade in.
 */
export function entranceDelay({ index = 0, stagger = 45, maxDelay = 260 } = {}) {
  const i = Number.isFinite(index) ? index : 0;
  if (!(stagger > 0) || !(maxDelay > 0) || i <= 0) return 0;
  // The rows the cascade covers: the ones that fit inside maxDelay.
  const screenful = Math.floor(maxDelay / stagger);
  return i < screenful ? i * stagger : 0;
}

/**
 * One frame of a counter, eased (easeOutCubic) — `from` at progress 0, `to` at 1.
 *
 * `from` is what makes a re-count honest: the counter used to interpolate from 0
 * on every value change, so a dashboard refresh dropped the day's revenue to ₹0
 * and climbed back up. It counts up from 0 on first mount and from whatever is
 * on screen after that.
 */
export function countUpFrame({ from = 0, to = 0, progress = 0 } = {}) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const eased = 1 - Math.pow(1 - p, 3);
  return from + (to - from) * eased;
}
