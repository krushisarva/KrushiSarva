/**
 * Client-side CSV export of the CURRENTLY LOADED, already-masked rows.
 *
 * The admin API masks PII by default, so what the table holds is safe to export —
 * raw decrypted PII only ever exists transiently behind an audited reveal and is
 * never part of a list payload. Callers pass plain string cells (no objects).
 */
function escapeCell(value: string): string {
  // A cell starting with = + - @ is a formula to Excel/Sheets, and these cells
  // hold text users typed (names, dispute reasons, post titles). Prefix a quote
  // so it stays text; plain numbers such as a negative amount are left alone.
  const risky = /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value);
  const v = risky ? `'${value}` : value;
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const lines = [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
