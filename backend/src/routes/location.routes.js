/**
 * Location Routes
 *
 * GET /api/v1/location/pincode/:pincode — India Post locality lookup that every
 *   location form in the apps uses to autofill state / district / taluka /
 *   village. See services/pincode.service.js for the upstream's quirks.
 *
 * Responses:
 *   200 { pincode, found: true,  postOffices: [...] }
 *   200 { pincode, found: false, postOffices: [] }   unknown pincode — a result,
 *       not an error, so a typo never shows up as a failed request
 *   400 not a 6-digit pincode starting 1–9
 *   503 { code: 'PINCODE_LOOKUP_UNAVAILABLE' }        India Post unreachable; the
 *       app lets the user carry on typing the address by hand
 */
import { Router } from 'express';
import { param } from 'express-validator';

import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { rateLimiter, clientIp } from '../middleware/rateLimit.js';
import { sendSuccess, sendError, sendServerError } from '../utils/response.js';
import {
  lookupPincode, PincodeLookupUnavailableError, PINCODE_RE,
} from '../services/pincode.service.js';

const router = Router();

// A person fixing typos in one form makes a handful of lookups; 60 per 10 min
// covers several forms back to back and still stops anyone walking the whole
// PIN space through us.
const pincodeLookupLimit = rateLimiter({
  windowMs: 10 * 60 * 1000,
  max:      60,
  prefix:   'location:pincode',
  key:      (req) => req.user?.id || clientIp(req),
  message:  'Too many PIN code lookups. Please wait a few minutes and try again.',
});

export const pincodeParamRules = [
  param('pincode').matches(PINCODE_RE).withMessage('Enter a valid 6-digit PIN code'),
];

router.get(
  '/pincode/:pincode',
  authenticate,
  pincodeLookupLimit,
  pincodeParamRules,
  validate,
  async (req, res) => {
    try {
      const result = await lookupPincode(req.params.pincode);
      // PIN data changes on the order of years; let the client keep it a day.
      res.set('Cache-Control', 'private, max-age=86400');
      return sendSuccess(res, result);
    } catch (err) {
      if (err instanceof PincodeLookupUnavailableError) {
        res.set('Retry-After', '30');
        return sendError(res, err.message, 503, { code: err.code });
      }
      return sendServerError(res, err, 'Could not look up this PIN code');
    }
  },
);

export default router;
