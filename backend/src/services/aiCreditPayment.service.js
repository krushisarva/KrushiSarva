/**
 * AI credit-pack payments — the AI half of the payment lifecycle (PAY-004).
 *
 * ── Where the line is ────────────────────────────────────────────────────────
 * The purpose-agnostic core — intent state machine, signature verification,
 * webhook inbox, event-id derivation — lives in paymentIntent.service.js and
 * payment.service.js and serves every product area. Nothing in this file
 * verifies a signature, claims a webhook event, or talks to Razorpay except
 * through those two modules. A second copy of any of that is a defect.
 *
 * THIS module is what makes a payment an AI-credits payment: which pack was
 * bought, and the single grant of credits that the money buys.
 *
 * ── What "exactly once" means here, and how it is enforced ───────────────────
 * Credits are fungible and instantly spendable, so a double grant is not a
 * cosmetic duplicate — it is minted money. Three callers can arrive for the
 * same payment, in any order, and more than once each:
 *
 *   POST /ai/credits/purchase/confirm   the app, after the checkout sheet closes
 *   payment.captured webhook            Razorpay, retried for up to 24 hours
 *   a retry of either                   a dropped response on a village connection
 *
 * The grant therefore does NOT stand on its own. It rides a conditional
 * transition of the payment intent:
 *
 *   BEGIN
 *     UPDATE payment_intents
 *        SET status = 'ORDER_CREATED', providerPaymentId = $pay
 *      WHERE id = $intent
 *        AND status NOT IN ('ORDER_CREATED','REFUND_INITIATED','REFUNDED')
 *     -- 0 rows  → somebody already settled this payment: grant nothing
 *     -- 1 row   → we own it; the row is locked until COMMIT
 *     UPDATE ai_credits        SET balance = balance + $credits ...
 *     INSERT ai_credit_transactions ...
 *   COMMIT
 *
 * Under Postgres READ COMMITTED the second concurrent transaction blocks on
 * that row lock, and when the first commits it re-evaluates the WHERE against
 * the NEW row version, sees ORDER_CREATED, and matches zero rows. So the
 * winner grants and every loser reports `alreadyProcessed` — no advisory lock,
 * no Redis, no read-then-write window. `payment_intents.providerOrderId` is
 * UNIQUE, so there is exactly one such row per gateway order to race for, and
 * `providerPaymentId` is UNIQUE, so one capture cannot be claimed by two
 * intents.
 *
 * `ORDER_CREATED` is the shared enum's name for "this intent produced its
 * fulfilment". For AgriStore that is an Order; here it is a grant. No new enum
 * value was added because none is needed — TERMINAL and SETTLED already treat
 * it as the settled state, which is precisely the meaning required.
 *
 * ── Price authority ──────────────────────────────────────────────────────────
 * The client sends a PACK ID. The price comes from CREDIT_PACKS in
 * aiCredit.service.js and is frozen into the intent's `metadata` before the
 * gateway is called, so repricing a pack mid-flight cannot change what an
 * in-flight purchase costs or delivers. No request body field is ever read as
 * an amount.
 */
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import {
  createPaymentOrder, fetchPaymentOrder, verifyPaymentSignature,
} from './payment.service.js';
import {
  PAYMENT_PURPOSE, SETTLED,
  createIntent, findIntent, receiptFor,
} from './paymentIntent.service.js';
import {
  getCreditPack, publicCreditPack, ensureCreditAccount, addCreditsWith,
} from './aiCredit.service.js';

/** `refType` for every intent this module raises — see PaymentIntent.refType. */
export const CREDIT_PACK_REF_TYPE = 'creditPack';

/** The ledger `type` a purchased grant is recorded under. */
const PURCHASE_TXN_TYPE = 'purchase';

function badRequest(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, expose: true, code });
}

/**
 * What this intent actually bought, as frozen at initiate time.
 *
 * `metadata` is authoritative, not the live pack table: a pack repriced or
 * withdrawn between initiate and capture must not change what an already-paid
 * farmer receives. The table is only a fallback for a row written before this
 * feature froze metadata (there are none today) and for the belt-and-braces
 * case of a truncated metadata column.
 *
 * @returns {{ id: string, credits: number, pricePaise: number }|null}
 */
function frozenPack(intent) {
  const meta = intent?.metadata && typeof intent.metadata === 'object' ? intent.metadata : {};
  const credits = Number(meta.credits);
  if (Number.isSafeInteger(credits) && credits > 0) {
    return {
      id: String(meta.packId || intent.refId || 'unknown'),
      credits,
      pricePaise: Number.isSafeInteger(Number(meta.pricePaise)) ? Number(meta.pricePaise) : intent.amountPaise,
    };
  }
  const fromTable = getCreditPack(intent?.refId);
  if (fromTable) return { id: fromTable.id, credits: fromTable.credits, pricePaise: fromTable.pricePaise };
  return null;
}

async function currentBalance(userId) {
  const row = await prisma.aICredit.findUnique({ where: { userId }, select: { balance: true } });
  return row?.balance ?? 0;
}

// ── Initiate ──────────────────────────────────────────────────────────────────

/**
 * Raise a gateway order for one credit pack and record the intent behind it.
 *
 * @param {{ userId: string, packId: string }} p
 * @returns {Promise<{ pack, providerOrderId: string, amountInPaise: number, receipt: string, mock: boolean }>}
 * @throws  400 UNKNOWN_PACK for a pack id the server does not define.
 */
export async function initiateCreditPurchase({ userId, packId }) {
  const pack = getCreditPack(packId);
  if (!pack) throw badRequest('That credit pack is not available.', 'UNKNOWN_PACK');

  // Unique per attempt, so a later cross-check binds the gateway order to THIS
  // purchase rather than merely to this user.
  const receipt = receiptFor(userId);

  // Breaker + 10s timeout live inside createPaymentOrder; mock mode returns a
  // deterministic `mock_order_…` when no keys are configured.
  const order = await createPaymentOrder(pack.pricePaise, 'INR', receipt);

  try {
    const intent = await createIntent({
      userId,
      providerOrderId: order.id,
      purpose: PAYMENT_PURPOSE.AI_CREDITS,
      refType: CREDIT_PACK_REF_TYPE,
      refId: pack.id,
      // Paise only. The rupee Decimal is derived from it by the core, so the
      // two representations cannot disagree by a rounding step.
      amountPaise: pack.pricePaise,
      receipt,
      metadata: { packId: pack.id, credits: pack.credits, pricePaise: pack.pricePaise, label: pack.label },
    });
    logger.info(
      { intentId: intent.id, providerOrderId: order.id, packId: pack.id, amountPaise: pack.pricePaise },
      '[AICreditPayment] intent created',
    );
  } catch (err) {
    // AgriStore deliberately SWALLOWS this failure, because by that point it has
    // already taken a stock hold and refusing would be worse. Here the opposite
    // is true: the intent is the only record of WHICH PACK this payment buys.
    // Without it a capture arrives with no purpose, the dispatcher can only mark
    // it IGNORED, and a farmer has paid for credits nothing can ever grant. So
    // this one fails the request — nothing has been charged yet, and the orphan
    // gateway order simply expires.
    logger.error({ err, providerOrderId: order.id, packId: pack.id }, '[ALERT][AICreditPayment] could not record payment intent — purchase refused');
    throw Object.assign(
      new Error('Could not start the purchase. Please try again in a moment.'),
      { statusCode: 503, expose: true, code: 'INTENT_NOT_RECORDED' },
    );
  }

  return {
    pack: publicCreditPack(pack),
    providerOrderId: order.id,
    amountInPaise: pack.pricePaise,
    receipt,
    mock: order.mock || false,
  };
}

// ── The grant ─────────────────────────────────────────────────────────────────

/**
 * Settle one AI_CREDITS intent: grant its pack, exactly once, ever.
 *
 * Safe to call from the client confirm AND from the webhook, in either order,
 * any number of times. See the module header for why.
 *
 * Never throws for an ordinary "somebody got there first" — that is a normal
 * outcome reported as `alreadyProcessed`.
 *
 * @returns {Promise<{ credited: number, balance: number, alreadyProcessed: boolean, status: string }>}
 */
async function settleCreditIntent({ intent, providerPaymentId = null, source }) {
  const pack = frozenPack(intent);
  if (!pack) {
    // Money recorded, nothing to deliver. Loud: this is code missing, not a
    // payment that failed, and only a human can decide what was bought.
    logger.error(
      { intentId: intent.id, providerOrderId: intent.providerOrderId, refId: intent.refId, source },
      '[ALERT][AICreditPayment] paid intent carries no resolvable credit pack — nothing granted',
    );
    return { credited: 0, balance: await currentBalance(intent.userId), alreadyProcessed: false, status: intent.status };
  }

  // Outside the transaction on purpose: a first-time buyer's account creation
  // (and any due monthly refill) must not hold a lock for the length of a
  // payment settlement.
  await ensureCreditAccount(intent.userId);

  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const { count } = await tx.paymentIntent.updateMany({
        where: {
          id: intent.id,
          // The gate. Anything already settled — granted, refunding, refunded —
          // is not granted again.
          status: { notIn: SETTLED },
          // Never rebind a capture. If this intent is already bound to a
          // DIFFERENT payment id, that is duplicate gateway data and reassigning
          // it would detach a real payment from its real grant.
          ...(providerPaymentId ? { OR: [{ providerPaymentId: null }, { providerPaymentId }] } : {}),
        },
        data: {
          status: 'ORDER_CREATED',
          ...(providerPaymentId ? { providerPaymentId } : {}),
        },
      });
      if (!count) return { granted: false };

      const { balance, transaction } = await addCreditsWith(
        tx,
        intent.userId,
        pack.credits,
        PURCHASE_TXN_TYPE,
        `Credit pack ${pack.id}: +${pack.credits} credits`,
        {
          source,
          intentId: intent.id,
          packId: pack.id,
          providerOrderId: intent.providerOrderId,
          providerPaymentId: providerPaymentId || intent.providerPaymentId || null,
        },
      );
      return { granted: true, balance, transactionId: transaction.id };
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      // providerPaymentId is already recorded against another intent.
      logger.error(
        { intentId: intent.id, providerPaymentId, source },
        '[ALERT][AICreditPayment] payment id already bound to another intent — nothing granted',
      );
      const fresh = await prisma.paymentIntent.findUnique({ where: { id: intent.id }, select: { status: true } });
      return {
        credited: 0,
        balance: await currentBalance(intent.userId),
        alreadyProcessed: SETTLED.includes(fresh?.status),
        status: fresh?.status ?? intent.status,
      };
    }
    throw err;
  }

  if (outcome.granted) {
    logger.info(
      { intentId: intent.id, packId: pack.id, credits: pack.credits, balance: outcome.balance, source, txnId: outcome.transactionId },
      '[AICreditPayment] credits granted',
    );
    return { credited: pack.credits, balance: outcome.balance, alreadyProcessed: false, status: 'ORDER_CREATED' };
  }

  // Lost the race, or the intent was already settled some other way. Report the
  // state rather than an error: to the caller "this is done" and "you did it"
  // must look the same, or a retrying client keeps retrying forever.
  const fresh = await prisma.paymentIntent.findUnique({ where: { id: intent.id }, select: { status: true } });
  const status = fresh?.status ?? intent.status;
  const settled = SETTLED.includes(status);
  if (!settled) {
    logger.warn({ intentId: intent.id, status, source }, '[AICreditPayment] settle matched no row and the intent is not settled');
  }
  return { credited: 0, balance: await currentBalance(intent.userId), alreadyProcessed: settled, status };
}

// ── Confirm ───────────────────────────────────────────────────────────────────

/**
 * Cross-check the gateway's own record of the order against the intent.
 *
 * Defence in depth, not the primary control: the HMAC already proves Razorpay
 * signed this exact (order, payment) pair, and the order's amount was fixed
 * server-side from the pack table before the order existed — there is no
 * client-supplied number anywhere in the chain for this to catch drifting. It
 * catches corrupted or swapped gateway data.
 *
 * Deliberately NOT fatal when the gateway is unreachable. An open breaker or a
 * timeout would otherwise fail a confirm for a payment that genuinely
 * succeeded, and the webhook would have to do the grant instead — a worse
 * experience for no security gain, since this check proves nothing the
 * signature has not already proved.
 */
async function crossCheckGatewayOrder(intent) {
  let order;
  try {
    order = await fetchPaymentOrder(intent.providerOrderId);
  } catch (err) {
    logger.warn({ intentId: intent.id, err: err?.message }, '[AICreditPayment] gateway order unreachable — relying on the signature');
    return;
  }
  if (!order || order.mock) return; // mock mode carries no amount to bind against

  if (order.receipt && order.receipt !== intent.receipt) {
    logger.error({ intentId: intent.id }, '[ALERT][AICreditPayment] gateway order receipt does not match the intent');
    throw badRequest('This payment does not match your purchase.', 'RECEIPT_MISMATCH');
  }
  if (Number(order.amount) !== intent.amountPaise) {
    logger.error(
      { intentId: intent.id, expectedPaise: intent.amountPaise, actualPaise: Number(order.amount) },
      '[ALERT][AICreditPayment] gateway order amount does not match the intent',
    );
    throw badRequest('The amount paid does not match this credit pack.', 'AMOUNT_MISMATCH');
  }
}

/**
 * The client reporting a completed checkout.
 *
 * @throws 400 on a bad signature (no credits granted), 404 when the intent is
 *         not this user's AI-credits purchase.
 */
export async function confirmCreditPurchase({ userId, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  // ONE signature verifier for the whole application. Malformed input is simply
  // an invalid signature — verifyPaymentSignature returns false rather than
  // throwing, so this is a clean 400 and never a 500.
  if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
    logger.warn({ providerOrderId: razorpayOrderId }, '[AICreditPayment] confirm rejected: signature mismatch');
    throw badRequest('Payment verification failed — signature mismatch', 'SIGNATURE_MISMATCH');
  }

  const intent = await findIntent(razorpayOrderId);
  // Object-level authorization. A valid signature proves Razorpay signed the
  // pair, NOT that the pair belongs to this farmer — and an intent that is some
  // other purpose (or somebody else's) must be indistinguishable from one that
  // does not exist.
  if (!intent || intent.userId !== userId || intent.purpose !== PAYMENT_PURPOSE.AI_CREDITS) return null;

  await crossCheckGatewayOrder(intent);

  return settleCreditIntent({ intent, providerPaymentId: razorpayPaymentId, source: 'confirm' });
}

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * "Did my credit purchase go through?" — asked after any interrupted payment,
 * so the farmer never has to guess and pay twice.
 *
 * @returns {Promise<null|{status, paid, amount, credited, balance, pack}>}
 *          null when there is no such purchase FOR THIS USER (rendered as 404).
 */
export async function getCreditPurchaseStatus({ userId, providerOrderId }) {
  const intent = await findIntent(providerOrderId);
  if (!intent || intent.userId !== userId || intent.purpose !== PAYMENT_PURPOSE.AI_CREDITS) return null;

  const pack = frozenPack(intent);
  const granted = intent.status === 'ORDER_CREATED';

  return {
    status: intent.status,
    // "The money has arrived" — true both while the grant is pending and after
    // it landed. Distinct from `credited`, which is the delivery.
    paid: granted || intent.status === 'PAID',
    amount: String(intent.amount),
    credited: granted ? pack?.credits ?? 0 : 0,
    balance: await currentBalance(userId),
    pack: pack ? { id: pack.id, credits: pack.credits } : null,
  };
}

// ── Webhook handler ───────────────────────────────────────────────────────────

/**
 * What AI_CREDITS does once the shared dispatcher has recorded the money.
 *
 * Registered in routes/paymentWebhooks.routes.js:
 *     [PAYMENT_PURPOSE.AI_CREDITS]: aiCreditsWebhookHandler,
 *
 * Same shape as shopWebhookHandler. The dispatcher has already verified the
 * signature over the raw bytes, claimed the event id through a UNIQUE index,
 * and called markIntentPaid — so by the time `captured` runs the intent is PAID
 * and this only has to deliver what was bought.
 */
export const aiCreditsWebhookHandler = {
  /**
   * The channel that does not depend on the farmer's phone still being alive.
   * This is usually the SECOND caller (the app's confirm normally wins), in
   * which case it grants nothing and says so.
   */
  async captured({ intent, providerPaymentId }) {
    if (!intent) return;
    const result = await settleCreditIntent({ intent, providerPaymentId, source: 'webhook' });
    if (result.alreadyProcessed) {
      logger.info({ intentId: intent.id }, '[AICreditPayment] webhook capture: already settled, nothing granted');
    }
  },

  /**
   * Nothing to unwind. A credit pack holds no stock and reserves nothing, so a
   * failed payment costs the farmer nothing and leaves no debris — the
   * dispatcher has already marked the intent FAILED, which is the whole of it.
   *
   * The handler still exists rather than being omitted: an absent handler is
   * reported as an unhandled purpose with an ALERT, and "this purpose has
   * nothing to do on failure" must not look like "this purpose is unimplemented".
   *
   * Note a failed attempt does NOT close the gateway order: Razorpay allows a
   * second attempt against the same order, and a later valid confirm on it still
   * grants, because FAILED is not a settled state.
   */
  async failed({ intent, providerOrderId }) {
    logger.info({ intentId: intent?.id, providerOrderId }, '[AICreditPayment] payment failed — no credits granted');
  },

  /**
   * A refunded credit purchase. NOT automatically clawed back.
   *
   * Credits are spendable the instant they land, so the balance may already be
   * gone, and the model has no negative balance (every path clamps at zero).
   * Deducting here would therefore either silently under-recover or drive a
   * farmer's account to zero mid-session. Reversal is a policy decision with a
   * ledger entry behind it — adminAdjustCredits, by a human who can see what was
   * spent. This makes that decision visible instead of guessing.
   */
  async refunded({ intent, providerPaymentId, status }) {
    logger.error(
      { intentId: intent?.id, providerPaymentId, status },
      '[ALERT][AICreditPayment] credit purchase refunded — granted credits are NOT clawed back automatically; review and adjust manually',
    );
  },
};
