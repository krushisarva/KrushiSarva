/** Accessible modal dialog: backdrop, ESC to close, focus on open, aria-modal. */
import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './ui';

/**
 * Open/close behaviour shared by Modal and Drawer: Escape closes, and focus moves
 * into the panel so the keyboard lands where the eye does and Tab walks the
 * panel rather than the page behind it.
 *
 * `onClose` is read through a ref so the effect runs only when `open` changes.
 * Most callers pass an inline `onClose`; with it in the dependency list the
 * effect re-ran on every parent render — every keystroke, where the parent holds
 * the field's state — and pulled focus out of the field being typed in.
 */
function useDialogPanel(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    // An autoFocus field inside the panel has already taken focus; leave it there.
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return ref;
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useDialogPanel(open, onClose);

  if (!open) return null;
  const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-lg';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      {/* The panel is only where focus lands when the dialog opens — not a
          control. No ring: opened from the keyboard it drew a second border
          round the whole card. The controls inside keep theirs. */}
      <div ref={ref} tabIndex={-1} className={`card relative z-10 w-full ${width} max-h-[90vh] overflow-y-auto focus-visible:ring-0 focus-visible:ring-offset-0`}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Right-hand detail drawer (used for row → detail views). */
export function Drawer({ open, onClose, title, children, width = 'max-w-xl' }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; width?: string;
}) {
  const ref = useDialogPanel(open, onClose);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div ref={ref} tabIndex={-1} className={`absolute right-0 top-0 h-full w-full ${width} overflow-y-auto bg-white shadow-xl focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0`}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></Button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
