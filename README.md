# KrushiSarva

KrushiSarva is a farming platform for Indian farmers. It has two Android apps,
a web admin panel, a backend, and a separate artificial intelligence (AI)
service.

What a farmer can do in the app:

- Scan a crop photo for disease and get a treatment plan.
- Ask farming questions by text or voice (the "Krushi AI" assistant).
- Check mandi (market) prices, minimum support prices (MSP), weather advice
  and government schemes.
- Buy seeds, fertiliser and other farm inputs from Krushi Seva Kendras (local
  farm-input shops) in AgriStore.
- Buy and sell animals (AnimalTrade), rent machinery or hire labour (Rent).
- Keep crop-cycle and cost records for each farm (MyFarm), and post in the
  community.

Kendras use the separate seller app to manage products, orders and their
know-your-customer (KYC) documents.

### Languages

The apps offer English and nine Indian languages. Hindi and Marathi are almost
fully translated (about 98% of the text). Tamil, Kannada, Malayalam, Telugu,
Bengali, Gujarati and Punjabi cover about 58%; any missing text shows in
English. `node shared/i18n/checkCoverage.js` checks the AI screens and lists
the gaps.

## Repository layout

```
KrushiSarva/
├── backend/      Express 4 + Prisma 5 + PostgreSQL + Redis + Socket.IO + BullMQ + node-cron
│                 The main application programming interface (API): sign-in, users,
│                 farms, market, community, chat, AgriStore, AnimalTrade, Rent,
│                 schemes, payments, admin API, and the public /legal pages.
├── fastapi/      FastAPI + Celery + asyncpg (Python 3.12)
│                 AI service: crop-disease pipeline, chat, smart alerts, price
│                 forecasts, pest prediction, soil-card reading. Called only by
│                 the backend, with signed requests.
├── frontend/     Expo 54 + React Native 0.81 + React 19
│                 Farmer app (com.krushisarva.app).
├── seller-app/   Expo 54 + React Native 0.81 + React 19
│                 Seller app for Krushi Seva Kendras (com.krushisarva.seller).
├── shared/       Code used by BOTH mobile apps as `@krushisarva/shared/*`
│                 (API client, sign-in and language context, translations, theme).
│                 Not an installed package: each app's metro.config.js points at
│                 this folder. See shared/README.md.
├── admin/        React 18 + Vite + TypeScript. Internal admin panel, hosted on Vercel.
├── website/      Company website. Plain HTML, CSS and JavaScript, hosted on Vercel.
├── marketing/    Marathi farmer-video autopilot (Python 3.12, runs on the owner's
│                 Mac; nothing is published without a tap on Telegram).
│                 See marketing/README.md.
├── deploy/       Production Docker Compose file and Caddy config.
├── Dockerfile    Backend image used by deploy/docker-compose.yml.
├── docs/         Design, deployment, performance and Play Store documents.
└── .github/      Continuous integration (CI) workflow.
```

Both mobile apps share one backend, one user account and `shared/`. Editing
anything under `shared/` affects both apps, so read its README first.

## How it works

- **Sign-in:** phone number and a one-time password (OTP) sent by SMS (text
  message) through Firebase phone authentication. This is the only sign-in in production, for
  the apps and the admin panel. `POST /api/v1/auth/send-otp` is for development
  only: it sends no SMS, returns the code in the response, and returns 503 in
  production.
- **AI:** Google Gemini (free tier, `gemini-3.6-flash` by default) handles crop
  diagnosis, chat and advice. If Gemini is down, text chat falls back to Groq
  (`openai/gpt-oss-120b`); images never go to Groq. Sarvam AI handles voice
  (speech-to-text and text-to-speech). The code can also call OpenAI or
  Anthropic models, but production does not use them.
- **AI limits:** AI credits cannot be bought. Each user has a monthly fair-use
  limit that refills automatically.
- **Payments:** Razorpay, for AgriStore orders and Rent bookings. Without
  Razorpay keys the backend runs payments in mock mode.
- **Images:** stored on Cloudinary; the database keeps only links and metadata.
- **Realtime:** Socket.IO for chat, with a Redis adapter so it works across
  backend instances. Expo push notifications for alerts.
- **Legal pages:** the backend serves them at `/legal` (privacy, terms,
  refunds, cookies, delete-account). The text lives in `backend/legal/`. In
  production, a page that is still a draft shows a "being finalised" notice.
  The privacy policy, cookie policy and delete-account page are live; the terms
  of service and refund policy are still drafts.

## Local development

You need Node.js 20, Python 3.12, PostgreSQL and Redis running locally.

### Backend (Express)

```bash
cd backend
cp .env.example .env          # fill in your values
npm run setup                 # install + create tables in local Postgres + seed reference data
npm run dev                   # http://localhost:3001/api/v1
```

Required in every environment: `DATABASE_URL`, `JWT_SECRET` (at least 32
characters) and `FIELD_ENCRYPTION_KEY` (64 hex characters; it encrypts personal
data such as bank numbers). The server will not start without them.

Useful in development: `REDIS_URL` (default `redis://localhost:6379`),
`AI_BACKEND_URL` (default `http://localhost:8001`), `AI_SHARED_SECRET` (must
match the FastAPI one), `GEMINI_API_KEY`, `SARVAM_API_KEY`, `CLOUDINARY_*`,
`DATA_GOV_API_KEY`, `OPENWEATHER_API_KEY`, `RAZORPAY_*` and `FIREBASE_*`.
Production refuses to start without `AI_SHARED_SECRET`, `GEMINI_API_KEY` and
`SARVAM_API_KEY`. Every variable is explained in `backend/.env.example`.

Without Firebase, local sign-in uses the development OTP: the app fills it in
for you. Setting `OTP_DEV_BYPASS_ENABLED=true` also accepts `000000` (never in
production; the server refuses to boot with it).

Database schema: on a local database, run `npm run db:push` after
`prisma/schema.prisma` changes. If it says it will drop `ai_scan_diagnoses` or
`ai_scan_feedback`, stop: FastAPI owns those tables. Production never uses
`db push`; schema changes there are reviewed SQL scripts (see
`backend/prisma/manual/` and `docs/deploy/VPS_DEPLOY_PLAN.md` §7–8).

### FastAPI AI service

```bash
cd fastapi
cp .env.example .env
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt               # Windows: .venv\Scripts\pip
.venv/bin/uvicorn main:app --reload --port 8001
.venv/bin/celery -A jobs.queue:celery_app worker --loglevel=info   # second terminal, for crop scans
```

Set `DATABASE_URL` (same Postgres as the backend), `REDIS_URL`,
`AI_SHARED_SECRET` (same value as the backend) and `GEMINI_API_KEY`.
`GROQ_API_KEY` is optional. On Windows, add `--pool=solo` to the Celery
command. Crop scans go through FastAPI only when the
"Use FastAPI scan pipeline" setting (`USE_FASTAPI_FOR_SCAN`) is on.

### Farmer app (Expo)

```bash
cd frontend
cp .env.example .env          # set EXPO_PUBLIC_API_BASE_URL
npm run setup                 # install + `expo prebuild --clean` (regenerates android/ and ios/)
npx expo start
```

`android/` and `ios/` are not in git; `expo prebuild` makes them from
`app.json`. Firebase sign-in in the app needs a development build and
`EXPO_PUBLIC_FIREBASE_AUTH=true`; without it the app uses the development OTP.

### Seller app (Expo)

```bash
cd seller-app
cp .env.example .env          # same backend as the farmer app
npm install
npx expo start --port 8082    # 8081 is usually taken by the farmer app's Metro bundler
```

Both apps read `../shared` straight from disk through `metro.config.js`. Each
app needs its own `npm install`, and a package used by `shared/` must be in
**both** apps' dependencies.

#### Run on an Android phone over USB

```bash
adb devices                         # confirm the phone is authorised
adb reverse tcp:3001 tcp:3001       # backend reachable from the phone as localhost:3001
adb reverse tcp:8081 tcp:8081       # Metro reachable for hot reload
npx expo run:android --device       # needs a local Android SDK
```

Set `EXPO_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1`. With
`adb reverse`, the phone's `localhost` points at your computer. On the Android
emulator, use `http://10.0.2.2:3001/api/v1` instead.

### Admin panel

```bash
cd admin
cp .env.example .env          # VITE_API_PROXY points at your local backend
npm install
npm run dev
```

See `admin/README.md` for Firebase login settings.

## Tests

```bash
# Backend: needs Postgres and Redis. Tests use a separate database named
# <your database>_test; create it once with
#   DATABASE_URL=<your url with _test> npx prisma db push
cd backend
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/<file>   # one suite
# The whole suite (it needs a lot of memory in one process):
NODE_OPTIONS=--max-old-space-size=6144 node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathPattern=tests/ --workerIdleMemoryLimit=1500MB

# Farmer app, seller app and shared code (all run from frontend/)
cd frontend && npx jest

# FastAPI
cd fastapi && pip install pytest && python -m pytest tests -q

# Admin panel
cd admin && npx tsc --noEmit && npm run build

# Translation coverage of the AI screens
node shared/i18n/checkCoverage.js
```

The CI workflow (`.github/workflows/ci.yml`) runs the same checks on every
pull request and every push to `main`, plus `prisma validate` and the
marketing tests.

## Production

Since 14 October 2026, production runs on one Hostinger virtual private server
(VPS) with Docker Compose (`deploy/docker-compose.yml`): Caddy (web server with
automatic HTTPS certificates), backend, fastapi, celery, PostgreSQL 16 and
Redis 7. PostgreSQL, Redis and FastAPI are not reachable from the internet.
Production environment files live on the server only, never in git. Design,
deploy steps and backups: `docs/deploy/VPS_DEPLOY_PLAN.md`.

- The admin panel and the company website are hosted on Vercel. The admin
  panel forwards `/api/*` to the backend (`admin/vercel.json`).
- The mobile apps are built with Expo Application Services (EAS) from each
  app's folder, for example
  `npx eas build --platform android --profile preview`. EAS uploads the whole
  git repository, so `shared/` is included. Installed apps receive
  JavaScript-only changes as over-the-air updates (`expo-updates`).

Health checks:

- `GET /healthz`: liveness, touches no dependency.
- `GET /readyz`: readiness, returns 503 if Postgres is unreachable (Redis
  problems are reported but do not fail it). It can only be called from the
  server itself; Caddy blocks it from outside.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): full system reference (API, database,
  security). Some details may lag behind the code.
- [docs/deploy/VPS_DEPLOY_PLAN.md](docs/deploy/VPS_DEPLOY_PLAN.md): production server.
- [docs/FIREBASE_PHONE_AUTH.md](docs/FIREBASE_PHONE_AUTH.md): phone sign-in.
- [docs/ADMIN_PANEL.md](docs/ADMIN_PANEL.md) and [admin/README.md](admin/README.md): admin panel.
- [docs/AI_CHAT_ARCHITECTURE.md](docs/AI_CHAT_ARCHITECTURE.md) and
  [fastapi/docs/ARCHITECTURE.md](fastapi/docs/ARCHITECTURE.md): AI service.
- [docs/performance/](docs/performance/): scalability work and its progress.
- [docs/play-store/](docs/play-store/): Google Play listing notes.
- [shared/README.md](shared/README.md), [frontend/README.md](frontend/README.md),
  [seller-app/README.md](seller-app/README.md), [marketing/README.md](marketing/README.md).

## Security

Never commit `.env` files. `.gitignore` excludes them, and the `.env.example`
files list each variable without real values. Anything in an `EXPO_PUBLIC_*`
variable ends up inside the app and is public. If a credential is ever pasted
into a chat, log or commit, treat it as leaked and rotate it at once.
