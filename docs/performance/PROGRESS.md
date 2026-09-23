# Current Optimization Progress

## Current Item

**PAY-002 — rent booking payments — COMPLETE.** PAY-004 (AI credit packs) is
also COMPLETE, and was verified against a database for the first time.

## Status

COMPLETED — pending the production SQL a human has to apply (see "Still owed by
a human" below).

## PAY-002 — rent booking payments (COMPLETE)

### The three endpoints, verbatim

A farmer-app agent is coding against these. Any change is a breaking change.

```
POST /rent/bookings/initiate
  body  { listingId, type: 'machinery'|'labour', startDate, endDate, hours?, workerCount?, notes? }
  200   { razorpayOrderId, amount, amountInPaise, currency: 'INR', receipt,
          quote: { days, rate, total, advancePct, payable }, mock }
  400   dates invalid / range > 365 days / listing inactive / outside the
        listing's availability window / payable below the gateway minimum
  403   the owner booking their own listing
  409   { code: 'SLOT_TAKEN' }  the slot is already taken
  503   the intent could not be recorded (nothing has been charged)

POST /rent/bookings/confirm
  body  { razorpayOrderId, razorpayPaymentId, razorpaySignature }
  200   { booking, paymentStatus: 'PAID' }
  400   bad signature / not this farmer's intent / not a RENT_BOOKING intent —
        NO booking is created and NO state changes
  409   error.details { refunded, paymentCaptured, providerOrderId, code }
        code is SLOT_TAKEN or PRICE_CHANGED; the money has been refunded and
        error.message says so

GET /rent/bookings/payment-status/:providerOrderId
  200   { state, status, paid, amount, booking, message? }
        status === state; amount is a 2-dp string; booking is null until confirm
  404   unknown reference, another farmer's intent, or a non-rent intent
```

Two deliberate deviations from the brief, both additive:

1. **`status` is accompanied by `state`** (the same value) on payment-status,
   for parity with AgriStore's `/orders/payment-status`, plus `message` on
   non-terminal states. Reading `status` alone is correct and sufficient.
2. **The 409 body is the house error envelope**, so `refunded` lives at
   `error.details.refunded` and the message at `error.message`. `sendError` has
   no shape that puts them at the top level, and inventing one here would make
   rent the only endpoint in the codebase with a bespoke error body.

### What confirm does, and where the transaction boundary is

```
verify the HMAC                     outside — pure, and a forged pair must not
                                    reach a database write
load the intent                     outside — object-level authorization; a
                                    signature proves Razorpay signed the pair,
                                    NOT that it belongs to this farmer
already bound?                      outside — return that booking (the webhook
                                    or an earlier attempt got here first)
fetch the gateway order             outside — a network call must not be held
                                    inside a Serializable transaction
-- BEGIN SERIALIZABLE --
  re-check the range is free
  re-price from the listing; refuse if the payable moved
  bind amount_paid to the recomputed total (receipt + amount vs the gateway)
  INSERT the Booking (paymentIntentId UNIQUE)
  UPDATE the intent -> ORDER_CREATED, refType 'booking', refId <booking>
-- COMMIT --
```

The split is AgriStore's, not a new one. Everything whose atomicity matters is
inside; the two things that cannot be are outside and are re-validated within.

### Decisions worth recording

- **Nothing is reserved at /initiate.** A cart holds stock, which is fungible; a
  booking holds a slot, which is not. Reserving one would need a third booking
  state that blocks the calendar for everyone while one farmer's UPI app
  decides. The availability check that binds is the one inside the confirm
  transaction.
- **The availability WINDOW is checked at initiate only, not at confirm.**
  Refusing before a rupee moves is free; refusing after costs a refund. The
  window is owner-set and static during a checkout, and the residual exposure —
  a booking just outside a window the owner narrowed two minutes ago — is
  something the owner can still reject.
- **The quote is frozen into `PaymentIntent.metadata` and confirm re-prices
  anyway.** The metadata says WHAT was bought (listing, dates, worker count);
  the price is re-derived from the listing. Without the metadata, confirm would
  have to take the listing and dates from the request body, and a farmer could
  pay for a one-day hire and then confirm a ten-day one.
- **`hours` is stored and still not charged for.** The recon note asked whether
  an hourly rate is meant to exist; the answer here is that the paid path must
  quote the same figure as the legacy path and as the app's own display.
  Charging for hours now would make the three disagree. It stays a product
  question.

### reconcileRentPayments was NOT wired — it is now

`rentPayment.service.js` exported it and nothing called it. It is now wired into
the existing `shop-payment-reconcile` cron in `server.js` (every 10 minutes),
inside the SAME `withLeaderLock` callback rather than as a second cron entry: one
scheduler, one lock, one place to read, and the two passes cannot interleave
against the gateway. It stays a separate PASS because the shop reconciler's rule
is "captured with no Order by paymentRef -> refund", and a rent payment never has
an Order — running rent through it would refund every successful booking.

## PAY-004 — AI credit packs (COMPLETE)

Written by a previous agent and never executed against a database. Run for the
first time here: **22 tests, all passing** after one fixture fix — the suite
captured its `before` balance while the `AICredit` row did not yet exist (it is
created lazily at the free monthly grant), so every balance assertion was off by
exactly that grant and looked like a double grant rather than a missing
baseline. The row is now warmed through `GET /ai/credits` in `beforeEach`.

## Database state

`booking_payment_fields_additive.sql` and `payment_intent_purpose_additive.sql`
had reached **no** database, not even locally. Both are now applied to the dev
(`cropsetu`) and test (`cropsetu_test`) databases; both are idempotent and
self-verifying, so the re-run of the purpose script was a confirmed no-op.
`prisma validate` and `prisma generate` are both clean.

## Tests

| Suite | Before | After |
|---|---|---|
| `api/rentPayment.api.test.js` | did not exist | 22 / 22 |
| `api/aiCreditPurchase.api.test.js` | never run (10 failed on first execution) | 22 / 22 |
| `api/paymentPurposeScope.api.test.js` | 10 (1 failing) | 10 / 10 |
| `api/shopPayment` + `orderRefund` + `orderRefundFailure` + `paymentAutoRefund` + `adminPaymentIntents` | 63 | 63 / 63 unchanged |
| `unit` + `security` payment / refund / money / credit (8 suites) | 65 | 65 / 65 unchanged |
| `api/rent` + `api/rentPrivacy` | 63 | 63 / 63 unchanged |
| `load/booking-concurrency` + `security/referentialIntegrity` | 11 | 11 / 11 unchanged |

Two pre-existing tests needed a change, and neither was an assertion loosened:

- `paymentPurposeScope.api.test.js` — "a purpose with no handler" used
  AI_CREDITS, which now HAS one (PAY-004 registered it). Repointed at
  ANIMAL_TOKEN, which is deliberately unhandled (PAY-005 is an open product
  decision), with a comment saying the next purpose to be implemented must move
  this block on again rather than delete it.
- `aiCreditPurchase.api.test.js` — the baseline fix described above.

## Still owed by a human, before this deploys

**Apply the manual SQL to production FIRST, then deploy the code**, in this
order:

```
1.  backend/prisma/manual/payment_intent_purpose_additive.sql   (PAY-001 — may
    already be applied; it is idempotent and self-verifying, so re-running it is
    safe and is the cheapest way to be sure)
2.  backend/prisma/manual/booking_payment_fields_additive.sql   (PAY-002)
3.  deploy the code
```

The other order breaks production. Prisma selects every scalar field it knows
about, so code that knows `paymentStatus` issues
`SELECT ... "paymentStatus" ... FROM bookings` against a table without it and
**every booking read fails with 42703** — including the existing unpaid booking
flow, which works today. The reverse is harmless: old code never mentions the new
columns.

The deploy runs `prisma db push`, which cannot be relied on for either script: it
tries to drop the FastAPI-owned tables it does not know about and aborts on data
loss, applying nothing. Never add `--accept-data-loss`.

## Next item

**PAY-003 — wire the seller ledger.** Nothing writes SALE or COMMISSION
entries, so every payout computes to zero. Recon is already in FINDINGS.md,
including the two traps: `SellerLedgerEntry` has no `@@unique` yet (the
idempotency key PAY-003 needs does not exist), and
`admin/finance.routes.js:90-91` computes a running balance with JS `Number` into
a `Decimal(12,2)` column.

---

## Previous item — PAY-001, generalise the payment core (COMPLETE)

## Current Feature

Payments (`docs/PAYMENT_GATEWAY_PROMPT.md`). Razorpay already works for
AgriStore and is NOT being rebuilt; PAY-001 widens that one core so rent
bookings, AI credit packs and anything later can raise an intent against it.

### What was discovered before writing anything

Two things the payments directive did not know, both of which changed the plan:

1. **A migration file alone never reaches production.** The deploy runs
   `prisma db push`, which tries to drop the FastAPI-owned tables
   (`ai_scan_diagnoses`, `ai_scan_feedback`), aborts on data loss, and then
   applies nothing. Every additive change in this repo therefore also ships a
   hand-applied `prisma/manual/*.sql`. PAY-001 has one.

2. **The reconciler is purpose-blind, and that is why `purpose` had to land
   first.** `reconcilePendingPayments` (shopPayment.service.js:336) sweeps
   every non-terminal intent through one hard-coded shop path: look for an
   `Order` by `paymentRef`, find none, release stock reservations, auto-refund
   after 30 minutes. Ship rent payments before the discriminator and a farmer
   who takes 11 minutes over a UPI approval gets refunded for a booking they
   completed — silently, with nothing in the logs calling it wrong.

### Step 1 — schema, migration, prod-apply script (COMPLETE)

Files:
```
backend/prisma/schema.prisma                                        + enum PaymentPurpose, 4 fields, 2 indexes
backend/prisma/migrations/20260921120000_payment_intent_purpose/    new
backend/prisma/manual/payment_intent_purpose_additive.sql           new — the one that reaches prod
ARCHITECTURE.md                                                     counts, PaymentIntent fields, enum table, both inventories
docs/performance/FINDINGS.md                                        PAY backlog + PAY-001 entry
```

Verified, not assumed:
- `prisma validate` passes.
- `prisma migrate diff` (read-only, DB vs schema) reports **zero** drift on
  `payment_intents` — the hand-written SQL and `schema.prisma` agree exactly,
  so a later `db push` is a no-op rather than a second, differently-named index.
- The manual script was applied to **two** databases (dev + test) and run
  **twice** on one: idempotent, and self-verifying (it re-reads the catalog
  inside the transaction and rolls back rather than reporting a partial apply).
- Payment suites: **9 suites / 81 tests, all passing**, unchanged.

### One thing the test run exposed that was not mine

The first run failed 31 tests. Cause was **pre-existing local drift**, not the
change: `order_items.batchQuantity` — the previous item's column — had never
been applied to either local database, so every order-creating test died with
P2022. This is exactly the failure the manual-SQL policy exists to catch, and it
had gone unnoticed because nobody had run the order suites since. Fixed by
applying the repo's own `order_item_batch_quantity_additive.sql` to both local
DBs. Still outstanding on those DBs: the two read-path indexes from
`read_path_indexes.sql` (performance only, nothing fails without them).

### Step 2 — extract the purpose-agnostic core (COMPLETE, and it absorbed step 4)

`backend/src/services/paymentIntent.service.js` (new) owns the intent state
machine and the webhook inbox for every purpose:

```
PAYMENT_PURPOSE, TERMINAL, REFUNDING, SETTLED
receiptFor, createIntent, findIntent, findIntentsForRef
markIntentPaid, markIntentFailed
claimWebhookEvent, finishWebhookEvent, webhookEventId
```

`shopPayment.service.js` keeps the shop half — `createIntent` (now a thin
wrapper that freezes the cart quote), `attachOrderToIntent`,
`bindIntentToOrderTx`, `refundUnorderedPayment`, `reconcilePendingPayments`,
`intentPublicStatus`, `AUTO_REFUND_FAILED` — and **re-exports** the moved
names. All 14 public symbols still resolve from the old path, so none of the
four importers (`agristore.routes.js`, `shopWebhooks.routes.js`, `server.js`,
`admin/shopCompliance.routes.js`) changed.

**Step 4 was pulled forward into this change, deliberately.** An adversarial
review of the split made the point that a generalised `createIntent` can mint a
RENT_BOOKING intent, while the reconciler still filtered on `status` alone —
and the migration comment already *promised* a purpose guard that did not
exist. Shipping the generaliser without the guard would have created exactly
the bug the guard is for, so `RECONCILED_PURPOSES` landed here instead.

**One new invariant, not a move:** `createIntent` accepts rupees or paise and
derives the other. When both are supplied and disagree it throws rather than
picking one — a row that says ₹49 while the gateway charged ₹499 is the worst
shape a payments bug can take, and it is silent.

Two review points were acted on, one rejected:

- *Acted on:* the missing reconciler purpose guard (above).
- *Acted on:* `SETTLED` containing `ORDER_CREATED` reads as shop vocabulary.
  It stays — PAY-002 also lands a paid booking in `ORDER_CREATED` — but the
  state now means "fulfilment created", and says so.
- *Rejected:* "don't move `TERMINAL`, it has one reader and that reader stays."
  True today, but the same review argued the exactly-once invariant must not be
  split across two files. `SETTLED` and `REFUNDING` had to move; splitting the
  trio would have put half a state machine in each module. All three moved.

Tests:
```
tests/backend/unit/paymentIntentCore.test.js    19 new — money guard, purpose validation,
                                                 enum/JS drift, receipt uniqueness, event ids
tests/backend/api/paymentPurposeScope.api.test.js  4 new — the reconciler guard
```

`paymentPurposeScope` was confirmed to **fail with the guard reverted** (2 of 4)
and pass with it restored, so it pins the property rather than merely
accompanying it. That matters more than usual here: the behaviour it protects
belongs to a feature that does not exist yet, so nothing else in the suite
would notice the filter being deleted as "an unnecessary where clause".

Payment suites after the split: **9 suites / 81 tests, unchanged, all passing.**

### Step 3 — the webhook becomes a dispatcher (COMPLETE)

`shopWebhooks.routes.js` → `paymentWebhooks.routes.js`. The URL is unchanged,
so the endpoint already configured in the Razorpay dashboard keeps working; only
the file name and the shape changed.

```
verify signature -> claim event -> load intent -> record the money
                                               -> PURPOSE_HANDLERS[intent.purpose]
```

The shop half moved into `shopWebhookHandler` in `shopPayment.service.js`
(`captured` / `failed` / `refunded`), registered against SHOP_ORDER. The route
itself now knows nothing about carts, orders or stock.

**Three decisions worth recording, because each could reasonably have gone the
other way:**

1. **An unhandled purpose still marks the intent PAID.** The handler is what is
   missing, not the payment. Leaving it CREATED would mean a real capture whose
   only trace is a webhook row — the exact silence this machinery exists to
   prevent. PAID with no fulfilment surfaces in the admin orphan queue; CREATED
   does not. The event is IGNORED, with an `[ALERT]` log naming the purpose.

2. **IGNORED returns 200, never 5xx.** Razorpay retries a 5xx for 24 hours, and
   every retry would reach the same missing handler. The answer will not change,
   so the gateway should not keep asking.

3. **A missing intent is NOT treated as an unknown purpose.** On
   `payment.failed` and on refunds, no intent row still gets the SHOP handler.
   `/orders/initiate` deliberately swallows a failed `createIntent` so
   telemetry can never fail a checkout — but it has already taken the stock hold
   by then. Routing that case to "no handler" would strand held stock that
   nothing else releases. This preserved a real recovery path that the obvious
   refactor would have quietly removed.

Tests: 3 added to `paymentPurposeScope.api.test.js` — unknown purpose is
IGNORED with 200, the money is still recorded, and a SHOP_ORDER capture is still
PROCESSED.

**Payment suites after step 3: 11 suites / 107 tests, all passing.** The 13
properties the existing webhook tests pin — the five signature refusals, the
replay header and `duplicate: true` body, the FAILED event for an unknown
gateway order, the IGNORED event for an unhandled event type — are reproduced
unchanged by the dispatcher.

Docs corrected in the same pass: 11 stale `shopWebhooks.routes.js` references in
ARCHITECTURE.md (with their line ranges re-derived rather than carried over), a
mount reference that had said `app.js:211` since before this work, and
`.env.example`, which never documented `RAZORPAY_WEBHOOK_SECRET` at all —
despite the webhook failing closed without it.

### Step 5 — the neutral webhook URL (COMPLETE)

One Router, two mounts, both above the global JSON parser:

```
/api/v1/webhooks/razorpay        the name that stays right when rent and credits arrive
/api/v1/shop-webhooks/razorpay   the URL already in the Razorpay dashboard
```

Changing a live webhook URL means a window where captures go nowhere. The alias
costs one line and removes that window entirely.

Two constraints, both load-bearing and both now commented at the mount:
- **Above `express.json`.** Below it the stream is consumed and the raw body —
  and therefore the HMAC this endpoint exists to verify — is gone.
- **One Router instance**, so both paths share the router's rate limiter. Its
  key (`rl:webhook:razorpay:<ip>`) has no path component: one gateway, one
  allowance, not one per URL spelling.

Tests (3 added): each path handles a capture identically, and — the property
that makes the alias safe rather than merely convenient — **they share one event
inbox**. The same delivery sent to the other path comes back `duplicate: true`
with `X-Webhook-Replay`, and `payment_webhook_events` holds exactly one row.
Without that, Razorpay retrying a capture against a different URL would be
processed twice.

### Step 6 — the admin queue learns what a payment was for (COMPLETE)

```
backend  GET /admin/payment-intents  ?purpose=  + purpose in the select
admin    PaymentIntents.tsx          "For" column + "For" filter
admin    paymentState.ts             PAYMENT_PURPOSES, purposeLabel
```

The filter is applied **after** the view branches and is never defaulted. Both
halves of that matter: the orphan view does `delete where.status`, so a purpose
set earlier could be dropped along with it, and a default would quietly hide
every non-shop payment from an operator who had not asked it to.

One gotcha worth keeping: `FilterSelect`'s "all" option is the empty string, and
axios omits `undefined` but sends `''` as `purpose=` — which the route would
then reject as an invalid enum. Hence `purpose ? { purpose } : {}` rather than
passing the state through.

Tests (5 added to `adminPaymentIntents.api.test.js`): the filter returns only
that area; the shop queue excludes other areas **and still contains rows written
before the column existed**; purpose ANDs with the orphan view rather than
replacing it; an unknown purpose is a 400, not a silent ignore; and no filter
still returns every area. Admin `tsc --noEmit` and `vite build` both clean.

### PAY-001 — done, pending the full-suite run

```
1 schema + migration + prod-apply SQL     COMPLETE
2 extract paymentIntent.service.js        COMPLETE
3 webhook -> per-purpose dispatcher       COMPLETE
4 reconciler scoped to known purposes     COMPLETE (landed inside step 2)
5 /webhooks/razorpay alias                COMPLETE
6 admin purpose column + filter           COMPLETE
```

31 tests added across four files. Every existing payment test passes unchanged.

**Still owed by a human, before the code deploys:** apply
`backend/prisma/manual/payment_intent_purpose_additive.sql` to production
FIRST. Deploy the code first and Prisma selects `purpose` against a table
without it — every payment read fails with 42703.

### The recon that shaped PAY-002 (all three facts held up)

`Booking` had no payment field and no unique constraint at all, so
double-booking was prevented solely by a Serializable overlap query; pricing was
already server-authoritative (the client's `totalAmount` was validated and then
never read); and `hours` was validated 1-24 but appeared in no pricing
arithmetic. PAY-002 added the UNIQUE (`paymentIntentId`), kept the Serializable
overlap query as the binding check, kept pricing server-side, and left `hours`
uncharged — see the PAY-002 section at the top for why.

Step 5's constraint also held: the webhook alias must be mounted before the
global JSON parser, or `express.json` consumes the stream and the raw body — and
therefore the HMAC — is gone. Both mounts share one rate-limit budget
(`rl:webhook:razorpay:<ip>` has no path component): one gateway, one budget.

---

## Previous item — the 79-section directive audit

Working the 79-section directive audit. The audit corrected this document: the
previous version claimed "the §71 backlog is drained", and it was not — three
items were still open in code (PERF-042). Treat that as the reason this section
now names what is OPEN rather than what is finished.

## Where the directive actually stands

All 80 sections audited, each verdict independently challenged (§51–61's
challenge pass died mid-run, so those verdicts are unverified).

| Verdict | Count |
|---|---:|
| DONE | 27 |
| PARTIAL | 42 |
| NOT_DONE | 0 |
| ONGOING_POLICY (rules, not tasks) | 11 |

Nothing is untouched; 42 sections have a tail. **Four are genuinely large and
are not close:** §12 signed direct upload, §62 the six load-test workflows
including Socket.IO, §71's per-area sweep across 25 product areas, and §74 which
depends on those.

## Status

Every item on the original P0/P1 list is closed. The remaining work is the §71
per-feature sweep and the two things that need something this environment does
not have: production `pg_stat_user_indexes` (index drops, §18) and a staging
environment with mocked AI providers (load testing, §62/§63).

## Current Feature

None in progress. The last item was PERF-045 (COMPLETE): PIN code → location
via India Post, behind one cached, breaker-guarded endpoint, wired into every
location form in both apps. The batch before it covered pagination
correctness, seller metrics, AI history read cost, upload memory, and mobile
start-up cost.

## Two lessons from this batch worth keeping

**Query-shape defects are invisible to behavioural tests.** PERF-033 and
PERF-034 both return the CORRECT answer by the wrong route — `distinct` resolved
in the client, an aggregate uncorrelated to the page. Every value assertion
passes before and after. Demonstrated rather than argued: restoring the
`_count` bug leaves all four behavioural tests green and fails only the two
query-shape ones. Where a fix changes cost rather than output, the test has to
observe the SQL.

**A test that runs only in the ambient environment can keep lying.** PERF-031's
UTC control passes WITH the bug restored. Had the suite tested only in the
machine's own timezone, CI would have stayed green while cursor pagination was
broken for every developer outside UTC.

## What was discovered

The session opened by establishing a baseline, then working the P0 list in the
order that makes later work measurable rather than in severity order.

**The suite was the first item, and it paid for itself immediately.** 37–38 tests
failed across 7–8 suites, flakily. Twenty-eight were stale assertions expecting HTTP
422 from a validator that has always answered 400 — measured, not assumed: flipping
the middleware made it *worse* (38 → 50). Under that noise were four real defects,
two of which no test could report because the phone fixture could not generate unique
numbers, so the suites asserting *the marketplace does not oversell a slot* and *does
not lose a rating update* had never executed once.

With the fixture fixed, both immediately failed:

- The booking race produced **1 booking and 9 HTTP 500s**. Isolation was working —
  nothing double-booked — but the losers were told the server had failed, and a 5xx is
  what the mobile client retries. `withSerializableRetry` already existed and guarded
  six AgriStore paths; rent booking had never been wrapped. Now 1 × 201, 9 × 409.
- Five concurrent reviews reproducibly left `ratingCount` at **3, not 5** — a lost
  update on the two columns that order the storefront and feed the buy box.

Then the adversarial recon pass over the remaining audit backlog found a defect **no
audit dimension had opened**: legacy products could be **oversold without limit**.
`applyStockDeltas` — the only function that writes `products.stock` — had zero call
sites, so the pre-backfill checkout branch validated stock against a number no order
ever moved. 20 of 67 products in the dev database take that branch.

The recon pass also refuted several *fix plans* while confirming their findings, which
is the more valuable half: hardening the socket handshake alone would cause a client
reconnect storm (PERF-005), and the obvious queue fix would break every queued job in
production via `worker.js` (PERF-008). Both traps are recorded in `FINDINGS.md`.

## Files changed

```
PERF-001  backend/src/routes/{rent,agristore,farmCropCycle}.routes.js
          backend/src/services/{farm,cropCycle,cacheWarmer}.service.js
          backend/tests/fixtures/factories.js  + 8 test files
PERF-002  .github/workflows/ci.yml (new)
          fastapi/tests/{test_llm_dispatch,test_diagnose_fallback}.py
          backend/tests/backend/security/farmRateLimit.test.js
PERF-003  backend/src/socket/chat.socket.js
          backend/tests/backend/security/socketChatOwnership.test.js (new)
PERF-004  backend/src/utils/stockBatch.js
          backend/src/routes/agristore.routes.js
          backend/tests/backend/api/shopLegacyStock.api.test.js (new)
PERF-006  backend/src/routes/animaltrade.routes.js
          backend/tests/backend/api/animaltrade.api.test.js
PERF-007  fastapi/db_pool.py, fastapi/jobs/tasks.py
          fastapi/tests/test_db_pool_event_loop.py (new)
PERF-008  backend/src/utils/mapLimit.js (new), backend/src/queue/{jobQueue,processors}.js
          backend/src/services/adminBroadcast.service.js, backend/src/config/env.js
          backend/tests/backend/unit/{mapLimit,jobQueue}.test.js
PERF-010  fastapi/jobs/queue.py, fastapi/jobs/tasks.py, fastapi/main.py
          backend/src/routes/admin/ops.routes.js
          fastapi/tests/test_worker_health.py (new)
          backend/tests/backend/unit/opsStatusVerdict.test.js (new)
PERF-005  backend/src/socket/chat.socket.js, backend/src/socket/socketReauth.js (new)
          backend/src/server.js, shared/services/{api,socket}.js
          backend/tests/backend/security/{socketHandshakeAuth,socketReauth}.test.js (new)
          frontend/src/services/__tests__/socketAuthRetry.test.js (new)
PERF-009  backend/src/services/erasure.service.js  (to_regclass probe, pre-transaction)
PERF-011  backend/src/server.js, backend/src/config/env.js  (CRON_ENABLED)
PERF-012  backend/src/services/authCache.js (new), middleware/auth.js, config/db.js
PERF-015  backend/prisma/schema.prisma, prisma/manual/read_path_indexes.sql (new)
PERF-016  shared/i18n/translations.js, frontend/src/screens/AI/{Scan,Voice}HistoryScreen.js
          fastapi/weather_service.py  (Redis address + re-probe)
docs      docs/performance/TABLES.md (new) — §14, §66, §67, §68, §69
```

## Tests

| Suite | Before | After |
|---|---|---|
| backend (`npm test`, no flags) | 7–8 suites / 37–38 failing → then 143 failing in parallel | **108 suites / 0 failing, 1275 passing** |
| fastapi (`pytest tests`) | 4 failing / 311 passing | **337 passing** |
| frontend + shared (`npx jest`) | 9 suites / 175 passing | **14 suites / 212 passing** |
| admin (`tsc --noEmit`, `vite build`) | green | green |

Two new suites were confirmed to **fail with the fix reverted** and pass with it
restored, so they pin their properties rather than merely accompanying them.

## Metrics

Behavioural, measured locally — no production telemetry is available:

- Rent booking under 10-way contention: **9 × 500 → 9 × 409**.
- Review aggregate under 5-way contention: **ratingCount 3 → 5**, 12/12 runs.
- `GET /farms/:id/financial-summary` with any unrecorded cost: **500 → 200**.
- Legacy product stock after an order: **unchanged → decremented**; the last unit can
  no longer be sold twice.
- Chat inbox last-message lookup: **6,000 rows read → 30**; `DISTINCT ON` 3.616 ms →
  `LATERAL` **0.163 ms**, and now O(page) rather than O(message history).
- Chat inbox unread count: 7,474 rows / 2,075 buffers / 12.1 ms → 4,771 / 581 / 5.5 ms,
  and now O(page) rather than O(all unread messages on the platform).
- Celery scan persistence: **1 of 30 tasks succeeded → 30 of 30**, Postgres backends
  flat at 3 (a naive per-task pool rebuild reached 29).
- "Scans queued, no worker" is now the only one of four worker states that reports
  `degraded`; it previously reported `ok`.
- Admin broadcast fan-out: 5,000 concurrent enqueues → bounded to 25; the inline
  fail-open path is capped and sheds best-effort work instead of the API.
- A banned or logged-out user could previously hold a socket indefinitely; the
  handshake now refuses one and the sweep closes an existing one within a tick.
- Buy-box: **6 offer queries → 1** for a six-variant product, same winner throughout.
- Consent: **320 rows read → 8**, identical verdict per purpose.
- Admin dashboard: 16 aggregates → **0 on a warm read**.
- Auth: **50 authenticated requests → 1 user read** (98% hit rate); a plain
  `prisma.user.update({isActive:false})` still 401s the next request.
- Comments replies: Seq Scan 8.31 ms → bitmap index scan **0.79 ms**.
- Community feed: 13.07 ms with a sort → **0.14 ms**, no sort.
- Celery scan persistence: 1 of 30 tasks succeeded → **30 of 30**, connections flat at 3.
- i18n: seven regional bundles (692 KB) no longer evaluated at cold start.
- Backend suite wall clock: ~30 s, unchanged.

## Recently completed (this session)

| ID | What | Verified by |
|---|---|---|
| PERF-022 | Retention for the two FastAPI-owned scan tables | live DB: absent/present/idempotent |
| PERF-023 | §27 payload split — measured and **rejected**, 15.9 KB/report | offline report build |
| PERF-024 | Write queue minted a new Idempotency-Key per retry | revert → 1 of 6 fails |
| PERF-025 | Uploads cut off mid-Cloudinary at 30 s | revert → 2 of 5 fail |
| PERF-026 | Native voice could not recover from an expired token | revert → 5 of 7 fail |
| PERF-027 | `npm test` ≠ CI; 143 spurious failures | 143 → 0 |
| PERF-028 | `reviews` index prefix-subsumed — proven, not dropped | EXPLAIN, 200k rows |
| PERF-029 | Decimal `+` concatenates — two live wrong-number bugs | revert → fails in both files |
| PERF-030 | Mandi trend unbounded: 146k rows / 15.2 MB | revert → 2 of 6 fail |
| PERF-031 | Keyset paging broken on any non-UTC session TimeZone | 20/50 rows → 50/50 |
| PERF-032 | Sellers capped at their newest 20 products | 27 of 47 were unreachable |
| PERF-033 | Seller enumeration read 540k rows to return 5k | 594 ms → 89 ms, +128 MB → +0.1 MB |
| PERF-034 | AI history counted every message on the platform | 29,369 buffers → page-scoped |
| PERF-035 | Unbounded 100 MB video buffering | 1,202 MB RSS → bounded at 4 in flight |
| PERF-036 | i18n backfill built ten languages to show one | 5,136 KB → 3,939 KB heap |
| PERF-037 | Expo receipts — investigated, **not built** (no client writes tokens) | — |
| PERF-038 | AI daily spend cap measured scans only — 3 of 4 meters dead | revert → 3 forms each fail |
| PERF-039 | Two unbounded fallback maps (velocity, otpLockout) | revert → 4 of 21 fail |
| PERF-040 | Last credit path charging without a gate | revert → 4 of 5 fail |
| PERF-041 | The three overturned DONEs: DM N+1, buy-box fan-out, nearby truncation | revert → each fails its own |
| PERF-042 | §71 tail: lying page, unbounded thread, dead sort | revert → 3 of 5 fail |
| PERF-043 | Two holes in cleanupTestData (78 + 77 phantom failures) | suite 1268 → 1345 |
| PERF-044 | **OPEN** — one test fails intermittently, never captured | — |

## Next item — what is genuinely left

Ranked by effort-to-impact, from the §0–79 audit:

**Medium, worth doing next**
- **§45 push** — the server half is complete and correct; ZERO pushes have ever
  been sent, because neither app depends on `expo-notifications`. The blocker is
  client registration, not the pipeline. Receipt polling (PERF-037) stays
  deferred until that lands.
- **§47 payload** — `GET /farms/:farmId` selects crop cycles with no `select`,
  pulling 8 unbounded JSON log columns plus `weatherHistory`. Product detail
  ships 10 full review rows on every open when a paginated `/reviews` already
  exists.
- **§64 targets** — no crash-reporting SDK exists in either app, so
  "crash-free users > 99.5%" cannot be produced even in principle. Nothing
  blocks adding one.

**Large, and honestly not close**
- **§12** signed direct upload — every scan byte still transits Express as
  base64.
- **§62/§63** — four of six workflows have no coverage; chat/Socket.IO is
  entirely unmeasured. The AI scenario needs a mock provider so a run does not
  spend real Gemini money. That is buildable here, not blocked.
- **§71** — 13 of 25 product areas have no per-area sweep record.
- **§74** — 1 not started (direct media upload), 1 prepared-not-deployed
  (PgBouncer), 9 partial.

**Genuinely blocked on this environment**
- **§18 index drops** — need production `pg_stat_user_indexes`. One is *proven*
  subsumed by query plan (PERF-028) and still not dropped, because §18 says a
  structural argument alone is not enough.

**Blocked on something this environment does not have — not on effort:**
- **§18 index drops** need `pg_stat_user_indexes` from production. ~40 of 284
  index declarations look prefix-subsumed or duplicated. One of them
  (`reviews.userId`, PERF-028) is now *proven* subsumed by query plan rather than
  suspected — and still not dropped, because §18 is explicit that a structural
  argument alone is not enough for a production index.
- **§62/§63 load testing under AI load** still needs mocked providers so a run
  does not spend real Gemini money. The read paths ARE now measured — see
  `LOAD-AND-PROFILE.md`: 5,028 rps on the storefront at 100 concurrent, zero
  errors to 2,000 concurrent, DB connections flat at 13. The AI path is the one
  scenario deliberately omitted rather than approximated.

**Known and deliberately deferred:** PERF-020 (the 676 KB i18n backfill is still
eager — splitting it means changing the generator), and the Expo receipt-polling
half of §45.

## A note on the test suite — now resolved (PERF-027)

The previous version of this section recorded three DB-backed suites each
failing once, never reproducing, cause unknown, hypothesis "shared-schema
contention between suites".

The hypothesis was right and the mechanism is now known. Every DB-backed suite
truncates all tables in `afterAll` against one shared database. Nothing enforced
serial execution: the CI workflow passed `--runInBand`, the `test` script did
not. Running `npm test` plainly produced **143 failures**, stably — the same 143
twice, which reads as a real regression rather than a harness problem, and cost
an hour of hunting through a diff before the flag explained it.

`maxWorkers: 1` now lives in the jest config, so `npm test`, `npx jest <file>`
and CI all mean the same thing. The intermittent single-suite failures were the
mild version of the same collision.

**Method note worth keeping:** the tell was that the failure count was
*identical* across runs while the failing *suite* set changed. Deterministic
count plus non-deterministic attribution is a harness signature, not a code
signature.