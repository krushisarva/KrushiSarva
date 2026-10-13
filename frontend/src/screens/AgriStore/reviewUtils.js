/**
 * Product reviews — the rules, with no React and no network in them.
 *
 * A farmer rates a product from My Orders once it has been DELIVERED, and reads
 * other buyers' ratings on the product page. The server owns the real rules
 * (POST /agristore/products/:id/review): only a delivered order line can be
 * reviewed, one review per line, sending again edits it. This file is what the
 * app needs to offer exactly that and no more — so the button is never shown for
 * a line the server would refuse, and nothing is posted that it would reject.
 *
 * Pure functions only, so the plain-node Jest config tests all of it.
 */

// How a rating is DRAWN (stars, the word for them, the split, the date) is shared
// with the seller app, which shows a seller their own ratings. Re-exported so the
// farmer screens keep one import.
import { isRating } from '@krushisarva/shared/utils/reviewDisplay';

export {
  STAR_VALUES, isRating, ratingWord, starKinds, distributionRows, reviewDay,
} from '@krushisarva/shared/utils/reviewDisplay';

/** The server's own limit (express-validator: comment max 500). */
export const REVIEW_MAX_COMMENT = 500;

/**
 * Can this order line be rated?
 *
 * Mirrors the server's purchase check: the line itself must be DELIVERED. An
 * order's own status is not enough — one shop can have delivered while another
 * is still on its way, and only the line that arrived can be rated.
 */
export function canReviewItem(item) {
  return !!item && item.status === 'DELIVERED' && !!item.id && !!item.productId;
}

/** The lines of an order that can be rated, in the order they were bought. */
export function reviewableItems(order) {
  return (Array.isArray(order?.items) ? order.items : []).filter(canReviewItem);
}

/**
 * The buyer's own review of a line — `{ rating, comment }` — or null.
 *
 * Null also for a response from an older server, which sends no `myReview` at
 * all: the button then reads "Rate this product", and rating again edits the
 * review that is already there, so nothing is lost.
 */
export function myReviewOf(item) {
  const r = item?.myReview;
  if (!r || !isRating(Number(r.rating))) return null;
  const comment = typeof r.comment === 'string' ? r.comment.trim() : '';
  return { rating: Number(r.rating), comment: comment || null };
}

/**
 * What to POST, or null when it must not be sent.
 *
 * An empty comment is left out rather than sent as '' — the server stores a
 * missing comment as NULL either way, which is also how clearing one on an edit
 * works.
 */
export function reviewPayload({ rating, comment, orderItemId } = {}) {
  const stars = Number(rating);
  if (!isRating(stars)) return null;
  const text = typeof comment === 'string' ? comment.trim() : '';
  if (text.length > REVIEW_MAX_COMMENT) return null;
  return {
    rating: stars,
    ...(text ? { comment: text } : {}),
    ...(orderItemId ? { orderItemId } : {}),
  };
}

/**
 * The name shown beside a review: the first name only.
 *
 * A review is public. The server sends the reviewer's whole display name, and a
 * farmer's full name next to what they bought is more than a stranger reading
 * the product page needs. Null when there is none — the screen then says
 * "A farmer".
 */
export function reviewerFirstName(user) {
  const name = typeof user?.name === 'string' ? user.name.trim() : '';
  return name ? name.split(/\s+/)[0] : null;
}

/**
 * Fold a saved review back into the orders on screen.
 *
 * Refetching the page instead would scroll-jump a farmer who has paged down.
 * Every order and line that did not change keeps its identity, so
 * `memo(OrderCard)` re-renders only the one row.
 */
export function applyMyReview(orders, orderId, orderItemId, review) {
  if (!Array.isArray(orders)) return orders;
  const mine = review && isRating(Number(review.rating))
    ? { rating: Number(review.rating), comment: (typeof review.comment === 'string' && review.comment.trim()) || null }
    : null;
  if (!mine) return orders;
  return orders.map((order) => {
    if (order?.id !== orderId || !Array.isArray(order.items)) return order;
    if (!order.items.some((i) => i?.id === orderItemId)) return order;
    return {
      ...order,
      items: order.items.map((i) => (i?.id === orderItemId ? { ...i, myReview: mine } : i)),
    };
  });
}

/**
 * Add a page of reviews to the ones already shown, without repeating any.
 * A review posted while the farmer is paging shifts the pages by one, and the
 * same review then arrives twice.
 */
export function mergeReviewPages(existing, incoming) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map((r) => r?.id));
  for (const r of Array.isArray(incoming) ? incoming : []) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
