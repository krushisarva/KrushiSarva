# Seller Delivery — Documentation & Design

**Status:** phases 1 to 4 are written and tested, and sit on the branch
`feat/seller-delivery-reviews` — not merged into `main`, not deployed, and not
yet run on a phone. Phase 5 is not started; it waits for decisions D3 and D4.
**Start with section 0.**
**Date:** 2026-10-13. Section 2 describes the code at commit `fb7b4c8`, before
this work.

Goal: the seller (Krushi Seva Kendra) delivers an AgriStore order to the farmer
with their own vehicle and staff. No courier company, no KrushiSarva riders.

This document has two parts:

- **Section 2 — Documentation:** how ordering and delivery work in the code today.
- **Sections 3 to 7 — Design:** what is missing and how we will build it, in phases.

Out of scope for now: courier integration, village pickup points, our own
riders, and delivery for Rent or AnimalTrade.

---

## 0. Where this stands (2026-10-13)

**Phases 1 to 4 are written and tested. Nothing is merged, nothing is
deployed, and nothing has been run on a phone.** The work is one commit on the
branch `feat/seller-delivery-reviews`, pushed to GitHub. The same commit also
carries product reviews, the in-app pop-ups that replaced system alerts, the
Catalog QC review screen and the My Orders redesign; none of those change what
this document describes.

### 0.1 What to do next, in order

1. Answer the decisions in section 6. D3 and D4 unblock phase 5.
2. Look through the branch and open a pull request into `main`. Do NOT merge it
   until step 3's database script has run on production.
3. Deploy by section 7: the database script first, then the backend, then a
   new build of both apps.
4. Run the phone test in 0.4. It has never been done.

### 0.2 What was built

| Phase | Backend | Seller app | Farmer app |
|---|---|---|---|
| 1. New-order alert | A push to each seller when an order is created | Tapping it opens Orders. Alerts now show while the app is open. A warning on the dashboard when notifications are off. | — |
| 2. Delivery areas | Already existed; now has tests | New "Delivery areas" screen, opened from Profile | — |
| 3. Delivery run | The farmer's order now carries the promised date, and per shop a name, status and phone | Call and Map buttons. "Out for delivery" wording. | "Arriving by" date, shop name, Call shop. Tapping an order notification opens My Orders. |
| 4. Proof of delivery | Delivery code, five-try lock, deliver without code, could not deliver. New table `order_deliveries`. | A sheet to enter the code or pick a reason | The code, in large digits |

All new text is in English, Hindi and Marathi (108 strings).

### 0.3 Test results

These were run by the session that coordinated the work, after the last code
change, not only by the agents that wrote the code.

| What | Result |
|---|---|
| Backend: delivery, orders, refunds, pricing, push, notifications | 30 suites, 526 tests, all passed |
| Backend: the whole suite, one run | 162 suites. 161 passed. One (`reviewSelfPurchase`) timed out in its setup because the laptop went to sleep during the run; re-run on its own it passed (4 tests). In total 2,002 tests passed, 69 are marked "todo". |
| Farmer app, seller app and shared code | 58 suites, 1,353 tests, all passed |

An independent review of the backend found no blocker and no high-severity
defect in the delivery code, the lock, cancel and refund, or access rules. What
it did find is either fixed (0.5, 0.6) or listed in section 9.

### 0.4 The phone test that is still owed

Two phones: one signed in as a seller, one as a farmer.

1. **Alert.** Farmer places a cash order from that seller. The seller's phone
   shows "New order". Tapping it opens Orders.
2. **Areas.** Seller: Profile, Delivery areas, add the farmer's PIN code with
   0 to 1 days and Rs 20 extra. Farmer: the cart for that seller shows the new
   time and Rs 20 more delivery.
3. **Confirm.** Seller confirms. Farmer's My Orders shows "Arriving by", the
   shop's name and "Call shop".
4. **Call and Map.** Seller taps both on the order. The dialler and a map open.
5. **Out for delivery.** Seller marks it. Farmer gets a push and sees a
   4-digit code in My Orders.
6. **Deliver.** Seller enters a wrong code and is told how many tries are
   left, then the right code. Both phones show Delivered.
7. **Could not deliver.** On a second order: out for delivery, then "Could not
   deliver", "The farmer refused the order". The order is cancelled on both
   phones and the stock is back.
8. **Alerts off.** Seller turns notifications off in Profile. The dashboard
   shows the warning.

### 0.5 Existing bugs found and fixed on the way

These were not part of the plan. Each has a test now.

1. **Order updates never reached the farmer's in-app inbox.** The push used a
   notification type the database does not have, so the inbox row was refused
   every time. The phone alert itself did go out.
2. **The inbox could not load for anyone who had a notification.** The list
   route threw, and then failed to send even the error. It only worked for an
   empty inbox.
3. **Strict delivery areas blocked the wrong sellers.** With
   `shop.serviceability.strict` on, a seller whose only area was a whole
   district was refused to every farmer, including those in that district.

### 0.6 Where the build differs from the plan

- **"Whole district" areas are not offered** in the seller app (see phase 2).
- **The code is never put in a push.** A push is shown on a lock screen and
  stored in plain text. The farmer's push says the order is on its way; the
  code is in My Orders.
- **The backend stands aside if the database script is missing.** It checks for
  the table. Without it, no code is issued or demanded and orders ship and
  deliver as before, with an error in the log. So deploying the code before the
  script no longer stops sellers from shipping.
- **A buyer cannot put a message into the seller's alert.** The alert shows the
  delivery city, which the buyer types. A "city" with digits or link characters
  is left out.
- **Extra, beyond the plan:** the farmer app now opens My Orders when an order
  notification is tapped (it did nothing before); the seller app shows alerts
  while it is open and reloads Orders when it comes back to the front.

---

## 1. Summary

Most of seller delivery already exists. A farmer can order, the seller can see
the order with the address, and the seller can mark it confirmed, shipped and
delivered.

Eight things are missing. The most serious one: **the seller is not told when a
new order arrives.** They only see it if they open the app.

The plan is five phases. Phases 1 to 3 need no database change. Phase 4 adds one
small table. Phase 5 changes how payment is recorded and needs the owner's
approval before any code is written.

| Phase | What it gives | Database change |
|---|---|---|
| 1 | Seller gets an alert for every new order | None |
| 2 | Seller sets where they deliver, how fast, and any extra charge | None |
| 3 | Call and map buttons for the seller; farmer sees the promised date and the seller's phone | None |
| 4 | Proof of delivery with a code; a path for "farmer refused the order" | One new table |
| 5 | Cash-on-delivery money is recorded | Uses the table from phase 4 |

---

## 2. How it works today (documentation)

### 2.1 The flow

```
FARMER APP                      BACKEND                         SELLER APP
----------                      -------                         ----------
Product page: enter PIN  ---->  "delivers in 3-7 days"
Cart / checkout          ---->  quote: one shipment per seller,
                                delivery fee per shipment
Place order              ---->  Order + one OrderItem per line
                                (each line has its seller and
                                its own status)
                                                                Seller opens Orders
                                                                (no alert is sent)
                                                                sees name, phone, address
Push: order confirmed    <----  status change           <----   taps "Mark Confirmed"
Push: order shipped      <----  status change           <----   taps "Mark Shipped"
                                                                seller drives to the farmer
Push: order delivered    <----  status change           <----   taps "Mark Delivered"
```

### 2.2 Where each piece lives

| Piece | Where | What it does |
|---|---|---|
| Order and order lines | `Order`, `OrderItem` in [schema.prisma](../backend/prisma/schema.prisma) | An order has many lines. Each line stores its seller, its own status, and the times it was confirmed, shipped, delivered or cancelled. |
| Delivery address | `Order.deliveryAddress` (JSON) | Name, phone, flat, street, landmark, city, state, PIN code. There is no GPS location. |
| Delivery promise | `Order.deliveryPincode`, `Order.promisedEtaDays` | The PIN code and the number of days the farmer was shown at checkout. |
| Delivery areas | `SellerServiceArea` in the schema; routes in [sellerCompliance.routes.js](../backend/src/routes/sellerCompliance.routes.js) under `/agristore/seller-compliance/service-areas` | A seller can save rows: one PIN code, a 3-digit PIN prefix, a district or a state, each with fastest days, slowest days, an extra charge, and COD / pickup flags. |
| Area lookup | [serviceability.service.js](../backend/src/services/serviceability.service.js) | Picks the most specific matching row: exact PIN, then prefix, then district, then state. A seller with no rows is treated as "delivers everywhere" with the default time. |
| Delivery price | [shopPricing.service.js](../backend/src/services/shopPricing.service.js) | Groups the cart into one shipment per seller and prices each one. |
| Seller status changes | `PUT /agristore/seller/orders/:orderId/status` in [agristore.routes.js](../backend/src/routes/agristore.routes.js) | Moves all of that seller's lines on the order together, then recalculates the order's overall status. |
| Seller order list | [OrdersScreen.js](../seller-app/src/screens/OrdersScreen.js) | Shows each line with buyer name, delivery phone, full address, amount and payment method, and the button for the next status. |
| Farmer order list | [MyOrdersScreen.js](../frontend/src/screens/Profile/MyOrdersScreen.js) | Shows status, lets the farmer cancel, shows refund state. |
| Settlement | `SellerLedgerEntry`, `Payout`; [settlement.service.js](../backend/src/services/settlement.service.js) | A per-seller money ledger and payouts, managed from the admin finance pages. |

### 2.3 Status rules for the seller

| From | The seller may move it to |
|---|---|
| PENDING | CONFIRMED, SHIPPED, DELIVERED, CANCELLED |
| CONFIRMED | SHIPPED, DELIVERED, CANCELLED |
| SHIPPED | DELIVERED only |
| DELIVERED | nothing (final) |
| CANCELLED | nothing (final) |

Other rules that are already enforced:

- Skipping forward is allowed. A shop that hands goods over the counter can go
  straight from PENDING to DELIVERED.
- A seller cancel puts the stock back and, if the order was paid online, starts
  the refund.
- The farmer can cancel only while the whole order is PENDING and no seller has
  moved any line.
- On an order with two sellers, each seller moves only their own lines. The
  order's overall status is worked out from all lines.
- The farmer gets a push notification when the overall status changes.

### 2.4 Delivery price today

All values are admin settings (admin panel, Settings, "Shop" group). They can
be changed without a deploy.

| Setting | Default | Meaning |
|---|---|---|
| `shop.delivery.feePerShipment` | 49 | Charged once per seller in the order. |
| `shop.delivery.freeAboveSubtotal` | 999 | A seller's shipment is free when that seller's goods reach this amount. |
| `shop.delivery.heavyFee` | 250 | Charged for each line whose product is marked HEAVY. Never waived. |
| `shop.delivery.freightQuoteRequired` | on | Products marked FREIGHT (large machinery) cannot be checked out. |
| `shop.delivery.codFee` | 0 | Extra fee for cash on delivery. |
| `shop.serviceability.defaultEtaMinDays` / `MaxDays` | 3 / 7 | Shown when the seller has no area row for the farmer's PIN. |
| `shop.serviceability.strict` | off | When on, a seller who has saved areas cannot be ordered from outside them. |
| `marketplace.commissionRatePct` | 5 | The platform's commission rate used by the settlement service. |

The seller's extra charge for an area is added on top of that seller's shipment
fee. The order's promised time is the slowest shipment in it.

### 2.5 What is missing today

Each line below was checked in the code.

| # | Gap | Evidence |
|---|---|---|
| G1 | **The seller is not told about a new order.** | Order creation sends no notification. The only order push in the backend goes to the buyer. The seller app only understands one push type (`crop_report_share`). The seller dashboard reloads only when the screen is opened. |
| G2 | The seller cannot set delivery areas. | The backend routes exist. No screen in the seller app calls them. So every seller is "everywhere, 3 to 7 days, no extra charge". |
| G3 | A seller can receive an order from any distance. | `shop.serviceability.strict` is off, and no seller has area rows. |
| G4 | The seller has no call or map button, and no location pin. | The order card prints the address as text. The address has no latitude or longitude. |
| G5 | There is no proof of delivery. | "Mark Delivered" is one tap by the seller. Nothing from the farmer is required. |
| G6 | A cash-on-delivery order is never marked paid. | The only code that sets an order to `paid` is the online-payment confirm. An admin can change it by hand. Ledger entries are written only from the admin finance routes, not from orders. |
| G7 | After ordering, the farmer cannot see the promised date or contact the seller. | My Orders shows status, cancel and refund only. |
| G8 | Two saved flags do nothing at checkout. | `codAvailable` and `pickupAvailable` are stored and returned in the quote. Checkout does not refuse cash on delivery where a seller turned it off, and there is no collect-from-shop flow. |

One more limit to know: once a line is SHIPPED the seller cannot cancel it. If
the farmer refuses the goods at the door, the order stays in SHIPPED for ever.
Phase 4 fixes this.

---

## 3. Design principles

1. **Reuse what exists.** Statuses, per-seller lines, delivery areas and pricing
   stay as they are.
2. **Additive database changes only.** New tables and new columns. No column is
   dropped or renamed.
3. **Each phase can ship alone.** A later phase never has to be finished for an
   earlier one to be useful.
4. **Old app versions keep working.** Anything that would break an older seller
   app sits behind an admin setting that starts off.
5. **Built for weak networks and simple phones.** No step depends on a live map
   or a constant connection.
6. **Money rules are never changed quietly.** Phase 5 needs the owner's written
   decision first.

---

## 4. The target flow

```
1. Farmer enters a PIN code. They see this seller's own delivery time
   and total price, including the seller's extra charge for that area.
2. Farmer places the order.
3. Seller's phone gets an alert: "New order - Rs 1,240 - Kasegaon".      (phase 1)
4. Seller opens the order and taps Confirm.
   Farmer sees "Arriving by 16 Oct" and the shop's phone number.         (phase 3)
5. Seller loads the vehicle and taps "Out for delivery".
   Farmer's app shows a 4-digit delivery code.                           (phase 4)
6. Seller taps Call or Map on the order to find the house.               (phase 3)
7. At the door the farmer says the code. The seller types it in.
   For a cash order the seller also confirms the cash received.          (phases 4, 5)
8. Order is Delivered. Farmer and seller both see it.
```

If the farmer refuses the goods or cannot be reached, the seller marks
"Could not deliver" with a reason. The stock goes back and any online payment
is refunded (phase 4).

---

## 5. The phases

### Phase 1 — Tell the seller about a new order

**Why first:** without this, the rest does not matter. An order nobody sees is
not delivered.

| Area | Change |
|---|---|
| Backend | After an order is created (both the cash path and the online-payment confirm path), send one push to each seller in the order. It is sent after the database transaction finishes, the same way the buyer's push is sent today, so a push failure never undoes an order. |
| Push content | Title "New order". Body with the amount and the village or city. Data: `{ kind: 'new_order', orderId }`. No farmer phone number in the push. |
| Seller app | Add `new_order` to the push allow-list in `pushRoute.js` so a tap opens Orders. |
| Seller app | If the seller has turned notifications off, show a warning on the dashboard: "You will not be told about new orders." |
| Database | None. |

Not in this phase: SMS to the seller. It costs money per message and needs an
approved SMS template. It can be added later for sellers with no push token.

**Tests:** an API test that an order from two sellers sends exactly two pushes;
a unit test for the new push route; one real test on a phone.

### Phase 2 — Seller sets where they deliver

**Why:** the backend already uses these rows for the farmer's time and price.
Only the screen is missing.

| Area | Change |
|---|---|
| Seller app | New screen "Delivery areas", opened from the seller profile. A form to add an area and a list of saved areas with Change and Remove. |
| Form fields | What the rule covers (one PIN code, or PIN codes starting with 3 digits), fastest days, slowest days, extra delivery charge. |
| Not offered: "whole district" | Found while building: the backend only ever knows the farmer's PIN code, and has no PIN-to-district table. So a district rule's days and charge were never applied to any farmer. The option is hidden until the backend can work out the district from the PIN. Existing district rows are still listed and can be changed or removed. |
| First use | The form starts filled with the shop's own PIN code, so the first area is one tap. |
| Backend | None. The three routes already exist. |
| Database | None. |

The screen will **not** show switches for "cash on delivery" or "pickup",
because checkout does not act on them yet (gap G8). Saved values for those two
flags are kept unchanged when a row is edited.

**Owner step after sellers have added areas:** turn on
`shop.serviceability.strict` in admin Settings. From then on a seller with
saved areas cannot be ordered from outside them. Sellers with no areas are not
affected. Do not turn it on before sellers have added areas, or nothing changes.

**Tests:** unit tests for the form rules; API tests for the three routes (none
exist today); a phone test that the farmer's quote shows the new time and charge.

### Phase 3 — Make the delivery run easier

| Area | Change |
|---|---|
| Seller app, order card | A **Call** button (the delivery phone number) and a **Map** button that opens the phone's map app with the address text. |
| Wording | The SHIPPED status is shown as "Out for delivery" in both apps. The stored status does not change. |
| Farmer app, My Orders | Show "Arriving by <date>", worked out from the order date and the promised days. After the seller confirms, show the shop's name and a Call button. |
| Backend | The farmer's order response includes the seller's shop name and phone, only while the order is between CONFIRMED and DELIVERED. |
| Database | None. |

Privacy note: the seller's phone is sent to the farmer only while that seller's
part of the order is CONFIRMED or SHIPPED. The farmer's delivery phone stays on
the seller's order card as text, as it did before this work; the Call and Map
buttons appear only on an order that is not finished.

**Later, not in this phase:** a GPS pin on the farmer's address ("use my
current location" when saving an address). It needs two new columns and a
privacy review, because a location is personal data.

### Phase 4 — Proof of delivery and "could not deliver"

**The delivery code**

1. When the seller taps "Out for delivery", the backend creates a 4-digit code
   for that seller's part of the order.
2. The farmer sees the code in the app on the order, and gets a push.
3. At the door, the seller types the code to mark the order delivered.
4. Five wrong tries lock the code for 15 minutes.

Design choices:

- **The code is shown in the farmer's app, not sent by SMS.** The farmer
  ordered through the app, so they have it. This costs nothing and needs no SMS
  template approval. SMS can be added later as a backup.
- **The code is never sent to the seller.** It is returned only to the buyer's
  own signed-in request.
- **A fallback exists.** If the farmer cannot give the code (phone off, a
  relative receives the goods), the seller can choose "Deliver without code"
  and must give a reason. These deliveries are counted per seller and visible
  to the admin.
- **It starts optional.** A new setting `shop.delivery.codeRequired` starts
  off. While it is off, a code is shown and accepted but not demanded, so older
  seller app versions keep working. The owner turns it on after sellers have
  updated the app.

**Could not deliver**

A new allowed move for the seller: SHIPPED to CANCELLED, only with a reason
("farmer refused", "could not reach farmer", "address not found"). The existing
cancel logic then puts the stock back and refunds an online payment. This is
safe for seller delivery because the goods come back with the seller.

**New table: `order_deliveries`** — one row per seller per order.

| Column | Purpose |
|---|---|
| `orderId`, `sellerId` | Which part of which order. Unique together. |
| `code` | The 4-digit code, stored encrypted. |
| `codeAttempts`, `codeLockedUntil` | Wrong-try protection. |
| `deliveredVia` | `CODE` or `NO_CODE`. |
| `noCodeReason` | Filled when delivered without a code. |
| `failedReason` | Filled for "could not deliver". |
| `codAmountDue`, `codCollectedAmount`, `codCollectedAt` | Used in phase 5. Empty until then. |

**Tests:** API tests for a right code, a wrong code, the lock, the fallback, two
sellers on one order each with their own code, and the new cancel move putting
stock back exactly once.

### Phase 5 — Record cash on delivery

**This phase changes how payment is recorded. It needs the owner's decisions
D3 and D4 (section 6) before any code is written.**

Proposed behaviour:

1. When a cash order is delivered, the same "Mark delivered" step shows
   "Cash received: Rs X" and the seller confirms it. X is that seller's share:
   their goods plus their shipment's delivery fee, taken from the price
   breakdown frozen on the order.
2. When every seller on the order has confirmed their cash, the order's payment
   status becomes `paid`.
3. Each confirmed amount is written to the seller ledger as a sale, and the
   commission is written as a separate entry, so the admin finance pages show
   what each seller owes.

Open point inside this phase: with cash on delivery the seller holds the money,
so the commission is money the seller owes KrushiSarva. How that is collected
is decision D4.

### Later ideas (not planned yet)

- A reminder to the seller, then an alert to the admin, when an order is not
  confirmed within a set number of hours.
- GPS pin on the farmer's address.
- A separate login for the seller's delivery staff.
- Grouping a day's orders by village for one trip.
- Collect from shop, and enforcing "no cash on delivery" per area (gap G8).
- A courier company for PIN codes no seller delivers to.

---

## 6. Decisions the owner must make

| # | Decision | Recommendation |
|---|---|---|
| D1 | Should a seller be blocked from getting orders outside their saved areas? | Yes. Turn `shop.serviceability.strict` on once sellers have added areas (phase 2). |
| D2 | Should the delivery code be required from day one? | No. Start optional, turn it on about two weeks after sellers update the app. |
| D3 | When is a cash order "paid"? | When the seller confirms the cash in the delivered step. Not automatically on delivery. |
| D4 | How does KrushiSarva collect its commission on cash orders? | Needs your business decision. Options: deduct it from the seller's online-payment payouts, send a monthly bill, or charge no commission on cash orders at first. Phase 5 records the amount owed in every case. |
| D5 | What happens to a farmer who refuses orders at the door? | Count refusals per farmer. After two, that farmer can pay online only. Also decide the money: today a refused order that was paid online is refunded in full, delivery fee included. |
| D6 | Should "could not deliver" count against the seller? | Today it does: it is a cancellation, and the seller's cancellation rate affects which shop wins the buy box. Recommended: do not count `REFUSED` and `UNREACHABLE` against the seller, but show the admin how often each seller uses them. Not built. |

---

## 7. Rollout

Phases 1 to 4 were built together, so they ship together. The order below
matters.

1. **A deployed backend that both apps can reach.** On 2026-10-12 the
   production URL built into both apps answered "Application not found". This
   was not re-checked.
2. **Apply the database script to production FIRST:**
   `backend/prisma/manual/seller_delivery_additive.sql`. It adds the table
   `order_deliveries` and the notification type `NEW_ORDER`. It needs
   PostgreSQL 12 or newer, is safe to run twice, and checks its own result.
3. **Then deploy the backend code.** The deploy itself changes no schema (the
   start command is only `node src/server.js`), so the script is the only way
   the table arrives. If the code goes out first nothing breaks, but delivery
   codes and "could not deliver" stay off, with an error in the log, until the
   script is applied. The backend re-checks every 30 seconds.
4. **Build both apps** and install them on two test phones.
5. **Test on the phones** (the checklist is in section 0.4).
6. Ask a few sellers to add their delivery areas. Check a farmer's price and
   delivery time in those PIN codes.
7. Turn on `shop.serviceability.strict` (decision D1).
8. When sellers have the new app, turn on `shop.delivery.codeRequired`
   (decision D2). An older seller app cannot enter a code, so turning this on
   early stops those sellers from marking any order delivered.
9. Phase 5 only after D3 and D4 are decided.

**Rollback:** revert the code. Both new settings start off, the new table can
stay empty, and the script does not need to be undone. Phase 5 is the only
phase that writes money records, which is why it is last.

---

## 8. API contract for phases 1 to 4

This section is the single source of truth for the three codebases. Every new
field is optional for the reader: an app must render correctly when a field is
missing (older backend), and the backend must accept requests without the new
fields (older app).

### 8.1 Push: new order (backend to seller app)

- Sent once per distinct seller on the order, after the transaction that creates
  the order has committed, on both creation paths (cash order, and online-payment
  confirm). Fire-and-forget: a push failure never changes the response.
- Not sent to a seller who is also the buyer of that order.
- Payload: `type: 'NEW_ORDER'`, `title: 'New order'`,
  `body: '<amount> · <city>'` where amount is the sum of that seller's lines
  (goods only), and `data: { kind: 'new_order', orderId }`.
- Default notification category, so it respects the seller's notification switch.
- Seller app: `pushTarget({ kind: 'new_order', orderId })` returns
  `{ name: 'SellerOrders', params: {} }` when `orderId` is a UUID, otherwise `null`.

### 8.2 Farmer order responses

`GET /agristore/orders` (page mode and cursor mode) and `GET /agristore/orders/:id`.
Each order gains two fields:

```
expectedBy: string | null     ISO time = createdAt + promisedEtaDays days;
                              null when promisedEtaDays is null
deliveries: [
  {
    sellerId:     string,
    sellerName:   string | null,   the lines' frozen sellerName, else the seller's account name
    status:       'PENDING' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED',
                                   this seller's status on this order: the least-advanced
                                   live line; CANCELLED when no line is live
    sellerPhone:  string | null,   only when status is CONFIRMED or SHIPPED
    deliveryCode: string | null    4 digits; only when status is SHIPPED and a code exists
  }
]
```

Lines with no `sellerId` are not listed. The extra data is loaded with a fixed
number of batched queries per page, never one query per order.

### 8.3 Seller order list

`GET /agristore/seller/orders`. Each row's `order` gains:

```
delivery: { hasCode: boolean, codeRequired: boolean, lockedUntil: string | null }
```

The code itself is never sent to the seller.

### 8.4 Seller status change

`PUT /agristore/seller/orders/:orderId/status`. New optional body fields:

| Field | Values | Read when |
|---|---|---|
| `deliveryCode` | a string of exactly 4 digits | `status` is `DELIVERED` |
| `noCodeReason` | `FARMER_PHONE_OFF`, `RECEIVED_BY_OTHER`, `HANDED_AT_SHOP`, `OTHER` | `status` is `DELIVERED` |
| `failedReason` | `REFUSED`, `UNREACHABLE`, `ADDRESS_NOT_FOUND` | `status` is `CANCELLED` |

Rules:

- **To SHIPPED:** creates the `order_deliveries` row for this order and seller if
  it does not exist, with a new random 4-digit code (`0000` to `9999`).
- **To DELIVERED:**
  - A `deliveryCode` is sent and a code exists: compare. A match delivers with
    `deliveredVia = 'CODE'`. A mismatch adds one to the attempt count and
    refuses with `DELIVERY_CODE_WRONG`. The fifth wrong try locks the code for
    15 minutes; while locked, any attempt with a code is refused with
    `DELIVERY_CODE_LOCKED`. **The attempt count must be saved even though the
    status change is refused.**
  - A `noCodeReason` is sent and no `deliveryCode`: delivers with
    `deliveredVia = 'NO_CODE'` and stores the reason. Creates the row if needed.
  - Neither is usable (nothing sent, or a `deliveryCode` sent when no code was
    ever issued): refused with `DELIVERY_CODE_REQUIRED` when the setting
    `shop.delivery.codeRequired` is on. When it is off, the order is delivered
    exactly as today and `deliveredVia` stays null.
- **To CANCELLED:**
  - Lines in PENDING or CONFIRMED: unchanged from today.
  - Lines in SHIPPED: can move only with a valid `failedReason`, which is
    stored. Stock is put back and an online payment is refunded through the
    existing cancel logic, exactly once. Without it the shipped lines cannot
    move and the refusal carries `FAILED_REASON_REQUIRED`.

Refusals are HTTP 409 in the house error envelope:
`{ success: false, error: { message, details: { code, ... } } }`.

| `details.code` | Extra `details` fields |
|---|---|
| `DELIVERY_CODE_REQUIRED` | none |
| `DELIVERY_CODE_WRONG` | `attemptsLeft` (number) |
| `DELIVERY_CODE_LOCKED` | `lockedUntil` (ISO time) |
| `FAILED_REASON_REQUIRED` | none |

The existing "already shipped / cannot be marked" refusal keeps its
`details: { from: [...] }`. A successful move to DELIVERED adds
`deliveredVia: 'CODE' | 'NO_CODE' | null` to the response data.

### 8.5 Setting

`shop.delivery.codeRequired`: BOOL, category `Shop`, default `false`.

### 8.6 Table

Prisma model `OrderDelivery`, table `order_deliveries`: `id`, `orderId`,
`sellerId`, `code` (encrypted at rest), `codeAttempts` (default 0),
`codeLockedUntil`, `deliveredVia`, `noCodeReason`, `failedReason`,
`codAmountDue`, `codCollectedAmount`, `codCollectedAt` (the three COD columns
are unused until phase 5), `createdAt`, `updatedAt`. Unique on
(`orderId`, `sellerId`). No other index.

Applied the way this repository applies schema changes: an idempotent,
self-verifying script in `backend/prisma/manual/` plus a matching migration
folder. In production the script is applied **before** the code is deployed.

### 8.7 New translation keys

The apps use `t('key', 'English text')` with new keys only. Existing keys in
`shared/i18n/translations.js` are not edited by the app work; the new keys are
added to English, Hindi and Marathi in one pass afterwards.

### 8.8 As built — points the contract left open

- **The fifth wrong try** answers `DELIVERY_CODE_WRONG` with `attemptsLeft: 0`
  and also carries `lockedUntil`. Every later try with a code answers
  `DELIVERY_CODE_LOCKED`. The count is of wrong tries only: a right code is not
  counted. When a lock has passed, the next try starts a new five.
- **`FAILED_REASON_REQUIRED`** keeps the old refusal's `from: [...]` beside
  `code`, and the old message, so an older seller app sees what it always saw.
- **Malformed input is HTTP 400**, not 409: a `deliveryCode` that is not a
  string of 4 digits, or a reason outside the lists. An empty string or null
  counts as "not sent".
- **A code and a reason sent together:** the code is checked and the reason is
  ignored. If no code was ever issued, the order is delivered as `NO_CODE`.
- **While the code is locked**, delivering with a `noCodeReason` still works.
- **`deliveredVia` is in the response only for a move that happened.** A
  repeated request still answers `{ itemsUpdated: 0, unchanged: true }`.
- **`sellerPhone` is the seller's account phone.** There is no separate shop
  phone.
- **No foreign key on `order_deliveries`**, and `code` is nullable: a delivery
  made without a code never has one.
- **The table is missing:** see section 0.6. The seller list then carries no
  `delivery` field at all, which the seller app treats as an older backend.

### 8.9 Delivery charge breakdown (added after the first build)

The farmer saw one "Delivery charges" figure, with a shop's extra charge folded
into it. The quote now also says what the fee is made of, and the farmer app
prints those parts under the delivery row in the cart, at checkout and in the
opened order.

```
quote.deliveryBreakdown              { base, heavy, area, cod }   strings, 2 decimals
quote.shipments[].deliveryBreakdown  { base, heavy, area }
order.pricingSnapshot                the same two, frozen when the order is placed
```

| Part | Meaning |
|---|---|
| `base` | The standard fee per delivery. 0 when free delivery applied. |
| `area` | That shop's extra charge for the farmer's PIN code. Not waived by free delivery. |
| `heavy` | Handling for heavy items. |
| `cod` | The cash-on-delivery fee, on a cash quote only. |

The parts always add up to `deliveryFee`. They explain the fee; nothing is
charged from them. The app shows the lines only when there is something besides
the standard fee, so an ordinary Rs 49 delivery looks as it did before. Orders
placed before this have no breakdown and show none.

---

## 9. Known gaps, and what is not verified

### 9.1 Before sellers use this

1. **Nothing has run on a phone.** No seller device has ever registered for
   push in the local database (zero rows in `push_tokens`), so the new-order
   alert has never been seen arriving. Do the test in section 0.4.
2. **The alert makes a sound but shows no pop-up on Android.** The notification
   channel is created with default importance
   (`shared/services/pushRegistration.js`). A pop-up needs high importance,
   which on Android means a new channel.
3. **On an order from two shops, the farmer gets one push.** It is sent when
   the first shop goes out for delivery. The second shop's code is in My Orders
   but nothing announces it.
4. **The admin cannot see misuse.** Deliveries without a code, wrong-code
   locks and "could not deliver" reasons are stored in `order_deliveries`, but
   no admin screen, count or alert reads them.
5. **"Could not deliver" counts against the seller** (decision D6).

### 9.2 Smaller, for later

- **District and state areas do nothing.** Their days and charge are never
  applied, and under strict mode a seller who has one is not blocked anywhere.
  The seller app cannot create them, so this only matters for rows made
  another way.
- **The code has no lifetime limit.** Five tries, then 15 minutes, for ever:
  about 480 guesses a day. A seller who keeps an order "out for delivery" for
  days could guess it. Fix: stop accepting the code after a few locks.
- **The "require the code" setting is slow to spread and fails open.** Each
  server process keeps settings for 60 seconds, and if settings cannot be read
  it is treated as off.
- **A new-order push can be lost** when Redis is down and several are being
  sent at once. Order creation is not affected.
- **The lock time is shown in English clock format** ("3:45 PM").
- **Four older seller-app strings are still English only**
  (`orders.statusUpdated`, `orders.cancelMsg`, `share.callFailed`,
  `common.offlineAction`).
- **A cash-on-delivery fee on a two-shop order:** `shop.delivery.codFee` is 0
  today. How to split it is part of phase 5.

### 9.3 Not verified

- Every screen: layout, the keyboard over the code sheet, long Hindi and
  Marathi labels, screen readers.
- That Call opens the dialler and Map finds a rural address.
- Push tap handling from a closed app, on both apps.
- The production PostgreSQL version (the script needs 12 or newer) and whether
  the Railway query tab runs it as written.

### 9.4 Separate from this feature

`frontend/railway.toml` has a start command containing
`prisma db push --accept-data-loss`. The root `railway.json` builds the
Dockerfile, whose start command does not. Which one Railway actually uses was
not checked. If anything still reads the old file it could drop tables, so it
is worth checking and then deleting.
