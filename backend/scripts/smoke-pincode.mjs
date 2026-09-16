/**
 * Live smoke check of the India Post lookup: real network, no Redis.
 *
 *   node scripts/smoke-pincode.mjs [pincode ...]
 *
 * Prints found/not-found, office count, distinct districts/states and timing
 * for each pincode, then repeats the first one to show the in-process cache.
 */
import 'dotenv/config';
import { lookupPincode } from '../src/services/pincode.service.js';

const pins = process.argv.slice(2);
if (!pins.length) pins.push('413102', '110001', '396230', '999999', '194101');

for (const pin of [...pins, pins[0]]) {
  const started = Date.now();
  try {
    const r = await lookupPincode(pin);
    const uniq = (k) => [...new Set(r.postOffices.map((o) => o[k]))].join(' | ');
    console.log(`${pin}  ${r.found ? 'FOUND' : 'NOT FOUND'}  ${r.postOffices.length} offices  ${Date.now() - started} ms`);
    if (r.found) console.log(`        districts: ${uniq('district')}\n        states:    ${uniq('state')}`);
  } catch (err) {
    console.log(`${pin}  ERROR ${err.code || err.message}  ${Date.now() - started} ms`);
  }
}
process.exit(0);
