/**
 * Seller delivery — the Krushi Seva Kendra delivers an AgriStore order itself.
 *
 * Contract: docs/SELLER_DELIVERY_DESIGN.md §8. Everything the three apps agree
 * on lives there; this file is the backend half of phases 1 to 4.
 *
 *   Phase 1  newOrderPushes / notifySellersOfNewOrder
 *            A seller was never told an order had arrived — the only order push
 *            in the backend went to the BUYER. An order nobody sees is an order
 *            nobody delivers.
 *   Phase 3  withOrderDeliveries
 *            What the farmer needs after ordering: when it should arrive, and
 *            who to call while it is on its way.
 *   Phase 4  planSellerDelivery / recordDeliveryOutcome / attachSellerDeliveryState
 *            Proof of delivery (a 4-digit code the farmer reads out at the door)
 *            and a way out of SHIPPED when the farmer refuses the goods.
 *
 * ── The one thing here that is easy to get wrong ────────────────────────────
 * The seller status change runs in ONE Serializable transaction, and a refusal
 * rolls that transaction back. A wrong delivery code is a refusal — so if the
 * attempt counter were written inside it, the count would roll back with it and
 * a seller could guess all 10,000 codes at their leisure. The counter therefore
 * lives OUTSIDE the transaction, in planSellerDelivery(), which runs first:
 *
 *     planSellerDelivery()            own statements, committed one by one
 *        claim an attempt  ── atomic UPDATE … RETURNING
 *        compare the code  ── constant time
 *        wrong → refuse    ── the claim stays spent
 *        right → hand it back, and return a plan
 *     $transaction(Serializable)      the existing status change
 *        recordDeliveryOutcome(plan)  writes deliveredVia with the lines
 *
 * The attempt is CLAIMED BEFORE the comparison, not counted after it. Counting
 * afterwards is the obvious shape and it is raceable: fifty parallel requests
 * would all read "not locked", all compare, and only then all increment — fifty
 * guesses for the price of five. Claiming first makes the limit hold however
 * the requests are interleaved, because the claim is a single conditional
 * UPDATE and Postgres serialises those on the row.
 *
 * ── Why this does not reuse otpLockout.service.js ───────────────────────────
 * It looks like the same problem and is not. That service keeps its counters in
 * Redis with an in-process fallback, sized by the OTP_LOCK_* env vars, with a
 * lock that doubles on every cycle. The delivery lock is a fixed 15 minutes, has
 * to be readable in bulk for the seller's order list (one batched query, not a
 * Redis round trip per order), has to survive a Redis restart, and is specified
 * as two columns on `order_deliveries` (§8.6). The OTP service also counts a
 * failure AFTER its caller has compared, which is the raceable shape above.
 *
 * ── The code itself ─────────────────────────────────────────────────────────
 * crypto.randomInt, four digits with leading zeros, AES-256-GCM at rest
 * (utils/encrypt.js), compared with timingSafeEqual. It is returned ONLY by
 * withOrderDeliveries(), on the buyer's own signed-in read. No function in this
 * file returns it to a seller, logs it, or puts it in a push — a push body is
 * also stored in `notifications` in plain text, which would undo the encryption.
 */
import crypto from 'crypto';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { D } from '../utils/money.js';
import { encrypt, decrypt } from '../utils/encrypt.js';
import { getSetting } from './settings.service.js';
import { sendPushToUser } from './push.service.js';

// ── Contract values (§8.4) ────────────────────────────────────────────────────
export const NO_CODE_REASONS = Object.freeze(['FARMER_PHONE_OFF', 'RECEIVED_BY_OTHER', 'HANDED_AT_SHOP', 'OTHER']);
export const FAILED_REASONS = Object.freeze(['REFUSED', 'UNREACHABLE', 'ADDRESS_NOT_FOUND']);

export const DELIVERY_REFUSALS = Object.freeze({
  CODE_REQUIRED: 'DELIVERY_CODE_REQUIRED',
  CODE_WRONG: 'DELIVERY_CODE_WRONG',
  CODE_LOCKED: 'DELIVERY_CODE_LOCKED',
  FAILED_REASON_REQUIRED: 'FAILED_REASON_REQUIRED',
});

/** Wrong tries before the code locks, and for how long. Fixed by §8.4. */
export const DELIVERY_CODE_MAX_ATTEMPTS = 5;
export const DELIVERY_CODE_LOCK_MINUTES = 15;

const CODE_RE = /^[0-9]{4}$/;

/** A string of exactly four digits. A NUMBER is refused: 0042 would arrive as 42. */
export function isDeliveryCode(value) {
  return typeof value === 'string' && CODE_RE.test(value);
}

/** `0000` to `9999`, uniformly, from the OS CSPRNG. */
export function generateDeliveryCode() {
  return String(crypto.randomInt(0, 10_000)).padStart(4, '0');
}

async function codeRequired() {
  return (await getSetting('shop.delivery.codeRequired')) === true;
}

// ── Is the table there? ───────────────────────────────────────────────────────
const TABLE_RECHECK_MS = 30_000;
let tableState = { ready: null, checkedAt: 0 };

/**
 * Whether `order_deliveries` exists in this database.
 *
 * The table arrives by a MANUAL script (prisma/manual/seller_delivery_additive.sql)
 * — the deploy runs no schema change of its own — and nothing forces that script
 * to be applied before this code goes out. Without this check the order is not
 * survivable in reverse: "Mark shipped" writes to the table INSIDE the status
 * transaction, so on a database that does not have it yet every seller would get
 * a 500 on every shipment. An outage, from a feature that is off by default.
 *
 * So the feature asks first, and when the table is missing it STANDS ASIDE: a
 * status change runs exactly as it did before this file existed — no code issued,
 * none checked, none demanded, no "could not deliver" — the seller list carries
 * no `delivery` (so the app behaves as it does against an older backend), and the
 * log says so at error level.
 *
 * `true` is remembered for the life of the process: a table does not go away.
 * `false` is re-checked every 30 s, so applying the script takes effect without a
 * restart. If the CHECK ITSELF fails the table is assumed present — a database
 * blip must not quietly switch the delivery code off, and the statements that
 * follow will fail honestly if the database really is down.
 */
export async function deliveryTableReady(now = Date.now()) {
  if (tableState.ready === true) return true;
  if (tableState.ready === false && now - tableState.checkedAt < TABLE_RECHECK_MS) return false;
  try {
    const rows = await prisma.$queryRaw`SELECT to_regclass('public.order_deliveries') IS NOT NULL AS "ready"`;
    const ready = rows?.[0]?.ready === true;
    tableState = { ready, checkedAt: now };
    if (!ready) {
      logger.error('[Delivery] table order_deliveries is missing — apply backend/prisma/manual/seller_delivery_additive.sql. Delivery codes and "could not deliver" are OFF until then; orders ship and deliver as before.');
    }
    return ready;
  } catch (err) {
    logger.warn('[Delivery] could not check for order_deliveries, assuming it exists: %s', err?.message);
    return true;
  }
}

/**
 * Tests only: make deliveryTableReady() answer `value` (true / false), or pass
 * null to forget what it remembered so the next call asks the database again.
 */
export function __setDeliveryTableReadyForTests(value) {
  tableState = { ready: value, checkedAt: value === false ? Date.now() : 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1 — tell the seller about a new order (§8.1)
// ═══════════════════════════════════════════════════════════════════════════════

const WHOLE_RUPEES = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const WITH_PAISE = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₹1,240 — or ₹1,240.50 when there are paise. Display only, never arithmetic. */
function formatRupees(amount) {
  const d = D(amount);
  return `₹${(d.isInteger() ? WHOLE_RUPEES : WITH_PAISE).format(d.toNumber())}`;
}

// Letters and combining marks of any script (Devanagari included), the joiners
// Marathi and Hindi spell with, spaces, and the punctuation a place name uses.
const PLACE_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}‌‍ .,'()-]*$/u;
const PLACE_NAME_MAX = 40;

/**
 * The delivery city for the push body — or '' when it does not read as a place
 * name, in which case the push carries the amount alone.
 *
 * `city` is free text the BUYER typed, and this puts it on the seller's lock
 * screen under the trusted title "New order". An order costs nothing to place
 * cash-on-delivery, so "Call 98xxxxxxxx to collect payment" in the city field
 * would be a phishing message delivered by KrushiSarva itself. A place name has
 * no digits and no URL characters, so anything that does is left out — the
 * seller still sees the full address on the order, behind their login, where it
 * is plainly the buyer's own words.
 */
export function pushCity(raw) {
  if (typeof raw !== 'string') return '';
  const city = raw.trim().replace(/\s+/g, ' ');
  return city && city.length <= PLACE_NAME_MAX && PLACE_NAME_RE.test(city) ? city : '';
}

/**
 * The NEW_ORDER pushes one freshly created order calls for — one per distinct
 * seller. Pure: it reads only the order that `tx.order.create` just returned
 * (which already carries every line), so it costs no query at all.
 *
 *   amount  that seller's GOODS total. Not the order total: a two-Kendra order
 *           would otherwise tell each of them about the other's sale, and the
 *           delivery fee is not what they pack.
 *   city    where it is going, from the delivery address. Enough to decide
 *           whether to load the van today.
 *
 * Deliberately absent: the farmer's phone and name. A push is read on a lock
 * screen and is stored in `notifications`; the seller sees both on the order
 * itself, behind their login.
 *
 * A seller who is also the BUYER is skipped — nothing stops a Kendra ordering
 * its own offer, and "you have a new order" from yourself is noise.
 *
 * @param {{id:string, userId:string, deliveryAddress?:object, items?:Array}} order
 */
export function newOrderPushes(order) {
  if (!order?.id) return [];
  const goodsBySeller = new Map();
  for (const item of order.items || []) {
    if (!item?.sellerId || item.sellerId === order.userId) continue;
    goodsBySeller.set(item.sellerId, (goodsBySeller.get(item.sellerId) || D(0)).plus(D(item.totalPrice)));
  }

  const city = pushCity(order.deliveryAddress?.city);

  return [...goodsBySeller].map(([sellerId, goods]) => ({
    userId: sellerId,
    type: 'NEW_ORDER',
    title: 'New order',
    body: city ? `${formatRupees(goods)} · ${city}` : formatRupees(goods),
    // `kind` is what the seller app routes on (pushRoute.js). ACTIVITY category
    // by default, so the seller's notification switch is respected.
    data: { kind: 'new_order', orderId: order.id },
  }));
}

/**
 * Fire-and-forget. Call it AFTER the order's transaction has committed: a push
 * is not worth holding a Serializable transaction open for, and a queue hiccup
 * must never undo — or even delay the response to — an order the farmer has
 * already been told succeeded. Never throws.
 */
export function notifySellersOfNewOrder(order) {
  try {
    for (const push of newOrderPushes(order)) {
      Promise.resolve(sendPushToUser(push)).catch(() => {});
    }
  } catch (err) {
    logger.warn('[Delivery] new-order push skipped for order %s: %s', order?.id, err?.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 3 — what the farmer sees on their order (§8.2)
// ═══════════════════════════════════════════════════════════════════════════════

const STATUS_RANK = { PENDING: 0, CONFIRMED: 1, SHIPPED: 2, DELIVERED: 3 };

/** The seller's phone is shown only while they are actively bringing the goods. */
const PHONE_VISIBLE = new Set(['CONFIRMED', 'SHIPPED']);

/**
 * One seller's status on one order: the LEAST advanced live line, or CANCELLED
 * when none is live.
 *
 * Least advanced, because the farmer is asking "is my delivery from this shop
 * on its way" and it is not until every line of it is. (The seller route moves
 * all of a seller's lines together, so they only differ on older orders.)
 */
export function sellerShipmentStatus(statuses) {
  let least = null;
  for (const s of statuses) {
    const rank = STATUS_RANK[s];
    if (rank === undefined) continue;   // CANCELLED, and anything unrecognised
    if (least === null || rank < STATUS_RANK[least]) least = s;
  }
  return least ?? 'CANCELLED';
}

/** createdAt + promisedEtaDays, as an ISO time. Null when no promise was recorded. */
export function expectedByFor(order) {
  const days = order?.promisedEtaDays;
  if (days == null || !Number.isFinite(Number(days)) || !order?.createdAt) return null;
  const placed = new Date(order.createdAt).getTime();
  if (Number.isNaN(placed)) return null;
  return new Date(placed + Number(days) * 86_400_000).toISOString();
}

/** The stored code as four digits, or null if it cannot be read back. */
function readableCode(ciphertext) {
  if (!ciphertext) return null;
  const plain = decrypt(ciphertext);
  return isDeliveryCode(plain) ? plain : null;
}

/**
 * Add `expectedBy` and `deliveries` to the BUYER's own orders.
 *
 * A fixed number of queries per PAGE, never one per order (§8.2):
 *   1. users             names + phones for the sellers that need one
 *   2. order_deliveries  codes for the shipments that are out for delivery
 * and neither runs when nothing on the page needs it — a page of delivered
 * orders with frozen seller names costs zero.
 *
 * Privacy is decided here, on the server, per shipment:
 *   sellerPhone   only CONFIRMED / SHIPPED. Not before the seller has accepted
 *                 the order, and not after it is delivered or cancelled.
 *   deliveryCode  only SHIPPED. It is useless before the van leaves and must
 *                 not linger on a delivered order.
 *
 * ONLY call this for the order's own buyer. The route has already scoped the
 * read to `userId: req.user.id`; this function does not re-check ownership.
 *
 * @param {Array<object>} orders  with `items` (sellerId, sellerName, status)
 * @returns {Promise<Array<object>>} copies, in the same order
 */
export async function withOrderDeliveries(orders) {
  const list = (orders || []).filter(Boolean);
  if (!list.length) return [];

  // Pass 1 — from rows already in memory. Lines with no seller are not listed.
  const shipmentsByOrder = list.map((order) => {
    const bySeller = new Map();
    for (const item of order.items || []) {
      if (!item?.sellerId) continue;
      let s = bySeller.get(item.sellerId);
      if (!s) {
        s = { sellerId: item.sellerId, sellerName: null, statuses: [] };
        bySeller.set(item.sellerId, s);
      }
      if (!s.sellerName && item.sellerName) s.sellerName = item.sellerName;
      s.statuses.push(item.status);
    }
    return [...bySeller.values()].map((s) => ({
      sellerId: s.sellerId,
      sellerName: s.sellerName,
      status: sellerShipmentStatus(s.statuses),
    }));
  });

  const sellersToLoad = new Set();
  const ordersOutForDelivery = new Set();
  shipmentsByOrder.forEach((shipments, idx) => {
    for (const s of shipments) {
      if (!s.sellerName || PHONE_VISIBLE.has(s.status)) sellersToLoad.add(s.sellerId);
      if (s.status === 'SHIPPED') ordersOutForDelivery.add(list[idx].id);
    }
  });

  // Asked only when a code could be shown. No table (script not applied yet) →
  // no codes exist, and the orders are served without them, quietly.
  const codesReadable = ordersOutForDelivery.size > 0 && await deliveryTableReady();

  const [sellers, codeRows] = await Promise.all([
    sellersToLoad.size
      ? prisma.user.findMany({
          where: { id: { in: [...sellersToLoad] } },
          select: { id: true, name: true, phone: true },
        })
      : [],
    codesReadable
      ? prisma.orderDelivery.findMany({
          where: { orderId: { in: [...ordersOutForDelivery] }, code: { not: null } },
          select: { orderId: true, sellerId: true, code: true },
        }).catch((err) => {
          // The farmer's order list must not 500 because the optional part of
          // it could not be read — the field is optional for the reader (§8).
          logger.warn('[Delivery] delivery codes unavailable, orders served without them: %s', err?.message);
          return [];
        })
      : [],
  ]);

  const sellerById = new Map(sellers.map((u) => [u.id, u]));
  const codeByShipment = new Map(codeRows.map((r) => [`${r.orderId}:${r.sellerId}`, r.code]));

  return list.map((order, idx) => ({
    ...order,
    expectedBy: expectedByFor(order),
    deliveries: shipmentsByOrder[idx].map((s) => {
      const seller = sellerById.get(s.sellerId);
      return {
        sellerId: s.sellerId,
        // The name frozen on the order line wins: it is what the farmer was
        // shown at checkout. The account name only fills in for older lines.
        sellerName: s.sellerName || seller?.name || null,
        status: s.status,
        sellerPhone: PHONE_VISIBLE.has(s.status) ? (seller?.phone || null) : null,
        deliveryCode: s.status === 'SHIPPED'
          ? readableCode(codeByShipment.get(`${order.id}:${s.sellerId}`))
          : null,
      };
    }),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4 — the seller's order list (§8.3)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Put `delivery: { hasCode, codeRequired, lockedUntil }` on each row's `order`.
 *
 * One batched query for the whole page. The row's ciphertext is read only to
 * answer "is there a code" and is never copied onto the response — the object
 * below is built field by field so nothing else can ride along.
 *
 * @param {Array<object>} items  order lines, each with `orderId` and `order`
 * @param {string} sellerId      the caller
 */
export async function attachSellerDeliveryState(items, sellerId) {
  // No table → no `delivery` at all, which is exactly what the seller app reads
  // as "this backend does not do delivery codes": it then offers one-tap
  // delivery and no "could not deliver", both of which this backend will accept.
  if (!(await deliveryTableReady())) return items;

  const orderIds = [...new Set((items || []).map((i) => i?.orderId).filter(Boolean))];
  const [required, rows] = await Promise.all([
    codeRequired(),
    orderIds.length
      ? prisma.orderDelivery.findMany({
          where: { sellerId, orderId: { in: orderIds } },
          select: { orderId: true, code: true, codeLockedUntil: true },
        }).catch((err) => {
          logger.warn('[Delivery] delivery state unavailable for the seller list: %s', err?.message);
          return [];
        })
      : [],
  ]);

  const byOrder = new Map(rows.map((r) => [r.orderId, r]));
  const now = Date.now();
  for (const item of items || []) {
    if (!item?.order) continue;
    const row = byOrder.get(item.orderId);
    const lockedUntil = row?.codeLockedUntil && row.codeLockedUntil.getTime() > now
      ? row.codeLockedUntil.toISOString()
      : null;
    item.order.delivery = { hasCode: Boolean(row?.code), codeRequired: required, lockedUntil };
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4 — the seller status change (§8.4)
// ═══════════════════════════════════════════════════════════════════════════════

/** Statuses a line can be delivered FROM. Mirrors SELLER_ITEM_TRANSITIONS. */
const DELIVERABLE_FROM = new Set(['PENDING', 'CONFIRMED', 'SHIPPED']);

/**
 * A Date as the UTC wall clock Postgres stores, with no zone designator.
 *
 * Every DateTime in this schema is `timestamp(3) WITHOUT time zone` holding UTC.
 * Binding a JS Date through raw SQL sends `timestamptz`, and comparing the two
 * makes Postgres read the column in the SESSION time zone — on a database whose
 * session is Asia/Kolkata a lock would appear to expire 5h30m early or late.
 * Text cast to `timestamp` carries no zone on either side, so nothing can shift.
 * (Same reasoning, measured, in utils/keyset.js.)
 */
function utcWallClock(date) {
  return date.toISOString().replace('Z', '');
}

/**
 * Take one of the five attempts — atomically, and BEFORE comparing.
 *
 * One statement, so it is correct under any interleaving:
 *   - not locked, attempts < 5      → attempts + 1; the claim that takes the
 *                                     LAST attempt also sets the lock, in the
 *                                     same statement, so "five used, not locked"
 *                                     is a state that cannot exist
 *   - lock in the past              → a fresh window: attempts = 1, lock cleared
 *   - lock in the future            → matches no row → null → DELIVERY_CODE_LOCKED
 *
 * Every right-hand side in SET sees the row as it was BEFORE the update, which
 * is what lets one CASE decide the counter and another the lock off the same
 * old values.
 *
 * @returns {Promise<{attempts:number, lockedUntil:Date|null}|null>} null = locked
 */
async function claimCodeAttempt(deliveryId, now = new Date()) {
  const nowText = utcWallClock(now);
  const lockText = utcWallClock(new Date(now.getTime() + DELIVERY_CODE_LOCK_MINUTES * 60_000));
  const rows = await prisma.$queryRaw`
    UPDATE "order_deliveries" SET
      "codeAttempts" = CASE WHEN "codeLockedUntil" IS NOT NULL THEN 1 ELSE "codeAttempts" + 1 END,
      "codeLockedUntil" = CASE
        WHEN "codeLockedUntil" IS NULL AND "codeAttempts" + 1 >= ${DELIVERY_CODE_MAX_ATTEMPTS}
          THEN ${lockText}::timestamp
        ELSE NULL
      END,
      "updatedAt" = ${nowText}::timestamp
    WHERE "id" = ${deliveryId}
      AND ("codeLockedUntil" IS NULL OR "codeLockedUntil" <= ${nowText}::timestamp)
    RETURNING "codeAttempts", "codeLockedUntil"`;
  if (!rows.length) return null;
  return { attempts: Number(rows[0].codeAttempts), lockedUntil: rows[0].codeLockedUntil || null };
}

/**
 * Hand back an attempt that turned out to be the RIGHT code.
 *
 * The counter is a count of WRONG tries. Without this, a seller on their fifth
 * attempt who typed the code correctly would have locked it by claiming — and
 * if the delivery transaction then lost a serialization race, the retry would
 * be refused as locked with the right code in hand.
 */
async function releaseCodeAttempt(deliveryId) {
  await prisma.orderDelivery.updateMany({
    where: { id: deliveryId, codeAttempts: { gt: 0 } },
    data: { codeAttempts: { decrement: 1 }, codeLockedUntil: null },
  });
}

/** Constant time, so the response time says nothing about how close a guess was. */
function codeMatches(ciphertext, candidate) {
  const stored = decrypt(ciphertext);
  if (typeof stored !== 'string' || !stored) return false;
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(String(candidate), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function refuse(code, message, extra = {}) {
  return { refusal: { message, details: { code, ...extra } } };
}

function lockedRefusal(lockedUntil) {
  return refuse(
    DELIVERY_REFUSALS.CODE_LOCKED,
    `Too many wrong codes. Try again in ${DELIVERY_CODE_LOCK_MINUTES} minutes, or deliver without the code and give a reason.`,
    { lockedUntil: lockedUntil ? new Date(lockedUntil).toISOString() : null },
  );
}

/**
 * Decide, BEFORE the status transaction, how this request may proceed.
 *
 * Returns `{ refusal: { message, details } }` (answer 409 and stop) or a plan
 * `{ via, noCodeReason, failedReason }` for recordDeliveryOutcome().
 *
 * ── Old seller apps ──────────────────────────────────────────────────────────
 * They send `{ status }` and nothing else. With `shop.delivery.codeRequired`
 * off — the default — that request leaves here on the first branch below having
 * run no query at all (the setting is cached in-process), and the transaction
 * then behaves exactly as it did before this file existed.
 *
 * ── A repeated tap stays a no-op ────────────────────────────────────────────
 * Nothing is claimed or refused unless the caller actually has a line that can
 * still be delivered. A second "Mark delivered" on an order that is already
 * delivered — even carrying a wrong code — must reach the transaction and get
 * its `unchanged: true`, not burn an attempt or be told a code is required.
 * That check reads the lines outside the transaction, which is safe in the one
 * direction that matters: DELIVERED and CANCELLED are final, so "nothing left
 * to deliver" can never become untrue afterwards.
 *
 * @param {{orderId:string, sellerId:string, status:string, body?:object}} args
 */
export async function planSellerDelivery({ orderId, sellerId, status, body = {} }) {
  const plan = { via: null, noCodeReason: null, failedReason: null, enabled: true };

  // CONFIRMED never touches the delivery table, so it does not ask about it.
  if (status === 'CONFIRMED') return plan;

  // Table not applied yet → the whole feature stands aside (deliveryTableReady).
  // `enabled: false` tells recordDeliveryOutcome() to write nothing, and leaving
  // `failedReason` null keeps a shipped line un-cancellable, exactly as before.
  plan.enabled = await deliveryTableReady();
  if (!plan.enabled) return plan;

  if (status === 'CANCELLED') {
    plan.failedReason = FAILED_REASONS.includes(body?.failedReason) ? body.failedReason : null;
    return plan;
  }
  if (status !== 'DELIVERED') return plan;

  const deliveryCode = isDeliveryCode(body?.deliveryCode) ? body.deliveryCode : null;
  const noCodeReason = NO_CODE_REASONS.includes(body?.noCodeReason) ? body.noCodeReason : null;

  const required = await codeRequired();
  if (!deliveryCode && !noCodeReason && !required) return plan;   // delivered exactly as before

  const [lines, row] = await Promise.all([
    prisma.orderItem.findMany({ where: { orderId, sellerId }, select: { status: true } }),
    prisma.orderDelivery.findUnique({
      where: { orderId_sellerId: { orderId, sellerId } },
      select: { id: true, code: true },
    }),
  ]);
  // Not their order, already delivered, or already cancelled: the transaction
  // has the right answer for each (404, no-op, "already …") and gives it.
  if (!lines.some((l) => DELIVERABLE_FROM.has(l.status))) return plan;

  if (deliveryCode && row?.code) {
    const claim = await claimCodeAttempt(row.id);
    if (!claim) {
      const current = await prisma.orderDelivery.findUnique({
        where: { id: row.id },
        select: { codeLockedUntil: true },
      });
      return lockedRefusal(current?.codeLockedUntil);
    }
    if (!codeMatches(row.code, deliveryCode)) {
      const attemptsLeft = Math.max(DELIVERY_CODE_MAX_ATTEMPTS - claim.attempts, 0);
      return refuse(
        DELIVERY_REFUSALS.CODE_WRONG,
        attemptsLeft > 0
          ? `That delivery code is not correct. ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.`
          : `That delivery code is not correct. Try again in ${DELIVERY_CODE_LOCK_MINUTES} minutes, or deliver without the code and give a reason.`,
        // `lockedUntil` rides along on the try that locks, so the app can show
        // the time without a second request. Absent on every other wrong try.
        { attemptsLeft, ...(claim.lockedUntil ? { lockedUntil: claim.lockedUntil.toISOString() } : {}) },
      );
    }
    await releaseCodeAttempt(row.id);
    plan.via = 'CODE';
    return plan;
  }

  // No code to check against (or none was sent). A reason is the fallback the
  // design promises for a phone that is off or a relative at the door — and it
  // stays available while the code is locked, on purpose: the lock stops
  // guessing, it must not strand a van at a farm gate.
  if (noCodeReason) {
    plan.via = 'NO_CODE';
    plan.noCodeReason = noCodeReason;
    return plan;
  }

  if (required) {
    return refuse(
      DELIVERY_REFUSALS.CODE_REQUIRED,
      'Enter the delivery code the farmer shows you, or choose why you are delivering without it.',
    );
  }
  return plan;
}

/**
 * "Could not deliver": may this line leave SHIPPED for CANCELLED?
 * Only with a valid reason — the plan carries one only when the request did.
 */
export function mayCancelShipped(fromStatus, toStatus, plan) {
  return fromStatus === 'SHIPPED' && toStatus === 'CANCELLED' && Boolean(plan?.failedReason);
}

/** Create this shipment's row and code if it has none. Never replaces a code. */
async function ensureDeliveryCode(tx, { orderId, sellerId }) {
  const existing = await tx.orderDelivery.findUnique({
    where: { orderId_sellerId: { orderId, sellerId } },
    select: { id: true, code: true },
  });
  // Re-issuing would silently invalidate the code already on the farmer's
  // screen, so an existing one is left exactly as it is.
  if (existing?.code) return;

  const code = encrypt(generateDeliveryCode());
  if (existing) {
    await tx.orderDelivery.update({
      where: { id: existing.id },
      data: { code, codeAttempts: 0, codeLockedUntil: null },
    });
  } else {
    await tx.orderDelivery.create({ data: { orderId, sellerId, code } });
  }
}

/**
 * INSIDE the status transaction, after the lines have moved: write what the
 * move means for the delivery row, so it commits or rolls back with them.
 *
 *   SHIPPED    issue the code (once)
 *   DELIVERED  record HOW it was delivered — or nothing, for a legacy request
 *   CANCELLED  record WHY it could not be delivered, only when a line that had
 *              actually left the shop was cancelled. A PENDING or CONFIRMED
 *              cancel is an ordinary cancel and writes nothing here.
 *
 * @param {object} tx
 * @param {{orderId:string, sellerId:string, status:string, movable:Array<{status:string}>, plan:object}} args
 *        `movable` are the lines being moved, with the status they had BEFORE.
 * @returns {Promise<'CODE'|'NO_CODE'|null>} deliveredVia, for the response
 */
export async function recordDeliveryOutcome(tx, { orderId, sellerId, status, movable = [], plan }) {
  // The table is not there yet (planSellerDelivery found out, before this
  // transaction began). Touching it now would abort the transaction and take
  // the status change down with it.
  if (plan?.enabled === false) return null;

  const where = { orderId_sellerId: { orderId, sellerId } };

  if (status === 'SHIPPED') {
    await ensureDeliveryCode(tx, { orderId, sellerId });
    return null;
  }

  if (status === 'DELIVERED') {
    if (plan?.via === 'CODE') {
      await tx.orderDelivery.updateMany({ where: { orderId, sellerId }, data: { deliveredVia: 'CODE' } });
      return 'CODE';
    }
    if (plan?.via === 'NO_CODE') {
      const data = { deliveredVia: 'NO_CODE', noCodeReason: plan.noCodeReason };
      await tx.orderDelivery.upsert({ where, create: { orderId, sellerId, ...data }, update: data });
      return 'NO_CODE';
    }
    return null;
  }

  if (status === 'CANCELLED' && plan?.failedReason && movable.some((i) => i.status === 'SHIPPED')) {
    const data = { failedReason: plan.failedReason };
    await tx.orderDelivery.upsert({ where, create: { orderId, sellerId, ...data }, update: data });
  }
  return null;
}
