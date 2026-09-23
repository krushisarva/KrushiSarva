/**
 * One booking button, two ways to honour it.
 *
 * Both rent detail screens need the same thing: take a date range, and either
 * collect the advance through Razorpay or — when the gateway is off,
 * unconfigured, or unreachable — create the booking for free exactly as this
 * app has always done. The sequencing around the payment sheet is
 * `usePaymentFlow`'s; the fallback, the request bodies and the wording are
 * `rentBookingFlow`'s. This hook is the wiring between them and the screen.
 *
 * ── Why the legacy path is not a legacy path ─────────────────────────────────
 * It is the path most farmers will take for a while: `/payments/config` decides,
 * it fails closed, and a gateway outage must never become "you cannot book a
 * tractor today". The free `POST /rent/bookings` route stays supported by the
 * backend indefinitely for exactly this reason, and older installed builds use
 * nothing else.
 *
 * ── The double-tap guard ─────────────────────────────────────────────────────
 * `busyRef` here, and `busyRef` inside usePaymentFlow, are refs rather than
 * state for the reason MachineryDetail has always used one: setState lags a
 * fast double tap by a render, so both presses read `false` and both fire. Two
 * presses on "Pay & Book" would otherwise raise two gateway orders — two
 * charges for one tractor. The guard here covers the legacy request; the hook's
 * own covers the whole initiate → sheet → confirm window, and neither releases
 * until the attempt reaches a terminal state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import usePaymentFlow from '../../../components/payments/usePaymentFlow';
import {
  fetchPaymentConfig,
  initiateRentBooking,
  confirmRentBooking,
  fetchRentPaymentStatus,
} from '../../../services/paymentClient';
import api from '@krushisarva/shared/services/api';
import { classifyError, ERROR_CODES } from '../../../utils/apiError';
import {
  buildInitiateArgs, buildLegacyBody, shouldPayOnline, isMockIntent,
  paymentFailureNotice, unknownNotice,
} from './rentBookingFlow';

/**
 * @param {object}   opts
 * @param {'machinery'|'labour'} opts.type
 * @param {function} opts.onBooked  ({ booking, paid, amount, request }) => void
 *                   Called once per successful booking, by either path.
 * @param {function} opts.onNotice  (notice) => void — something to tell the farmer.
 */
export default function useRentBooking({ type, onBooked, onNotice }) {
  const [config, setConfig] = useState(null);      // null while loading
  const [legacyBusy, setLegacyBusy] = useState(false);

  const aliveRef   = useRef(true);
  const busyRef    = useRef(false);                // ← the double-tap guard
  const requestRef = useRef(null);                 // what is being paid for
  const mockRef    = useRef(false);                // this intent was simulated
  const cbRef      = useRef({ onBooked, onNotice });
  cbRef.current = { onBooked, onNotice };

  // ── Payment config ──────────────────────────────────────────────────────────
  // Fetched once. `fetchPaymentConfig` already resolves to "off" on any error,
  // so there is no failure branch here — an unreachable config simply means the
  // free path, which is the safe default.
  useEffect(() => {
    aliveRef.current = true;
    const ac = new AbortController();
    fetchPaymentConfig(ac.signal).then((cfg) => {
      if (aliveRef.current) setConfig(cfg);
    });
    return () => {
      aliveRef.current = false;
      ac.abort();
    };
  }, []);

  /** The free booking this app has always made. Also the gateway fallback. */
  const bookFree = useCallback(async (request) => {
    setLegacyBusy(true);
    try {
      const { data } = await api.post('/rent/bookings', buildLegacyBody(request));
      if (!aliveRef.current) return;
      cbRef.current.onBooked?.({
        booking: data?.data || null, paid: false, amount: null, request,
      });
    } catch (err) {
      if (!aliveRef.current) return;
      const e = classifyError(err, 'Booking failed');
      if (e.code === ERROR_CODES.CANCELED) return;
      cbRef.current.onNotice?.({
        kind: 'LEGACY_ERROR',
        // A 409 is the useful case: someone booked the same slot first. Nothing
        // was charged on this path, so "pick another range" is honest.
        titleKey: e.status === 409 ? 'rent.slotTakenTitle' : 'rent.bookingFailed',
        titleFallback: e.status === 409 ? 'Those dates just went' : 'Booking failed',
        bodyKey: e.status === 409 ? 'rent.slotTakenMsg' : 'rent.bookingFailedMsg',
        bodyFallback: e.status === 409
          ? 'Those dates were just booked by someone else. Please pick another range.'
          : e.message,
        vars: null,
        serverMessage: e.code === ERROR_CODES.OFFLINE ? null : e.message,
        preferServerMessage: e.status !== 409 && e.code !== ERROR_CODES.OFFLINE,
        moneyTaken: false,
        mayRetry: true,
      });
    } finally {
      if (aliveRef.current) setLegacyBusy(false);
      busyRef.current = false;
    }
  }, []);

  // ── The paid path ───────────────────────────────────────────────────────────
  /**
   * A simulated intent cannot drive the real checkout script, so it is stripped
   * of its order id here. `usePaymentFlow` then settles FAILED/INITIATE without
   * ever opening a sheet, and `onFailed` below turns that into a free booking
   * rather than an error — the farmer gets their booking and nobody is asked
   * for money the server cannot collect.
   */
  const initiate = useCallback(async (body) => {
    const intent = await initiateRentBooking(body);
    mockRef.current = isMockIntent(intent);
    return mockRef.current ? { ...intent, razorpayOrderId: null } : intent;
  }, []);

  const flow = usePaymentFlow({
    initiate,
    confirm: confirmRentBooking,
    status: fetchRentPaymentStatus,

    onDone: (result, intent) => {
      busyRef.current = false;
      if (!aliveRef.current) return;
      cbRef.current.onBooked?.({
        // `confirm` answers with the booking; a status recovery answers with
        // the report, which carries one once the webhook has written it.
        booking: result?.booking || null,
        paid: true,
        amount: Number(intent?.quote?.payable ?? intent?.amount ?? result?.amount) || null,
        request: requestRef.current,
      });
    },

    onFailed: (failure) => {
      busyRef.current = false;
      // The simulated-intent case: not a failure, a redirect to the free path.
      if (mockRef.current && failure?.code === 'INITIATE') {
        mockRef.current = false;
        flowRef.current?.reset();
        busyRef.current = true;
        bookFree(requestRef.current);
        return;
      }
      if (!aliveRef.current) return;
      cbRef.current.onNotice?.(paymentFailureNotice(failure));
    },

    onUnknown: (report) => {
      busyRef.current = false;
      if (!aliveRef.current) return;
      cbRef.current.onNotice?.(unknownNotice(report));
    },
  });

  // `flow` is referenced inside its own callbacks (the mock redirect calls
  // reset()), which is only legal through a ref.
  const flowRef = useRef(flow);
  flowRef.current = flow;

  /**
   * Book. One press, one attempt.
   * @param {{listingId, startDate, endDate, days, hours?, workerCount?, notes?}} request
   */
  const book = useCallback(async (request) => {
    if (busyRef.current) return { skipped: true };
    busyRef.current = true;
    const req = { ...request, type };
    requestRef.current = req;
    mockRef.current = false;

    if (!shouldPayOnline(config)) {
      await bookFree(req);
      return {};
    }
    // usePaymentFlow holds its own ref guard from here until the attempt
    // settles, so busyRef is released by its callbacks, never by this function.
    await flowRef.current.start(buildInitiateArgs(req));
    return {};
  }, [bookFree, config, type]);

  /** Back to a pressable button after a terminal state. */
  const reset = useCallback(() => {
    busyRef.current = false;
    mockRef.current = false;
    flowRef.current.reset();
  }, []);

  return {
    /** null while the config is loading; then true when the sheet is in play. */
    payOnline: config == null ? null : shouldPayOnline(config),
    keyId: config?.keyId || null,
    /** Disables the button and drives the spinner. */
    busy: legacyBusy || flow.busy,
    /** 'confirm' | 'dismiss' | null — which sentence the overlay shows. */
    verifyReason: flow.verifyReason,
    /** True while the app is asking the server what happened to a payment. */
    verifying: flow.state === 'confirming',
    /** The server's quote for the current attempt, for the button label. */
    intent: flow.intent,
    checkoutProps: flow.checkoutProps,
    book,
    reset,
  };
}
