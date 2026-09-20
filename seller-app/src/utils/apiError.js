/**
 * The server's own reason when it REFUSES an action — no React, no React Native.
 *
 * safeErrorMessage() maps a 409 to "A conflict occurred. Please refresh and try
 * again." and a 403 to "You do not have permission…", which hides the one thing
 * the seller needs: WHY. The seller routes write their 409/403 messages for
 * people ("This order is already shipped and cannot be marked cancelled.",
 * "This offer has been blocked by KrushiSarva. Contact support."), so those are
 * shown as sent. Anything else returns null and the caller falls back to
 * safeErrorMessage(), which keeps 5xx internals off the screen.
 */
export function refusalMessage(error) {
  const status = error?.response?.status;
  if (status !== 409 && status !== 403) return null;
  const message = error?.response?.data?.error?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : null;
}
