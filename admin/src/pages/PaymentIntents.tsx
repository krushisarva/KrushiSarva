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
 */
import { useMemo, useState } from 'react';
import { useKeyset } from '../lib/useKeyset';
import { PageHeader, Badge, StatusBadge } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Toolbar, FilterSelect } from '../components/filters';
import { formatINR, formatDateTime } from '../lib/format';
import { INTENT_STATUSES, gatewayStatusLabel, moneyState } from '../lib/paymentState';

const VIEWS = [
  { label: 'Paid with no order (open queue)', value: 'orphaned' },
  { label: 'Auto-refund FAILED — refund by hand', value: 'refundFailed' },
  ...INTENT_STATUSES.map((s) => ({ label: `Status: ${gatewayStatusLabel(s)}`, value: `status:${s}` })),
];

interface IntentRow {
  id: string; userId: string; provider: string; providerOrderId: string; providerPaymentId: string | null;
  amount: number | string; currency: string; status: string; orderId: string | null;
  failureReason: string | null; reconciledAt: string | null; reconcileNote: string | null; createdAt: string;
}

export default function PaymentIntentsPage() {
  const [view, setView] = useState('');

  const params = useMemo(() => {
    if (view === 'orphaned') return { orphaned: true };
    if (view === 'refundFailed') return { refundFailed: true };
    if (view.startsWith('status:')) return { status: view.slice('status:'.length) };
    return {};
  }, [view]);
  const list = useKeyset<IntentRow>('/admin/payment-intents', params);

  const columns: Column<IntentRow>[] = [
    { key: 'createdAt', header: 'Started', render: (i) => formatDateTime(i.createdAt), csv: (i) => i.createdAt },
    { key: 'userId', header: 'Buyer', render: (i) => <span className="font-mono text-xs">{i.userId.slice(0, 8)}</span>, csv: (i) => i.userId },
    { key: 'amount', header: 'Amount', render: (i) => formatINR(i.amount), csv: (i) => String(i.amount) },
    {
      key: 'money', header: 'Money',
      render: (i) => { const s = moneyState(i); return <Badge tone={s.tone}>{s.label}</Badge>; },
      csv: (i) => moneyState(i).label,
    },
    // Label humanised; the CSV keeps the raw enum for reconciliation against the DB.
    { key: 'status', header: 'Gateway status', render: (i) => <StatusBadge value={i.status} label={gatewayStatusLabel(i.status)} />, csv: (i) => i.status },
    { key: 'orderId', header: 'Order', render: (i) => (i.orderId ? <span className="font-mono text-xs">{i.orderId.slice(0, 8)}</span> : <span className="text-slate-400">none</span>), csv: (i) => i.orderId || '' },
    {
      key: 'note', header: 'Why',
      render: (i) => {
        const note = i.failureReason || i.reconcileNote;
        return note ? <span className="block max-w-xs truncate text-xs text-slate-500" title={note}>{note}</span> : <span className="text-slate-400">—</span>;
      },
      csv: (i) => i.failureReason || i.reconcileNote || '',
    },
    { key: 'providerPaymentId', header: 'Gateway payment', render: (i) => <span className="font-mono text-xs">{i.providerPaymentId || i.providerOrderId}</span>, csv: (i) => i.providerPaymentId || i.providerOrderId },
  ];

  return (
    <div>
      <PageHeader
        title="Payment intents"
        subtitle="Gateway payments and where the money stands. A red row is money the buyer has not got back — an auto-refund failure must be refunded by hand in the Razorpay dashboard."
      />
      <Toolbar>
        <FilterSelect label="View" value={view} onChange={setView} options={VIEWS} allLabel="All intents" />
      </Toolbar>
      <DataTable
        columns={columns}
        items={list.items}
        rowKey={(i) => i.id}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        error={list.error}
        page={list.page}
        canPrev={list.canPrev}
        canNext={list.canNext}
        onPrev={list.prev}
        onNext={list.next}
        exportName="payment-intents"
        emptyMessage="No payment intents match this view."
      />
    </div>
  );
}
