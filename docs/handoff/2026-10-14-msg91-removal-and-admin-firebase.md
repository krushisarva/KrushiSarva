# Handoff — MSG91 removal + admin Firebase login (2026-10-14)

What one Claude Code session did on 2026-10-14, written so another session can pick up without the transcript. All facts were checked that evening.

## 1. Owner decision

- **MSG91 is out for good.** The owner will not use it, now or after DLT registration. Do not suggest MSG91, DLT templates or another SMS vendor as a fix for login.
- **Firebase Phone Auth is the only production SMS sign-in** for the farmer app, the seller app and the admin panel. Google sends and verifies the SMS. The client posts the Firebase ID token to `POST /api/v1/auth/firebase-login`, and the admin panel adds `audience: 'admin'`.
- **`/auth/send-otp` + `/auth/verify-otp` are kept only as the local development login.** They send no SMS. The code is logged and returned as `devOtp` for auto-fill. With `NODE_ENV=production`, `/send-otp` returns 503 `OTP_DELIVERY_UNAVAILABLE`.

## 2. What was merged

| PR | Commit | What |
|---|---|---|
| #16 `chore/remove-msg91` | `5ca0c2c` (merge `97d360a`) | MSG91 removed from all 35 files that mentioned it (this session) |
| #17 `chore/admin-headers-dockerfile` | `09ff19d` (merge `f142b72`) | Built on #16 by session `krushisarva-87`. Drops the admin build stage from the root Dockerfile, adds `admin/` to `.dockerignore`, widens the `admin/vercel.json` header source to `/(.*)` |

Earlier the same day, from `krushisarva-87`: #14 (Caddy redirects `/admin*` to Vercel, compose drops `VITE_FIREBASE_*`) and #15 (`admin/vercel.json` proxies `/api/*` to the VPS).

### Inside #16

- `backend/src/services/otp.service.js`: the MSG91 sender and the axios import are deleted. The guard is now `if (!ENV.IS_DEV)` → 503.
- `backend/src/config/env.js`:
  - `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` and `MSG91_SENDER_ID` are removed.
  - `OTP_DEV_BYPASS` (accepts `000000`) now needs both `OTP_DEV_BYPASS_ENABLED=true` and `NODE_ENV !== 'production'`. The old "no MSG91 key" condition is gone.
- `backend/src/server.js`: the boot warning checks `FIREBASE_AUTH_ENABLED` instead of the MSG91 key.
- `backend/src/services/settings.service.js`: in `ENV_MANIFEST` ("SMS / OTP"), the MSG91 keys are replaced by `FIREBASE_AUTH_ENABLED`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` (secret). That makes 24 entries.
- `backend/legal/privacy.html`: the MSG91 sub-processor row is removed. Firebase was already listed.
- Comments, both `.env.example` files, the Dockerfile comment, tests and docs:
  - Firebase is now described as permanent, not "until DLT".
  - `ARCHITECTURE.md`, `docs/FIREBASE_PHONE_AUTH.md`, `README.md` and `frontend/README.md` are updated.
  - `docs/deploy/VPS_DEPLOY_PLAN.md` (§10 step 5, decision 1) and `admin/README.md` now say the admin panel lives only on Vercel.
- Tests run before merge, all passing:
  - Backend (otp, firebaseAuth, auth.api, adminFirebaseLogin, authSessionEnd, phoneValidation, otpLockout, csp): 8 suites, 108 tests.
  - `shared/context/__tests__/AuthContext.test.js`: 16 tests.
  - Admin `tsc --noEmit`: clean.

## 3. Production state (VPS `https://srv2061596.hstgr.cloud`)

- `krushisarva-87` deployed main `f142b72` using `/root/update.sh`.
- Spot-checks from outside:
  - `/healthz` → 200.
  - `POST /api/v1/auth/send-otp` → 503.
  - `/admin/` → 302 to `https://krushi-sarva.vercel.app/admin/`.
- Backend env:
  - `FIREBASE_AUTH_ENABLED=true`, and all 3 service-account keys are set.
  - Firebase project: `krushisarva-b234d`.
  - No MSG91 variables.

## 4. Admin panel (Vercel `https://krushi-sarva.vercel.app`)

- **Done:**
  - The owner added the 4 `VITE_FIREBASE_*` values in Vercel and redeployed.
  - The live bundle (`/admin/assets/index-BHDG6tvl.js`) contains the real config, and the project matches the backend (`krushisarva-b234d`).
  - The bundle before that (`index-CPttQdeV.js`) had empty values. That build fell back to `/send-otp` and got 503.
- **Open at the time of writing — this blocks admin login:**
  - `krushi-sarva.vercel.app` was **not** in the Firebase authorized domains.
  - Identity Toolkit returned only `localhost`, `krushisarva-b234d.firebaseapp.com` and `krushisarva-b234d.web.app`.
  - The owner was told to add it: Firebase console → Authentication → Settings → Authorized domains.
  - Then test the admin login with the first admin's phone (in Claude's `hostinger-vps` memory; kept out of this file because the repo is public).
  - To re-check the list: `GET https://identitytoolkit.googleapis.com/v1/projects?key=<web apiKey from the bundle>`. Send `Referer: https://krushi-sarva.vercel.app/`.
- `vercel.json` sets no CSP, so reCAPTCHA is not blocked there.

## 5. Local repo

- On `main` at `f142b72`, working tree clean. This handoff file is the only uncommitted change.
- Run `cd admin && npm install` before running the admin panel locally: the admin Firebase login (#13) added the `firebase` package.
- Stashes:
  - `stash@{0}` "msg91 removal (pre-branch)" is left over from moving the work to a new branch. Its content is merged, so it is safe to drop.
  - `stash@{1}` "stray prisma 7 bump" predates this session and was not touched.
- The `gh` CLI is not installed. PRs were opened by the owner from a pre-filled GitHub compare link. `winget install GitHub.cli` + `gh auth login` would let a session open PRs itself.

## 6. Still owed (not touched here)

1. **App cutover.** Installed APKs still point at the old, dead host URL. The fix is an OTA (over-the-air update) to both apps. The shell env for `eas update` must include `EXPO_PUBLIC_FIREBASE_AUTH=true`; without it, login falls back to the dev OTP path and gets 503 in production.
2. The Razorpay webhook URL must point at the VPS.
3. A Hostinger snapshot.
4. An off-box backup: the rclone remote `ksbackup` and the healthchecks.io ping.

## 7. Rules that still apply

- Never run `prisma db push` on production (FastAPI owns tables). Use reviewed `migrate diff` SQL only.
- Never run the backend publicly with `NODE_ENV` other than `production`. The dev OTP path returns `devOtp` to anyone, which is an open sign-in bypass.
- Claude memory files updated this session: `no-msg91-firebase-only-sms.md`, `hostinger-vps.md`, `local-test-logins.md`.
