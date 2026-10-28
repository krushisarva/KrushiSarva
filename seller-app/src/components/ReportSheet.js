/**
 * ReportSheet — the seller app's copy of the shared sheet
 * (shared/components/ReportSheet.js, which the farmer app uses too), thanking
 * the seller with this app's toast instead of a system alert.
 *
 * Google Play's user-content rule: wherever this app shows something another
 * person wrote — a buyer's review, a farmer's shared crop report — the seller
 * can report it. Usage, one sheet per screen:
 *
 *   const [reportTarget, setReportTarget] = useState(null);
 *   <ReportSheet target={reportTarget} onClose={() => setReportTarget(null)} />
 */
import { useCallback } from 'react';
import SharedReportSheet from '@krushisarva/shared/components/ReportSheet';
import { useToast } from './ui';

export default function ReportSheet(props) {
  const toast = useToast();
  // A toast is one line: the body ("Your report has been sent…") says it all.
  const thank = useCallback((title, message) => toast.success(message), [toast]);
  return <SharedReportSheet onThanks={thank} {...props} />;
}
