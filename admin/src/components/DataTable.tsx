/** Server-paginated, accessible data table with optional CSV export. */
import { type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { Button, EmptyState, ErrorState } from './ui';
import { errorMessage } from '../lib/api';
import { downloadCsv } from '../lib/csv';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  /** String accessor for CSV export. Defaults to String(row[key]). */
  csv?: (row: T) => string;
  className?: string;
  /**
   * Exported but not drawn. Lets a screen move a field into a detail panel to
   * keep the table readable WITHOUT dropping it from the CSV an operator
   * reconciles against the database.
   */
  csvOnly?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  items: T[];
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /**
   * Extra classes for one row — for marking the rows that need a human out from
   * the rows that do not. Applied after the base row classes, so a background
   * here wins over the default hover.
   */
  rowClassName?: (row: T) => string | undefined;
  /**
   * Pin the header while the body scrolls inside the card. Opt-in: it caps the
   * table's height, which only suits screens where scanning a long list is the
   * job.
   */
  stickyHeader?: boolean;
  page?: number;
  canPrev?: boolean;
  canNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  exportName?: string; // enables CSV export of the current page when set
  emptyMessage?: string;
}

/** Placeholder rows shaped like the real ones, so the first load does not jump. */
function SkeletonRows({ columns, rows = 8 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: columns }, (__, c) => (
            <td key={c} className="table-td">
              <div
                className="h-3 animate-pulse rounded bg-slate-100"
                style={{ width: `${[70, 45, 60, 55, 80, 50, 65][(r + c) % 7]}%`, animationDelay: `${(r % 4) * 90}ms` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function DataTable<T>({
  columns, items, isLoading, isFetching, error, rowKey, onRowClick, rowClassName, stickyHeader,
  page, canPrev, canNext, onPrev, onNext, exportName, emptyMessage,
}: DataTableProps<T>) {
  // Hidden columns still export: the CSV is the reconciliation artefact.
  const shown = columns.filter((c) => !c.csvOnly);

  const exportCsv = () => {
    const headers = columns.map((c) => c.header);
    const rows = items.map((row) =>
      columns.map((c) => (c.csv ? c.csv(row) : String((row as Record<string, unknown>)[c.key] ?? ''))),
    );
    downloadCsv(`${exportName}-page${page ?? 1}`, headers, rows);
  };

  const showSkeleton = isLoading && items.length === 0;

  return (
    <div className="card overflow-hidden">
      {exportName && (
        <div className="flex items-center justify-end border-b border-slate-100 px-3 py-2">
          <Button variant="ghost" onClick={exportCsv} disabled={!items.length} title="Export current page (masked data only)">
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        </div>
      )}
      <div className={stickyHeader ? 'max-h-[70vh] overflow-auto' : 'overflow-x-auto'}>
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50">
            <tr>
              {shown.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`table-th whitespace-nowrap ${stickyHeader ? 'sticky top-0 z-10 bg-slate-50 shadow-[inset_0_-1px_0_theme(colors.slate.200)]' : ''}`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody
            className={`divide-y divide-slate-100 transition-opacity duration-200 ${isFetching && !isLoading ? 'opacity-60' : 'opacity-100'}`}
          >
            {showSkeleton && <SkeletonRows columns={shown.length} />}
            {!showSkeleton && items.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={[
                  'transition-colors duration-150',
                  // Focus is an OUTLINE, not a background: a row tinted by
                  // rowClassName must keep its own colour when focused, and the
                  // app-wide focus ring is a box-shadow that a collapsed table
                  // row does not paint.
                  onRowClick ? 'cursor-pointer hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600' : '',
                  rowClassName?.(row) ?? '',
                ].filter(Boolean).join(' ')}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); }
                } : undefined}
              >
                {shown.map((c) => (
                  <td key={c.key} className={`table-td ${c.className ?? ''}`}>
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!isLoading && error != null && <div className="p-4"><ErrorState message={errorMessage(error)} /></div>}
      {!isLoading && !error && items.length === 0 && <EmptyState message={emptyMessage} />}

      {(canPrev || canNext) && (
        <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-sm text-slate-500">
          <span>Page {page ?? 1}{isFetching ? ' · loading…' : ''}</span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onPrev} disabled={!canPrev}><ChevronLeft className="h-4 w-4" /> Prev</Button>
            <Button variant="secondary" onClick={onNext} disabled={!canNext}>Next <ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
