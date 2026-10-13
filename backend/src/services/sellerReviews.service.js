/**
 * What buyers said about ONE seller — the seller's own view.
 *
 * A review is written against a delivered order line and stamped with the
 * seller who delivered it (Review.sellerId). That is what makes the seller's
 * rating a thing at all: the buy box already weighs it. The seller had no way
 * to see it — not the average, not a single comment.
 *
 *   listSellerReviews(sellerId, { cursor, limit })
 *     reviews   newest first, keyset-paged like every other long list
 *     summary   average / count / star split — on the FIRST page only. It is
 *               one grouped query and it does not change while the seller
 *               scrolls, so later pages do not pay for it again.
 *
 * ── What a seller is and is not shown ───────────────────────────────────────
 * The product, the stars, the comment, the day — and the buyer's FIRST NAME.
 * Not their phone, id or address: a seller who is unhappy with a one-star
 * review must not be handed the means to turn up at the farmer's door about
 * it. (The order itself, while it is being delivered, is a different read with
 * a different purpose.)
 *
 * `sellerId` MUST be the signed-in seller, never a value from the request: it
 * is the only thing scoping this read.
 *
 * Index: reviews(sellerId). The seek filters on it and sorts that one seller's
 * reviews by (createdAt, id) — a handful to a few thousand rows. If a seller
 * ever holds enough reviews for that sort to show up in pg_stat_statements,
 * the fix is the composite (sellerId, createdAt DESC, id DESC); it is not
 * added speculatively (claude.md §17).
 */
import prisma from '../config/db.js';
import { keysetPage } from '../utils/keyset.js';

const firstNameOf = (name) => {
  const text = typeof name === 'string' ? name.trim() : '';
  return text ? text.split(/\s+/)[0] : null;
};

/** Average, count and the 1–5 split of every review attributed to `sellerId`. One query. */
export async function sellerReviewSummary(sellerId) {
  const buckets = await prisma.review.groupBy({
    by: ['rating'],
    where: { sellerId },
    _count: { rating: true },
  });
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0; let weighted = 0;
  for (const b of buckets) {
    distribution[b.rating] = b._count.rating;
    count += b._count.rating;
    weighted += b.rating * b._count.rating;
  }
  return { average: count ? Number((weighted / count).toFixed(2)) : 0, count, distribution };
}

export async function listSellerReviews(sellerId, { cursor, limit } = {}) {
  const { items, nextCursor, hasMore } = await keysetPage(prisma, {
    table: 'reviews', filterColumn: 'sellerId', filterValue: sellerId,
    cursor, limit,
    hydrate: (ids) => prisma.review.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, rating: true, comment: true, createdAt: true,
        user: { select: { name: true } },
        product: { select: { id: true, name: true, nameHi: true, nameMr: true, images: true } },
      },
    }),
  });

  const reviews = items.map((r) => ({
    id: r.id,
    rating: r.rating,
    comment: r.comment || null,
    createdAt: r.createdAt,
    product: r.product ? {
      id: r.product.id,
      name: r.product.name,
      nameHi: r.product.nameHi || null,
      nameMr: r.product.nameMr || null,
      image: r.product.images?.[0] || null,
    } : null,
    buyer: { firstName: firstNameOf(r.user?.name) },
  }));

  return {
    reviews, nextCursor, hasMore,
    summary: cursor ? null : await sellerReviewSummary(sellerId),
  };
}
