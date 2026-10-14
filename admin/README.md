# KrushiSarva Admin Panel

Web SPA (React + Vite + TypeScript + Tailwind + TanStack Query) for operating every
domain of KrushiSarva through the **ADMIN-gated, audited** `/api/v1/admin/*` API.

It reuses the platform's existing auth unchanged: **phone OTP → JWT (access in
memory) + httpOnly refresh cookie + CSRF double-submit**, with silent refresh-rotation
and an idle-timeout auto-logout. A non-ADMIN account is hard-rejected (and the server
enforces ADMIN on every route regardless of the UI).

---

## 1. Seed an ADMIN user

Admins log in with phone OTP like any user — they just need the `ADMIN` role. From
`backend/`:

```bash
npm run db:seed:admin -- 9876543210      # creates or promotes that phone to ADMIN
```

(Use the 10-digit form the OTP flow normalises to.) Then sign in at the admin app
with that number and the OTP.

> Local dev tip: a development backend never sends an SMS from `/auth/send-otp`. It
> prints the code to the backend log and returns it as `devOtp`, which the login
> screen auto-fills. With `OTP_DEV_BYPASS_ENABLED=true` (non-production only) the
> OTP `000000` is also accepted.

## 2. Configure & run the admin app

From `admin/`:

```bash
cp .env.example .env       # then edit if needed
npm install
npm run dev                # http://localhost:5180/admin/  (served under /admin)
```

> The app is served under **`/admin`** (Vite `base` + router `basename`) so the
> backend can host the production build same-origin. See
> [`docs/ADMIN_DEPLOY_RAILWAY.md`](../docs/ADMIN_DEPLOY_RAILWAY.md) for the Railway
> deploy (the backend serves `admin/dist` at `/admin` — no separate service).

### Environment variables (`admin/.env`)

| Var | Default | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | `/api/v1` | Base path the client calls (`${VITE_API_URL}/admin/*`, `/auth/*`). Keep relative to use the dev proxy / a same-origin reverse proxy in prod. Set to an absolute origin only if the admin app is served from a **different** origin than the API. |
| `VITE_API_PROXY` | `http://localhost:3000` | Dev only — where `vite dev` proxies `/api` to your running backend. |
| `VITE_ENV_NAME` | `local` | Shown in the top-bar environment badge (`local` / `staging` / `production`). |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | empty | Firebase **web** app config (public, not secrets). All four set → Firebase phone login; any empty → the dev OTP flow, which only works against a development backend. See [Firebase phone login](#firebase-phone-login). |
| `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_STORAGE_BUCKET` | empty | Optional; not used by phone auth, accepted so the console snippet can be pasted whole. |

In dev, Vite proxies `/api` → the backend, so the browser stays **same-origin** and
cookies + CSRF "just work" with no CORS. For production behind a reverse proxy, serve
the built `admin/dist` and proxy `/api` to the backend the same way.

## 3. Backend setup for the admin app

The admin API lives in `backend/src/routes/admin/*` and is mounted at
`/api/v1/admin` (in `backend/src/app.js`). Two things to know:

- **CORS** — only needed if the admin SPA is on a **different origin** than the API.
  Add that origin to the backend's `ALLOWED_ORIGINS` (comma-separated) in
  `backend/.env`, e.g.:

  ```env
  ALLOWED_ORIGINS=https://admin.cropsetu.app
  ```

  If you serve the admin app same-origin (recommended — dev proxy or a prod reverse
  proxy), no `ALLOWED_ORIGINS` change is required.

- The backend keeps its existing OTP + JWT + CSRF + cookie auth **unchanged**. The
  admin client sends `X-Auth-Transport: cookie`, `withCredentials`, and the
  `X-CSRF-Token` header on mutations — the same contract the mobile web build uses.

## Firebase phone login

Firebase phone auth is the only production SMS sign-in: the backend's
`/auth/send-otp` never sends an SMS and returns 503 in production. The farmer and
seller apps sign in with Firebase, where Google sends the SMS, and the admin panel
signs in the same way.

**How it works.** When the build has the four required `VITE_FIREBASE_*` values,
the login screen:

1. sends the SMS through Firebase after an invisible reCAPTCHA check;
2. confirms the code;
3. posts the Firebase ID token to the same `POST /api/v1/auth/firebase-login`
   route the apps use, with `audience: "admin"`.

On the server:

- If the phone's existing account is **not** ADMIN (including a number with no
  account), the server answers `403 NOT_ADMIN`. It creates nothing: no user, no
  consent row, no refresh token, no cookies. The attempt is written to the
  audit log as `AUTH_LOGIN_BLOCKED`.
- The SMS behind the token must be recent: its `auth_time` must be within
  `FIREBASE_REAUTH_MAX_AGE_SECONDS` (default 300 s), the same check
  `/auth/change-phone` uses. So a long-lived Firebase session (for example the
  farmer app signed in on an admin's phone) cannot mint an admin session
  without a new SMS. An older token gets `401` "request a new code".
- An ADMIN gets exactly the OTP path's session: httpOnly refresh cookie + CSRF,
  refresh rotation, `isActive` / `tokenVersion` checks, scopes read from the
  DB, and the idle logout.

Without the values, the build uses the backend's dev OTP flow (`/auth/send-otp` +
`/auth/verify-otp`), which only works against a development backend. When
Firebase is on, the login screen never calls `/auth/send-otp`.

> **Keep `FIREBASE_AUTH_ENABLED=true` on the production backend.** An admin
> image built with the `VITE_FIREBASE_*` values logs in **only** through
> Firebase. If the backend flag is off while that image is running, the browser
> blocks the reCAPTCHA script (the CSP no longer allows it) and
> `/auth/firebase-login` returns 503, so **no admin can log in**. An image built
> without the values does not help either: in production its `/auth/send-otp`
> returns 503 too.

**One-time owner setup**

1. **Register a Web app.** This repo has no Firebase web config. Only the
   Android `google-services.json` files exist, for `com.krushisarva.app` and
   `com.krushisarva.seller`.
   - In the Firebase console, open project **`krushisarva-b234d`**. The apps and
     the backend's `FIREBASE_PROJECT_ID` use this project. Go to Project
     settings → Your apps → Add app → **Web**.
   - Copy `apiKey`, `authDomain` (`krushisarva-b234d.firebaseapp.com`),
     `projectId` and `appId`.
   - It must be the same project, or the backend rejects every token on
     audience.
   - Do not reuse the Android API key.
2. **Phone sign-in.** Check that Authentication → Sign-in method → Phone is
   enabled. It already is for the apps.
3. **Authorized domains.** In Authentication → Settings → Authorized domains,
   add **`srv2061596.hstgr.cloud`** and any other host that serves `/admin`.
   `localhost` is listed by default, which covers `http://localhost:5180/admin/`
   and `http://localhost:3001/admin`. Without this step the reCAPTCHA / SMS
   request is refused.
4. **API key restrictions: by API, never by HTTP referrer.** The backend sends
   `Referrer-Policy: no-referrer` (helmet's default), so the browser sends no
   `Referer` header to Google. A key restricted by **HTTP referrers** then
   refuses every call ("requests from referer <empty> are blocked") and the
   login breaks. If you restrict the web API key in Google Cloud → APIs &
   Services → Credentials, use **API restrictions** only and allow at least:
   - Identity Toolkit API
   - Token Service API
5. **Build with the values.**
   - Local: put them in `admin/.env`.
   - Docker: the root `Dockerfile` stage 1 takes them as build args, for
     example `docker build --build-arg VITE_FIREBASE_API_KEY=… --build-arg VITE_FIREBASE_AUTH_DOMAIN=… --build-arg VITE_FIREBASE_PROJECT_ID=… --build-arg VITE_FIREBASE_APP_ID=… .`
   - The args default to empty, so a build without them uses the dev OTP flow
     and cannot log in to a production backend.
   - Vite inlines the values at build time, so changing them needs a rebuild.
   - Docker may warn `SecretsUsedInArgOrEnv` about `…_API_KEY`. That is a false
     positive: a Firebase web API key is public.
6. **Backend env on the server.** Set the same values the apps need:
   `FIREBASE_AUTH_ENABLED=true`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`
   and `FIREBASE_PRIVATE_KEY`.
   - `FIREBASE_AUTH_ENABLED=true` also adds Google's reCAPTCHA and
     identitytoolkit / securetoken origins to the CSP of the `/admin` page only
     ([`backend/src/utils/csp.js`](../backend/src/utils/csp.js)). Every other
     response keeps the normal CSP. Without the flag the browser blocks the
     reCAPTCHA script.
   - On the VPS, `ALLOWED_ORIGINS` must include `https://srv2061596.hstgr.cloud`.
     The backend only treats Railway domains as its own origin, and it refuses
     a browser POST whose `Origin` it does not know. This applies to the dev OTP
     flow too.
7. **Limit SMS abuse.** Firebase sends the SMS straight from the browser, so
   the backend's OTP limiters and proof-of-work gate never see a send. Only
   Firebase's own controls apply:
   - Authentication → Settings → **SMS region policy**: allow **India (IN)**
     only. This stops SMS pumping to foreign numbers, billed to the project.
   - Turn on **reCAPTCHA Enterprise SMS defense** (or App Check for the web app)
     if your plan offers it.
   - Set a **budget alert** in Google Cloud Billing that covers Identity Platform
     SMS.

   These protect the farmer and seller apps too, which use the same project.

> **Never add a real admin's number under *Phone numbers for testing* in this
> project.** Test numbers are project-wide and work in production. A test
> number's fixed code produces a normal phone token for that number, so the
> admin login would become a fixed, shared code that never rotates and never
> touches the handset. Anyone who can read the console's auth settings could
> use it. This project is the one the backend trusts, so the same is true for
> the apps.
>
> To test the admin login without SMS, use a separate dev Firebase project and
> a dev backend pointed at it. If you must use a test number in this project,
> use a fictional number that belongs to no real person, make sure its account
> is **not** an ADMIN in the production database, and delete the test number
> straight after.

## 4. Build

```bash
npm run typecheck     # tsc, no emit
npm run build         # tsc -b && vite build  → admin/dist
npm run preview       # serve the production build locally
```

### Hosting on Vercel (https://krushi-sarva.vercel.app)

The admin panel is built for one origin with the API (cookies are `SameSite=Lax`,
`backend/src/utils/cookies.js`), so [vercel.json](vercel.json) makes Vercel look
like that origin to the browser:

- `/api/*` is proxied to the VPS backend (`https://srv2061596.hstgr.cloud/api/*`),
  so login cookies are first-party for the Vercel domain. Socket.IO is not
  proxied; the admin panel does not use it.
- The build goes to `out/admin`, matching Vite's `base: '/admin/'`; `/` redirects
  to `/admin/`, and any `/admin/*` route falls back to `index.html`.

Vercel project settings: root directory `admin`. Env vars: leave `VITE_API_URL`
**unset** (the default `/api/v1` goes through the proxy) and set the four
`VITE_FIREBASE_*` values from the section above. Add `krushi-sarva.vercel.app`
under Firebase → Authentication → Authorized domains. The backend must list
`https://krushi-sarva.vercel.app` in `ALLOWED_ORIGINS`.

Known limit: the backend sees Vercel's servers, not the admin's own IP, so every
admin shares the per-IP limits (global 200 requests / 15 min). That is fine for a
few admins.

---

## What's inside

Left nav grouped by phase, ⌘K command palette, global toasts, and confirm-+-reason
dialogs for every destructive action.

- **Dashboard** — KPI cards + time-series (signups, GMV, AI tokens), API-health, and
  deep-link counters for pending moderation / open incidents / breach-SLA.
- **Users** — search + filters; detail page with **masked PII**, an audited
  **Reveal** (reason required), consents, audit trail, and role / deactivate /
  force-logout actions.
- **KYC / Sellers** — review queue, audited document access (short-lived signed
  URLs), masked bank/ID with audited reveal, verify / reject.
- **Marketplace** — categories CRUD (multilingual), products (approve / feature /
  stock / remove), reviews.
- **Orders** — filters, detail, status / payment / refund.
- **Rentals & Trade** — animals / machinery / labour moderation + bookings.
- **Community** — posts (pin / soft-delete / restore), comments, groups.
- **AI Ops** — usage & cost, per-user credit ledger with manual grant/deduct (reason
  required), disease-feedback retrain queue, report analytics.
- **CMS** — schemes (react-hook-form + zod), MSP, crop master, pest alerts (+ region
  broadcast), mandi-sync status/trigger.
- **Broadcast** — compose + audience preview (estimated recipients) + send.
- **Trust & Safety** — moderation queue, fraud device-cluster explorer, incident
  manager with timeline + DPDP breach-notification SLA.
- **Compliance** — consent explorer, erasure processor (type-to-confirm), read-only
  audit-log viewer.
- **Ops** — feature flags, external-API health, BullMQ queue stats.

### Cross-cutting guarantees

- **ADMIN enforced server-side** on every `/api/v1/admin/*` route (UI gating is
  cosmetic).
- **Every mutation is audited** (`AuditLog`), with PII redacted in before/after.
- **PII masked by default**; reveals/exports need a logged reason. CSV export only
  ever serialises the already-masked rows on screen.
- **Keyset pagination** with bounded limits on every list.

## Design decision — admin sub-roles

The spec flags an optional DB migration for admin sub-roles. This build ships the
single existing `ADMIN` role (no schema migration) — every admin has the full
surface. Granular sub-roles (e.g. `KYC_REVIEWER`, `CONTENT_MODERATOR`) are a clean
follow-up: add an `adminScopes String[]` column on `User` (or a join table) and gate
sub-routers on it in `routes/admin/index.js`. Not included here to avoid an
unrequested migration.

## Mandi sync note

`POST /admin/mandi/sync` records an audited manual trigger row in `PriceDataSync`
(`status: 'queued'`). Wiring that record to the actual data.gov.in fetch worker is a
follow-up — the endpoint + status view are in place.
