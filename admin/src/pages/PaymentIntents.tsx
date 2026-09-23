/**
 * Payment intents — what the gateway took, and what happened to it.
 *
 * One row is one Razorpay order. The rows that matter are payments captured with
 * no order behind them: the automatic refund (backend shopPayment.service.js)
 * walks such an intent REFUND_INITIATED → REFUNDED, and a failed gateway call
 * leaves it REFUND_INITIATED with failureReason "AUTO-REFUND FAILED: …" — money
 * that is still with the buyer's bank and needs a human.
 *
 * Those three states are indistinguishable from `status` alone, so the "Money"
 * column names each one and the view filter isolates the failures.
 *
 * ── Why the screen is shaped like this ───────────────────────────────────────
 * The page is a triage queue, not a report. Nine columns of equal weight made an
 * operator read every row to find the one that needed them, so:
 *   - the two urgent views are chips at the top, carrying REAL counts from
 *     GET /admin/payment-intents/summary (the list is keyset-paginated, so a
 *     count taken from the loaded page would understate how much money is
 *     stranded — a number an operator would act on, and a wrong one);
 *   - a row nobody but a person can move is tinted and barred (moneyState's
 *     `attention: 'act'`), so it is findable without reading;
 *   - the fields an operator only needs once they have picked a row — gateway
 *     ids, notes, timestamps — live in the detail panel, each with a copy
 *     button, because the next step is pasting one into the Razorpay dashboard.
 * Everything moved off the table stays in the CSV (`csvOnly` columns): the
 * export is what gets reconciled against the database.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
import { apiGet } from '../lib/api';
import { useKeyset } from '../lib/useKeyset';
import { PageHeader, Badge, StatusBadge, Button, CopyValue } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { FilterSelect, DescList } from '../components/filters';
import { Drawer } from '../components/Modal';
import { formatINR, formatDateTime, relativeTime } from '../lib/format';
import {
  INTENT_STATUSES, PAYMENT_PURPOSES, QUEUE_VIEWS, gatewayStatusLabel, moneyState, moneyAdvice,
  purposeLabel, formatQueueCount, type IntentSummary, type QueueView, type Tone,
} from '../lib/paymentState';

const STATUS_OPTIONS = INTENT_STATUSES.map((s) => ({ label: gatewayStatusLabel(s), value: `status:${s}` }));
const PURPOSE_OPTIONS = PAYMENT_PURPOSES.map((p) => ({ label: purposeLabel(p), value: p }));

/**
 * Tone → chip styling. The page chooses how a tone LOOKS; which tone a view has
 * is decided in paymentState.ts, so a queue can never be recoloured here into
 * meaning something it does not.
 */
const CHIP: Record<Tone, { on: string; off: string }> = {
  red: { on: 'bg-red-600 text-white shadow-sm', off: 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100' },
  amber: { on: 'bg-amber-500 text-white shadow-sm', off: 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100' },
  green: { on: 'bg-green-600 text-white shadow-sm', off: 'border-green-200 bg-green-50 text-green-800 hover:bg-green-100' },
  blue: { on: 'bg-blue-600 text-white shadow-sm', off: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100' },
  violet: { on: 'bg-violet-600 text-white shadow-sm', off: 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100' },
  slate: { on: 'bg-slate-800 text-white shadow-sm', off: 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50' },
};

interface IntentRow {
  id: string; userId: string; provider: string; purpose: string; providerOrderId: string; providerPaymentId: string | null;
  amount: number | string; currency: string; status: string; orderId: string | null;
  failureReason: string | null; reconciledAt: string | null; reconcileNote: string | null;
  createdAt: string; updatedAt?: string;
}

// ── Triage chip ───────────────────────────────────────────────────────────────

/**
 * `count` is undefined while the summary is in flight or unavailable, and the
 * chip then shows no number at all. A count that cannot be trusted is worse than
 * none: this one says how much money is stranded.
 */
function Chip({ tone, label, title, active, count, loading, onClick }: {
  tone: Tone; label: string; title: string; active: boolean;
  count?: string; loading?: boolean; onClick: () => void;
}) {
  const style = CHIP[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={[
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-all duration-150',
        active ? `border-transparent ${style.on}` : style.off,
      ].join(' ')}
    >
      {label}
      {loading && <span className="h-3 w-5 animate-pulse rounded-full bg-current opacity-30" />}
      {!loading && count !== undefined && (
        <span
          className={[
            'rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums transition-colors',
            active ? 'bg-white/25' : count === '0' ? 'bg-slate-100 text-slate-400' : 'bg-white/70',
          ].join(' ')}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function Ids({ intent }: { intent: IntentRow }) {
  const rows: { label: string; value: string | null; hint?: string }[] = [
    { label: 'Gateway payment id', value: intent.providerPaymentId, hint: 'Search Razorpay for this.' },
    { label: 'Gateway order id', value: intent.providerOrderId },
    { label: 'Intent id', value: intent.id },
    { label: 'Buyer (user id)', value: intent.userId },
    { label: 'Order id', value: intent.orderId },
  ];
  return (
    <div>
      <h4 className="mb-2 text-sm font-medium text-slate-700">Identifiers</h4>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100">
        {rows.map((r) => (
          <li key={r.label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
              {r.label}
              {r.hint && <span className="ml-1 font-normal normal-case tracking-normal text-slate-400">· {r.hint}</span>}
            </span>
            <span className="min-w-0 text-sm text-slate-800">
              <CopyValue value={r.value} label={r.label.toLowerCase()} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IntentDrawer({ intent, onClose }: { intent: IntentRow | null; onClose: () => void }) {
  const money = intent ? moneyState(intent) : null;
  const advice = intent ? moneyAdvice(intent) : null;

  return (
    <Drawer
      open={!!intent}
      onClose={onClose}
      title={intent ? `Payment · ${formatINR(intent.amount)}` : 'Payment'}
      width="max-w-2xl"
    >
      {intent && money && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={money.tone}>{money.label}</Badge>
            <Badge tone={intent.purpose === 'SHOP_ORDER' ? 'slate' : 'violet'}>{purposeLabel(intent.purpose)}</Badge>
            <StatusBadge value={intent.status} label={gatewayStatusLabel(intent.status)} />
          </div>

          {advice && (
            <p className={`rounded-lg border px-3 py-2 text-sm ${
              money.attention === 'act' ? 'border-red-200 bg-red-50 text-red-800' : 'border-slate-200 bg-slate-50 text-slate-600'
            }`}
            >
              {advice}
            </p>
          )}

          <DescList items={[
            { label: 'Amount', value: <span className="font-medium">{formatINR(intent.amount)}{intent.currency && intent.currency !== 'INR' ? ` ${intent.currency}` : ''}</span> },
            { label: 'Gateway', value: intent.provider || '—' },
            { label: 'Started', value: <span title={formatDateTime(intent.createdAt)}>{relativeTime(intent.createdAt)}</span> },
            { label: 'Last changed', value: <span title={formatDateTime(intent.updatedAt)}>{relativeTime(intent.updatedAt)}</span> },
            { label: 'Reconciled', value: intent.reconciledAt ? <span title={formatDateTime(intent.reconciledAt)}>{relativeTime(intent.reconciledAt)}</span> : <span className="text-slate-400">Not yet</span> },
          ]}
          />

          {(intent.failureReason || intent.reconcileNote) && (
            <div className="space-y-3">
              {intent.failureReason && (
                <div>
                  <h4 className="mb-1 text-sm font-medium text-slate-700">Failure reason</h4>
                  {/* Verbatim: the AUTO-REFUND FAILED prefix and the gateway's own
                      words are what an operator quotes back to Razorpay. */}
                  <p className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{intent.failureReason}</p>
                </div>
              )}
              {intent.reconcileNote && (
                <div>
                  <h4 className="mb-1 text-sm font-medium text-slate-700">Reconcile note</h4>
                  <p className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{intent.reconcileNote}</p>
                </div>
              )}
            </div>
          )}

          <Ids intent={intent} />
        </div>
      )}
    </Drawer>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PaymentIntentsPage() {
  const [view, setView] = useState('');
  const [purpose, setPurpose] = useState('');
  const [open, setOpen] = useState<IntentRow | null>(null);

  const params = useMemo(() => {
    // The two filters are independent and AND together: "rent payments that are
    // paid with no booking" is the question an operator actually has.
    //
    // `purpose || undefined` is not cosmetic — axios omits undefined but sends
    // an empty string as `purpose=`, which the route would then reject as an
    // invalid enum value. FilterSelect's "all" option IS the empty string.
    const purposeParam = purpose ? { purpose } : {};
    const queue = QUEUE_VIEWS.find((v) => v.value === view);
    if (queue) return { ...queue.params, ...purposeParam };
    if (view.startsWith('status:')) return { status: view.slice('status:'.length), ...purposeParam };
    return purposeParam;
  }, [view, purpose]);
  const list = useKeyset<IntentRow>('/admin/payment-intents', params);

  // Real totals for the chips, scoped by the same purpose filter as the list, so
  // a chip's number always matches the list clicking it opens. Fails soft: no
  // summary (older backend, transient error) means chips with no number.
  const summary = useQuery({
    queryKey: ['payment-intent-summary', purpose],
    queryFn: () => apiGet<IntentSummary>('/admin/payment-intents/summary', purpose ? { purpose } : undefined).then((r) => r.data),
    staleTime: 30_000,
    retry: 1,
  });
  const s = summary.data;

  const countFor = (v: QueueView) => (s ? formatQueueCount(s[v.summaryKey], s.cap) : undefined);
  const activeQueue = QUEUE_VIEWS.find((v) => v.value === view);

  // Who has to pick the orphan queue up. Null from the server means the queue was
  // too large to split cheaply — better no breakdown than a partial one.
  const split = s?.byPurpose
    ? Object.entries(s.byPurpose).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    : [];

  const busy = list.isFetching || summary.isFetching;
  const refresh = () => { list.refetch(); void summary.refetch(); };

  const columns: Column<IntentRow>[] = [
    // Money leads: it is the only column that says whether the row is anybody's
    // job. A row that needs a human carries the gateway's own words underneath.
    {
      key: 'money', header: 'Money',
      render: (i) => {
        const m = moneyState(i);
        const note = m.attention === 'act' ? i.failureReason : null;
        return (
          <div className="min-w-0">
            <Badge tone={m.tone}>
              {m.attention === 'act' && <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />}
              {m.label}
            </Badge>
            {note && <span className="mt-0.5 block max-w-xs truncate text-xs text-slate-500" title={note}>{note}</span>}
          </div>
        );
      },
      csv: (i) => moneyState(i).label,
    },
    { key: 'amount', header: 'Amount', render: (i) => <span className="font-medium tabular-nums">{formatINR(i.amount)}</span>, csv: (i) => String(i.amount) },
    // Rows written before PAY-001 carry the SHOP_ORDER default, so this column
    // is never blank; a purpose this build does not know shows its raw value
    // rather than being smoothed into something friendly and wrong.
    {
      key: 'purpose', header: 'For',
      render: (i) => <Badge tone={i.purpose === 'SHOP_ORDER' ? 'slate' : 'violet'}>{purposeLabel(i.purpose)}</Badge>,
      csv: (i) => i.purpose || 'SHOP_ORDER',
    },
    // Label humanised; the CSV keeps the raw enum for reconciliation against the DB.
    { key: 'status', header: 'Gateway status', render: (i) => <StatusBadge value={i.status} label={gatewayStatusLabel(i.status)} />, csv: (i) => i.status },
    {
      key: 'createdAt', header: 'Started',
      render: (i) => <span className="whitespace-nowrap text-slate-500" title={formatDateTime(i.createdAt)}>{relativeTime(i.createdAt)}</span>,
      csv: (i) => i.createdAt,
    },
    { key: 'userId', header: 'Buyer', render: (i) => <span className="font-mono text-xs text-slate-500">{i.userId.slice(0, 8)}</span>, csv: (i) => i.userId },
    {
      key: 'open', header: '',
      render: () => <ChevronRight className="h-4 w-4 text-slate-300" aria-hidden="true" />,
      csv: () => '',
    },

    // ── Exported, not drawn ──────────────────────────────────────────────────
    // Read in the detail panel; kept in the CSV because that is the artefact an
    // operator reconciles against the database. Raw values, never labels.
    { key: 'id', header: 'Intent id', csvOnly: true, csv: (i) => i.id },
    { key: 'orderId', header: 'Order id', csvOnly: true, csv: (i) => i.orderId || '' },
    { key: 'providerPaymentId', header: 'Gateway payment id', csvOnly: true, csv: (i) => i.providerPaymentId || '' },
    { key: 'providerOrderId', header: 'Gateway order id', csvOnly: true, csv: (i) => i.providerOrderId },
    { key: 'provider', header: 'Gateway', csvOnly: true, csv: (i) => i.provider || '' },
    { key: 'currency', header: 'Currency', csvOnly: true, csv: (i) => i.currency || '' },
    { key: 'failureReason', header: 'Failure reason', csvOnly: true, csv: (i) => i.failureReason || '' },
    { key: 'reconcileNote', header: 'Reconcile note', csvOnly: true, csv: (i) => i.reconcileNote || '' },
    { key: 'reconciledAt', header: 'Reconciled at', csvOnly: true, csv: (i) => i.reconciledAt || '' },
  ];

  return (
    <div>
      <PageHeader
        title="Payment intents"
        subtitle="Gateway payments and where the money stands, across every product area. A red row is money the buyer has not got back — an auto-refund failure must be refunded by hand in the Razorpay dashboard."
        actions={
          <Button variant="secondary" onClick={refresh} disabled={busy} title="Re-read the queue and its totals">
            <RefreshCw className={`h-4 w-4 transition-transform ${busy ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        }
      />

      <div className="card mb-3 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Queue">
            <Chip
              tone="slate"
              label="All intents"
              title="Every payment intent, newest first."
              active={!activeQueue && !view.startsWith('status:')}
              onClick={() => setView('')}
            />
            {QUEUE_VIEWS.map((v) => (
              <Chip
                key={v.value}
                tone={v.tone}
                label={v.label}
                title={v.description}
                active={view === v.value}
                count={countFor(v)}
                loading={summary.isLoading}
                onClick={() => setView(view === v.value ? '' : v.value)}
              />
            ))}
          </div>
          {/* The chips and the status select are ONE axis — which rows — so they
              share `view`: picking a status drops the chip and vice versa. */}
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect label="For" value={purpose} onChange={setPurpose} options={PURPOSE_OPTIONS} allLabel="All product areas" />
            <FilterSelect
              label="Status"
              value={view.startsWith('status:') ? view : ''}
              onChange={setView}
              options={STATUS_OPTIONS}
              allLabel="Any status"
            />
          </div>
        </div>

        {/* Only meaningful text under the chips: who picks the open queue up.
            Silent when the server could not split it, rather than guessing. */}
        {split.length > 0 && (
          <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-500">
            <span className="font-medium text-slate-600">Paid with no order, by area:</span>{' '}
            {split.map(([p, n]) => `${purposeLabel(p)} ${n}`).join(' · ')}
          </p>
        )}
        {summary.error != null && (
          <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-400">
            Queue totals unavailable right now — the chips and filters still work, they just cannot say how many.
          </p>
        )}
      </div>

      <DataTable
        columns={columns}
        items={list.items}
        rowKey={(i) => i.id}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        error={list.error}
        onRowClick={(i) => setOpen(i)}
        // A row only a person can move: tinted, and barred down the left edge so
        // it is findable in peripheral vision. `!` on the hover colour because
        // DataTable's own hover:bg-slate-50 has equal specificity and happens to
        // sort later in the generated stylesheet — it would win a tie and wash
        // the mark out exactly when the operator points at it.
        rowClassName={(i) => (moneyState(i).attention === 'act'
          ? 'bg-red-50/70 hover:!bg-red-100/60 [&>td:first-child]:border-l-2 [&>td:first-child]:border-l-red-500'
          : undefined)}
        stickyHeader
        page={list.page}
        canPrev={list.canPrev}
        canNext={list.canNext}
        onPrev={list.prev}
        onNext={list.next}
        exportName="payment-intents"
        emptyMessage={activeQueue ? activeQueue.emptyLabel : 'No payment intents match this view.'}
      />

      <IntentDrawer intent={open} onClose={() => setOpen(null)} />
    </div>
  );
}
