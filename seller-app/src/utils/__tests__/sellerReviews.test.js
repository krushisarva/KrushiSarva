/**
 * The seller's own ratings (utils/sellerReviews.js) — what the Ratings &
 * reviews screen shows, worked out from GET /agristore/seller/reviews.
 */
import {
  reviewBuyerName, reviewProductName, summaryFromResponse, summaryView,
} from '../sellerReviews';

describe('the score card', () => {
  test('average to one decimal, the count, and the split best-first', () => {
    const view = summaryView({ average: 3.5, count: 2, distribution: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 } });
    expect(view.average).toBe(3.5);
    expect(view.averageText).toBe('3.5');
    expect(view.count).toBe(2);
    expect(view.rows.map((r) => [r.stars, r.count, r.percent])).toEqual([
      [5, 1, 50], [4, 0, 0], [3, 0, 0], [2, 1, 50], [1, 0, 0],
    ]);
  });

  test('a whole-number average still reads as a score: "4.0", not "4"', () => {
    expect(summaryView({ average: 4, count: 3, distribution: { 4: 3 } }).averageText).toBe('4.0');
  });

  test('nobody has rated yet: no card at all — never "0.0", which reads as a bad score', () => {
    expect(summaryView({ average: 0, count: 0, distribution: {} })).toBeNull();
    expect(summaryView(null)).toBeNull();
    expect(summaryView(undefined)).toBeNull();
  });

  test('a nonsense average from the server is clamped, not drawn as six stars', () => {
    expect(summaryView({ average: 9, count: 1, distribution: { 5: 1 } }).average).toBe(5);
    expect(summaryView({ average: -2, count: 1, distribution: { 1: 1 } }).average).toBe(0);
  });
});

describe('which product a review is about', () => {
  const review = { product: { id: 'p1', name: 'Khurpi Hand Weeder', nameHi: 'खुरपी हैंड वीडर', nameMr: 'खुरपी' } };

  test('in the seller\'s language where the catalogue has it', () => {
    expect(reviewProductName(review, 'mr')).toBe('खुरपी');
    expect(reviewProductName(review, 'hi')).toBe('खुरपी हैंड वीडर');
    expect(reviewProductName(review, 'en')).toBe('Khurpi Hand Weeder');
  });

  test('falls back to the main name when there is no translation', () => {
    expect(reviewProductName({ product: { name: 'Urea 45 kg', nameMr: null } }, 'mr')).toBe('Urea 45 kg');
    expect(reviewProductName(review, 'te')).toBe('Khurpi Hand Weeder');
  });

  test('a product since removed: no name, and the review is still shown', () => {
    expect(reviewProductName({ product: null }, 'en')).toBeNull();
    expect(reviewProductName({ product: { name: '  ' } }, 'en')).toBeNull();
    expect(reviewProductName(null, 'en')).toBeNull();
  });
});

describe('who wrote it', () => {
  test('the first name the server sent, and nothing else', () => {
    expect(reviewBuyerName({ buyer: { firstName: 'Dattatray' } })).toBe('Dattatray');
  });

  test('no name', () => {
    expect(reviewBuyerName({ buyer: { firstName: null } })).toBeNull();
    expect(reviewBuyerName({ buyer: {} })).toBeNull();
    expect(reviewBuyerName({})).toBeNull();
  });
});

describe('the summary rides on the first page only', () => {
  test('the first page carries it', () => {
    const summary = { average: 4, count: 1, distribution: { 4: 1 } };
    expect(summaryFromResponse({ data: { data: [], meta: { summary } } })).toBe(summary);
  });

  test('a later page answers undefined — "keep what you have", never "no ratings"', () => {
    expect(summaryFromResponse({ data: { data: [], meta: { hasMore: false } } })).toBeUndefined();
    expect(summaryFromResponse({ data: {} })).toBeUndefined();
    expect(summaryFromResponse(null)).toBeUndefined();
  });
});
