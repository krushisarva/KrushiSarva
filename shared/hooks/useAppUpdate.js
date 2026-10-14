// ─────────────────────────────────────────────────────────────────────────────
// useAppUpdate — over-the-air updates the user applies by hand.
//
//   const { status, errorKind, restarting, progress, info, bannerVisible,
//           checkNow, updateNow, dismiss } = useAppUpdate();
//
// status: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' |
//         'ready' (already downloaded; one restart applies it) | 'upToDate' | 'error'
// errorKind: 'check' (a check the user started failed) | 'download' | null
// restarting: reloadAsync accepted; the app is about to restart
//
// Nothing downloads on its own. When a consumer mounts, and when the app comes
// back to the foreground, we only ASK whether an update exists, at most once per
// 30 minutes (2 minutes after a failed ask). The download waits for "Update
// now". An update the native layer already fetched (binaries built before
// checkAutomatically was NEVER still download on launch) shows as 'ready'.
//
// A failed automatic check is silent: the status goes back to what it was. Only
// a check the user asked for reports 'error'. A failed restart goes back to
// 'ready', so "Restart to update" is the retry.
//
// After "Update now" the app restarts only if the user is still looking at the
// banner. If they tapped Later during the download or left the app, the update
// waits as 'ready' (and the next cold start applies it anyway).
//
// Every consumer reads one module-level store, so the banner and the Profile
// "App version" row agree, and share one throttle and one in-flight check.
//
// Inert ('disabled', no expo-updates calls) in development, on web, in any
// build where expo-updates is off, and in builds with no EAS channel (Expo Go
// and development builds, where every call throws). Every expo-updates call is
// caught; nothing here throws into render.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';

const AUTO_CHECK_EVERY_MS = 30 * 60 * 1000;
const RETRY_FAILED_CHECK_MS = 2 * 60 * 1000;

// Dismissing hides the banner for one update. These stand in for an update
// with no manifest id (a rollback to the built-in bundle, or one we only know
// failed to download).
const ROLLBACK_KEY = 'rollback';
const UNKNOWN_KEY = 'unknown';

// Lazy and guarded like RootErrorBoundary's: a build without the native module
// must not crash on import. Web has nothing to update.
let Updates = null;
if (Platform.OS !== 'web') {
  try { Updates = require('expo-updates'); } catch { Updates = null; }
}

const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;
// Preview and production builds always carry an EAS channel. A development
// build running a published update has __DEV__ false and isEnabled true, but no
// channel, and its native check/fetch always throw.
const DISABLED = IS_DEV || !Updates || !Updates.isEnabled || !Updates.channel;

// ── store ────────────────────────────────────────────────────────────────────

let state = {
  status: DISABLED ? 'disabled' : 'idle',
  updateKey: null,     // the update the banner is about
  pending: false,      // downloaded, waiting for a restart
  errorKind: null,     // set only while status is 'error'
  restarting: false,
  dismissedKey: null,
};
let nextAutoCheckAt = 0;
let inFlightCheck = null;
let manualCheck = false;   // a checkNow joined the in-flight check
let inFlightUpdate = null;
let reloadRequested = false;
// A fetch that finds nothing new still leaves native isUpdatePending true for
// the rest of the session. Once ours did, native "pending" means nothing.
let nativePendingIsStale = false;
// The native launch procedure (old binaries: check + background download) runs
// before any JS check would; ours would just queue behind it.
let nativeStartupRunning = false;
const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}
function subscribe(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function getSnapshot() {
  return state;
}

const keyOf = (manifest) => manifest?.id || UNKNOWN_KEY;
const isDismissed = (s) => s.dismissedKey === (s.updateKey || UNKNOWN_KEY);

function isBannerVisible(s) {
  const showing = s.status === 'available' || s.status === 'ready' || s.status === 'downloading'
    || (s.status === 'error' && s.errorKind === 'download');
  return showing && !isDismissed(s);
}

let info = null;
function readInfo() {
  if (info) return info;
  let version = '';
  try { version = Constants.expoConfig?.version || ''; } catch { /* keep '' */ }
  let runtimeVersion = null, updateId = null, isEmbedded = true, channel = null, createdAt = null;
  try {
    if (Updates) {
      runtimeVersion = Updates.runtimeVersion || null;
      isEmbedded = Updates.isEmbeddedLaunch !== false;
      // The built-in bundle has an id too, but it names no published update.
      updateId = !isEmbedded && Updates.updateId ? String(Updates.updateId).slice(0, 8) : null;
      channel = Updates.channel || null;
      createdAt = Updates.createdAt || null;
    }
  } catch { /* keep the defaults */ }
  info = { version: version || runtimeVersion || '', runtimeVersion, updateId, isEmbedded, channel, createdAt };
  return info;
}

function isForeground() {
  try {
    const s = AppState.currentState;
    return s !== 'background' && s !== 'inactive';
  } catch { return true; }
}

// ── actions ──────────────────────────────────────────────────────────────────

async function check(before) {
  try {
    const result = await Updates.checkForUpdateAsync();
    nextAutoCheckAt = Date.now() + AUTO_CHECK_EVERY_MS;
    const found = !!(result?.isAvailable || result?.isRollBackToEmbedded);
    // A native download or an updateNow may have moved on while we waited.
    if (state.status === 'checking') {
      setState(found
        ? { status: 'available', updateKey: result.isAvailable ? keyOf(result.manifest) : ROLLBACK_KEY }
        : { status: 'upToDate' });
    }
    if (state.pending) return 'ready';
    return found ? 'available' : 'upToDate';
  } catch {
    nextAutoCheckAt = Date.now() + RETRY_FAILED_CHECK_MS;
    if (state.status === 'checking') {
      // Offline at launch is normal; only a check the user asked for says so.
      setState(manualCheck ? { status: 'error', errorKind: 'check' } : before);
    }
    if (state.pending) return 'ready';
    return manualCheck ? 'error' : state.status;
  }
}

function runCheck(manual) {
  if (state.pending) {
    if (state.status !== 'ready') setState({ status: 'ready', errorKind: null });
    return Promise.resolve('ready');
  }
  if (state.status === 'downloading') return Promise.resolve('available');
  if (manual) manualCheck = true;
  if (!inFlightCheck) {
    const before = { status: state.status, errorKind: state.errorKind };
    setState({ status: 'checking', errorKind: null });
    inFlightCheck = check(before).finally(() => { inFlightCheck = null; manualCheck = false; });
  }
  return inFlightCheck;
}

// Manual: ignores the throttle.
function checkNow() {
  if (DISABLED) return Promise.resolve('disabled');
  return runCheck(true);
}

function autoCheck() {
  if (DISABLED || inFlightCheck || inFlightUpdate || nativeStartupRunning) return;
  // An update is in hand, or offered for retry: asking again adds nothing.
  if (state.pending || state.status === 'downloading' || state.errorKind === 'download') return;
  // While its banner is up, an offered update stays put. Once dismissed, keep
  // asking, so a newer one (a hotfix) can replace it and raise the banner again.
  if (state.status === 'available' && !isDismissed(state)) return;
  if (Date.now() < nextAutoCheckAt) return;
  runCheck(false);
}

async function restart() {
  if (reloadRequested) return;
  reloadRequested = true;
  setState({ restarting: true });
  try {
    // Resolves just BEFORE native posts the restart; reloadRequested stays set,
    // so a second tap in that gap cannot queue a second restart.
    await Updates.reloadAsync();
  } catch {
    reloadRequested = false;
    setState({ status: 'ready', errorKind: null, restarting: false });
  }
}

async function applyUpdate() {
  if (!state.pending) {
    // Tapped from Profile on an update whose banner was already dismissed:
    // that is not "Later during the download".
    const dismissedBefore = isDismissed(state);
    setState({ status: 'downloading', errorKind: null });
    let result;
    try {
      result = await Updates.fetchUpdateAsync();
    } catch {
      setState({ status: 'error', errorKind: 'download' });
      return;
    }
    // A rollback directive is not "new" but still needs the restart to land.
    if (!result?.isNew && !result?.isRollBackToEmbedded) {
      // The update went away between the check and the tap (deleted,
      // republished, channel re-pointed). Native still flags it pending.
      nativePendingIsStale = true;
      nextAutoCheckAt = Date.now() + AUTO_CHECK_EVERY_MS;
      setState({ status: 'upToDate' });
      return;
    }
    const key = result.isNew ? keyOf(result.manifest) : ROLLBACK_KEY;
    const hidden = !dismissedBefore && isDismissed(state);
    setState({ status: 'ready', pending: true, updateKey: key, ...(hidden ? { dismissedKey: key } : null) });
    // Later during the download, or the app left the screen: no surprise
    // restart. "Restart to update" (or the next cold start) applies it.
    if (hidden || !isForeground()) return;
  }
  await restart();
}

function updateNow() {
  if (DISABLED || reloadRequested) return Promise.resolve();
  if (!inFlightUpdate) {
    inFlightUpdate = applyUpdate().catch(() => {}).finally(() => { inFlightUpdate = null; });
  }
  return inFlightUpdate;
}

function dismiss() {
  setState({ dismissedKey: state.updateKey || UNKNOWN_KEY });
}

function markPending(key) {
  // Our own fetch decides while it runs, and after it found nothing new.
  if (DISABLED || state.pending || inFlightUpdate || nativePendingIsStale) return;
  setState({ status: 'ready', pending: true, errorKind: null, updateKey: key || state.updateKey || UNKNOWN_KEY });
}

// One AppState listener for however many consumers are mounted.
let consumers = 0;
let appStateSub = null;
function retain() {
  if (DISABLED) return undefined;
  consumers += 1;
  if (!appStateSub) {
    try {
      appStateSub = AppState.addEventListener('change', (next) => { if (next === 'active') autoCheck(); });
    } catch { appStateSub = null; }
  }
  autoCheck();
  return () => {
    consumers -= 1;
    if (consumers === 0 && appStateSub) {
      try { appStateSub.remove(); } catch { /* already gone */ }
      appStateSub = null;
    }
  };
}

function noteNativeStartup(running) {
  if (DISABLED) return;
  const was = nativeStartupRunning;
  nativeStartupRunning = running;
  if (was && !running && consumers > 0) autoCheck();
}

// What the Profile "App version" rows show, per state: [i18n key, fallback]
// pairs plus which action the button runs. Shared so the two apps' rows cannot
// drift apart.
export function describeUpdateRow({ status, errorKind, restarting } = {}) {
  const downloadFailed = status === 'error' && errorKind === 'download';
  const offersUpdate = status === 'available' || status === 'ready' || status === 'downloading' || downloadFailed;
  const note = {
    available:   ['appUpdate.available', 'New version available'],
    ready:       ['appUpdate.available', 'New version available'],
    checking:    ['appUpdate.checking', 'Checking…'],
    downloading: ['appUpdate.updating', 'Updating…'],
    upToDate:    ['appUpdate.upToDate', "You're up to date"],
    error:       downloadFailed
      ? ['appUpdate.failed', "Couldn't update. Check your internet."]
      : ['appUpdate.checkFailed', "Couldn't check. Try again."],
  }[status] || null;
  let action = ['appUpdate.check', 'Check for updates'];
  if (status === 'ready') action = ['appUpdate.restartToUpdate', 'Restart to update'];
  else if (downloadFailed) action = ['appUpdate.retry', 'Try again'];
  else if (offersUpdate) action = ['appUpdate.updateNow', 'Update now'];
  return {
    note,
    noteIsError: status === 'error',
    action,
    runs: offersUpdate ? 'update' : 'check',
    busy: status === 'checking' || status === 'downloading' || !!restarting,
    showButton: status !== 'disabled',
  };
}

// ── hook ─────────────────────────────────────────────────────────────────────

const NO_NATIVE = {
  isUpdatePending: false, downloadedUpdate: undefined, downloadProgress: undefined,
  isDownloading: false, isStartupProcedureRunning: false,
};
function useNoNativeUpdates() {
  return NO_NATIVE;
}
// Chosen once per launch, so every render calls the same hook.
const useNativeUpdates = !DISABLED && typeof Updates.useUpdates === 'function' ? Updates.useUpdates : useNoNativeUpdates;

export function useAppUpdate() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const native = useNativeUpdates() || NO_NATIVE;
  const downloaded = native.downloadedUpdate;
  // isUpdatePending alone is not enough: a fetch that found nothing new sets it
  // too, with no downloaded update behind it.
  const nativePending = !!native.isUpdatePending && !!downloaded;
  const nativeKey = downloaded?.updateId || (downloaded?.type === 'rollback' ? ROLLBACK_KEY : null);
  const startupRunning = !!native.isStartupProcedureRunning;

  // Both before retain(), so an update already downloaded, or a native launch
  // check still running, skips the automatic check.
  useEffect(() => { if (nativePending) markPending(nativeKey); }, [nativePending, nativeKey]);
  useEffect(() => { noteNativeStartup(startupRunning); }, [startupRunning]);
  useEffect(() => retain(), []);

  // Native keeps the last attempt's progress until its next download starts.
  const raw = native.downloadProgress;
  const progress = s.status !== 'downloading' ? null
    : native.isDownloading && typeof raw === 'number' && raw > 0 ? Math.min(raw, 1) : 0;

  return {
    status: s.status,
    errorKind: s.errorKind,
    restarting: s.restarting,
    progress,
    info: readInfo(),
    bannerVisible: isBannerVisible(s),
    checkNow,
    updateNow,
    dismiss,
  };
}

export default useAppUpdate;
