/**
 * useProfileSync — keep the signed-in account complete and current on the
 * screens that show business and KYC details.
 *
 * AuthContext is filled from two places. A session restored at launch gets the
 * full GET /users/me. A fresh OTP login gets only the login response: id, phone,
 * name, role. Nothing refetched after that, so straight after logging in the
 * seller profile showed no location, "GST: Not added", "Bank: Not added" and a
 * 10% completion bar for a fully set-up seller, and the business profile form
 * opened blank — and saving it wrote those blanks over the stored details.
 *
 * This hook fetches /users/me when the screen gains focus and the copy in
 * context is either incomplete or older than `maxAgeMs`, and reports whether a
 * complete copy is available yet so a screen can wait for it.
 *
 * Guards:
 *   - One request at a time, shared by every screen, so Profile → Business
 *     profile costs one request, not two.
 *   - A read that was in flight while a save completed is older than the save,
 *     so it is discarded instead of putting the pre-save values back. Call
 *     noteProfileWrite() right after any PUT /users/me succeeds.
 *   - A read that finishes after the account changed (log out, log in as
 *     someone else) is discarded rather than merged into the new account.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@krushisarva/shared/context/AuthContext';
import api, { safeErrorMessage } from '@krushisarva/shared/services/api';
import { isConnectivityError, useNetwork } from './useNetwork';
import { isProfileHydrated } from '../utils/businessProfile';

let lastSyncAt = 0;
let lastWriteAt = 0;
let currentUserId = null;
let inflight = null;

export function noteProfileWrite() {
  lastWriteAt = Date.now();
}

function syncProfile(updateUser) {
  if (inflight) return inflight;
  const startedAt = Date.now();
  const requestedFor = currentUserId;
  inflight = api.get('/users/me')
    .then(({ data }) => {
      const fresh = data?.data;
      if (!fresh || lastWriteAt >= startedAt) return;
      if (fresh.id !== requestedFor || requestedFor !== currentUserId) return;
      updateUser(fresh);
      lastSyncAt = Date.now();
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export default function useProfileSync({ maxAgeMs = 30_000 } = {}) {
  const { user, updateUser } = useAuth();
  const hydrated = isProfileHydrated(user);
  const hydratedRef = useRef(hydrated);
  hydratedRef.current = hydrated;
  currentUserId = user?.id ?? null;

  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const sync = useCallback(async ({ force = false } = {}) => {
    if (!force && hydratedRef.current && Date.now() - lastSyncAt < maxAgeMs) return;
    if (!currentUserId) return;

    setSyncing(true);
    setError(null);
    try {
      await syncProfile(updateUser);
    } catch (e) {
      if (mounted.current) {
        setError({
          message: safeErrorMessage(e),
          isOffline: isConnectivityError(e),
          status: e?.response?.status ?? null,
        });
      }
    } finally {
      if (mounted.current) setSyncing(false);
    }
  }, [maxAgeMs, updateUser]);

  useFocusEffect(useCallback(() => { sync(); }, [sync]));

  // Back online after failing to load: try again without waiting for a tap.
  const { reconnectedAt } = useNetwork();
  const lastReconnect = useRef(reconnectedAt);
  useEffect(() => {
    if (!reconnectedAt || reconnectedAt === lastReconnect.current) return;
    lastReconnect.current = reconnectedAt;
    if (error || !hydratedRef.current) sync({ force: true });
  }, [reconnectedAt, error, sync]);

  const retry = useCallback(() => sync({ force: true }), [sync]);

  return { hydrated, syncing, error, retry };
}
