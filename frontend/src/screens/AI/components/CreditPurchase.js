/**
 * Buying AI credits — the wiring, kept out of the screen.
 *
 * The generic payment sequencing (initiate → sheet → confirm, and the status
 * check on a dismissal) lives in components/payments/usePaymentFlow.js and is
 * shared with shop checkout and rent bookings. This file is the CREDITS half:
 * which endpoints, what a pack is, and what sentence a farmer is shown when it
 * ends.
 *
 * ── Why it is not inside AICreditsScreen.js ──────────────────────────────────
 * The project's Jest config (frontend/jest.config.js) runs in a node
 * environment with a `react-native` stub that exports Platform and nothing
 * else, so a screen full of <View> cannot be rendered in a test at all. Keeping
 * this module free of every react-native import means the parts that decide
 * what is SENT and what is SAID are testable — and those are the parts that,
 * got wrong, charge a farmer twice.
 *
 * ── The two rules ────────────────────────────────────────────────────────────
 * 1. The server owns the price. Nothing here invents a pack, a credit count or
 *    a rupee figure; `normalizeCreditPacks` drops a pack it cannot price rather
 *    than filling in a default. A price rendered from a local constant is a
 *    price that will one day disagree with what the farmer is charged (§51).
 * 2. A closed sheet is not a failed payment. That branch is usePaymentFlow's,
 *    and every outcome below that means "the money may have moved" says so and
 *    never offers "try again".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import usePaymentFlow, {
  PAYMENT_FAILURE, PAYMENT_STATE,
} from '../../../components/payments/usePaymentFlow';
import {
  fetchPaymentConfig, fetchCreditPacks,
  initiateCreditPurchase, confirmCreditPurchase, fetchCreditPurchaseStatus,
} from '../../../services/paymentClient';

/** Whether the shop is open, as far as this screen is concerned. */
export const PACKS = {
  LOADING: 'loading',
  /** At least one sellable pack and a gateway that can take the money. */
  READY: 'ready',
  /** Payments off, no packs, or the packs call failed — show the old notice. */
  UNAVAILABLE: 'unavailable',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Server packs → rows this screen can render.
 *
 * Deliberately strict: a pack with no id cannot be bought, and a pack whose
 * price did not survive the trip must not be shown at some made-up figure. The
 * rupee price is taken from `priceInr` when the server sends it and otherwise
 * derived from `pricePaise` — still the server's number, just the other field.
 */
export function normalizeCreditPacks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    const id = p?.id != null && String(p.id).length ? String(p.id) : null;
    if (!id) continue;

    const credits = num(p?.credits);
    if (credits == null || credits <= 0) continue;

    const pricePaise = num(p?.pricePaise);
    const priceInr = num(p?.priceInr) ?? (pricePaise != null ? pricePaise / 100 : null);
    if (priceInr == null || priceInr < 0) continue;

    out.push({
      id,
      credits,
      priceInr,
      pricePaise: pricePaise ?? Math.round(priceInr * 100),
      // The server's own wording where it sent one. No English default is
      // fabricated here — the screen falls back to "<n> credits" itself, in the
      // farmer's language, rather than pretending the server named the pack.
      label: typeof p?.label === 'string' && p.label.trim() ? p.label.trim() : null,
    });
  }
  return out;
}

/**
 * What a settled flow actually credited.
 *
 * Two different bodies land here and both are read the same way: the confirm
 * response `{ credited, balance, alreadyProcessed }`, and — when the farmer
 * closed the sheet and the server was asked instead — the status report
 * `{ status, paid, amount, credited, balance }`.
 */
export function readCreditResult(result) {
  return {
    credited: num(result?.credited),
    balance: num(result?.balance),
    /**
     * The webhook got there first. This is a SUCCESS: the credits are already
     * on the balance. Treating it as a duplicate-payment warning would frighten
     * a farmer whose purchase worked perfectly.
     */
    alreadyProcessed: result?.alreadyProcessed === true,
  };
}

/**
 * The sentence shown when the flow settles.
 *
 * Returned as keys plus English fallbacks so the screen can call
 * `t(key, fallback)` — no translations.js entry is required for this to read
 * correctly in English today.
 *
 * `tone` drives colour only. `moneyMayHaveMoved` drives whether a retry is
 * offered, and is the field that matters: "you can try again" must never be
 * said to someone whose rupees are still with the gateway.
 */
export function creditPurchaseNotice({ state, result, failure, report } = {}) {
  if (state === PAYMENT_STATE.DONE) {
    const { credited, balance } = readCreditResult(result);
    if (credited != null && balance != null) {
      return {
        tone: 'success', moneyMayHaveMoved: false, mayRetry: false,
        titleKey: 'aiCredits.purchaseDone', titleFallback: 'Credits added',
        bodyKey: 'aiCredits.purchaseDoneMsg',
        bodyFallback: '{{credits}} credits added. Your balance is now {{balance}}.',
        vars: { credits: credited, balance },
      };
    }
    // Credited, but the body did not carry the numbers. Still a success — just
    // without a figure to quote, so none is invented.
    return {
      tone: 'success', moneyMayHaveMoved: false, mayRetry: false,
      titleKey: 'aiCredits.purchaseDone', titleFallback: 'Credits added',
      bodyKey: 'aiCredits.purchaseDonePlain',
      bodyFallback: 'Your credits have been added. Pull down to refresh your balance.',
      vars: null,
    };
  }

  if (state === PAYMENT_STATE.FAILED) {
    switch (failure?.code) {
      case PAYMENT_FAILURE.SCRIPT_LOAD:
        return {
          tone: 'error', moneyMayHaveMoved: false, mayRetry: true,
          titleKey: 'aiCredits.purchaseNoNetwork', titleFallback: 'Could not open the payment page',
          bodyKey: 'aiCredits.purchaseNoNetworkMsg',
          bodyFallback: 'Check your internet connection and try again. No money was taken.',
          vars: null,
        };
      case PAYMENT_FAILURE.REFUNDED:
        // Money moved and is coming back. No retry offer: a second payment now
        // is a second charge to chase.
        return {
          tone: 'warning', moneyMayHaveMoved: true, mayRetry: false,
          titleKey: 'aiCredits.purchaseRefunding', titleFallback: 'Your payment is being refunded',
          bodyKey: 'aiCredits.purchaseRefundingMsg',
          bodyFallback: 'The credits could not be added, so the money is on its way back. It can take 5-7 working days.',
          serverMessage: failure?.serverMessage || null,
          vars: null,
        };
      case PAYMENT_FAILURE.INITIATE:
        return {
          tone: 'error', moneyMayHaveMoved: false, mayRetry: true,
          titleKey: 'aiCredits.purchaseNotStarted', titleFallback: 'Could not start the payment',
          bodyKey: 'aiCredits.purchaseNotStartedMsg',
          bodyFallback: 'Please try again in a moment. No money was taken.',
          serverMessage: failure?.serverMessage || null,
          vars: null,
        };
      default:
        // GATEWAY, NOT_PAID — the server or the gateway is positive that
        // nothing was captured, so this is the one place "try again" is safe.
        return {
          tone: 'error', moneyMayHaveMoved: false, mayRetry: true,
          titleKey: 'aiCredits.purchaseFailed', titleFallback: 'Payment failed',
          bodyKey: 'aiCredits.purchaseFailedMsg',
          bodyFallback: 'No money was taken. You can try again.',
          serverMessage: failure?.serverMessage || null,
          vars: null,
        };
    }
  }

  if (state === PAYMENT_STATE.UNKNOWN) {
    // The server was asked, repeatedly, and could not say. The honest answer —
    // and the only one that does not risk a double charge.
    return {
      tone: 'warning', moneyMayHaveMoved: true, mayRetry: false,
      titleKey: 'aiCredits.purchaseUnknown', titleFallback: 'We could not confirm your payment',
      bodyKey: 'aiCredits.purchaseUnknownMsg',
      bodyFallback: 'Please check your credit balance before paying again, so you are not charged twice.',
      report: report || null,
      vars: null,
    };
  }

  return null;
}

// ── The purpose-specific calls handed to usePaymentFlow ──────────────────────
/**
 * `{ packId }` and nothing else, rebuilt here rather than forwarded.
 *
 * usePaymentFlow passes whatever `start()` was given straight through, so this
 * wrapper is the second place — after paymentClient's own destructuring — where
 * an amount someone added to the call site would be dropped on the floor
 * instead of reaching the wire.
 */
const initiate = ({ packId } = {}) => initiateCreditPurchase({ packId });
const confirm = (body) => confirmCreditPurchase(body);
const status = (providerOrderId, signal) => fetchCreditPurchaseStatus(providerOrderId, signal);

/**
 * Everything the Buy button needs.
 *
 * @param {object} opts
 * @param {(summary: {balance: number|null, credited: number|null}) => void} opts.onCredited
 *        Called with the SERVER's new balance when a purchase lands, so the
 *        screen can show it without re-deriving anything locally.
 */
export default function useCreditPurchase({ onCredited } = {}) {
  const [packsState, setPacksState] = useState(PACKS.LOADING);
  const [packs, setPacks] = useState([]);
  const [keyId, setKeyId] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedPackId, setSelectedPackId] = useState(null);
  const [notice, setNotice] = useState(null);

  const creditedRef = useRef(onCredited);
  creditedRef.current = onCredited;

  // A ref, not `flow.busy`: setState lags a fast double tap by a render, so
  // both presses would read busy===false, both would set a selected pack and
  // both would ask for a gateway order. usePaymentFlow guards `start()` the
  // same way (and for the same reason as MachineryDetail.js:347); this guard
  // exists so the screen's own state cannot drift from it either.
  const startingRef = useRef(false);

  const settled = useCallback(() => { startingRef.current = false; }, []);

  const flow = usePaymentFlow({
    initiate,
    confirm,
    status,
    onDone: (result) => {
      settled();
      setSheetOpen(false);
      const summary = readCreditResult(result);
      setNotice(creditPurchaseNotice({ state: PAYMENT_STATE.DONE, result }));
      // The balance the SERVER reports, not balance + credits computed here.
      if (summary.balance != null) creditedRef.current?.(summary);
    },
    onFailed: (failure) => {
      settled();
      setSheetOpen(false);
      setNotice(creditPurchaseNotice({ state: PAYMENT_STATE.FAILED, failure }));
    },
    onUnknown: (report) => {
      settled();
      setSheetOpen(false);
      setNotice(creditPurchaseNotice({ state: PAYMENT_STATE.UNKNOWN, report }));
    },
  });

  /**
   * One load, on mount — not on every focus.
   *
   * The screen re-reads the BALANCE whenever it regains focus, which is cheap
   * and is what a farmer came back to see. The catalogue of packs and the
   * gateway config do not change between two glances at a screen, and two more
   * requests per focus on a 2G connection buy nothing (§42, §46).
   */
  useEffect(() => {
    let alive = true;
    const ac = new AbortController();

    (async () => {
      // fetchPaymentConfig fails CLOSED, so a rejection here can only come from
      // the packs call.
      const [cfg, rawPacks] = await Promise.all([
        fetchPaymentConfig(ac.signal),
        fetchCreditPacks(ac.signal).catch(() => null),
      ]);
      if (!alive) return;

      setKeyId(cfg?.keyId || null);
      const list = normalizeCreditPacks(rawPacks);
      setPacks(list);
      // Every one of these must hold before a Buy button does anything: the
      // gateway is on, we have its publishable key, and the server named at
      // least one pack it is willing to sell.
      setPacksState(
        cfg?.onlineEnabled === true && cfg?.keyId && list.length
          ? PACKS.READY
          : PACKS.UNAVAILABLE,
      );
    })();

    return () => { alive = false; ac.abort(); };
  }, []);

  const openSheet = useCallback(() => {
    if (packsState !== PACKS.READY) return;
    setNotice(null);
    setSheetOpen(true);
  }, [packsState]);

  const closeSheet = useCallback(() => {
    // Only while nothing is in flight — the sheet is not a way out of a payment
    // that is already being raised.
    if (startingRef.current) return;
    setSheetOpen(false);
  }, []);

  /** Buy one pack. Two taps produce one gateway order. */
  const buy = useCallback((packId) => {
    if (startingRef.current) return;
    if (!packId) return;
    startingRef.current = true;
    setSelectedPackId(packId);
    setNotice(null);
    flow.start({ packId });
  }, [flow]);

  const dismissNotice = useCallback(() => {
    setNotice(null);
    flow.reset();
  }, [flow]);

  return {
    packsState,
    packs,
    keyId,
    sheetOpen,
    openSheet,
    closeSheet,
    buy,
    dismissNotice,
    notice,
    selectedPack: packs.find((p) => p.id === selectedPackId) || null,
    /** True from the tap until the flow settles — disables the sheet's rows. */
    busy: flow.busy,
    verifying: flow.state === PAYMENT_STATE.CONFIRMING,
    verifyReason: flow.verifyReason,
    checkoutProps: flow.checkoutProps,
  };
}
