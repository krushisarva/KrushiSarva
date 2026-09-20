/**
 * Where a tapped push notification takes the seller — no React, no React
 * Native, so frontend/jest.config.js can test it without a renderer.
 *
 * The backend has been sending the ids all along and the app ignored them: a
 * new crop report pushes `{ kind: 'crop_report_share', shareId, reportId }`
 * (cropReportShare.routes.js), and tapping it opened the dashboard, leaving the
 * seller to find the report in the inbox by hand.
 *
 * A notification payload is NOT trusted input — anything that can mint a push
 * for this project can choose its `data`. So this is an allowlist of kinds, and
 * every id is shape-checked before it reaches a screen that will request it.
 * An unknown kind returns null, which means "open normally".
 */

// CropReportShare.id is @default(uuid()).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null);

/**
 * The `data` object of an expo-notifications response, or null.
 *
 * Android has historically delivered the payload as a JSON string under `body`
 * rather than as the object Expo documents, so that shape is read too — but only
 * when the plain object carries no `kind` of its own.
 */
export function responseData(response) {
  const raw = response?.notification?.request?.content?.data;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind == null && typeof raw.body === 'string') {
    try {
      const parsed = JSON.parse(raw.body);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Not JSON. Fall through to the raw object.
    }
  }
  return raw;
}

/**
 * `{ name, params }` for the screen this notification names, or null when it
 * names none (or names one with an unusable id).
 */
export function pushTarget(data) {
  if (!data || typeof data !== 'object') return null;

  switch (data.kind) {
    case 'crop_report_share': {
      const shareId = uuid(data.shareId);
      return shareId ? { name: 'ReceivedReportDetail', params: { shareId } } : null;
    }
    default:
      return null;
  }
}
