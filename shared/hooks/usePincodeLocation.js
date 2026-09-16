/**
 * PIN code → location hooks for forms.
 *
 *   usePincodeLookup(pincode)   status + summary for whatever the field holds
 *   usePincodeAutofill({...})   the above, plus writing state / district /
 *                               taluka / village into the form
 *
 * Statuses: 'idle' (empty) | 'incomplete' | 'invalid' | 'loading' | 'found' |
 * 'not_found' | 'unavailable' | 'offline' | 'rate_limited'.
 *
 * Autofill rules, in the order a person meets them:
 *   - Opening a saved form never overwrites what was saved; it only fills
 *     blanks. The pincode the form opened with is treated that way until the
 *     user edits it.
 *   - A pincode the user types decides state and district: those follow it.
 *     Taluka / village / city are filled when blank, or replaced when they
 *     still hold what autofill last wrote — never when the user typed them.
 *   - When a new pincode moves the district, a taluka picker that no longer
 *     fits is cleared rather than left pointing at the old district.
 *   - A pincode covering several villages (or districts) fills only what they
 *     share; picking a village settles the rest.
 *   - Lookups for a pincode the user has already moved past are dropped.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchPincode, peekPincode, PincodeLookupError, isPincodeLookupCancel,
} from '../services/pincodeApi';
import {
  sanitizePincode, pincodeInputState, summarisePincode, localityToValues, pincodeBlocksSubmit,
} from '../utils/pincode';

const DEBOUNCE_MS = 300;

const INPUT_STATUS = { empty: 'idle', incomplete: 'incomplete', invalid: 'invalid' };

function resolved(pincode, result) {
  return {
    pincode,
    status: result.found ? 'found' : 'not_found',
    summary: result.found ? summarisePincode(result) : null,
  };
}

function startState(pincode, input, enabled) {
  if (!enabled || input !== 'complete') return { pincode, status: enabled ? INPUT_STATUS[input] : 'idle', summary: null };
  const cached = peekPincode(pincode);
  return cached ? resolved(pincode, cached) : { pincode, status: 'loading', summary: null };
}

/**
 * @param {string} value  the PIN field's current value
 * @param {{enabled?: boolean, debounceMs?: number}} [opts]
 */
export function usePincodeLookup(value, { enabled = true, debounceMs = DEBOUNCE_MS } = {}) {
  const pincode = sanitizePincode(value);
  const input = pincodeInputState(pincode);
  const [state, setState] = useState(() => startState(pincode, input, enabled));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const start = startState(pincode, input, enabled);
    setState(start);
    if (start.status !== 'loading') return undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchPincode(pincode, { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted) setState(resolved(pincode, result));
        })
        .catch((err) => {
          if (controller.signal.aborted || isPincodeLookupCancel(err)) return;
          const status = err instanceof PincodeLookupError ? err.kind : 'unavailable';
          setState({ pincode, status, summary: null });
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [pincode, input, enabled, attempt, debounceMs]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // Between a keystroke and the effect, `state` still describes the previous
  // value; never show that.
  const current = state.pincode === pincode ? state : startState(pincode, input, enabled);
  return { ...current, retry };
}

// Coarse → fine. Changing a coarser field invalidates the finer ones.
const LEVEL = { state: 0, district: 1, taluka: 2, village: 3, city: 3 };
// Fields that follow a typed pincode even over a value the user chose.
const FOLLOWS_PINCODE = new Set(['state', 'district']);

const text = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

/**
 * @param {object} args
 * @param {string} args.pincode
 * @param {Record<string,string>} args.values   current values of the mapped fields
 * @param {Record<string,'state'|'district'|'taluka'|'village'|'city'>} args.fields
 *        form field name → what it holds
 * @param {string[]} [args.strict]   form fields that are pickers: canonical names only
 * @param {(patch: Record<string,string>) => void} args.onChange
 * @param {string} [args.savedPincode]  the pincode stored on the record being
 *        edited, for forms that load it after mounting. Defaults to whatever
 *        the field holds on first render.
 * @param {string|number} [args.resetKey]  change it when the form starts over
 *        for another record (a sheet reopened for a different address), so the
 *        new record is treated as freshly opened
 * @param {boolean} [args.enabled]
 */
export function usePincodeAutofill({
  pincode, values, fields, strict = [], onChange, savedPincode, resetKey, enabled = true,
}) {
  const lookup = usePincodeLookup(pincode, { enabled });
  const [selectedKey, setSelectedKey] = useState(null);

  const openedWith = useRef(sanitizePincode(savedPincode ?? pincode) || null);
  const lastFilled = useRef({});
  const appliedFor = useRef(null);

  // Latest props for effects and callbacks without re-subscribing them.
  const latest = useRef({});
  latest.current = { values, fields, strict, onChange };

  const pin = sanitizePincode(pincode);
  const saved = savedPincode === undefined ? undefined : sanitizePincode(savedPincode);
  // A new record (resetKey) or a record that finished loading (savedPincode)
  // starts a fresh session. Declared before the apply effect so a record whose
  // pincode and values arrive in one render is recognised as opened, not typed.
  const session = `${resetKey ?? ''}|${saved ?? ''}`;
  const sessionRef = useRef(session);
  useEffect(() => {
    if (sessionRef.current === session) return;
    sessionRef.current = session;
    openedWith.current = (saved ?? pin) || null;
    appliedFor.current = null;
    lastFilled.current = {};
    setSelectedKey(null);
  }, [session, saved, pin]);

  // Only a move AWAY from the opened pincode counts as the user editing it. A
  // form still loading its record passes through other values on the way to
  // the saved one, and that must not end the opened session.
  const prevPin = useRef(pin);
  useEffect(() => {
    const before = prevPin.current;
    prevPin.current = pin;
    if (openedWith.current && before === openedWith.current && pin !== openedWith.current) {
      openedWith.current = null;
    }
    if (pin !== appliedFor.current) setSelectedKey(null);
  }, [pin]);

  const write = useCallback((patch) => {
    if (!Object.keys(patch).length) return;
    lastFilled.current = { ...lastFilled.current, ...patch };
    latest.current.onChange?.(patch);
  }, []);

  // Fields finer than any coarse field this patch changes, and not set by it:
  // a picker takes the new pincode's value or is cleared (its options just
  // changed); text is replaced only if autofill put it there.
  const clearStaleFiner = useCallback((patch, suggested = {}) => {
    const { values: cur = {}, fields: map = {}, strict: pickers = [] } = latest.current;
    let changedLevel = Infinity;
    for (const [field, value] of Object.entries(patch)) {
      const level = LEVEL[map[field]];
      if (level < LEVEL.village && text(cur[field]) && text(cur[field]) !== value) {
        changedLevel = Math.min(changedLevel, level);
      }
    }
    if (changedLevel === Infinity) return patch;
    const out = { ...patch };
    for (const [field, kind] of Object.entries(map)) {
      if (field in out || LEVEL[kind] <= changedLevel) continue;
      const value = text(cur[field]);
      if (!value) continue;
      if (pickers.includes(field) || value === lastFilled.current[field]) out[field] = suggested[field] ?? '';
    }
    return out;
  }, []);

  useEffect(() => {
    if (lookup.status !== 'found' || !lookup.summary) return;
    if (appliedFor.current === lookup.pincode) return;
    appliedFor.current = lookup.pincode;

    const { summary } = lookup;
    const { values: cur = {}, fields: map = {}, strict: pickers = [] } = latest.current;
    setSelectedKey(summary.localities.length === 1 ? summary.localities[0].key : null);

    const opening = openedWith.current === lookup.pincode;
    const suggested = localityToValues(summary, map, pickers);
    const patch = {};

    for (const [field, value] of Object.entries(suggested)) {
      const now = text(cur[field]);
      if (!now) { patch[field] = value; continue; }
      if (opening || now === value) continue;
      if (FOLLOWS_PINCODE.has(map[field]) || now === lastFilled.current[field]) patch[field] = value;
    }

    if (!opening) {
      // A field autofill wrote for the previous pincode that this pincode
      // can't vouch for.
      for (const [field, kind] of Object.entries(map)) {
        if (field in suggested) continue;
        const now = text(cur[field]);
        if (!now || now !== lastFilled.current[field]) continue;
        const stillPossible = summary.localities.some((l) => {
          const v = localityToValues(l, { [field]: kind }, pickers)[field];
          return v === now;
        });
        if (!stillPossible) patch[field] = '';
      }
    }

    write(opening ? patch : clearStaleFiner(patch, suggested));
    // `session`: a record reopened with the same PIN gets its blanks filled,
    // though the lookup itself did not change.
  }, [lookup.status, lookup.pincode, lookup.summary, session, write, clearStaleFiner]);

  const selectLocality = useCallback((locality) => {
    if (!locality) return;
    const { fields: map = {}, strict: pickers = [] } = latest.current;
    const values = localityToValues(locality, map, pickers);
    // An explicit choice sets every field it can; a picker it can't set is
    // cleared so it doesn't keep another district's taluka.
    const patch = { ...values };
    for (const field of pickers) {
      if (!(field in patch) && map[field]) patch[field] = '';
    }
    setSelectedKey(locality.key);
    openedWith.current = null;
    write(clearStaleFiner(patch));
  }, [write, clearStaleFiner]);

  return {
    ...lookup,
    localities: lookup.summary?.localities || [],
    selectedKey,
    selectLocality,
    blocksSubmit: pincodeBlocksSubmit(lookup.status),
  };
}
