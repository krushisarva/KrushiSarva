import { mergeRefreshedPages } from '../pagedList';

const rows = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: `r${from + i}` }));
const ids = (list) => list.map((r) => r.id);

describe('mergeRefreshedPages', () => {
  const LIMIT = 20;

  it('keeps the pages below the ones just re-read', () => {
    // Seller has scrolled through three pages; a pull re-reads the first two.
    const prev = rows(0, 60);
    const fetched = rows(0, 40);

    const merged = mergeRefreshedPages({ prev, fetched, pagesRead: 2, limit: LIMIT, reachedEnd: false });

    // Before the fix a refresh returned page 1 only and the seller lost their
    // place — so both the row count and the last row matter here.
    expect(merged).toHaveLength(60);
    expect(ids(merged.slice(0, 40))).toEqual(ids(fetched));
    expect(merged[59].id).toBe('r59');
  });

  it('re-reads page 1 and keeps pages 2+ when only one page was read', () => {
    const prev = rows(0, 40);
    const fetched = [{ id: 'new' }, ...rows(0, 19)];

    const merged = mergeRefreshedPages({ prev, fetched, pagesRead: 1, limit: LIMIT, reachedEnd: false });

    expect(merged).toHaveLength(40);
    expect(merged[0].id).toBe('new');
    expect(ids(merged.slice(20))).toEqual(ids(rows(20, 40)));
  });

  it('drops the rows below when the server says the list now ends there', () => {
    const prev = rows(0, 60);
    const fetched = rows(0, 25);

    const merged = mergeRefreshedPages({ prev, fetched, pagesRead: 2, limit: LIMIT, reachedEnd: true });

    expect(merged).toEqual(fetched);
  });

  it('does not show a row twice when it moved up into the re-read pages', () => {
    // r45 was on page 3 and has moved onto page 2 (an order was updated).
    const prev = rows(0, 60);
    const fetched = [...rows(0, 39), { id: 'r45' }];

    const merged = mergeRefreshedPages({ prev, fetched, pagesRead: 2, limit: LIMIT, reachedEnd: false });

    expect(merged.filter((r) => r.id === 'r45')).toHaveLength(1);
    expect(new Set(ids(merged)).size).toBe(merged.length);
  });

  it('returns just the fetched rows when nothing was loaded past the re-read pages', () => {
    const prev = rows(0, 15);
    const fetched = rows(0, 12);

    expect(mergeRefreshedPages({ prev, fetched, pagesRead: 1, limit: LIMIT, reachedEnd: false })).toEqual(fetched);
  });

  it('honours a custom key and tolerates missing arguments', () => {
    const prev = [{ sku: 'a' }, { sku: 'b' }];
    const fetched = [{ sku: 'a' }];

    expect(mergeRefreshedPages({
      prev, fetched, pagesRead: 1, limit: 1, reachedEnd: false, keyOf: (it) => it.sku,
    })).toEqual([{ sku: 'a' }, { sku: 'b' }]);

    expect(mergeRefreshedPages({})).toEqual([]);
  });
});
