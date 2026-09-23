/**
 * Razorpay checkout, hosted in a WebView.
 *
 * ── Why a WebView and not the native SDK ─────────────────────────────────────
 * `react-native-razorpay` is a native module, so adding it forces a new dev
 * build and a new store binary before anyone can test the flow.
 * `react-native-webview` is already a dependency, and Razorpay's Standard
 * Checkout is a supported, first-party web integration — so this needs no new
 * package and runs in the build that is already installed.
 *
 * ── The security boundary ────────────────────────────────────────────────────
 * Nothing this component reports is trusted. On success Razorpay hands back
 * (order_id, payment_id, signature); the app forwards them to
 * POST /agristore/orders/confirm, which re-verifies the HMAC with the SECRET key
 * — which never leaves the server — re-prices the cart, and only then writes the
 * order. A tampered WebView can therefore claim "paid" all it likes and get a
 * 400. The amount is likewise fixed server-side: this component is passed a
 * gateway ORDER ID that already carries the amount, never a client-supplied one.
 *
 * ── The one rule that matters for the farmer ─────────────────────────────────
 * DISMISSAL IS NOT FAILURE. A farmer who backgrounds the app mid-UPI, or whose
 * connection drops after approving, has quite possibly paid. This component
 * reports `dismissed` and `failed` as DIFFERENT outcomes, and the caller checks
 * the real payment status with the server rather than assuming either.
 *
 * ── Where this lives, and why ────────────────────────────────────────────────
 * This file used to sit in screens/AgriStore/. Nothing in it is shop-specific —
 * it is handed a gateway order id and reports what the gateway said — so rent
 * bookings and AI credit packs use the same component rather than each growing
 * their own copy of the dismissal rule. The `/agristore/orders/confirm` named
 * above is the SHOP's verifier; every purpose has one, and every one of them
 * re-checks the HMAC server-side. The props contract is unchanged by the move.
 *
 * The flow around it — initiate, open, confirm, and the status check on a
 * dismissal — is in ./usePaymentFlow.js, so no screen re-implements it.
 */
import { useMemo, useRef, useState } from 'react';
import {
  View, Text, Modal, StyleSheet, ActivityIndicator, TouchableOpacity, BackHandler,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '@krushisarva/shared/constants/colors';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import { routeCheckoutMessage } from './checkoutMessage';

/** Escape a value for safe interpolation into the checkout HTML. */
function jsString(value) {
  return JSON.stringify(String(value ?? ''));
}

/**
 * Build the checkout page.
 *
 * `order_id` carries the amount server-side, so `amount` here is display only —
 * Razorpay charges what the order says, not what this page claims.
 */
function buildHtml({ keyId, orderId, amountPaise, name, phone, description }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <style>
    html,body { margin:0; padding:0; height:100%; background:#F6F8F5;
      font-family:-apple-system,Roboto,sans-serif; }
    .wrap { display:flex; height:100%; align-items:center; justify-content:center;
      color:#4B554E; font-size:15px; }
  </style>
</head>
<body>
  <div class="wrap">Opening secure payment…</div>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    function post(payload) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify(payload)); } catch (e) {}
    }
    var booted = false;
    function boot() {
      if (booted) return;
      booted = true;
      if (typeof Razorpay === 'undefined') {
        // The checkout script could not load — almost always no connectivity.
        // Reported as its own outcome so the app can say "check your connection"
        // instead of "payment failed", which would be a lie.
        post({ type: 'script_error' });
        return;
      }
      var rzp = new Razorpay({
        key: ${jsString(keyId)},
        order_id: ${jsString(orderId)},
        amount: ${Number(amountPaise) || 0},
        currency: 'INR',
        name: 'KrushiSarva',
        description: ${jsString(description)},
        prefill: { name: ${jsString(name)}, contact: ${jsString(phone)} },
        theme: { color: '#176B43' },
        retry: { enabled: false },
        handler: function (r) {
          post({
            type: 'success',
            razorpayPaymentId: r.razorpay_payment_id,
            razorpayOrderId: r.razorpay_order_id,
            razorpaySignature: r.razorpay_signature
          });
        },
        modal: {
          escape: false,
          ondismiss: function () { post({ type: 'dismissed' }); }
        }
      });
      rzp.on('payment.failed', function (r) {
        post({
          type: 'failed',
          code: r && r.error ? r.error.code : null,
          reason: r && r.error ? r.error.description : null
        });
      });
      rzp.open();
      // Tells the app the sheet is up, so it can drop its own "opening…"
      // overlay. onLoadEnd is not enough: it rides the window load event,
      // which never fires while the checkout script request is still hanging.
      // (No backticks in this comment — it lives inside a template literal.)
      post({ type: 'opened' });
    }
    window.onerror = function () { post({ type: 'script_error' }); };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot);
    // The watchdog. A request for checkout.js that HANGS — captive portal, dead
    // DNS, a 2G connection that stalls mid-transfer — never fires load and
    // never fires onerror, so without this the farmer watches a spinner until
    // they give up. "We could not reach the payment page" is a poor outcome;
    // an infinite spinner on a screen about money is a worse one, because the
    // farmer cannot tell it from a payment that is quietly going through.
    setTimeout(function () { if (!booted) { booted = true; post({ type: 'script_error' }); } }, 20000);
  </script>
</body>
</html>`;
}

/**
 * @param {object}   props
 * @param {boolean}  props.visible
 * @param {string}   props.keyId          Razorpay PUBLISHABLE key, from the server
 * @param {string}   props.orderId        gateway order id from /orders/initiate
 * @param {number}   props.amountPaise
 * @param {function} props.onSuccess      ({razorpayPaymentId, razorpayOrderId, razorpaySignature})
 * @param {function} props.onDismiss      farmer closed the sheet — status UNKNOWN
 * @param {function} props.onFailure      ({code, reason}) — gateway said it failed
 */
export default function RazorpayCheckout({
  visible, keyId, orderId, amountPaise, buyerName, buyerPhone, description,
  onSuccess, onDismiss, onFailure,
}) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  // Razorpay fires `ondismiss` after a successful `handler` too. Without this
  // latch a completed payment would ALSO report as dismissed, and the app would
  // start hunting for a payment it had already confirmed.
  //
  // It holds the ORDER ID it settled, not a boolean, because this component is
  // reused across attempts: a farmer whose first booking failed and who tries a
  // second one gets a new gateway order on the same mounted instance. A boolean
  // would still be true, so that second attempt's `dismissed` — the one event
  // this whole flow exists to hear — would be swallowed at the guard below, and
  // the app would never ask the server whether the money actually moved.
  // Keyed on orderId, a new attempt starts unlatched while a retry of the SAME
  // order stays latched, which is the behaviour each case needs.
  const settledFor = useRef(null);

  const html = useMemo(
    () => buildHtml({
      keyId, orderId, amountPaise,
      name: buyerName, phone: buyerPhone, description,
    }),
    [keyId, orderId, amountPaise, buyerName, buyerPhone, description],
  );

  function handleMessage(event) {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }

    // Anything at all from the page means it is alive, so the "opening…"
    // overlay has done its job. Not left to onLoadEnd alone, which waits on the
    // window `load` event and so never arrives if the checkout script hangs.
    setLoading(false);

    const decision = routeCheckoutMessage(msg, { orderId, settledFor: settledFor.current });
    if (decision.settle !== undefined) settledFor.current = decision.settle;

    switch (decision.action) {
      case 'success': onSuccess?.(decision.payload); break;
      case 'failure': onFailure?.(decision.payload); break;
      // NOT a failure. The payment may well have gone through.
      case 'dismiss': onDismiss?.(); break;
      default: break;
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      // Hardware back must go through the same "we don't know" path as tapping
      // close, never silently cancel a payment that may have succeeded.
      onRequestClose={() => onDismiss?.()}
    >
      <View style={S.root}>
        <View style={S.bar}>
          <TouchableOpacity
            onPress={() => onDismiss?.()}
            hitSlop={12}
            style={S.close}
            accessibilityRole="button"
            accessibilityLabel={t('checkout.closePayment', 'Close payment')}
          >
            <Ionicons name="close" size={24} color={COLORS.textDark} />
          </TouchableOpacity>
          <Text style={S.title}>{t('checkout.securePayment', 'Secure payment')}</Text>
          <View style={S.close} />
        </View>

        <WebView
          originWhitelist={['*']}
          source={{ html, baseUrl: 'https://checkout.razorpay.com' }}
          onMessage={handleMessage}
          onLoadEnd={() => setLoading(false)}
          javaScriptEnabled
          domStorageEnabled
          // The UPI apps Razorpay hands off to open in their own activity.
          setSupportMultipleWindows={false}
          startInLoadingState
        />

        {loading ? (
          <View style={S.loading} pointerEvents="none">
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={S.loadingTxt}>{t('checkout.openingPayment', 'Opening secure payment…')}</Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const S = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8, paddingTop: 44, paddingBottom: 10,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 15, fontWeight: '800', color: COLORS.textDark },
  loading: {
    ...StyleSheet.absoluteFillObject, top: 100,
    alignItems: 'center', justifyContent: 'center', gap: 12,
    backgroundColor: COLORS.background,
  },
  loadingTxt: { fontSize: 14, color: COLORS.textMedium },
});
