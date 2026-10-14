# Firebase Phone Auth — production SMS login

## Why this exists

SMS to Indian numbers requires the sender to be registered on the telecom operators'
**DLT** platform (TRAI TCCCPR 2018). Firebase Phone Auth works because **Google** is
the DLT-registered sender: Google sends and verifies the SMS, and our backend only
checks the resulting ID token.

Firebase is the **only** production SMS sign-in, for the farmer app, the seller app
and the admin panel. The backend's own `/auth/send-otp` + `/auth/verify-otp` pair is
kept only as a local development/test login: it never sends an SMS, prints the code
to the backend log and returns it as `devOtp` so the app auto-fills it. Under
`NODE_ENV=production`, `/send-otp` returns 503 `OTP_DELIVERY_UNAVAILABLE`.

| | Dev OTP path (local only) | Firebase path |
|---|---|---|
| Who generates the OTP | We do (`crypto.randomInt`) | Google |
| Who sends the SMS | Nobody — logged and returned as `devOtp` | Google (already DLT-registered) |
| Who verifies the code | We do (bcrypt vs `OtpSession`) | Google |
| What our server checks | the 6-digit code | a Google-signed ID token |
| Endpoint | `POST /auth/verify-otp` | `POST /auth/firebase-login` |
| Brute-force lockout | `otpLockout.service.js` | same lockout, enforced on the token's phone |

## What you give up

Google, not us, checks the 6-digit code, so our per-attempt limits on *guessing* do
not apply — that is Firebase's abuse protection now.

The per-phone **lockout does apply**: `/firebase-login` calls `checkOtpLock(phone)`
once the token identifies the number and returns 423. Without that the two routes
were a lockout-evasion pair — burn through the `/verify-otp` attempts until the
number locks, then walk in through Firebase.

There is no fallback SMS provider: with `FIREBASE_AUTH_ENABLED` off, production has
no SMS sign-in at all.

---

## Setup

### 1. Firebase console (only you can do this)

1. Create a project at <https://console.firebase.google.com>
2. **Authentication → Sign-in method → Phone → Enable**
3. **Project settings → Your apps → Add app → Android**
   - Package name must match `android.package` in `frontend/app.json`
   - Add your **SHA-1 and SHA-256** fingerprints (debug *and* the EAS release keystore —
     phone auth fails with `auth/missing-client-identifier` without them)
   - Download `google-services.json` → save to `frontend/google-services.json`
4. **Project settings → Service accounts → Generate new private key** → downloads a JSON file

Get the EAS release fingerprints with:

```bash
cd frontend && npx eas credentials
```

### 2. Backend env

From the service-account JSON, copy three fields into `backend/.env`:

```
FIREBASE_AUTH_ENABLED=true
FIREBASE_PROJECT_ID=<project_id>
FIREBASE_CLIENT_EMAIL=<client_email>
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
```

Keep the literal `\n` sequences and the surrounding quotes — the service converts them
to real newlines. Restart the backend.

### 3. app.json — already applied

Both plugins and `android.googleServicesFile` are in `frontend/app.json`, and the
Android package is `com.krushisarva.app`. Nothing to do here.

Your Android package is `com.krushisarva.app` — the Firebase console app must use
**exactly** that string or phone auth fails at runtime.

Without `google-services.json` the Gradle build fails at the google-services step,
not at prebuild — so do step 1 first.

iOS additionally needs `GoogleService-Info.plist`, `ios.googleServicesFile`, and
`expo-build-properties` with `useFrameworks: "static"`. Skip it unless you ship iOS.

### 4. App env + rebuild

`frontend/.env`:

```
EXPO_PUBLIC_FIREBASE_AUTH=true
```

Then rebuild the dev client. **This will not work in Expo Go** — `@react-native-firebase/auth`
is a native module:

```bash
cd frontend
npx expo prebuild --clean
npx expo run:android
```

### 5. Test

Enter a real Indian mobile on the login screen. A real SMS should arrive within seconds.

To test without burning SMS quota, add a test number under
**Firebase console → Authentication → Sign-in method → Phone → Test phone numbers**.
Those pairs verify without sending anything.

---

## Files

| File | Change |
|---|---|
| `backend/src/services/firebaseAuth.service.js` | **new** — ID-token verification, lazy admin SDK init |
| `backend/src/services/authSession.service.js` | **new** — session issuance + fraud stack for a proven phone |
| `backend/src/routes/auth.routes.js` | **added** `POST /firebase-login` (existing routes untouched) |
| `backend/src/middleware/csrf.js` | `/auth/firebase-login` added to `PRE_AUTH_PATHS` |
| `backend/src/config/env.js` | `FIREBASE_*` keys (additive) |
| `shared/services/firebasePhoneAuth.js` | **new** — client wrapper, lazy native require |
| `shared/context/AuthContext.js` | `sendOtp`/`verifyOtp` branch on the flag; Firebase sign-out on logout |
| `shared/constants/config.js` | `FIREBASE_AUTH_ENABLED` flag |
| `backend/tests/backend/unit/firebaseAuth.test.js` | **new** — 13 tests, incl. the +91 gate and provider assertion |

`shared/screens/LoginScreen.js` needed **no changes** — the branch lives in
`AuthContext`, so the UI, resend timer and error handling are identical on both paths.

`AuthProvider` takes the Firebase adapter as a **`phoneAuth` prop**, injected by
`frontend/App.js` and `seller-app/App.js`. It is deliberately not imported inside
`shared/`, so nothing in the shared tree statically requires the native module. With
no adapter, or with `EXPO_PUBLIC_FIREBASE_AUTH` off (Expo Go, local dev),
`AuthProvider` uses the dev OTP path, which only works against a development backend.

## One shared implementation

`/verify-otp` and `/firebase-login` both call `issueSessionForVerifiedPhone()`.
There is no inline copy in either route, so a fix to the session/fraud/audit stack
lands on every login path at once. The 40 auth API integration tests cover it.

## Not done

- iOS builds are not configured: the RNFirebase plugin is in `app.json` but there is
  no `GoogleService-Info.plist` / `ios.googleServicesFile`. Android is unaffected;
  fix this before any iOS build.
