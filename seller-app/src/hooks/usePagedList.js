/**
 * usePagedList — paginated list state for both pagination styles the API offers:
 *
 *   mode: 'cursor'  → GET ?paginate=cursor&limit=N, then ?cursor=<meta.nextCursor>
 *   mode: 'page'    → GET ?page=N&limit=N
 *
 * Fixes carried over from the hand-rolled versions in MyProducts / Orders:
 *   - failures are surfaced instead of console.warn'd into the void
 *   - a "load more" failure keeps the rows already on screen and shows a
 *     retry footer, instead of silently stopping pagination forever
 *   - concurrent refresh + load-more can no longer interleave and duplicate rows
 *   - duplicate ids are dropped (a row inserted server-side between page reads
 *     used to appear twice and crash FlatList's key check)
 *   - reaching the end is detected correctly for both modes
 *   - a refresh no longer throws away everything past page 1: it re-reads the
 *     first REFRESH_MAX_PAGES loaded pages and keeps the rest, so a pull (or a
 *     focus refetch) does not drop the seller back to the top of the list
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { safeErrorMessage } from '@krushisarva/shared/services/api';
import { useNetwork, isConnectivityError } from './useNetwork';
import { mergeRefreshedPages } from '../utils/pagedList';

const DEFAULT_LIMIT = 20;

/**
 * How many already-loaded pages a refresh (pull-to-refresh or a focus refetch)
 * re-reads. Capped on purpose: a seller sitting on page 10 must not fire ten
 * requests on one pull. The pages below the cap are kept on screen rather than
 * discarded, so refreshing no longer collapses the list back to page 1.
 */
const REFRESH_MAX_PAGES = 2;

export default function usePagedList({
  /** ({ cursor, page, limit, signal }) => axios response */
  fetchPage,
  mode = 'page',
  limit = DEFAULT_LIMIT,
  /** Re-created list whenever any of these change (e.g. a status filter). */
  deps = [],
  refetchOnFocus = false,
  keyOf = (item) => item?.id,
  errorFallback,
}) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);          // blocks the whole list
  const [moreError, setMoreError] = useState(null);  // only the footer
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const cursorRef = useRef(null);
  const pageRef = useRef(1);
  const pagesLoaded = useRef(1);     // pages currently on screen, in both modes
  const mounted = useRef(true);
  const runId = useRef(0);
  const abortRef = useRef(null);
  const hasLoaded = useRef(false);
  const inFlight = useRef(false);

  const { reconnectedAt } = useNetwork();

  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; abortRef.current?.abort(); };
  }, []);

  const load = useCallback(async ({ mode: how = 'load' } = {}) => {
    const isMore = how === 'more';
    const isRefresh = how === 'refresh';

    // One request at a time. Without this, an onEndReached firing during a
    // pull-to-refresh appended page 2 of the OLD list onto the new page 1.
    if (inFlight.current && !isMore) abortRef.current?.abort();
    else if (inFlight.current && isMore) return;

    const id = ++runId.current;
    inFlight.current = true;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (!isMore) abortRef.current = controller;

    if (isMore) { setLoadingMore(true); setMoreError(null); }
    else if (isRefresh) setRefreshing(true);
    else { setLoading(true); if (how === 'retry') setError(null); }

    // A refresh re-reads the pages the seller has already scrolled through, up
    // to the cap; everything below the cap is kept by mergeRefreshedPages.
    const wanted = isRefresh ? Math.min(pagesLoaded.current, REFRESH_MAX_PAGES) : 1;

    try {
      const fetched = [];
      const seen = new Set();
      let cursor = isMore ? cursorRef.current : null;
      let read = 0;
      let end = false;

      // One request for a load / retry / load-more, and up to `wanted` for a
      // refresh — sequentially, under one spinner.
      while (read < wanted) {
        const res = await fetchRef.current({
          cursor,
          page: isMore ? pageRef.current + 1 : read + 1,
          limit,
          signal: controller?.signal,
        });

        if (!mounted.current || id !== runId.current) return;

        const list = res?.data?.data ?? res?.data ?? [];
        const rows = Array.isArray(list) ? list : [];
        const meta = res?.data?.meta ?? {};

        for (const it of rows) {
          // Drop anything this run already holds — the server can shift rows
          // between page reads, and duplicate keys break FlatList.
          const key = keyRef.current(it);
          if (seen.has(key)) continue;
          seen.add(key);
          fetched.push(it);
        }

        cursor = meta.nextCursor || null;
        read += 1;

        // A short page means the end. `meta.hasMore`/`meta.total` win when present.
        const pages = isMore ? pageRef.current + 1 : read;
        if (mode === 'cursor') end = !cursor;
        else if (typeof meta.hasMore === 'boolean') end = !meta.hasMore;
        else if (typeof meta.total === 'number') end = pages * limit >= meta.total;
        else end = rows.length < limit;
        if (end) break;
      }

      setItems((prev) => {
        if (isMore) {
          const held = new Set(prev.map((it) => keyRef.current(it)));
          return [...prev, ...fetched.filter((it) => !held.has(keyRef.current(it)))];
        }
        if (!isRefresh) return fetched;
        return mergeRefreshedPages({
          prev, fetched, pagesRead: read, limit, reachedEnd: end, keyOf: keyRef.current,
        });
      });

      if (isMore) {
        pageRef.current += 1;
        pagesLoaded.current += 1;
        cursorRef.current = cursor;
        setHasMore(!end);
      } else if (isRefresh && !end && read < pagesLoaded.current) {
        // Pages past the cap are still on screen, so the cursor and the page
        // counter must keep pointing after THOSE, not after what we re-read.
        //
        // `hasMore` is the one thing worth updating: the refresh saw rows beyond
        // the pages it read, so a list that had reached its end before the pull
        // must not stay stuck at "nothing more" now that the server has grown.
        // Only when there is something to page from — in cursor mode the cursor
        // we keep is the old one, and a null cursor cannot be followed.
        if (mode !== 'cursor' || cursorRef.current) setHasMore(true);
      } else {
        pageRef.current = read;
        pagesLoaded.current = read;
        cursorRef.current = cursor;
        setHasMore(!end);
      }

      hasLoaded.current = true;
      setError(null);
    } catch (e) {
      if (!mounted.current || id !== runId.current) return;
      if (e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED') return;
      const payload = {
        message: safeErrorMessage(e, errorFallback) || errorFallback || 'Something went wrong.',
        isOffline: isConnectivityError(e),
        status: e?.response?.status ?? null,
      };
      // A failed "load more" must not wipe the rows already on screen.
      if (isMore) setMoreError(payload);
      else setError(payload);
    } finally {
      if (mounted.current && id === runId.current) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
      inFlight.current = false;
    }
  }, [limit, mode, errorFallback]);

  // (Re)build the list whenever the caller's deps change.
  useEffect(() => {
    hasLoaded.current = false;
    cursorRef.current = null;
    pageRef.current = 1;
    pagesLoaded.current = 1;
    setHasMore(true);
    setMoreError(null);
    setItems([]);
    load({ mode: 'load' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  const lastReconnect = useRef(reconnectedAt);
  useEffect(() => {
    if (reconnectedAt && reconnectedAt !== lastReconnect.current) {
      lastReconnect.current = reconnectedAt;
      if (error?.isOffline || !hasLoaded.current) load({ mode: 'retry' });
    }
  }, [reconnectedAt, error, load]);

  const focusRun = useCallback(() => {
    if (refetchOnFocus && hasLoaded.current) load({ mode: 'refresh' });
  }, [refetchOnFocus, load]);
  useFocusEffect(focusRun);

  const refresh = useCallback(() => load({ mode: 'refresh' }), [load]);
  const retry = useCallback(() => load({ mode: 'retry' }), [load]);

  const loadMore = useCallback(() => {
    // Guard on hasLoaded too: FlatList fires onEndReached once on mount for an
    // empty list, which used to request page 2 of a list that had no page 1.
    if (!hasLoaded.current || !hasMore || loadingMore || moreError || error) return;
    if (mode === 'cursor' && !cursorRef.current) return;
    load({ mode: 'more' });
  }, [hasMore, loadingMore, moreError, error, mode, load]);

  const retryMore = useCallback(() => { setMoreError(null); load({ mode: 'more' }); }, [load]);

  return {
    items,
    setItems,
    error,
    moreError,
    loading,
    refreshing,
    loadingMore,
    hasMore,
    isInitialLoading: loading && !hasLoaded.current,
    hasLoaded: hasLoaded.current,
    refresh,
    retry,
    loadMore,
    retryMore,
  };
}
