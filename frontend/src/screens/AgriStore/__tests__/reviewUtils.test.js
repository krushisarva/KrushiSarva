/**
 * Product reviews — the rules the app applies before the server sees anything
 * (reviewUtils.js): which order lines can be rated, what gets posted, and how a
 * saved rating is folded back into My Orders.
 */
import {
  REVIEW_MAX_COMMENT, applyMyReview, canReviewItem, distributionRows, isRating, mergeReviewPages,
  myReviewOf, ratingWord, reviewDay, reviewPayload, reviewableItems, reviewerFirstName, starKinds,
} from '../reviewUtils';

const line = (over = {}) => ({ id: 'item-1', productId: 'prod-1', status: 'DELIVERED', ...over });

describe('which lines can be rated', () => {
  test('only a line that has been delivered', () => {
    expect(canReviewItem(line())).toBe(true);
    for (const status of ['PENDING', 'CONFIRMED', 'SHIPPED', 'CANCELLED']) {
      expect(canReviewItem(line({ status }))).toBe(false);
    }
  });

  test('not a line with nothing to post against', () => {
    expect(canReviewItem(line({ id: null }))).toBe(false);
    expect(canReviewItem(line({ productId: null }))).toBe(false);
    expect(canReviewItem(null)).toBe(false);
  });

  test('an order with one shop delivered and one on its way offers only what arrived', () => {
    const order = { status: 'SHIPPED', items: [line({ id: 'a' }), line({ id: 'b', status: 'SHIPPED' }), line({ id: 'c' })] };
    expect(reviewableItems(order).map((i) => i.id)).toEqual(['a', 'c']);
  });

  test('an order with no lines in the payload offers nothing, and does not throw', () => {
    expect(reviewableItems({})).toEqual([]);
    expect(reviewableItems(null)).toEqual([]);
  });
});

describe('the rating already given', () => {
  test('read from the line', () => {
    expect(myReviewOf(line({ myReview: { rating: 4, comment: ' Strong blade ' } })))
      .toEqual({ rating: 4, comment: 'Strong blade' });
  });

  test('a rating with no comment', () => {
    expect(myReviewOf(line({ myReview: { rating: 5, comment: null } }))).toEqual({ rating: 5, comment: null });
  });

  test('not rated yet, an older server that sends no field, or junk — all "not rated"', () => {
    expect(myReviewOf(line({ myReview: null }))).toBeNull();
    expect(myReviewOf(line())).toBeNull();
    expect(myReviewOf(line({ myReview: { rating: 9 } }))).toBeNull();
    expect(myReviewOf(line({ myReview: { rating: 'four' } }))).toBeNull();
  });
});

describe('what gets posted', () => {
  test('stars, the trimmed comment and the order line', () => {
    expect(reviewPayload({ rating: 4, comment: '  Good khurpi  ', orderItemId: 'item-1' }))
      .toEqual({ rating: 4, comment: 'Good khurpi', orderItemId: 'item-1' });
  });

  test('an empty comment is left out — that is also how an edit clears one', () => {
    expect(reviewPayload({ rating: 5, comment: '   ', orderItemId: 'item-1' }))
      .toEqual({ rating: 5, orderItemId: 'item-1' });
    expect(reviewPayload({ rating: 5, orderItemId: 'item-1' })).toEqual({ rating: 5, orderItemId: 'item-1' });
  });

  test('nothing is posted without a real star rating', () => {
    for (const rating of [0, 6, 2.5, null, undefined, 'abc']) {
      expect(reviewPayload({ rating, orderItemId: 'item-1' })).toBeNull();
    }
  });

  test('nothing longer than the server accepts', () => {
    expect(reviewPayload({ rating: 3, comment: 'x'.repeat(REVIEW_MAX_COMMENT) })).not.toBeNull();
    expect(reviewPayload({ rating: 3, comment: 'x'.repeat(REVIEW_MAX_COMMENT + 1) })).toBeNull();
  });

  test('isRating', () => {
    expect([1, 2, 3, 4, 5].every(isRating)).toBe(true);
    expect([0, 6, 1.5, '3', null].some(isRating)).toBe(false);
  });
});

describe('the word for the stars', () => {
  test('every rating has one, with a translation key', () => {
    expect([1, 2, 3, 4, 5].map((n) => ratingWord(n).key)).toEqual([
      'reviews.word1', 'reviews.word2', 'reviews.word3', 'reviews.word4', 'reviews.word5',
    ]);
    expect(ratingWord(5).fallback).toBe('Very good');
  });

  test('no rating, no word', () => {
    expect(ratingWord(0)).toBeNull();
    expect(ratingWord(undefined)).toBeNull();
  });
});

describe('drawing stars', () => {
  test('whole numbers', () => {
    expect(starKinds(3)).toEqual(['full', 'full', 'full', 'empty', 'empty']);
    expect(starKinds(5)).toEqual(['full', 'full', 'full', 'full', 'full']);
  });

  test('an average is rounded to the nearest half star', () => {
    expect(starKinds(4.2)).toEqual(['full', 'full', 'full', 'full', 'empty']);
    expect(starKinds(4.4)).toEqual(['full', 'full', 'full', 'full', 'half']);
    expect(starKinds(4.8)).toEqual(['full', 'full', 'full', 'full', 'full']);
    expect(starKinds(0.5)).toEqual(['half', 'empty', 'empty', 'empty', 'empty']);
  });

  test('out of range or not a number never throws', () => {
    expect(starKinds(9)).toEqual(['full', 'full', 'full', 'full', 'full']);
    expect(starKinds(-1)).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
    expect(starKinds('abc')).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
  });
});

describe('how the stars split', () => {
  test('best first, with each row\'s share of all ratings', () => {
    const rows = distributionRows({ distribution: { 1: 1, 2: 0, 3: 1, 4: 2, 5: 6 } });
    expect(rows.map((r) => r.stars)).toEqual([5, 4, 3, 2, 1]);
    expect(rows.map((r) => r.count)).toEqual([6, 2, 1, 0, 1]);
    expect(rows.map((r) => r.percent)).toEqual([60, 20, 10, 0, 10]);
  });

  test('no ratings: five empty rows, no division by zero', () => {
    expect(distributionRows(null).every((r) => r.count === 0 && r.percent === 0)).toBe(true);
    expect(distributionRows({ distribution: {} })).toHaveLength(5);
  });
});

describe('who wrote it', () => {
  test('the first name only — a review is public', () => {
    expect(reviewerFirstName({ name: 'Dattatray Mane' })).toBe('Dattatray');
    expect(reviewerFirstName({ name: '  Sunita   ' })).toBe('Sunita');
  });

  test('no name', () => {
    expect(reviewerFirstName({ name: null })).toBeNull();
    expect(reviewerFirstName(undefined)).toBeNull();
  });

  test('the day it was written, or nothing for a date that cannot be read', () => {
    expect(reviewDay('2026-10-12T08:30:00.000Z')).toMatch(/12.*Oct.*2026/);
    expect(reviewDay('not a date')).toBe('');
    expect(reviewDay(null)).toBe('');
  });
});

describe('folding a saved rating back into My Orders', () => {
  const orders = [
    { id: 'o1', items: [{ id: 'a', status: 'DELIVERED', myReview: null }, { id: 'b', status: 'DELIVERED', myReview: null }] },
    { id: 'o2', items: [{ id: 'c', status: 'DELIVERED', myReview: null }] },
  ];

  test('only that line changes', () => {
    const next = applyMyReview(orders, 'o1', 'b', { rating: 4, comment: 'Good' });
    expect(next[0].items[1].myReview).toEqual({ rating: 4, comment: 'Good' });
    expect(next[0].items[0].myReview).toBeNull();
  });

  test('every other order and line keeps its identity, so only one row re-renders', () => {
    const next = applyMyReview(orders, 'o1', 'b', { rating: 4, comment: null });
    expect(next[1]).toBe(orders[1]);
    expect(next[0]).not.toBe(orders[0]);
    expect(next[0].items[0]).toBe(orders[0].items[0]);
  });

  test('the original list is not mutated', () => {
    applyMyReview(orders, 'o1', 'a', { rating: 1, comment: 'Bad' });
    expect(orders[0].items[0].myReview).toBeNull();
  });

  test('an order or line that is not on screen, or a review with no rating, changes nothing', () => {
    expect(applyMyReview(orders, 'nope', 'a', { rating: 4 })).toEqual(orders);
    expect(applyMyReview(orders, 'o1', 'nope', { rating: 4 })[0]).toBe(orders[0]);
    expect(applyMyReview(orders, 'o1', 'a', null)).toBe(orders);
    expect(applyMyReview(orders, 'o1', 'a', { rating: 0 })).toBe(orders);
  });
});

describe('paging through reviews', () => {
  test('a review that arrives twice is shown once', () => {
    const first = [{ id: 'r1' }, { id: 'r2' }];
    const merged = mergeReviewPages(first, [{ id: 'r2' }, { id: 'r3' }]);
    expect(merged.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(first).toHaveLength(2);
  });

  test('junk pages do not throw', () => {
    expect(mergeReviewPages(null, undefined)).toEqual([]);
    expect(mergeReviewPages([{ id: 'r1' }], [null, {}, { id: 'r1' }])).toEqual([{ id: 'r1' }]);
  });
});
