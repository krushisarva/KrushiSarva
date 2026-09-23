# KrushiSarva — Razorpay Payment Gateway Expansion Directive

> Paste this as the opening prompt of a Claude Code session working on payments.
> It assumes the root `claude.md` engineering directive is already in effect.

---

## 0. READ THIS BEFORE WRITING ANY CODE

**Razorpay is already integrated for AgriStore. Do NOT rebuild it.**

Verified as existing and working (read these first — they are the reference implementation):

```text
backend/src/services/payment.service.js        create order, fetch order, verify signature, refund, mock mode
backend/src/services/shopPayment.service.js    PaymentIntent lifecycle, webhook claim/finish, quote binding
backend/src/routes/shopWebhooks.routes.js      raw-body HMAC webhook, idempotent by eventId
backend/src/services/orderRefund.service.js    refund path
backend/src/services/paymentTamper.service.js  amount-tamper detection
backend/src/resilience/breakers.js             razorpayBreaker
backend/prisma/schema.prisma:2834              PaymentIntent
backend/prisma/schema.prisma:2884              PaymentWebhookEvent
frontend/src/screens/AgriStore/RazorpayCheckout.js   WebView Standard Checkout (no native module)
frontend/src/screens/AgriStore/CheckoutScreen.js
admin/src/pages/PaymentIntents.tsx             ops surface
backend/tests/backend/api/shopPayment.api.test.js
backend/tests/backend/api/paymentAutoRefund.api.test.js
backend/tests/backend/api/orderRefund.api.test.js
backend/tests/backend/unit/money.test.js
```

Your job is to **generalise this proven core and wire it into the product areas that
currently have no payment path at all**. Every new flow must reuse
`payment.service.js`, `PaymentIntent`, `PaymentWebhookEvent`, the breaker and the
WebView checkout component. A second implementation of signature verification,
webhook handling or intent state is a defect, not a feature.

---

## 1. VERIFIED GAPS — THE BACKLOG

| ID | Area | Current state | Priority |
|---|---|---|---|
| PAY-001 | Shared payment core | Intent + webhook are AgriStore-shaped (`cartHash`, `quoteSnapshot`, `orderId`) | P0 |
| PAY-002 | Rent bookings | `backend/src/routes/rent.routes.js` has **zero** payment references. `Booking` has `totalAmount` but no payment fields. Bookings are created unpaid. | P0 |
| PAY-003 | Seller ledger wiring | `settlement.service.js` header states SALE/COMMISSION/REFUND seeding from completed orders is "out of scope, a follow-up". Payouts are computed from an empty ledger. | P0 |
| PAY-004 | AI credit packs | `aiCredit.service.js:104` — pack prices exist, comment says "for future payment integration". No purchase endpoint. | P1 |
| PAY-005 | AnimalTrade | `animaltrade.routes.js` has no payment. Needs a product decision before code. | P1 |
| PAY-006 | Seller payouts | `Payout` rows are created PENDING and settled by hand. No RazorpayX integration. | P2 — blocked on business decision |

Work them **in this order**, one at a time, following the root directive's
READ → MEASURE → SMALLEST SAFE FIX → TEST → VERIFY → DOCUMENT loop.

---

## 2. NON-NEGOTIABLE MONEY RULES

These override every performance or convenience consideration.

```text
1.  The server is the only authority on price. Never trust a client amount.
2.  Integer paise at the Razorpay boundary. Prisma.Decimal in the database.
    Never float arithmetic on money.
3.  Webhook signature verified over RAW BYTES, before JSON.parse, with a
    timing-safe compare. Router mounted with express.raw BEFORE the global
    JSON parser.
4.  Fail closed: no RAZORPAY_WEBHOOK_SECRET configured -> reject every webhook.
5.  Idempotent everywhere. The gateway event id is claimed through a UNIQUE
    index before any work happens. Redelivery is normal, not exceptional.
6.  Every state change that moves money happens in one transaction with the row
    that authorises it. Reserve -> execute -> settle, or release.
7.  Dismissal is not failure. A farmer who backgrounds the app mid-UPI may have
    paid. The client reports `dismissed` and `failed` as different outcomes and
    asks the server for the truth.
8.  Mock mode stays. No keys configured -> deterministic fake responses, so dev
    and CI never hit the network or spend money.
9.  No raw gateway payload is stored — it carries contact details and card
    metadata. Extract only the fields the handler needs.
10. Refunds are never automatic beyond the existing reconciler rules without an
    explicit, documented policy.
```

Re-read `claude.md` §51 (money), §52 (stock), §54 (security), §72 (safe autonomy)
before touching any of the above.

---

## 3. PAY-001 — GENERALISE THE PAYMENT CORE (P0, do first)

**Goal:** one payment module any product area can raise an intent against, without
AgriStore-specific columns leaking into rent or AI credits.

1. Add to `PaymentIntent`:
   ```prisma
   purpose   PaymentPurpose @default(SHOP_ORDER)  // SHOP_ORDER | RENT_BOOKING | AI_CREDITS | ANIMAL_TOKEN
   refType   String?        // "booking" | "creditPack" | "animalListing"
   refId     String?
   metadata  Json?          // purpose-specific frozen quote; replaces per-area columns

   @@index([purpose, status, createdAt])
   @@index([refType, refId])
   ```
   Keep `cartHash` / `quoteSnapshot` / `orderId` exactly as they are.
   **Expand only — do not drop or rename any existing column.**

2. Write an **additive** migration under `backend/prisma/migrations/`. No
   `prisma db push` against production. Defaults must make every existing row
   valid (`purpose = SHOP_ORDER`).

3. Extract from `shopPayment.service.js` into a new
   `backend/src/services/paymentIntent.service.js`:
   ```text
   createIntent({ userId, purpose, refType, refId, amountPaise, receipt, metadata })
   findIntent / markIntentPaid / markIntentFailed       (purpose-agnostic)
   claimWebhookEvent / finishWebhookEvent / webhookEventId
   ```
   `shopPayment.service.js` keeps the cart/quote/order logic and calls into it.
   The public behaviour of the AgriStore endpoints must not change.

4. Rework `shopWebhooks.routes.js` into a dispatcher:
   ```text
   verify signature -> claim event -> load intent -> switch (intent.purpose) -> handler
   ```
   Unknown purpose -> mark IGNORED, return 200. Never 5xx on an event you do not
   handle; Razorpay would retry it for 24 hours.

5. Mount it at a neutral `/webhooks/razorpay`, keeping the current path as an
   alias so the URL already configured in the dashboard keeps working.

**Done when:** every existing payment test passes unchanged, and a new unit test
proves an unknown purpose is IGNORED with 200.

---

## 4. PAY-002 — RENT BOOKING PAYMENTS (P0)

Rent bookings are created today with no money involved. Implement advance payment
at booking time.

1. **Schema** (`Booking`, additive):
   ```prisma
   advanceAmount   Decimal? @db.Decimal(12, 2)
   paidAmount      Decimal  @default(0) @db.Decimal(12, 2)
   paymentIntentId String?  @unique
   paymentStatus   String   @default("UNPAID")  // UNPAID | PENDING | PAID | REFUNDED
   ```

2. **Pricing is server-side.** The client sends
   `{ listingId, startDate, endDate, hours?, workerCount? }` and nothing else. The
   server recomputes days/hours × rate, applies the advance percentage from a new
   `settings.service.js` key `rent.advancePct` (default 100 — full payment, since
   partial payment needs a collection policy), and freezes the quote into
   `PaymentIntent.metadata`.

3. **Endpoints** — mirror the AgriStore shape exactly:
   ```text
   POST /rent/bookings/initiate        -> { intentId, razorpayOrderId, amountPaise, keyId }
   POST /rent/bookings/confirm         -> verify signature, rebind amount, create Booking
   GET  /rent/bookings/:id/payment-status
   ```
   `confirm` must, in **one transaction**:
   ```text
   re-check the date range is still free (no double booking)
   re-compute the quote and refuse if the payable moved
   verify the HMAC
   fetch the gateway order and bind amount_paid to the recomputed total
   create the Booking
   link intent -> booking, set status ORDER_CREATED
   ```
   An availability conflict discovered after payment -> mark the intent
   `REFUND_INITIATED` and refund, exactly as `refundUnorderedPayment` does for
   shop orders. This is rent's version of overselling: keeping money for a slot
   someone else took must be impossible.

4. **Mobile:** reuse `RazorpayCheckout.js` unchanged from the rent booking screen.
   Do not copy it. If the import path is awkward, lift it to a shared location in
   its own commit.

5. **Tests** — `backend/tests/backend/api/rentPayment.api.test.js`:
   ```text
   happy path initiate -> confirm -> booking exists and is paid
   tampered signature -> 400, no booking
   client-supplied amount is ignored
   concurrent confirm on the same slot -> one booking, one refund
   webhook arrives before confirm -> intent PAID, no booking, reconciler refunds
   duplicate webhook delivery -> single effect
   mock mode works with no keys configured
   ```

---

## 5. PAY-003 — WIRE THE SELLER LEDGER (P0)

`settlement.service.js` computes payouts from `SellerLedgerEntry`, and nothing
writes SALE or COMMISSION entries. Payouts are therefore always zero.

1. On the order transition that means the seller has earned the money (read
   `OrderStatus` and pick DELIVERED unless the code says otherwise — **state which
   you chose and why in COMPLETED.md**), write in the same transaction as the
   status change:
   ```text
   SALE        +orderItem subtotal for that seller
   COMMISSION  -(subtotal x commissionRatePct / 100)
   ```
   Both with `balanceAfter` snapshotted, using `Prisma.Decimal` only.

2. On refund, write a negative `REFUND` entry and reverse the proportional
   commission. Never delete or mutate a ledger row — the ledger is append-only.

3. **Idempotency:** add `@@unique([orderItemId, type])` (or an equivalent business
   key) so a retried status transition cannot double-credit a seller. This is the
   single most important line in this work item.

4. Backfill existing delivered orders with a **dry-run-first** script under
   `backend/scripts/`: print the totals it would write, require an explicit
   `--apply` flag. Do not run it against production without the owner's sign-off.

5. Tests: balance after sale, after refund, after a replayed transition (must not
   change), commission rounding at paise precision.

---

## 6. PAY-004 — AI CREDIT PACK PURCHASE (P1)

1. Pack definitions stay server-side in `aiCredit.service.js:104`. The client calls
   `GET /ai/credits/packs` and gets `{ id, credits, pricePaise, label }`.
2. `POST /ai/credits/purchase/initiate` takes **a pack id, never an amount**.
3. On confirm/webhook, `addCredits(userId, amount, 'purchase', ...)` runs in the
   same transaction that moves the intent to a terminal state, keyed on
   `providerPaymentId` so a redelivered webhook cannot grant credits twice.
4. Tests: double webhook grants once; a failed payment grants nothing; a tampered
   pack price is rejected.

---

## 7. PAY-005 — ANIMALTRADE (P1)

**Ask the owner before implementing.** Cattle deals are normally settled in person;
a token payment changes the product's legal posture (escrow, disputes, refund
policy on a live animal). Report the options with a recommendation, then stop:

```text
Option A  contact-only, no payment            no change, lowest risk
Option B  refundable token to unlock contact  needs a refund policy + dispute flow
Option C  full escrow                         needs legal review, out of scope now
```

---

## 8. PAY-006 — PAYOUTS (P2, blocked)

RazorpayX is a separate product with its own KYC, account activation and API keys.
Do not integrate it speculatively. Produce a one-page design note covering account
requirements, the payout state machine, reconciliation and failure handling — then
stop and report.

---

## 9. DEFINITION OF DONE — EVERY ITEM

```text
[ ] Existing payment tests still pass, unchanged
[ ] New API tests cover: happy path, tampered signature, client-amount ignored,
    duplicate webhook, webhook-before-confirm, mock mode
[ ] Migration is additive, reviewed, and has a written rollback
[ ] No new signature-verification or webhook code path
[ ] Decimal in the DB, integer paise at the gateway
[ ] Breaker + timeout on every new gateway call
[ ] admin/src/pages/PaymentIntents.tsx shows the new purpose (column + filter)
[ ] The reconciler handles the new purpose (money paid, nothing delivered)
[ ] docs/performance/FINDINGS.md and COMPLETED.md carry the PAY-xxx entry
[ ] Logged: intent created / paid / failed / refunded — with intentId, never PII
```

Run before declaring anything done:

```bash
cd backend && npm test -- --testPathPattern="payment|refund|money|rent|credit"
cd backend && npx prisma validate
```

---

## 10. MANUAL STEPS FOR THE OWNER (list them, do not attempt them)

```text
1. Razorpay dashboard -> Settings -> Webhooks -> add the production URL and
   subscribe to: payment.captured, payment.failed, refund.processed,
   refund.failed, order.paid
2. Copy the webhook secret into RAZORPAY_WEBHOOK_SECRET
   (it is NOT the API secret — they are different values)
3. Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in Railway — test keys first
4. Complete Razorpay KYC before switching to live keys
5. Test with Razorpay test cards and the UPI test flow before going live
```

---

## 11. START HERE

```text
Read docs/performance/PROGRESS.md.
Read the files listed in section 0 in full before proposing anything.
Then begin PAY-001, smallest safe step first.
Report the PAY-001 plan before writing the migration.
```
