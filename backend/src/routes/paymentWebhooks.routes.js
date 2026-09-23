/**
 * Payment webhooks — the gateway's side of the conversation, for every purpose.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The only thing that used to tell this system a payment had succeeded was the
 * mobile app, calling /orders/confirm. On a village connection the app very
 * often cannot: the connection drops between the payment sheet closing and the
 * confirm request, the OS kills the process, or the farmer switches away. The
 * money is captured, and nobody here hears about it.
 *
 * A webhook is the channel that does not depend on the buyer's phone still being
 * alive. Razorpay retries it for 24 hours.
 *
 * ── The three rules a webhook endpoint has to obey ───────────────────────────
 * 1. VERIFY THE SIGNATURE, over the RAW BYTES. Re-serialising parsed JSON does
 *    not reproduce what was signed, so this router is mounted with express.raw
 *    ahead of the global JSON parser (see app.js).
 * 2. FAIL CLOSED. No webhook secret configured → reject everything. This endpoint
 *    can mark money as received with no authenticated user behind it.
 * 3. BE IDEMPOTENT. Redelivery is normal, not exceptional. Every event id is
 *    claimed through a UNIQUE index before any work happens, so the second
 *    delivery of `payment.captured` is a no-op instead of a second order.
 *
 * ── Why it is a dispatcher (PAY-001) ─────────────────────────────────────────
 * Recording that money arrived is the same job whatever the money was for; what
 * happens NEXT is not. An AgriStore capture looks for the order the client may
 * already have created and releases stock holds when a payment fails. A rent
 * booking has no cart and no stock. So the shared half runs first — claim the
 * event, mark the intent — and then `intent.purpose` selects the handler that
 * knows what this payment was supposed to buy.
 *
 * A purpose with no registered handler is IGNORED with 200, never a 5xx. Two
 * reasons: Razorpay would retry a 5xx for 24 hours, and the money is already
 * recorded against the intent, so the right recovery is a human looking at the
 * admin orphan queue — not the gateway hammering an endpoint that will keep
 * giving the same answer.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────
 * It does not create orders. By the time a webhook arrives the buyer's cart may
 * have changed, stock may have sold to someone else, and there is no delivery
 * address in the payload. Fabricating an order from a payment would produce a
 * shipment nobody chose. It records the payment against its intent; the client's
 * confirm creates the order, and reconciliation refunds anything left paid with
 * no order (refundUnorderedPayment).
 */
import { Router } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { verifyWebhookSignature } from '../services/payment.service.js';
import {
  claimWebhookEvent, finishWebhookEvent, webhookEventId,
  markIntentPaid, markIntentFailed, findIntent,
  PAYMENT_PURPOSE,
} from '../services/paymentIntent.service.js';
import { shopWebhookHandler } from '../services/shopPayment.service.js';
import { rentWebhookHandler } from '../services/rentPayment.service.js';
import { aiCreditsWebhookHandler } from '../services/aiCreditPayment.service.js';
import prisma from '../config/db.js';
import { rateLimiter, clientIp } from '../middleware/rateLimit.js';
import { recordEvent, SHOP_EVENTS } from '../services/shopMetrics.service.js';

const router = Router();

/**
 * What each purpose does once the shared half has recorded the money.
 *
 * Every handler is optional: a purpose may care about captures and not about
 * refunds. A purpose absent from this map is not an error — it is a payment
 * this build does not yet know how to complete, which is a different thing from
 * a payment that failed, and is reported as such (IGNORED, plus an alert).
 */
const PURPOSE_HANDLERS = {
  [PAYMENT_PURPOSE.SHOP_ORDER]: shopWebhookHandler,
  // Rent holds no stock, so its `failed` hook releases nothing — it exists
  // precisely so an ordinary failed booking payment is not reported as an
  // unhandled purpose at ERROR with an alert.
  [PAYMENT_PURPOSE.RENT_BOOKING]: rentWebhookHandler,
  // Credits are granted by whichever of the webhook and /purchase/confirm
  // arrives first; both route through the same keyed grant, so the second one
  // to land is a no-op rather than a second top-up.
  [PAYMENT_PURPOSE.AI_CREDITS]: aiCreditsWebhookHandler,
  // ANIMAL_TOKEN  → PAY-005 is an open product decision; deliberately absent.
};

/**
 * This router is mounted ahead of the global per-IP limiter (it has to be, to get
 * the raw body), so it carries its own. Generous — a burst of legitimate
 * redeliveries after an outage is normal — but not unbounded, because signature
 * verification is an HMAC per request and this endpoint is unauthenticated.
 *
 * The key (`rl:webhook:razorpay:<ip>`) has no path component, so mounting this
 * router at more than one path shares ONE budget between them. That is the
 * intended reading: one gateway, one allowance.
 */
router.use(rateLimiter({
  windowMs: 60_000,
  max: 300,
  prefix: 'webhook:razorpay',
  key: clientIp,
  message: 'Too many webhook deliveries.',
}));

/**
 * Report a payment whose purpose nothing can complete.
 *
 * Loud on purpose. The money is real and recorded; what is missing is code.
 * Silence here would mean a farmer's payment sitting in the database with
 * nobody told, which is precisely the failure the whole intent machinery
 * exists to make impossible.
 */
async function ignoreUnhandledPurpose(eventId, { intent, eventType }) {
  logger.error({
    eventId, eventType, intentId: intent?.id, purpose: intent?.purpose,
    providerOrderId: intent?.providerOrderId,
  }, '[ALERT][Webhook] no handler for this payment purpose — money recorded, nothing settled it');
  await finishWebhookEvent(eventId, { status: 'IGNORED', error: `no handler for purpose ${intent?.purpose}` });
}

/**
 * Razorpay expects a 2xx quickly, and retries anything else. Handled events and
 * ignored events both return 200: an event type we do not act on is not an
 * error, and telling the gateway to retry it forever would be.
 */
router.post('/razorpay', async (req, res) => {
  const signature = req.get('X-Razorpay-Signature');
  const raw = req.body; // Buffer — express.raw, mounted before the JSON parser

  if (!verifyWebhookSignature(raw, signature)) {
    // Deliberately terse. An attacker probing this endpoint learns nothing about
    // whether a secret is configured or how the comparison failed.
    logger.warn({ ip: req.ip }, '[Webhook] rejected: bad or missing signature');
    recordEvent(SHOP_EVENTS.WEBHOOK_BAD_SIGNATURE);
    return res.status(400).json({ success: false });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    return res.status(400).json({ success: false });
  }

  const eventType = payload?.event || 'unknown';
  const paymentEntity = payload?.payload?.payment?.entity;
  const providerPaymentId = paymentEntity?.id || null;
  const providerOrderId = paymentEntity?.order_id || payload?.payload?.order?.entity?.id || null;
  const eventId = webhookEventId(payload);
  const payloadDigest = crypto.createHash('sha256').update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))).digest('hex');

  // Claim first, work second. A redelivery loses the claim and returns 200
  // immediately, having changed nothing.
  let claimed;
  try {
    claimed = await claimWebhookEvent({ eventId, eventType, providerOrderId, providerPaymentId, payloadDigest });
  } catch (err) {
    logger.error({ err, eventId }, '[Webhook] could not claim event');
    // 500 so Razorpay retries — losing the event entirely is worse than a retry.
    return res.status(500).json({ success: false });
  }
  if (!claimed) {
    res.setHeader('X-Webhook-Replay', 'true');
    recordEvent(SHOP_EVENTS.WEBHOOK_DUPLICATE);
    return res.status(200).json({ success: true, duplicate: true });
  }

  try {
    switch (eventType) {
      case 'payment.captured':
      case 'order.paid': {
        if (!providerOrderId) { await finishWebhookEvent(eventId, { status: 'IGNORED' }); break; }

        const intent = await findIntent(providerOrderId);
        if (!intent) {
          // A capture with no local intent means /initiate never recorded one —
          // a real hole worth an alert, not a silent 200.
          logger.error({ providerOrderId, providerPaymentId }, '[Webhook] captured payment has no local intent');
          await finishWebhookEvent(eventId, { status: 'FAILED', error: 'no matching payment intent' });
          break;
        }

        // Purpose-agnostic and unconditional: the money HAS arrived, and that
        // fact is recorded before anything decides what to do about it. An
        // unhandled purpose must still leave a PAID intent behind, or the only
        // record of a real payment would be a webhook row.
        await markIntentPaid({
          providerOrderId,
          providerPaymentId,
          amountPaise: paymentEntity?.amount ?? undefined,
        });

        const handler = PURPOSE_HANDLERS[intent.purpose];
        if (!handler?.captured) {
          await ignoreUnhandledPurpose(eventId, { intent, eventType });
          break;
        }

        await handler.captured({ intent, providerOrderId, providerPaymentId, paymentEntity });
        await finishWebhookEvent(eventId, { status: 'PROCESSED' });
        break;
      }

      case 'payment.failed': {
        if (providerOrderId) {
          const intent = await findIntent(providerOrderId);
          await markIntentFailed({
            providerOrderId,
            reason: paymentEntity?.error_description || paymentEntity?.error_reason || 'payment failed',
          });

          // No intent row is NOT the same as an unknown purpose. /orders/initiate
          // deliberately swallows a failed createIntent so a telemetry write can
          // never fail a checkout — but it has already taken the stock hold by
          // then. So a missing intent still gets the shop cleanup, because a
          // shop hold may well exist for this gateway order and nothing else
          // will ever release it.
          const handler = intent ? PURPOSE_HANDLERS[intent.purpose] : shopWebhookHandler;
          if (!handler?.failed) {
            await ignoreUnhandledPurpose(eventId, { intent, eventType });
            break;
          }
          await handler.failed({ intent, providerOrderId, providerPaymentId, paymentEntity });
        }
        await finishWebhookEvent(eventId, { status: 'PROCESSED' });
        recordEvent(SHOP_EVENTS.WEBHOOK_OK);
        break;
      }

      case 'refund.created':
      case 'refund.processed': {
        const refund = payload?.payload?.refund?.entity;
        const refPaymentId = refund?.payment_id;
        if (refPaymentId) {
          const status = eventType === 'refund.processed' ? 'REFUNDED' : 'REFUND_INITIATED';

          // Keyed on the payment id rather than the order id: a refund event
          // carries no order. updateMany, not update, because an unmatched
          // payment id is a no-op rather than a throw.
          await prisma.paymentIntent.updateMany({
            where: { providerPaymentId: refPaymentId },
            data: { status },
          }).catch(() => {});

          const intent = await prisma.paymentIntent.findUnique({
            where: { providerPaymentId: refPaymentId },
            select: { id: true, purpose: true, providerOrderId: true },
          }).catch(() => null);

          // Same reasoning as payment.failed: a refund for a payment we have no
          // intent for is still, historically, a shop refund, and the order row
          // has to stop reading "paid" either way.
          const handler = intent ? PURPOSE_HANDLERS[intent.purpose] : shopWebhookHandler;
          if (!handler?.refunded) {
            await ignoreUnhandledPurpose(eventId, { intent, eventType });
            break;
          }
          await handler.refunded({ intent, providerPaymentId: refPaymentId, status, eventType });
        }
        await finishWebhookEvent(eventId, { status: 'PROCESSED' });
        break;
      }

      default:
        await finishWebhookEvent(eventId, { status: 'IGNORED' });
        break;
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error({ err, eventId, eventType }, '[Webhook] handler failed');
    recordEvent(SHOP_EVENTS.WEBHOOK_FAIL);
    await finishWebhookEvent(eventId, { status: 'FAILED', error: err.message });
    // 500 → Razorpay retries. The event row is already claimed, so the retry
    // short-circuits as a duplicate; recovery is the reconciler's job, which
    // reads the gateway directly rather than waiting for another delivery.
    return res.status(500).json({ success: false });
  }
});

export default router;
