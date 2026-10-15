/**
 * ReportSheet — the farmer app's copy of the shared sheet
 * (shared/components/ReportSheet.js, which the seller app uses too), thanking
 * the farmer with this app's in-app pop-up. Every import of this file keeps
 * working: the default export and the named helpers are the shared ones.
 */
import SharedReportSheet from '@krushisarva/shared/components/ReportSheet';
import { showPopup } from '../utils/popup';

export {
  REPORT_MAX_DETAILS, REPORT_MAX_SNAPSHOT, REPORT_REASONS, reportPayload, submitReport,
} from '@krushisarva/shared/components/ReportSheet';

export default function ReportSheet(props) {
  return <SharedReportSheet onThanks={showPopup} {...props} />;
}
