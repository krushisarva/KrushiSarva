/**
 * Paged-list maths, kept out of the hook so it can be tested without a renderer.
 */

/**
 * What a refresh should leave on screen.
 *
 * A pull-to-refresh used to replace the whole list with page 1, so a seller who
 * had scrolled to page 5 was thrown back to the top with four pages of rows
 * gone. The refresh re-reads only the first few pages (it must not fire five
 * requests on one pull), and everything BELOW the pages it re-read is kept where
 * it was — the seller keeps their place and their scroll offset still points at
 * a row that exists.
 *
 * @param prev       rows currently on screen
 * @param fetched    rows from the pages just re-read, in order
 * @param pagesRead  how many pages were re-read
 * @param limit      page size (so `pagesRead * limit` is the old page boundary)
 * @param reachedEnd the server says there is nothing after the pages just read,
 *                   so the rows below them no longer exist
 */
export function mergeRefreshedPages({
  prev = [],
  fetched = [],
  pagesRead = 1,
  limit = 20,
  reachedEnd = false,
  keyOf = (item) => item?.id,
}) {
  if (reachedEnd) return fetched;
  const tail = prev.slice(Math.max(1, pagesRead) * limit);
  if (!tail.length) return fetched;
  // A row that moved up into the re-read pages must not also appear below them.
  const seen = new Set(fetched.map(keyOf));
  return [...fetched, ...tail.filter((item) => !seen.has(keyOf(item)))];
}

export default mergeRefreshedPages;
