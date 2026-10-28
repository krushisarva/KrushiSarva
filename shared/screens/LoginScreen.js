// ─────────────────────────────────────────────────────────────────────────────
// Auth flow — KrushiSarva design (ported from the Lovable "dharti-connect-hub" project).
// Three steps: WELCOME (pre-login) → PHONE (mobile entry) → OTP (6-digit verify).
// Shared by the farmer app and the seller app.
//
// Real OTP backend logic (sendOtp / verifyOtp) is preserved. The phone field is
// uncontrolled (ref-based) to dodge the New-Architecture Android caret-reset bug.
// A complete code verifies itself — the Verify button is the manual fallback.
//
// WHAT THIS FILE GUARANTEES, AND WHY EACH ONE BROKE BEFORE
//   Keyboard. Android runs edge-to-edge on Expo SDK 54, so the window is not
//     resized for the keyboard and the phone field sat under it. AuthSurface
//     now shrinks the scroll viewport by the covered height and scrolls the
//     field + its button into view (shared/utils/keyboardInset.js has the full
//     history). It stays mounted from PHONE to OTP, so a keyboard that is
//     already open when the code screen appears is still accounted for.
//   OTP cells. The code is ONE TextInput laid over six drawn cells. Six real
//     inputs had two faults: Android pads a TextInput by default, which clipped
//     a 28px digit inside a 43px box; and SMS autofill targets the focused
//     field, which after the first digit was a box with autofill switched off.
//   Autofill. iOS reads textContentType, Android reads autoComplete, the web
//     reads autocomplete="one-time-code" — all on the one input.
//   One spinner. "Verifying…" lives in the button only; the status box that
//     spun alongside it is gone.
//   Consent. The phone step used to end with "By continuing you agree to our
//     Terms & Privacy Policy", and the server recorded that agreement when the
//     account was created, though nobody had been asked. It is now a tick box
//     above Send OTP: never pre-ticked, never stored, and no code is requested
//     without it (sendOtpBlocker in shared/utils/otp.js).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Keyboard,
  Linking,
  Platform,
  Image,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, resendSeconds } from '../context/AuthContext';
import { isValidPhone, normalizePhone } from '../utils/validators';
import {
  activeOtpCell, arrivedWhole, isOtpComplete, sanitizeOtp, sendOtpBlocker, shouldAutoSubmitOtp, OTP_LENGTH,
} from '../utils/otp';
import { revealScrollOffset } from '../utils/keyboardInset';
import { useKeyboardRoom } from '../hooks/useKeyboardRoom';
import { KHET, KFONT, KSHADOW } from '../constants/khetTheme';
import { LEGAL_URLS } from '../constants/config';

const HERO = require('../assets/khet/welcome-hero.jpg');

const STEPS = { WELCOME: 'welcome', PHONE: 'phone', OTP: 'otp' };
const LANGS = ['हिन्दी', 'English', 'मराठी', 'தமிழ்', 'తెలుగు', 'ಕನ್ನಡ', 'বাংলা'];
const OTP_LEN = OTP_LENGTH;
// How long "Resend" stays disabled is provider-dependent and comes from
// AuthContext as `otpResendSeconds` (60 s on Firebase, 30 s on the dev OTP path);
// resendSeconds() there applies the safe fallback if it is ever missing. The
// hard-coded 30 that used to live here offered a Firebase resend at half the
// minute Google enforces — a tap that reports success and sends no SMS.

// Each platform reads a different hint; passing another platform's value logs
// a prop warning and switches autofill off.
const OTP_AUTOCOMPLETE = Platform.select({ ios: 'one-time-code', android: 'sms-otp', default: 'one-time-code' });

// Auto-submit is deliberately not instantaneous: the filled cells need a beat on
// screen so the farmer sees WHY the app moved on. Longer when the code arrived by
// itself, so the "Code filled in" banner is readable before it disappears.
const AUTO_SUBMIT_DELAY_MS = 350;
const AUTO_SUBMIT_DELAY_AUTOFILLED_MS = 900;

// Space kept between the revealed field/button block and the keyboard edge.
// Generous because Android reports the keyboard height once, when it opens: a
// suggestion strip appearing later makes the keyboard taller than reported.
const REVEAL_MARGIN = 24;

const IS_ANDROID = Platform.OS === 'android';
const IS_WEB = Platform.OS === 'web';

// Fully see-through, but NOT 'transparent' (which is the integer 0 on Android,
// the same value React Native uses for "no colour set"). On its own this did NOT
// hide the OTP input's digits on real Android phones: ReactEditText lays a
// highest-priority span of the view's own text colour over the whole text
// (addSpansFromStyleAttributes), and the digits still showed in black over the
// cells. What hides them is
// OTP_INPUT_OPACITY below; this stays so the text is clear wherever a colour
// does apply (iOS, web).
const INVISIBLE = 'rgba(255,255,255,0)';

// The OTP input is drawn at 1.1% opacity. View alpha applies to everything the
// field draws, whatever text colour Android picks, so the digits cannot show.
// Not 0: a view at alpha 0 counts as not visible to the user, and iOS and some
// Android autofill services then skip it — 0.011 is the value
// react-native-confirmation-code-field uses for exactly this reason.
const OTP_INPUT_OPACITY = 0.011;

// ── Web viewport lock ────────────────────────────────────────────────────────
// App.js pins html/body/#root to `height:auto; overflow:visible` so the app uses
// native document scroll. LoginScreen renders straight into #root (not inside a
// Stack.Navigator), so nothing above us bounds the height: a `flex:1` root grows
// to fit its content and the whole PAGE scrolls/overflows instead of the inner
// ScrollView. Clamping each step to the viewport makes the ScrollView the only
// scroll surface. No-op on native, where flex:1 already resolves to the screen.
function useViewportLock() {
  const { height } = useWindowDimensions();
  return IS_WEB ? { height, maxHeight: height, overflow: 'hidden' } : null;
}

// CSS flex children default to `min-height:auto` and refuse to shrink below
// their content, which defeats overflow:auto on the ScrollView. No-op on native.
const WEB_SHRINK = IS_WEB ? { minHeight: 0 } : null;

// `flexGrow:1` on the scroll content makes it exactly fill the parent on web —
// no overflow, so react-native-web never enables scrolling. Native still needs
// it so the footer text is pushed to the bottom on tall screens.
const SCROLL_GROW = IS_WEB ? { flexGrow: 0 } : null;

// Terms / Privacy open in the device browser. A failure is swallowed on
// purpose: this screen has no toast host, and a link that cannot open must
// never stand between someone and signing in.
function openLegal(url) {
  Linking.openURL(url).catch(() => {});
}

export default function LoginScreen() {
  const { sendOtp, verifyOtp, otpResendSeconds } = useAuth();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState(STEPS.WELCOME);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [resendIn, setResendIn] = useState(0);

  // Phone — uncontrolled (ref holds the live value; boolean drives the button).
  const phoneValueRef = useRef('');
  const [phoneReady, setPhoneReady] = useState(false);
  const [phoneFocused, setPhoneFocused] = useState(false);
  const [phoneDisplay, setPhoneDisplay] = useState(''); // STABLE snapshot for the field + OTP labels

  // Agreement to the Terms and Privacy Policy, ticked on the phone step. Plain
  // state on purpose: un-ticked on every mount and never stored, because the
  // server records it as consent given on this screen.
  const [consent, setConsent] = useState(false);
  const [consentError, setConsentError] = useState(false);

  // OTP — one string, drawn as six cells.
  const [code, setCode] = useState('');
  const [autoFilled, setAutoFilled] = useState(false);
  const otpInputRef = useRef(null);

  // The block (field + button) AuthSurface keeps above the keyboard.
  const revealRef = useRef(null);

  const codeRef = useRef(code);
  codeRef.current = code;
  const phoneDisplayRef = useRef(phoneDisplay);
  phoneDisplayRef.current = phoneDisplay;

  // Guards a double-submit: `loading` is async state, so the Verify tap and the
  // auto-submit timer can both pass a `loading` check inside the same tick.
  const verifyingRef = useRef(false);
  // Last code the auto-submitter fired for, so a re-render cannot resend it.
  const autoSubmittedRef = useRef(null);
  // Only the newest OTP request may update this screen.
  const sendAttemptRef = useRef(0);
  const mountedRef = useRef(true);
  // Re-armed in the effect body, not just cleared in the cleanup: React re-runs
  // effects without remounting (Fast Refresh, StrictMode), and a flag left at
  // `false` makes every later request drop its reply and never clear `loading`.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const otpComplete = isOtpComplete(code, OTP_LEN);

  // ── Resend countdown ───────────────────────────────────────────────────────
  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const id = setInterval(() => setResendIn((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [resendIn]);

  const resetCode = useCallback(() => {
    setCode('');
    setAutoFilled(false);
    autoSubmittedRef.current = null;
  }, []);

  // ── Step 2: verify OTP ─────────────────────────────────────────────────────
  const verify = useCallback(async () => {
    const submitted = codeRef.current;
    if (verifyingRef.current) return;
    if (!isOtpComplete(submitted, OTP_LEN)) return;
    verifyingRef.current = true;
    setLoading(true);
    setErrorMsg(null);
    try {
      await verifyOtp(phoneDisplayRef.current || phoneValueRef.current, submitted);
      // RootNavigator routes on success and this screen unmounts.
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorMsg(err.userMessage || err.response?.data?.error?.message || 'Invalid or expired code.');
      // Clear only the code that failed — it may have been replaced while the
      // request was in flight.
      setCode((current) => (current === submitted ? '' : current));
      setAutoFilled(false);
      // Clear the guard too: after a wrong code the farmer may well retype the
      // very same digits, and that attempt must be allowed to auto-submit again.
      autoSubmittedRef.current = null;
      requestAnimationFrame(() => otpInputRef.current?.focus());
    } finally {
      verifyingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [verifyOtp]);

  // ── Auto-submit on a complete code ─────────────────────────────────────────
  // Fires for every source — typed, pasted, SMS-autofilled and the dev fallback
  // OTP. shouldAutoSubmitOtp() plus verifyingRef make sure it and the Verify
  // button can never both land.
  useEffect(() => {
    if (step !== STEPS.OTP) return undefined;
    if (!shouldAutoSubmitOtp({ code, verifying: loading, lastSubmitted: autoSubmittedRef.current, len: OTP_LEN })) {
      return undefined;
    }
    const delay = autoFilled ? AUTO_SUBMIT_DELAY_AUTOFILLED_MS : AUTO_SUBMIT_DELAY_MS;
    const id = setTimeout(() => {
      autoSubmittedRef.current = code;
      verify();
    }, delay);
    return () => clearTimeout(id);
  }, [step, code, loading, autoFilled, verify]);

  // ── Step 1: send OTP ───────────────────────────────────────────────────────
  async function handleSendOtp({ isResend = false } = {}) {
    if (loading) return;
    const phone = phoneValueRef.current || phoneDisplay;
    // Nothing below this point runs without the tick: not a new code, not a
    // resend, and not the shortcut back to a code that is still fresh.
    const blocker = sendOtpBlocker({ phoneValid: isValidPhone(phone), agreed: consent });
    if (blocker === 'phone') {
      setErrorMsg('Enter a valid 10-digit mobile number.');
      return;
    }
    if (blocker === 'consent') {
      // Said next to the box rather than silently refused. The number is
      // complete, so the keyboard has nothing left to do: closing it leaves the
      // box, its message and the button in view together.
      setErrorMsg(null);
      setConsentError(true);
      if (!IS_WEB) Keyboard.dismiss();
      return;
    }
    if (resendIn > 0) {
      // Same number, code still fresh: go back to it instead of silently
      // ignoring the tap (the button used to do nothing for up to 30 s after
      // "Change").
      if (!isResend && phone === phoneDisplay) {
        setErrorMsg(null);
        setStep(STEPS.OTP);
        return;
      }
      if (isResend) return;
    }

    const attempt = ++sendAttemptRef.current;
    setLoading(true);
    setErrorMsg(null);
    try {
      const result = await sendOtp(phone);
      if (!mountedRef.current || attempt !== sendAttemptRef.current) return;
      // Android verified the number on the device (Firebase instant
      // verification): already signed in, no SMS is coming, and RootNavigator
      // is replacing this screen — so no code step to show.
      if (result?.signedIn) return;
      setPhoneDisplay(phone);
      setStep(STEPS.OTP);
      setResendIn(resendSeconds(otpResendSeconds));
      resetCode();
      // Demo mode: server returns the OTP when SMS is not configured — auto-fill.
      const devOtp = result?.data?.devOtp ?? result?.devOtp;
      if (devOtp && /^\d{6}$/.test(String(devOtp))) {
        setCode(String(devOtp));
        setAutoFilled(true);
      }
    } catch (err) {
      if (!mountedRef.current || attempt !== sendAttemptRef.current) return;
      const retryAfter = Number(err?.response?.headers?.['retry-after']);
      if (Number.isFinite(retryAfter) && retryAfter > 0) setResendIn(Math.min(Math.ceil(retryAfter), 300));
      setErrorMsg(err.userMessage || err.response?.data?.error?.message || 'Could not send OTP. Please try again.');
    } finally {
      if (mountedRef.current && attempt === sendAttemptRef.current) setLoading(false);
    }
  }

  function handlePhoneChange(v) {
    // Normalise first: strips spaces/punctuation and a pasted +91 country code or
    // leading-0 trunk prefix, then cap at the 10-digit national number. Pasting
    // "+91 98765 43210" or "098765 43210" now yields the correct number.
    const digits = normalizePhone(v).slice(0, 10);
    phoneValueRef.current = digits;
    const ready = digits.length === 10;
    setPhoneReady((r) => (r === ready ? r : ready));
    if (errorMsg) setErrorMsg(null);
  }

  function handleCodeChange(text) {
    const next = sanitizeOtp(text, OTP_LEN);
    const whole = arrivedWhole(codeRef.current, next, OTP_LEN);
    if (errorMsg) setErrorMsg(null);
    setCode(next);
    // More than one digit in a single change means the code arrived whole — an
    // SMS autofill, a keyboard suggestion or a paste. Flag it so the banner is
    // honest and the auto-submit waits long enough for it to be read.
    if (whole) setAutoFilled(true);
    else if (autoFilled) setAutoFilled(false);
  }

  function backToPhone() {
    // Abandoning the code screen abandons its pending send, so a late response
    // cannot drop someone who is now typing a different number back on it.
    sendAttemptRef.current += 1;
    // A resend still in flight now belongs to nobody and will not clear the
    // spinner itself — without this the Send button stayed disabled.
    if (!verifyingRef.current) setLoading(false);
    setStep(STEPS.PHONE);
    resetCode();
    setErrorMsg(null);
  }

  function backToWelcome() {
    // Same rule as backToPhone: leaving the step abandons its pending request.
    sendAttemptRef.current += 1;
    if (!verifyingRef.current) setLoading(false);
    setErrorMsg(null);
    setConsentError(false);
    setStep(STEPS.WELCOME);
  }

  function toggleConsent() {
    setConsent((ticked) => !ticked);
    // Either way the "tick this box" message has done its job: ticked, it is
    // answered; un-ticked again, the next tap on Send says so afresh.
    setConsentError(false);
  }

  if (step === STEPS.WELCOME) {
    return <WelcomeView insets={insets} onStart={() => setStep(STEPS.PHONE)} />;
  }

  const onOtp = step === STEPS.OTP;

  // One surface for PHONE and OTP: same element type in the same place, so it
  // stays mounted across the step change and keeps its keyboard state.
  return (
    <AuthSurface
      insets={insets}
      revealRef={revealRef}
      onBack={onOtp ? backToPhone : backToWelcome}
      headerRight={onOtp ? (
        <View style={sty.onlinePill}>
          <Ionicons name="wifi" size={12} color={KHET.primary} />
          <Text style={sty.onlinePillTxt}>Online</Text>
        </View>
      ) : <View style={{ width: 40 }} />}
      // No footer on the phone step: its "By continuing you agree…" line is now
      // the tick box above Send OTP, where agreement is given, not assumed.
      footer={onOtp
        ? <Text style={sty.footerTerms}>Didn't get the code? Check your SMS inbox or try again in a moment.</Text>
        : null}
    >
      {({ reveal }) => (onOtp ? (
        <OtpStep
          key="otp"
          loading={loading}
          errorMsg={errorMsg}
          code={code}
          inputRef={otpInputRef}
          revealRef={revealRef}
          autoFilled={autoFilled}
          phoneDisplay={phoneDisplay}
          resendIn={resendIn}
          complete={otpComplete}
          onBack={backToPhone}
          onChangeCode={handleCodeChange}
          onVerify={() => verify()}
          onResend={() => handleSendOtp({ isResend: true })}
          onFocusField={reveal}
        />
      ) : (
        <PhoneStep
          key="phone"
          loading={loading}
          errorMsg={errorMsg}
          phoneReady={phoneReady}
          phoneFocused={phoneFocused}
          phoneDisplay={phoneDisplay}
          revealRef={revealRef}
          consent={consent}
          consentError={consentError}
          onChange={handlePhoneChange}
          onFocus={() => { setPhoneFocused(true); reveal(); }}
          onBlur={() => setPhoneFocused(false)}
          onSubmit={() => handleSendOtp()}
          onToggleConsent={toggleConsent}
        />
      ))}
    </AuthSurface>
  );
}

// ── Reusable bits ────────────────────────────────────────────────────────────
function GradientButton({ label, sublabel, onPress, disabled, loading, style }) {
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onPress}
      disabled={disabled}
      style={[{ borderRadius: 18 }, style]}
      accessibilityRole="button"
      accessibilityLabel={sublabel ? `${label} ${sublabel}` : label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
    >
      <LinearGradient
        colors={KHET.gradPrimary}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[sty.gradBtn, disabled && sty.gradBtnDisabled]}
      >
        <Text style={sty.gradBtnTxt}>
          {label}
          {sublabel ? <Text style={sty.gradBtnSub}>{`  ${sublabel}`}</Text> : null}
        </Text>
        <View style={sty.gradBtnArrow}>
          {loading ? (
            <ActivityIndicator color={KHET.primaryForeground} size="small" />
          ) : (
            <Ionicons name="arrow-forward" size={16} color={KHET.primaryForeground} />
          )}
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function Blobs() {
  // Decorative only — never let them swallow taps meant for the form beneath.
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[sty.blob, { backgroundColor: KHET.primaryGlow, top: -96, left: -96 }]} />
      <View style={[sty.blob, { backgroundColor: KHET.primary, top: 160, right: -80, opacity: 0.1 }]} />
    </View>
  );
}

// ── Surface shared by PHONE and OTP ──────────────────────────────────────────
function AuthSurface({ insets, revealRef, onBack, headerRight, footer, children }) {
  const scrollRef = useRef(null);
  const lockViewport = useViewportLock();
  const keyboard = useKeyboardRoom(insets.bottom);
  const viewportRef = useRef(0);
  const scrollYRef = useRef(0);

  // Bring the step's field + button block into view above the keyboard. Only
  // while the keyboard is up; scrolls only if part of the block is hidden.
  const reveal = useCallback(() => {
    if (IS_WEB) return;
    requestAnimationFrame(() => {
      const block = revealRef.current;
      const scroller = scrollRef.current;
      if (!block || !scroller || !keyboard.visibleRef.current) return;
      const inner = scroller.getInnerViewRef?.();
      if (!inner || typeof block.measureLayout !== 'function') return;
      block.measureLayout(
        inner,
        (_x, y, _w, h) => {
          const target = revealScrollOffset({
            blockTop: y,
            blockHeight: h,
            viewportHeight: viewportRef.current,
            scrollY: scrollYRef.current,
            margin: REVEAL_MARGIN,
          });
          if (target != null) scroller.scrollTo({ y: target, animated: true });
        },
        () => {},
      );
    });
  }, [revealRef, keyboard.visibleRef]);

  // The viewport shrinks when room is made for the keyboard (Android padding
  // below, iOS KeyboardAvoidingView) — that is the moment the block can move.
  const onViewportLayout = useCallback((e) => {
    const h = e.nativeEvent.layout.height;
    const shrank = viewportRef.current > 0 && h < viewportRef.current - 1;
    viewportRef.current = h;
    if (shrank) reveal();
  }, [reveal]);

  const onScroll = useCallback((e) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  return (
    <LinearGradient
      colors={KHET.gradSurface}
      start={{ x: 0, y: 0 }}
      end={{ x: 0.7, y: 1 }}
      style={[sty.root, lockViewport]}
      onLayout={keyboard.onRootLayout}
    >
      <StatusBar style="dark" />
      <Blobs />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[{ flex: 1 }, WEB_SHRINK, IS_ANDROID ? { paddingBottom: keyboard.inset } : null]}
      >
        <ScrollView
          ref={scrollRef}
          style={[{ flex: 1 }, WEB_SHRINK]}
          contentContainerStyle={[
            sty.surfaceBody,
            SCROLL_GROW,
            // With the keyboard up the navigation bar is behind it, so the
            // bottom inset would only be dead space.
            { paddingTop: insets.top + 8, paddingBottom: keyboard.visible ? 16 : insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
          onLayout={onViewportLayout}
          onScroll={onScroll}
          scrollEventThrottle={32}
          showsVerticalScrollIndicator={false}
        >
          <View style={sty.surfaceHeader}>
            <TouchableOpacity
              onPress={onBack}
              style={sty.backCircle}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="arrow-back" size={16} color={KHET.foreground} />
            </TouchableOpacity>
            <View style={sty.brandRow}>
              <Ionicons name="leaf" size={15} color={KHET.primary} />
              <Text style={sty.brandTxt}>KrushiSarva</Text>
            </View>
            {headerRight}
          </View>

          {children({ reveal })}

          {footer}
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

// ── Welcome (pre-login) ──────────────────────────────────────────────────────
function WelcomeView({ insets, onStart }) {
  const lockViewport = useViewportLock();
  return (
    <View style={[sty.root, lockViewport]}>
      <StatusBar style="light" />
      <Image source={HERO} style={StyleSheet.absoluteFill} resizeMode="cover" />
      <LinearGradient
        colors={KHET.gradHero}
        locations={KHET.gradHeroLocs}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Top bar */}
      <View style={[sty.topbar, { paddingTop: insets.top + 8 }]}>
        <View style={sty.glassPill}>
          <Ionicons name="leaf" size={15} color={KHET.primaryGlow} />
          <Text style={sty.glassPillTxt}>KrushiSarva</Text>
        </View>
        <View style={sty.glassPill}>
          <Ionicons name="language" size={13} color="#fff" />
          <Text style={sty.glassPillTxt}>हिन्दी / EN</Text>
        </View>
      </View>

      {/* Bottom content panel — sits at the bottom over the hero when it fits.
          It is a ScrollView (not a fixed View) so that on short screens or with
          a large system font it scrolls below the top bar instead of
          overflowing upward underneath it. */}
      <ScrollView
        style={[{ flex: 1 }, WEB_SHRINK]}
        contentContainerStyle={[sty.welcomeBody, { paddingBottom: insets.bottom + 24 }]}
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
      >
        <Text style={sty.heroTitle}>
          Your farm,{'\n'}
          <Text style={sty.heroTitleItalic}>smarter every season.</Text>
        </Text>

        <Text style={sty.heroDesc}>
          Diagnose crop disease from a photo, talk to your personal AI agronomist, and track mandi prices — all in your language.
        </Text>

        <View style={sty.langRow}>
          {LANGS.map((l) => (
            <View key={l} style={sty.langChip}>
              <Text style={sty.langChipTxt}>{l}</Text>
            </View>
          ))}
          <View style={sty.langChip}>
            <Text style={[sty.langChipTxt, { opacity: 0.8 }]}>+3 more</Text>
          </View>
        </View>

        <View style={{ marginTop: 28 }}>
          <GradientButton label="Get started" sublabel="/ शुरू करें" onPress={onStart} />
        </View>

        <View style={sty.termsRow}>
          <Ionicons name="shield-checkmark" size={12} color="rgba(255,255,255,0.6)" />
          {/* A pointer to the documents, not agreement by tapping: agreement is
              the tick box on the next step. */}
          <Text style={sty.termsTxt}>
            Read our{' '}
            <Text style={sty.termsLink} accessibilityRole="link" onPress={() => openLegal(LEGAL_URLS.terms)}>Terms</Text>
            {' '}&{' '}
            <Text style={sty.termsLink} accessibilityRole="link" onPress={() => openLegal(LEGAL_URLS.privacy)}>Privacy Policy</Text>
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ── Phone (mobile entry) ─────────────────────────────────────────────────────
function PhoneStep({
  loading, errorMsg, phoneReady, phoneFocused, phoneDisplay, revealRef,
  consent, consentError, onChange, onFocus, onBlur, onSubmit, onToggleConsent,
}) {
  // Ten digits in, nothing left to type: the keyboard goes away so the tick box
  // and the button under it are in view (the code step does the same when its
  // six digits are in). Only on the CHANGE to ready: a number carried back from
  // the code step opens with the keyboard up, because it is about to be edited.
  // Not on web, where it would blur the field and lose Enter-to-submit.
  const wasReadyRef = useRef(phoneReady);
  useEffect(() => {
    if (phoneReady && !wasReadyRef.current && !IS_WEB) Keyboard.dismiss();
    wasReadyRef.current = phoneReady;
  }, [phoneReady]);

  return (
    <View style={{ marginTop: 24 }}>
      <View style={sty.accentPill}>
        <Ionicons name="shield-checkmark" size={11} color={KHET.primary} />
        <Text style={sty.accentPillTxt}>Secure OTP verification</Text>
      </View>

      <View style={sty.progressRow}>
        <LinearGradient colors={KHET.gradPrimary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={sty.progFill} />
        <View style={sty.progEmpty} />
        <Text style={sty.progTxt}>Step 1 of 2</Text>
      </View>

      <LinearGradient colors={KHET.gradPrimary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={sty.iconSquare}>
        <Ionicons name="call" size={24} color={KHET.primaryForeground} />
      </LinearGradient>

      <Text style={sty.title} accessibilityRole="header">
        What's your{'\n'}
        <Text style={sty.titleItalic}>mobile number?</Text>
      </Text>
      <Text style={sty.subtle}>We'll send a 6-digit OTP on your number to verify it's really you.</Text>
      <Text style={[sty.subtle, { marginTop: 4 }]}>आपका मोबाइल नंबर क्या है?</Text>

      <Text style={sty.fieldLabel}>MOBILE NUMBER</Text>
      {/* Kept above the keyboard as one block: the field, its message, the
          consent tick, and the button that sends the code. */}
      <View ref={revealRef} collapsable={false}>
        <View style={[sty.inputCard, phoneFocused && sty.inputCardFocused]}>
          <View style={sty.ccChip}>
            <Text style={{ fontSize: 16 }}>🇮🇳</Text>
            <Text style={sty.ccTxt}>+91</Text>
          </View>
          <TextInput
            style={sty.phoneInput}
            placeholder="98765 43210"
            placeholderTextColor={KHET.mutedForeground}
            keyboardType="number-pad"
            maxLength={15}
            defaultValue={phoneDisplay}
            onChangeText={onChange}
            onFocus={onFocus}
            onBlur={onBlur}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
            accessibilityLabel="Mobile number"
            autoFocus
          />
        </View>

        {errorMsg ? (
          <View style={sty.errorBox} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle" size={15} color={KHET.destructive} />
            <Text style={sty.errorTxt}>{errorMsg}</Text>
          </View>
        ) : (
          <View style={sty.privacyBox}>
            <Ionicons name="shield-checkmark" size={15} color={KHET.primary} />
            <Text style={sty.privacyTxt}>Used to sign you in and for your orders. We never sell it.</Text>
          </View>
        )}

        {/* The agreement the server records when the account is created. Asked
            for here, above the button it gates, and never pre-ticked. The box
            and the plain words of the label tick it; the two links only open
            their document. */}
        <View style={[sty.consentCard, consentError && sty.consentCardError]}>
          <View style={sty.consentRow}>
            <TouchableOpacity
              style={sty.consentHit}
              activeOpacity={0.7}
              onPress={onToggleConsent}
              disabled={loading}
              accessibilityRole="checkbox"
              accessibilityLabel="I agree to the Terms and Privacy Policy"
              accessibilityState={{ checked: !!consent, disabled: !!loading }}
            >
              <View style={[sty.consentBox, consent && sty.consentBoxOn, consentError && sty.consentBoxError]}>
                {consent ? <Ionicons name="checkmark" size={18} color={KHET.primaryForeground} /> : null}
              </View>
            </TouchableOpacity>
            <View style={sty.consentBody}>
              <Text style={sty.consentTxt} onPress={loading ? undefined : onToggleConsent}>
                I agree to the{' '}
                <Text style={sty.footerStrong} accessibilityRole="link" onPress={() => openLegal(LEGAL_URLS.terms)}>Terms</Text>
                {' '}and{' '}
                <Text style={sty.footerStrong} accessibilityRole="link" onPress={() => openLegal(LEGAL_URLS.privacy)}>Privacy Policy</Text>
              </Text>
              <Text style={sty.consentTxtAlt} onPress={loading ? undefined : onToggleConsent}>
                मैं नियम एवं शर्तों और गोपनीयता नीति से सहमत हूं
              </Text>
            </View>
          </View>
          {consentError ? (
            <View style={sty.consentErr} accessibilityRole="alert" accessibilityLiveRegion="polite">
              <Ionicons name="alert-circle" size={14} color={KHET.destructive} />
              <Text style={sty.consentErrTxt}>Tick this box to continue. / जारी रखने के लिए इस बॉक्स पर टिक करें।</Text>
            </View>
          ) : null}
        </View>

        <GradientButton
          label="Send OTP / OTP भेजें"
          onPress={onSubmit}
          loading={loading}
          disabled={loading || !phoneReady}
          style={{ marginTop: 16, opacity: !phoneReady && !loading ? 0.65 : 1 }}
        />
      </View>
    </View>
  );
}

// ── OTP (verify) ─────────────────────────────────────────────────────────────
function OtpStep({
  loading, errorMsg, code, inputRef, revealRef, autoFilled, phoneDisplay,
  resendIn, complete, onBack, onChangeCode, onVerify, onResend, onFocusField,
}) {
  // Six cells across the body width (48 = body padding, 5 gaps), capped so they
  // don't balloon on web/tablet and floored so a digit always fits.
  const { width } = useWindowDimensions();
  const cellSize = Math.max(40, Math.min(56, Math.floor((width - 48 - OTP_GAP * (OTP_LEN - 1)) / OTP_LEN)));
  const [focused, setFocused] = useState(false);

  // Once all six digits are in (typed, pasted or auto-filled), no more typing is
  // needed — hide the keyboard so the Verify button is in view.
  useEffect(() => { if (complete) Keyboard.dismiss(); }, [complete]);

  const masked = phoneDisplay ? `+91 ${phoneDisplay.slice(0, 5)} ${phoneDisplay.slice(5)}` : '+91 ••••• •••••';
  const mm = Math.floor(resendIn / 60).toString();
  const ss = (resendIn % 60).toString().padStart(2, '0');
  const active = activeOtpCell(code, OTP_LEN);

  return (
    <View style={{ marginTop: 24 }}>
      <View style={sty.progressRow}>
        <LinearGradient colors={KHET.gradPrimary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={sty.progFill} />
        <LinearGradient colors={KHET.gradPrimary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={sty.progFill} />
        <Text style={sty.progTxt}>Step 2 of 2</Text>
      </View>

      <Text style={sty.title} accessibilityRole="header">
        Enter the{'\n'}
        <Text style={sty.titleItalic}>6-digit code</Text>
      </Text>
      <Text style={sty.subtle}>
        Sent to <Text style={sty.subtleStrong}>{masked}</Text>
        <Text onPress={onBack} style={sty.changeLink} accessibilityRole="link">  Change</Text>
      </Text>

      <View ref={revealRef} collapsable={false}>
        {/* The cells only DRAW the code. The real input is laid over them, so a
            tap anywhere on the row focuses it and the OS autofill sees one
            field that takes the whole code. */}
        <View style={[sty.otpRow, { height: cellSize + 8 }]}>
          <View
            style={sty.otpCells}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            {Array.from({ length: OTP_LEN }, (_, i) => {
              const digit = code[i] || '';
              const isActive = focused && !loading && i === active && (!complete || i === OTP_LEN - 1);
              return (
                <View
                  key={i}
                  style={[
                    sty.otpCell,
                    { width: cellSize, height: cellSize + 8 },
                    digit ? sty.otpCellFilled : null,
                    isActive ? sty.otpCellActive : null,
                    errorMsg ? sty.otpCellError : null,
                  ]}
                >
                  {digit ? (
                    <Text style={sty.otpDigit}>{digit}</Text>
                  ) : isActive ? (
                    <View style={sty.otpCaret} />
                  ) : (
                    <View style={sty.otpDot} />
                  )}
                </View>
              );
            })}
          </View>

          <TextInput
            ref={inputRef}
            value={code}
            onChangeText={onChangeCode}
            onFocus={() => { setFocused(true); onFocusField?.(); }}
            onBlur={() => setFocused(false)}
            editable={!loading}
            keyboardType="number-pad"
            // Slack above six so a pasted "482 913" reaches onChangeText whole;
            // sanitizeOtp() trims it back to the digits.
            maxLength={OTP_LEN + 6}
            autoFocus={!code}
            caretHidden
            selectionColor={INVISIBLE}
            underlineColorAndroid="transparent"
            textContentType="oneTimeCode"
            autoComplete={OTP_AUTOCOMPLETE}
            importantForAutofill="yes"
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel={`Verification code, ${OTP_LEN} digits`}
            accessibilityHint={code ? `${code.length} of ${OTP_LEN} entered` : undefined}
            style={sty.otpInput}
          />
        </View>

        {autoFilled ? (
          <LinearGradient colors={KHET.gradPrimary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={sty.autofillBanner}>
            <Ionicons name="checkmark-circle" size={13} color={KHET.primaryForeground} />
            <Text style={sty.autofillTxt}>Code filled in</Text>
          </LinearGradient>
        ) : null}

        {errorMsg ? (
          <View style={sty.errorBox} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle" size={15} color={KHET.destructive} />
            <Text style={sty.errorTxt}>{errorMsg}</Text>
          </View>
        ) : null}

        {/* Resend */}
        <View style={{ marginTop: 18, alignItems: 'center' }}>
          {resendIn > 0 ? (
            <Text style={sty.subtle}>
              Resend OTP in <Text style={sty.subtleStrong}>{mm}:{ss}</Text>
            </Text>
          ) : (
            <TouchableOpacity onPress={onResend} disabled={loading} accessibilityRole="button">
              <Text style={[sty.resendLink, loading && { opacity: 0.5 }]}>Resend OTP / दोबारा भेजें</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* The only progress indicator while verifying. */}
        <GradientButton
          label={loading ? 'Verifying…' : 'Verify OTP'}
          onPress={onVerify}
          loading={loading}
          disabled={!complete || loading}
          style={{ marginTop: 24, opacity: !complete && !loading ? 0.65 : 1 }}
        />
      </View>
    </View>
  );
}

const OTP_GAP = 8;

const sty = StyleSheet.create({
  // overflow:hidden clips the decorative <Blobs/>, which sit at left:-96 / right:-80.
  // Without it they bleed past the screen edge and widen the scrollable area.
  root: { flex: 1, backgroundColor: KHET.background, overflow: 'hidden' },

  // ── Welcome ──
  // In normal flow (not absolute) so the body below can never slide under it.
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
  },
  glassPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  glassPillTxt: { color: '#fff', fontSize: 13, fontFamily: KFONT.sansSemi },
  welcomeBody: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 24, paddingTop: 16 },
  heroTitle: { color: '#fff', fontSize: 44, lineHeight: 46, fontFamily: KFONT.display, letterSpacing: -0.5 },
  heroTitleItalic: { color: KHET.primaryGlow, fontFamily: KFONT.displayItalic, fontStyle: 'italic' },
  heroDesc: { color: 'rgba(255,255,255,0.82)', fontSize: 15, lineHeight: 23, marginTop: 16, fontFamily: KFONT.sans },
  langRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 22 },
  langChip: {
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  langChipTxt: { color: 'rgba(255,255,255,0.88)', fontSize: 11, fontFamily: KFONT.sansMed },
  termsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 24 },
  // flexShrink so a large system font wraps the line inside the row instead of
  // pushing the shield icon past the screen padding.
  termsTxt: { flexShrink: 1, color: 'rgba(255,255,255,0.6)', fontSize: 11, fontFamily: KFONT.sans },
  termsLink: { color: '#fff', textDecorationLine: 'underline' },

  // ── Gradient button ──
  gradBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 18,
    paddingHorizontal: 22,
    paddingVertical: 16,
    ...KSHADOW.elegant,
  },
  gradBtnDisabled: { shadowOpacity: 0, elevation: 0 },
  // flexShrink so the long bilingual labels ("Send OTP / OTP भेजें") wrap inside
  // the button instead of pushing the arrow past the gradient's right edge.
  gradBtnTxt: { flexShrink: 1, color: KHET.primaryForeground, fontSize: 16, fontFamily: KFONT.sansSemi },
  gradBtnSub: { color: 'rgba(244,251,237,0.8)', fontSize: 13, fontFamily: KFONT.sans },
  gradBtnArrow: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Surface (phone / otp) ──
  surfaceBody: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 8 },
  blob: { position: 'absolute', width: 288, height: 288, borderRadius: 144, opacity: 0.18 },
  surfaceHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1,
    borderColor: KHET.border,
    alignItems: 'center',
    justifyContent: 'center',
    ...KSHADOW.soft,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  brandTxt: { color: KHET.foreground, fontSize: 14, fontFamily: KFONT.sansSemi },
  onlinePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 40,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(0,95,33,0.2)',
  },
  onlinePillTxt: { color: KHET.primary, fontSize: 11, fontFamily: KFONT.sansMed },

  accentPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: KHET.accent,
    borderWidth: 1,
    borderColor: 'rgba(0,95,33,0.2)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  accentPillTxt: { color: KHET.accentForeground, fontSize: 11, fontFamily: KFONT.sansSemi, letterSpacing: 0.3 },

  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 22, marginBottom: 28 },
  progFill: { flex: 1, height: 4, borderRadius: 2 },
  progEmpty: { flex: 1, height: 4, borderRadius: 2, backgroundColor: KHET.border },
  progTxt: { flexShrink: 1, color: KHET.mutedForeground, fontSize: 11, fontFamily: KFONT.sansMed },

  iconSquare: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center', ...KSHADOW.elegant },

  title: { color: KHET.foreground, fontSize: 36, lineHeight: 40, fontFamily: KFONT.display, letterSpacing: -0.5, marginTop: 26 },
  titleItalic: { color: KHET.primary, fontFamily: KFONT.displayItalic, fontStyle: 'italic' },
  subtle: { color: KHET.mutedForeground, fontSize: 14, lineHeight: 21, marginTop: 12, fontFamily: KFONT.sans },
  subtleStrong: { color: KHET.foreground, fontFamily: KFONT.sansSemi },
  changeLink: { color: KHET.primary, fontFamily: KFONT.sansSemi },

  fieldLabel: { color: KHET.mutedForeground, fontSize: 11, fontFamily: KFONT.sansBold, letterSpacing: 1, marginTop: 28, marginBottom: 8 },
  inputCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: KHET.card,
    borderRadius: 16,
    padding: 8,
    borderWidth: 1,
    borderColor: KHET.border,
    ...KSHADOW.soft,
  },
  inputCardFocused: { borderColor: KHET.primary, borderWidth: 2 },
  ccChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: KHET.secondary, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12 },
  ccTxt: { color: KHET.secondaryForeground, fontSize: 14, fontFamily: KFONT.sansSemi },
  phoneInput: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 12,
    fontSize: 18,
    color: KHET.foreground,
    fontFamily: KFONT.sansSemi,
    letterSpacing: 1,
    // The input card border shows focus; kill the web default outline.
    ...(IS_WEB ? { outlineStyle: 'none' } : null),
  },

  privacyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(201,242,192,0.6)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 16,
    borderWidth: 1,
    borderColor: 'rgba(0,95,33,0.1)',
  },
  privacyTxt: { flex: 1, color: KHET.accentForeground, fontSize: 12, lineHeight: 17, fontFamily: KFONT.sans },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(223,34,37,0.08)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 16,
    borderWidth: 1,
    borderColor: 'rgba(223,34,37,0.25)',
  },
  errorTxt: { flex: 1, color: KHET.destructiveInk, fontSize: 13, lineHeight: 18, fontFamily: KFONT.sansMed },

  footerTerms: { textAlign: 'center', color: KHET.mutedForeground, fontSize: 11, marginTop: 40, fontFamily: KFONT.sans, lineHeight: 16 },
  footerStrong: { color: KHET.foreground, fontFamily: KFONT.sansSemi, textDecorationLine: 'underline' },

  // ── Consent tick (phone step) ──
  consentCard: {
    backgroundColor: KHET.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: KHET.border,
    marginTop: 12,
  },
  consentCardError: { borderColor: KHET.destructive },
  consentRow: { flexDirection: 'row' },
  // The tick's own target: never under 48dp square, and as tall as the label
  // beside it once that wraps.
  consentHit: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  consentBox: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: KHET.mutedForeground,
    backgroundColor: KHET.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  consentBoxOn: { backgroundColor: KHET.primary, borderColor: KHET.primary },
  consentBoxError: { borderColor: KHET.destructive },
  // flex: 1 so the label wraps inside the card on a 320dp screen or at a large
  // system font instead of running past its edge.
  consentBody: { flex: 1, minHeight: 48, justifyContent: 'center', paddingVertical: 8, paddingRight: 12 },
  consentTxt: { color: KHET.foreground, fontSize: 13, lineHeight: 19, fontFamily: KFONT.sansMed },
  consentTxtAlt: { color: KHET.mutedForeground, fontSize: 12, lineHeight: 18, marginTop: 2, fontFamily: KFONT.sans },
  consentErr: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingLeft: 48,
    paddingRight: 12,
    paddingBottom: 10,
  },
  consentErrTxt: { flex: 1, color: KHET.destructiveInk, fontSize: 12, lineHeight: 17, fontFamily: KFONT.sansMed },

  // ── OTP cells ──
  otpRow: { marginTop: 32, justifyContent: 'center' },
  otpCells: { flexDirection: 'row', justifyContent: 'center', gap: OTP_GAP },
  otpCell: {
    borderRadius: 14,
    backgroundColor: KHET.card,
    // A visible edge on the pale green surface: the old 1px KHET.border was
    // close to invisible there, so an empty code field read as blank space.
    borderWidth: 1.5,
    borderColor: 'rgba(6,33,13,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    ...KSHADOW.soft,
  },
  otpCellFilled: { borderColor: KHET.primary, backgroundColor: '#f3fbef' },
  otpCellActive: { borderColor: KHET.primary, borderWidth: 2.5 },
  otpCellError: { borderColor: KHET.destructive },
  // Plus Jakarta Sans for lining numerals (Fraunces' old-style 3/4/5/7 dip below
  // the baseline). A Text in a View has no input padding to clip it, and
  // includeFontPadding:false keeps Android from adding its own above the glyph.
  otpDigit: {
    color: KHET.foreground,
    fontSize: 26,
    lineHeight: 32,
    fontFamily: KFONT.sansBold,
    textAlign: 'center',
    includeFontPadding: false,
  },
  otpCaret: { width: 2, height: 24, borderRadius: 1, backgroundColor: KHET.primary },
  otpDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(6,33,13,0.18)' },
  // Laid exactly over the cells: taps focus it, its text is invisible, and it
  // is still an ordinary on-screen field as far as autofill is concerned
  // (opacity 0 or an off-screen input is skipped by some autofill services).
  otpInput: {
    ...StyleSheet.absoluteFillObject,
    opacity: OTP_INPUT_OPACITY,
    color: INVISIBLE,
    backgroundColor: 'transparent',
    textAlign: 'center',
    fontSize: 16,
    padding: 0,
    ...(IS_WEB ? { outlineStyle: 'none', caretColor: 'transparent' } : null),
  },
  autofillBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 10,
    marginTop: 16,
    ...KSHADOW.soft,
  },
  autofillTxt: { color: KHET.primaryForeground, fontSize: 12, fontFamily: KFONT.sansMed },
  resendLink: { color: KHET.primary, fontSize: 14, fontFamily: KFONT.sansBold },
});
