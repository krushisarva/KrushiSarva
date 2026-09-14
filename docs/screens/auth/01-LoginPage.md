# Login (KhetAI — Welcome · Phone · OTP)

> **Tab:** Auth/Onboarding · **Stack:** None — rendered directly by `App.js` (`RootNavigator`) when `!isLoggedIn`, outside any React Navigation navigator · **Route name:** none (top-level gate; internal steps `welcome` / `phone` / `otp`) · **File:** `shared/screens/LoginScreen.js` — the same screen in the farmer app (`frontend/App.js`) and the seller app (`seller-app/App.js`)

## Purpose
The **live, production auth screen** of the app. It is a single self-contained component implementing the full KhetAI three-step phone-OTP login: WELCOME (pre-login hero) → PHONE (10-digit mobile entry) → OTP (6-digit verify). It performs the real OTP backend round-trip (`sendOtp` / `verifyOtp` from `AuthContext`) and, on successful verification, lets `RootNavigator` route the user into onboarding or the main app. Used by every unauthenticated user on app open.

## Where it sits / how you reach it
- **Reached from:** `App.js` → `RootNavigator`: `if (!isLoggedIn) return <LoginScreen />;` (`App.js:51`). It is the default screen for any logged-out session (after the loading spinner resolves).
- **Navigates to:** No React Navigation calls. On `verifyOtp` success, `AuthContext` sets `isLoggedIn = true`; `RootNavigator` then re-renders into `OnboardingNavigator` (new users, `onboardingStep === 'BASIC'` and no farms) or `AppNavigator` (main tabs). Internal step transitions: WELCOME → PHONE (`Get started`), PHONE → OTP (after `Send OTP` succeeds), OTP → back to PHONE (`Change` / back arrow).
- **Route params in:** none (rendered without props).

## How it works
Internal step state machine via `useState` (`step` ∈ `welcome | phone | otp`, default `welcome`). `WelcomeView` renders on its own; PHONE and OTP render inside one `AuthSurface` (gradient, header, keyboard handling, scroll), which stays mounted across the step change so an already-open keyboard is still accounted for.

**Keyboard.** Expo SDK 54 builds Android edge-to-edge, so the window is not resized for the keyboard. On Android `AuthSurface` pads the scroll viewport by the covered strip (`keyboardDidShow` height + bottom inset, minus anything the window gave back — `shared/utils/keyboardInset.js`); on iOS `KeyboardAvoidingView` pads. When the viewport shrinks, or a field gains focus with the keyboard up, it scrolls the step's field-and-button block into view (`revealScrollOffset`) — never `scrollToEnd`, which pushed the field off the top of short screens.

Phone is **uncontrolled** — held in `phoneValueRef` (with `phoneReady` boolean + `phoneDisplay` snapshot) to avoid an Android New-Architecture caret-reset bug. `handlePhoneChange` normalises (strips +91 / leading 0 / punctuation) to ≤10 digits and toggles `phoneReady` at length 10.

`handleSendOtp({isResend})`: validates via `isValidPhone`, sets `loading`, calls `sendOtp(phone)`. On success: snapshots `phoneDisplay`, moves to OTP, starts a 30s resend countdown (`RESEND_SECONDS`), clears the code. Tapping Send again for the **same** number while the countdown runs returns to the code screen instead of doing nothing. **Demo mode:** a `devOtp` from the server fills the code. On error it reads `retry-after` to seed the countdown and surfaces `err.userMessage` / `err.response.data.error.message`. Leaving a step (Change, back) abandons its pending request.

**OTP entry** is ONE `TextInput` laid transparently over six drawn cells. A typed digit, a paste ("482 913"), a keyboard code suggestion and an SMS autofill all arrive as that input's text; `sanitizeOtp` keeps the digits. Autofill hints: `textContentType="oneTimeCode"` (iOS), `autoComplete="sms-otp"` (Android), `one-time-code` (web). A complete code verifies itself after 350 ms (900 ms when it arrived whole, so the "Auto-filled from SMS" banner is readable); the Verify button is the manual fallback and the two can never both fire. On failure the code clears and the input refocuses.

## UI elements

| Element | Type | Description / action |
|---|---|---|
| **WELCOME — hero image** | `Image` (welcome-hero.jpg) + `LinearGradient` overlay | Full-bleed background + green hero gradient |
| WELCOME — KhetAI brand pill | Glass pill (`leaf` icon + "KhetAI") | Brand badge, top-left |
| WELCOME — language pill | Glass pill (`language` icon + "हिन्दी / EN") | Static language indicator (no handler) |
| WELCOME — AI badge pill | Pill (`sparkles`) | "Powered by on-device AI · 2,00,000+ farmers" |
| WELCOME — hero title / desc | `Text` | "Your farm, smarter every season." + description |
| WELCOME — language chips row | Chips from `LANGS` (7) + "+3 more" | Shows supported languages (हिन्दी, English, मराठी, தமிழ், తెలుగు, ಕನ್ನಡ, বাংলা) |
| WELCOME — Get started button | `GradientButton` (`label="Get started"`, sublabel "/ शुरू करें", `arrow-forward`) | → `onStart` → step = PHONE |
| WELCOME — terms row | `shield-checkmark` icon + `Text` | "By continuing you agree to our Terms & Privacy" |
| **PHONE — back button** | `TouchableOpacity` (`arrow-back` in circle) | → step = WELCOME |
| PHONE — brand row | `leaf` icon + "KhetAI" | Header brand |
| PHONE — accent pill | `sparkles` + "Secure AI verification" | Trust badge |
| PHONE — progress row | Two bars + "Step 1 of 2" | Step indicator |
| PHONE — title | `Text` | "What's your mobile number?" |
| PHONE — country-code chip | `🇮🇳` + "+91" | Fixed dial code |
| PHONE — phone input | `TextInput` (`number-pad`, `maxLength=10`, uncontrolled `defaultValue`, `autoFocus`) | Enters 10-digit number; `onSubmitEditing` → send |
| PHONE — privacy box | `shield-checkmark` + `Text` | "Your number stays private…" (shown when no error) |
| PHONE — error box | `alert-circle` + `Text` | Inline error (replaces privacy box) |
| PHONE — Send OTP button | `GradientButton` ("Send OTP / OTP भेजें", spinner when loading, disabled until `phoneReady`) | → `handleSendOtp()` |
| PHONE — footer terms | `Text` (Terms / Privacy bold) | Legal microcopy |
| **OTP — back button** | `TouchableOpacity` (`arrow-back`) | → `backToPhone` |
| OTP — online pill | `wifi` + "Online" | Connectivity badge (static) |
| OTP — progress row | Two filled bars + "Step 2 of 2" | Step indicator |
| OTP — title + masked number | `Text` | "Enter the 6-digit code", "Sent to +91  XXXXX XXXXX" + **Change** link → back |
| OTP — code cells | 6 drawn `View` cells + one transparent `TextInput` over them (`number-pad`, autofill hints) | Digits, a caret in the next empty cell while focused, red edge on error |
| OTP — auto-fill banner | `LinearGradient` (`sparkles` + "Auto-filled from SMS") | Shown when the code arrived whole (SMS, suggestion, paste, devOtp) |
| OTP — error box | `alert-circle` + `Text` | Invalid/expired code message |
| OTP — resend countdown / link | `Text` "Resend OTP in m:ss" → `TouchableOpacity` "Resend OTP / दोबारा भेजें" | Countdown then resend (`handleSendOtp({isResend:true})`) |
| OTP — Verify button | `GradientButton` ("Verify OTP" → "Verifying…", disabled until complete) | → `verify()`. Its spinner is the **only** progress indicator while verifying |
| OTP — footer hint | `Text` | "Didn't get the code? Check your SMS inbox…" |
| Decorative blobs | `Blobs` (two soft circles) | Background décor on PHONE/OTP |
| Status bar | `StatusBar` (`light` on welcome, `dark` on phone/otp) | Themed status bar |

## Services, APIs & data
- **API endpoints:**
  - `POST /auth/send-otp` via `AuthContext.sendOtp` → `api.post('/auth/send-otp', { phone })` (with transparent 428 proof-of-work retry, sending `x-otp-pow` header).
  - `POST /auth/verify-otp` via `AuthContext.verifyOtp` → `api.post('/auth/verify-otp', { phone, otp })`, which stores `accessToken`/`refreshToken`/`userId` and sets the user.
  - (Base URL prefix `/api/v1` is applied by `services/api.js`.)
- **Backend route/service:** `backend/src/routes/auth.routes.js` — `POST /api/v1/auth/send-otp` (rate-limited per-IP & per-phone, proof-of-work gate) and `POST /api/v1/auth/verify-otp` (returns tokens + `user`, `isNewUser`, optional `stepUp`).
- **State / context:** `useAuth()` (`AuthContext`) for `sendOtp`/`verifyOtp`; local `useState`/`useRef` for step, loading, errors, phone (uncontrolled ref), OTP digits, resend countdown, autofill. `useSafeAreaInsets()` for padding.
- **Local / static data:** `STEPS`, `LANGS` (7 languages), `OTP_LEN=6`, `RESEND_SECONDS=30`, `HERO` image require, `KHET`/`KFONT`/`KSHADOW` from `constants/khetTheme`. Validators `isValidPhone`, `isValidOtp` from `utils/validators`.

## Languages / i18n
This screen does **not** use the app's `LanguageContext`/`t()` — all copy is hardcoded bilingual English+Hindi inline (e.g. "Send OTP / OTP भेजें", "Resend OTP / दोबारा भेजें", "आपका मोबाइल नंबर क्या है?"). The `LANGS` array advertises 7 Indian languages as static chips on the welcome view, but the screen itself is fixed bilingual EN/HI text.

## Notes, edge cases & gaps
- **This is the wired auth screen** (App.js gate in both apps). The parallel `LoginFlow`/`Landing`/`PhoneEntry`/`OtpVerification` design-system set is not used by the app.
- **Demo/dev OTP:** if the backend returns `devOtp` (SMS unconfigured), the code fills in, the banner appears, and it verifies itself after the 900 ms pause.
- **Rate limiting:** on a `send-otp` error with a `retry-after` header, the resend countdown is seeded from it (clamped to ≤300s). Backend enforces per-IP and per-phone OTP limits (429) plus a proof-of-work 428 challenge under suspicion (handled transparently in `AuthContext`).
- **Phone field is uncontrolled** (ref-based `defaultValue`) specifically to dodge an Android New-Architecture caret-reset bug.
- Keyboard auto-dismisses once 6 OTP digits are present so the Verify button is revealed.
- **Android SMS autofill** comes from the keyboard's own code suggestion (`autoComplete="sms-otp"`); the screen does not read SMS itself.
- New users are routed to onboarding by `RootNavigator` based on `user.onboardingStep === 'BASIC'` && `!user.totalFarms`.
- Errors are surfaced from `err.userMessage` or `err.response.data.error.message` with plain-language fallbacks; no offline-specific UI beyond the generic error copy.
