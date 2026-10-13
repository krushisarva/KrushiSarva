/**
 * The buyer's own reviews, attached to their order lines.
 *
 * A review is written against a DELIVERED order line (POST
 * /agristore/products/:id/review) and is unique per (buyer, line). The farmer
 * app's "My Orders" has to know, per line, whether that review exists yet — it
 * is the difference between "Rate this product" and "Your rating ★★★★☆ · Edit",
 * and what the edit sheet opens pre-filled with.
 *
 * ONE query for the whole page, whatever its size, and none at all for a page
 * with nothing delivered (most pages of a new buyer's orders). It rides the
 * unique index reviews(userId, orderItemId) — userId equality, then an IN list on
 * the second column — so there is no scan.
 */
import prisma from '../config/db.js';

/**
 * Set `item.myReview = { rating, comment } | null` on every DELIVERED line of
 * `orders`, for the reviews `userId` wrote. Lines in any other state are left
 * without the field: they cannot be reviewed, so there is nothing to say.
 *
 * Mutates and returns `orders`, like withOrderDeliveries().
 *
 * `userId` MUST be the signed-in buyer, never a value from the request body or
 * query: it is what scopes the read to the caller's own reviews.
 */
export async function withMyReviews(orders, userId) {
  if (!Array.isArray(orders) || !orders.length || !userId) return orders;

  const delivered = [];
  for (const order of orders) {
    for (const item of order?.items || []) {
      if (item?.status === 'DELIVERED' && item.id) delivered.push(item);
    }
  }
  if (!delivered.length) return orders;

  const reviews = await prisma.review.findMany({
    where: { userId, orderItemId: { in: delivered.map((i) => i.id) } },
    select: { orderItemId: true, rating: true, comment: true },
  });
  const byItem = new Map(reviews.map((r) => [r.orderItemId, r]));

  for (const item of delivered) {
    const r = byItem.get(item.id);
    item.myReview = r ? { rating: r.rating, comment: r.comment || null } : null;
  }
  return orders;
}
