/**
 * Payments — the purpose-neutral client-facing bits.
 *
 * Today that is one endpoint: what this build can actually collect money with.
 * It lived at GET /agristore/payment-config, which was accurate when AgriStore
 * was the only thing that took a payment and became misleading the moment rent
 * bookings did too — a rent screen asking a SHOP url whether card payments work
 * reads like a bug even when it is not.
 *
 * The handler is exported so the old path keeps serving it (agristore.routes.js
 * mounts the same function). One implementation, two URLs: an app build already
 * in a farmer's hand keeps working, and nothing has to be kept in sync.
 *
 * Deliberately tiny. Anything that knows what the money BUYS belongs in that
 * product area's router, not here.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { sendSuccess } from '../utils/response.js';
import { isMockPayments } from '../services/payment.service.js';
import { ENV } from '../config/env.js';

const router = Router();

/**
 * Can this build actually take an online payment?
 *
 * The app used to render UPI and Card tiles unconditionally, then post the
 * chosen method to an endpoint that creates an order and never asks for money.
 * A farmer picked UPI, saw "Order Placed!" with a UPI badge, and nothing was
 * ever charged. Offering a payment method the server cannot collect with is the
 * worst kind of broken: it looks like it worked.
 *
 * The app asks first and only shows what can actually be collected.
 *
 * `keyId` is Razorpay's PUBLISHABLE key — it is designed to sit in a client and
 * identifies the merchant when opening checkout. The SECRET never leaves the
 * server, and every payment signature is verified server-side, so a tampered
 * client cannot manufacture a paid order or a paid booking.
 */
export async function paymentConfigHandler(_req, res) {
  const mock = isMockPayments();
  return sendSuccess(res, {
    // False whenever the gateway is unconfigured (no keys). In that state a
    // caller must fall back to its own offline path — cash on delivery for the
    // shop — rather than opening a checkout sheet that cannot complete.
    onlineEnabled: !mock,
    provider: 'razorpay',
    keyId: mock ? null : ENV.RAZORPAY_KEY_ID,
    methods: mock ? ['cod'] : ['cod', 'upi', 'card'],
  });
}

router.get('/config', authenticate, paymentConfigHandler);

export default router;
