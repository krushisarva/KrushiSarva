import { useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { apiGet, apiPost, errorMessage } from '../lib/api';
import { PageHeader, Card, Button, Badge, StatusBadge, Spinner, ErrorState, Field, Textarea, Select, CopyValue } from '../components/ui';
import { Toolbar, FilterSelect, DescList } from '../components/filters';
import { Drawer } from '../components/Modal';
import { useConfirm } from '../components/confirm';
import { useToast } from '../lib/toast';
import { formatDateTime, relativeTime, titleCase } from '../lib/format';

// Hand-built tables on this page open a drawer from the row. Same contract as
// DataTable rows: focusable, outlined on focus (with the app-wide ring switched
// off, or the row shows two green lines), and Enter/Space on the row itself
// opens it.
const CLICKABLE_ROW = 'cursor-pointer hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-700 focus-visible:ring-0 focus-visible:ring-offset-0';
const onRowKey = (open: () => void) => (e: KeyboardEvent<HTMLTableRowElement>) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
};

// ── Moderation ────────────────────────────────────────────────────────────────
interface Flag { id: string; entityType: string; entityId: string; authorId?: string | null; reasons: string[]; score: number; status: string; createdAt: string; reviewedAt?: string | null; resolution?: string | null }

/** One person's report, newest first (GET /admin/moderation/:id → report.reports). */
interface ReportEntry { reporterId: string; reporterName: string | null; reason: string; details: string | null; clientTargetId?: string; at: string }
interface ReportSummary {
  reporterCount: number;
  snapshot: string | null;
  snapshotSource: 'server' | 'client' | null;
  author: { id: string; name: string | null } | null;
  reports: ReportEntry[];
  previousResolutions: { status: string; note: string | null; reviewedAt: string | null }[];
}
interface FlagDetail { flag: Flag; entity: unknown; report: ReportSummary | null }
/** An animal listing's own report rows (entity.reports), some filed before the queue mirrored them. */
interface ListingReportRow { reason: string; details: string | null; status: string; createdAt: string; reporter: { id: string; name: string | null } | null }

// Review/Product come from the fraud signals (score = signal strength). Every
// other type is a user report (score = number of distinct reporters).
const FRAUD_SIGNAL_TYPES = ['Review', 'Product'];
const ENTITY_TYPE_LABELS: Record<string, string> = {
  AI_MESSAGE: 'AI chat reply',
  AI_VOICE_MESSAGE: 'AI voice reply',
  AI_DIAGNOSIS: 'AI crop-scan result',
  USER: 'User',
  CHAT_MESSAGE: 'Chat message',
  AnimalListing: 'Animal listing',
  MACHINERY_LISTING: 'Machinery listing',
  LABOUR_LISTING: 'Labour listing',
  PRODUCT_REVIEW: 'Product review',
  // Seller app: a farmer's scan photos and note, shared with a Krushi Seva Kendra.
  CROP_REPORT_SHARE: 'Shared crop report',
  Review: 'Review (fraud signal)',
  Product: 'Product (fraud signal)',
};
const isUserReport = (entityType: string) => !FRAUD_SIGNAL_TYPES.includes(entityType);
const typeLabel = (entityType: string) => ENTITY_TYPE_LABELS[entityType] ?? entityType;
const reasonLabel = (reason: string) => titleCase(reason.replace(/^user_report:/, ''));

function UserRef({ id, name }: { id: string; name: string | null }) {
  return <Link to={`/users/${id}`} className="font-medium text-brand-700 hover:underline">{name || id}</Link>;
}

export function ModerationPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [status, setStatus] = useState('PENDING');
  const [entityType, setEntityType] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  // The API reads a missing status as PENDING, so "All" has to be asked for.
  const q = useQuery({ queryKey: ['moderation', status, entityType], queryFn: () => apiGet<{ flags: Flag[] }>('/admin/moderation', { status: status || 'ALL', entityType: entityType || undefined, limit: 100 }).then((r) => r.data.flags) });
  const detail = useQuery({ queryKey: ['flag', openId], queryFn: () => apiGet<FlagDetail>(`/admin/moderation/${openId}`).then((r) => r.data), enabled: !!openId });

  const resolve = useMutation({
    mutationFn: (vars: { status: 'APPROVED' | 'REJECTED'; note: string }) => apiPost(`/admin/moderation/${openId}/resolve`, vars),
    onSuccess: () => { toast.success('Flag resolved'); setOpenId(null); qc.invalidateQueries({ queryKey: ['moderation'] }); qc.invalidateQueries({ queryKey: ['flag'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const onResolve = async (decision: 'APPROVED' | 'REJECTED', userReport: boolean) => {
    const { confirmed, reason } = await confirm(userReport ? {
      title: decision === 'APPROVED' ? 'Dismiss this report?' : 'Uphold this report?',
      message: decision === 'APPROVED'
        ? 'The content stays as it is. A report from someone new puts it back in the queue.'
        : 'This records the violation. Remove the content or suspend the account from its own admin page.',
      tone: decision === 'REJECTED' ? 'danger' : 'default',
      reasonLabel: 'Moderator note (optional)',
      confirmLabel: decision === 'APPROVED' ? 'Dismiss' : 'Uphold',
    } : {
      title: decision === 'APPROVED' ? 'Approve (keep) content?' : 'Reject (remove) content?',
      tone: decision === 'REJECTED' ? 'danger' : 'default',
      reasonLabel: 'Moderator note (optional)',
      confirmLabel: decision === 'APPROVED' ? 'Approve' : 'Reject',
    });
    if (confirmed) resolve.mutate({ status: decision, note: reason });
  };

  const d = detail.data;
  const report = d?.report ?? null;
  const userReport = d ? isUserReport(d.flag.entityType) : false;
  // Animal-listing reports filed before they were mirrored here exist only on the listing.
  const mirrored = new Set((report?.reports ?? []).map((r) => r.reporterId));
  const earlierListingReports = d?.flag.entityType === 'AnimalListing'
    ? ((d.entity as { reports?: ListingReportRow[] } | null)?.reports ?? []).filter((r) => !r.reporter || !mirrored.has(r.reporter.id))
    : [];

  return (
    <div>
      <PageHeader title="Moderation queue" subtitle="Content reported by users, and content flagged by the fraud/abuse signals." />
      <Toolbar>
        <FilterSelect label="Status" value={status} onChange={setStatus} options={['PENDING', 'APPROVED', 'REJECTED'].map((s) => ({ label: s, value: s }))} allLabel="All" />
        <FilterSelect label="Type" value={entityType} onChange={setEntityType} options={Object.entries(ENTITY_TYPE_LABELS).map(([value, label]) => ({ label, value }))} />
      </Toolbar>
      {q.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> : q.error ? <ErrorState message="Failed to load queue." /> : (
        <Card className="overflow-hidden">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr><th className="table-th">Type</th><th className="table-th">Reasons</th><th className="table-th">Reporters / score</th><th className="table-th">Status</th><th className="table-th">Flagged</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(q.data ?? []).map((f) => (
                <tr key={f.id} className={CLICKABLE_ROW} tabIndex={0} onClick={() => setOpenId(f.id)} onKeyDown={onRowKey(() => setOpenId(f.id))}>
                  <td className="table-td"><Badge tone={isUserReport(f.entityType) ? 'blue' : 'slate'}>{typeLabel(f.entityType)}</Badge></td>
                  <td className="table-td">{f.reasons.map((r) => <Badge key={r} tone="amber" className="mr-1">{reasonLabel(r)}</Badge>)}</td>
                  <td className="table-td font-medium">{isUserReport(f.entityType) ? `${f.score} reporter${f.score === 1 ? '' : 's'}` : `Score ${f.score}`}</td>
                  <td className="table-td"><StatusBadge value={f.status} /></td>
                  <td className="table-td text-xs text-slate-500">{relativeTime(f.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(q.data ?? []).length === 0 && <p className="py-10 text-center text-sm text-slate-500">Queue is clear.</p>}
        </Card>
      )}

      <Drawer open={!!openId} onClose={() => setOpenId(null)} title={userReport ? 'User report' : 'Flagged content'} width="max-w-2xl">
        {detail.isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
        {detail.error && <ErrorState message="Failed to load this flag." />}
        {d && (
          <div className="space-y-5">
            <DescList items={[
              { label: 'Type', value: <Badge tone={userReport ? 'blue' : 'slate'}>{typeLabel(d.flag.entityType)}</Badge> },
              { label: 'Status', value: <StatusBadge value={d.flag.status} /> },
              userReport ? { label: 'Reporters', value: report?.reporterCount ?? d.flag.score } : { label: 'Score', value: d.flag.score },
              { label: 'Reasons', value: d.flag.reasons.map(reasonLabel).join(', ') || '—' },
              { label: 'Author', value: report?.author ? <UserRef id={report.author.id} name={report.author.name} /> : (d.flag.authorId ? <UserRef id={d.flag.authorId} name={null} /> : <span className="text-slate-500">Not known (AI content or no stored author)</span>) },
              { label: 'Content id', value: d.flag.entityId.startsWith('snap_') ? <span className="text-slate-500">None — keyed on the reported text</span> : <CopyValue value={d.flag.entityId} label="content id" /> },
              { label: 'First flagged', value: formatDateTime(d.flag.createdAt) },
              ...(d.flag.reviewedAt ? [{ label: 'Resolved', value: `${formatDateTime(d.flag.reviewedAt)}${d.flag.resolution ? ` — ${d.flag.resolution}` : ''}` }] : []),
            ]} />

            {report && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium text-slate-700">Reported content</h4>
                  {report.snapshotSource && (
                    <Badge tone={report.snapshotSource === 'server' ? 'green' : 'amber'}>
                      {report.snapshotSource === 'server' ? 'Stored content (verified)' : 'As sent by the reporter (unverified)'}
                    </Badge>
                  )}
                </div>
                <Card className="bg-slate-50 p-3">
                  {report.snapshot
                    ? <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{report.snapshot}</p>
                    : <p className="text-sm text-slate-500">No text was captured with this report.</p>}
                </Card>
              </div>
            )}

            {report && (
              <div>
                <h4 className="mb-2 text-sm font-medium text-slate-700">
                  Reports ({report.reports.length}{report.reports.length < report.reporterCount ? ` newest of ${report.reporterCount}` : ''})
                </h4>
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
                  {report.reports.map((r) => (
                    <li key={`${r.reporterId}-${r.at}`} className="space-y-1 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <UserRef id={r.reporterId} name={r.reporterName} />
                        <Badge tone="amber">{reasonLabel(r.reason)}</Badge>
                        <span className="text-xs text-slate-500" title={formatDateTime(r.at)}>{relativeTime(r.at)}</span>
                      </div>
                      {r.details && <p className="whitespace-pre-wrap break-words text-slate-600">{r.details}</p>}
                      {r.clientTargetId && <p className="text-xs text-slate-500">App-side id (not matched on the server): <span className="font-mono">{r.clientTargetId}</span></p>}
                    </li>
                  ))}
                  {report.reports.length === 0 && <li className="px-3 py-2 text-slate-500">No report entries recorded.</li>}
                </ul>
              </div>
            )}

            {earlierListingReports.length > 0 && (
              <div>
                <h4 className="mb-2 text-sm font-medium text-slate-700">Earlier reports on this listing ({earlierListingReports.length})</h4>
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
                  {earlierListingReports.map((r, i) => (
                    <li key={r.reporter?.id ?? i} className="space-y-1 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {r.reporter ? <UserRef id={r.reporter.id} name={r.reporter.name} /> : <span className="text-slate-500">Unknown reporter</span>}
                        <Badge tone="amber">{reasonLabel(r.reason.toLowerCase())}</Badge>
                        <StatusBadge value={r.status} />
                        <span className="text-xs text-slate-500" title={formatDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span>
                      </div>
                      {r.details && <p className="whitespace-pre-wrap break-words text-slate-600">{r.details}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report && report.previousResolutions.length > 0 && (
              <div>
                <h4 className="mb-2 text-sm font-medium text-slate-700">Earlier decisions (re-opened by a new reporter)</h4>
                <ul className="space-y-1 text-sm">
                  {report.previousResolutions.map((p, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <StatusBadge value={p.status} />
                      <span className="text-xs text-slate-500">{p.reviewedAt ? formatDateTime(p.reviewedAt) : '—'}</span>
                      {p.note && <span className="text-slate-600">{p.note}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {userReport ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-slate-600">Stored record now{d.entity ? '' : ' (none)'}</summary>
                <Card className="mt-2 bg-slate-50 p-3">
                  {d.entity
                    ? <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-slate-600">{JSON.stringify(d.entity, null, 2)}</pre>
                    : <p className="text-xs text-slate-500">No stored row: an AI reply known only by its text, or the content has been deleted.</p>}
                </Card>
              </details>
            ) : (
              <Card className="bg-slate-50 p-3 text-sm">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-slate-600">{JSON.stringify(d.entity, null, 2)}</pre>
              </Card>
            )}

            {d.flag.status === 'PENDING' && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Button variant="primary" className="flex-1" onClick={() => onResolve('APPROVED', userReport)} loading={resolve.isPending}><Check className="h-4 w-4" /> {userReport ? 'Dismiss (no violation)' : 'Approve'}</Button>
                  <Button variant="danger" className="flex-1" onClick={() => onResolve('REJECTED', userReport)} loading={resolve.isPending}><X className="h-4 w-4" /> {userReport ? 'Uphold (violation)' : 'Reject'}</Button>
                </div>
                {userReport && <p className="text-xs text-slate-500">Resolving records the decision only. Remove the content or suspend the author from its own admin page.</p>}
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

// ── Fraud clusters ────────────────────────────────────────────────────────────
interface Cluster { fingerprint: string; accountCount: number; accounts: { userId: string; lastSeenAt: string; seenCount: number; lastContext: string | null }[] }

export function FraudPage() {
  const [days, setDays] = useState('30');
  const [min, setMin] = useState('3');
  const [expanded, setExpanded] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['fraud', days, min], queryFn: () => apiGet<{ clusters: Cluster[] }>('/admin/fraud/device-clusters', { days, minAccounts: min, limit: 100 }).then((r) => r.data.clusters) });

  return (
    <div>
      <PageHeader title="Fraud — device clusters" subtitle="Devices backing many accounts (multi-account signal)." />
      <Toolbar>
        <FilterSelect label="Window" value={days} onChange={setDays} options={[{ label: '7 days', value: '7' }, { label: '30 days', value: '30' }, { label: '90 days', value: '90' }]} allLabel="30 days" />
        <FilterSelect label="Min accounts" value={min} onChange={setMin} options={[{ label: '2+', value: '2' }, { label: '3+', value: '3' }, { label: '5+', value: '5' }]} allLabel="3+" />
      </Toolbar>
      {q.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> : q.error ? <ErrorState message="Failed to load clusters." /> : (
        <div className="space-y-2">
          {(q.data ?? []).map((c) => (
            <Card key={c.fingerprint} className="overflow-hidden">
              <button className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => setExpanded(expanded === c.fingerprint ? null : c.fingerprint)}>
                <div className="flex items-center gap-3">
                  {expanded === c.fingerprint ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <span className="font-mono text-xs text-slate-500">{c.fingerprint}</span>
                </div>
                <Badge tone={c.accountCount >= 5 ? 'red' : 'amber'}>{c.accountCount} accounts</Badge>
              </button>
              {expanded === c.fingerprint && (
                <ul className="divide-y divide-slate-100 border-t border-slate-100 text-sm">
                  {c.accounts.map((a) => (
                    <li key={a.userId} className="flex items-center justify-between px-4 py-2">
                      <span className="font-mono text-xs">{a.userId}</span>
                      <span className="text-slate-500">{a.lastContext} · {a.seenCount}× · {relativeTime(a.lastSeenAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
          {(q.data ?? []).length === 0 && <p className="py-10 text-center text-sm text-slate-500">No clusters above the threshold.</p>}
        </div>
      )}
    </div>
  );
}

// ── Incidents ─────────────────────────────────────────────────────────────────
interface Incident {
  id: string; reference: string; title: string; category: string; severity: string; status: string; createdAt: string;
  notificationRequired: boolean; notifyDueAt: string | null; boardNotifiedAt: string | null; usersNotifiedAt: string | null;
  description?: string | null; affectedUserCount?: number | null; updates?: { id: string; note: string; statusTo: string | null; createdAt: string }[];
}
const INC_STATUS = ['OPEN', 'INVESTIGATING', 'CONTAINED', 'RESOLVED', 'CLOSED'];

export function IncidentsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [overdue, setOverdue] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [statusTo, setStatusTo] = useState('');

  const q = useQuery({ queryKey: ['incidents', status, overdue], queryFn: () => apiGet<{ incidents: Incident[] }>('/admin/incidents', { status: status || undefined, overdue: overdue || undefined }).then((r) => r.data.incidents) });
  const detail = useQuery({ queryKey: ['incident', openId], queryFn: () => apiGet<Incident>(`/admin/incidents/${openId}`).then((r) => r.data), enabled: !!openId });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['incidents'] }); qc.invalidateQueries({ queryKey: ['incident', openId] }); };
  const addUpdate = useMutation({ mutationFn: () => apiPost(`/admin/incidents/${openId}/updates`, { note, statusTo: statusTo || undefined }), onSuccess: () => { toast.success('Update added'); setNote(''); setStatusTo(''); refresh(); }, onError: (e) => toast.error(errorMessage(e)) });
  const notify = useMutation({ mutationFn: (target: 'board' | 'users') => apiPost(`/admin/incidents/${openId}/notify`, { target }), onSuccess: () => { toast.success('Notification recorded'); refresh(); }, onError: (e) => toast.error(errorMessage(e)) });

  const isOverdue = (i: Incident) => i.notificationRequired && !i.boardNotifiedAt && i.notifyDueAt && new Date(i.notifyDueAt) < new Date();

  return (
    <div>
      <PageHeader title="Security incidents" subtitle="Incident manager with DPDP breach-notification SLA tracking." />
      <Toolbar>
        <FilterSelect label="Status" value={status} onChange={setStatus} options={INC_STATUS.map((s) => ({ label: s, value: s }))} />
        <FilterSelect label="SLA" value={overdue} onChange={setOverdue} options={[{ label: 'Overdue only', value: 'true' }]} allLabel="All" />
      </Toolbar>
      {q.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> : q.error ? <ErrorState message="Failed to load incidents." /> : (
        <Card className="overflow-hidden">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50"><tr><th className="table-th">Ref</th><th className="table-th">Title</th><th className="table-th">Severity</th><th className="table-th">Status</th><th className="table-th">Breach SLA</th><th className="table-th">Opened</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(q.data ?? []).map((i) => (
                <tr key={i.id} className={CLICKABLE_ROW} tabIndex={0} onClick={() => setOpenId(i.id)} onKeyDown={onRowKey(() => setOpenId(i.id))}>
                  <td className="table-td font-mono text-xs">{i.reference}</td>
                  <td className="table-td font-medium">{i.title}</td>
                  <td className="table-td"><StatusBadge value={i.severity} /></td>
                  <td className="table-td"><StatusBadge value={i.status} /></td>
                  <td className="table-td">{i.notificationRequired ? (isOverdue(i) ? <Badge tone="red"><AlertTriangle className="mr-1 inline h-3 w-3" />Overdue</Badge> : i.boardNotifiedAt ? <Badge tone="green">Notified</Badge> : <Badge tone="amber">Due {relativeTime(i.notifyDueAt)}</Badge>) : <span className="text-slate-500">—</span>}</td>
                  <td className="table-td text-xs text-slate-500">{relativeTime(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(q.data ?? []).length === 0 && <p className="py-10 text-center text-sm text-slate-500">No incidents.</p>}
        </Card>
      )}

      <Drawer open={!!openId} onClose={() => setOpenId(null)} title={detail.data?.reference || 'Incident'} width="max-w-2xl">
        {detail.isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
        {detail.data && (
          <div className="space-y-5">
            <div>
              <h3 className="text-base font-semibold">{detail.data.title}</h3>
              <p className="mt-1 text-sm text-slate-500">{detail.data.description || 'No description.'}</p>
            </div>
            <DescList items={[
              { label: 'Severity', value: <StatusBadge value={detail.data.severity} /> },
              { label: 'Status', value: <StatusBadge value={detail.data.status} /> },
              { label: 'Category', value: detail.data.category },
              { label: 'Affected users', value: detail.data.affectedUserCount ?? '—' },
              { label: 'Notify due', value: detail.data.notifyDueAt ? formatDateTime(detail.data.notifyDueAt) : '—' },
              { label: 'Board notified', value: detail.data.boardNotifiedAt ? formatDateTime(detail.data.boardNotifiedAt) : 'No' },
            ]} />

            {detail.data.notificationRequired && (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => notify.mutate('board')} disabled={!!detail.data.boardNotifiedAt}>Notify Board</Button>
                <Button variant="secondary" onClick={() => notify.mutate('users')} disabled={!!detail.data.usersNotifiedAt}>Notify users</Button>
              </div>
            )}

            <div>
              <h4 className="mb-2 text-sm font-medium text-slate-700">Timeline</h4>
              <ul className="space-y-2 border-l-2 border-slate-100 pl-4 text-sm">
                {(detail.data.updates ?? []).map((u) => (
                  <li key={u.id}>
                    <div className="flex items-center gap-2">
                      {u.statusTo && <StatusBadge value={u.statusTo} />}
                      <span className="text-xs text-slate-500">{formatDateTime(u.createdAt)}</span>
                    </div>
                    <p className="text-slate-600">{u.note}</p>
                  </li>
                ))}
                {(detail.data.updates ?? []).length === 0 && <li className="text-slate-500">No updates yet.</li>}
              </ul>
            </div>

            <div className="space-y-2 border-t border-slate-100 pt-4">
              <Field label="Add timeline note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed?" /></Field>
              <div className="flex items-center gap-2">
                <Select value={statusTo} onChange={(e) => setStatusTo(e.target.value)} className="flex-1" aria-label="Incident status"><option value="">Keep status</option>{INC_STATUS.map((s) => <option key={s} value={s}>Set: {s}</option>)}</Select>
                <Button variant="primary" disabled={!note.trim()} loading={addUpdate.isPending} onClick={() => addUpdate.mutate()}>Add</Button>
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
