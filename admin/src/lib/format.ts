/** Small display formatters shared across screens. */

export function formatDate(value?: string | Date | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: '2-digit' });
}

export function formatDateTime(value?: string | Date | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(value?: string | Date | null): string {
  if (!value) return '—';
  const d = new Date(value).getTime();
  if (Number.isNaN(d)) return '—';
  const diff = Date.now() - d;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatDate(value);
}

export function formatINR(value?: number | string | null): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

export function formatNumber(value?: number | string | null): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-IN').format(n);
}

export function formatUsd(value?: number | string | null, digits = 2): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(digits)}`;
}

/**
 * Suffix for the toast after a KYC rejection / account deactivation / seller
 * demotion: the backend pulls that seller's live offers in the same transaction
 * and returns `listingsDeactivated`. Empty when nothing was pulled, so it
 * appends cleanly to any success message.
 */
export function offersPulledNote(count?: number | null): string {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return ` — ${n} ${n === 1 ? 'offer' : 'offers'} taken off sale`;
}

// ── Delivery address ────────────────────────────────────────────────────
// `Order.deliveryAddress` is a JSON blob, not columns. Checkout copies a saved
// address (backend agristore.routes.js `resolveDeliveryAddress`), so the shape is
// { type, name, phone, flat, street, landmark, city, state, pincode } — the same
// keys as the SavedAddress model, `landmark` only when the seller filled it in.
// An INLINE address is spread through verbatim, so unrecognised keys are possible;
// an account erased under DPDP leaves exactly { redacted: true }
// (backend erasure.service.js). Support reads this out to a courier, so nothing
// may be dropped: every known part gets its own line and anything unrecognised is
// appended verbatim. The phone arrives already masked by the admin route.

/** One rendered address line. `key` lets the caller style name/phone differently. */
export interface AddressLine { key: string; text: string }

export interface DeliveryAddressView {
  /** HOME / WORK / … when present, for the heading. */
  type: string;
  /** The whole address was erased under a DPDP request. */
  redacted: boolean;
  lines: AddressLine[];
  /** `key: value` for keys this build does not know — shown rather than dropped. */
  extras: string[];
  /** Nothing at all to show (and not redacted) — caller shows a placeholder. */
  empty: boolean;
}

/** Keys rendered explicitly; everything else on the blob falls through to `extras`. */
const ADDRESS_KEYS = ['type', 'name', 'phone', 'flat', 'street', 'landmark', 'city', 'state', 'pincode', 'redacted'];

/** Assemble a delivery-address blob into ordered, printable lines. Pure. */
export function deliveryAddressLines(addr?: Record<string, unknown> | null): DeliveryAddressView {
  const a = addr && typeof addr === 'object' ? addr : {};
  const f = (key: string) => { const v = a[key]; return v == null || v === '' ? '' : String(v); };
  const redacted = a.redacted === true;

  const extras = redacted ? [] : Object.entries(a)
    .filter(([k, v]) => !ADDRESS_KEYS.includes(k) && v != null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);

  const lines: AddressLine[] = [];
  if (!redacted) {
    const push = (key: string, text: string) => { if (text) lines.push({ key, text }); };
    push('name', f('name'));
    push('phone', f('phone'));
    push('street', [f('flat'), f('street')].filter(Boolean).join(', '));
    push('landmark', f('landmark') ? `Landmark: ${f('landmark')}` : '');
    const region = [f('city'), f('state')].filter(Boolean).join(', ');
    // A PIN with no city/state still has to reach the courier.
    push('region', region ? (f('pincode') ? `${region} — ${f('pincode')}` : region) : (f('pincode') ? `PIN ${f('pincode')}` : ''));
  }

  return { type: f('type'), redacted, lines, extras, empty: !redacted && lines.length === 0 && extras.length === 0 };
}

export function titleCase(s?: string | null): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
