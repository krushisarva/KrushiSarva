/**
 * utils/response.js errorStatus — the status the global error handler sends.
 *
 * The handler read only `err.status`. This codebase's errors set `statusCode`
 * (withSerializableRetry's "lost a race" 409, thrown 400/404s), so any of them
 * that escaped a route without its own catch reached the client as a 500 — and
 * a lost race counted against the 5xx rate as an outage.
 */
import { errorStatus } from '../../../src/utils/response.js';

test.each([
  [{ status: 413 }, 413],                      // body-parser / http-errors
  [{ statusCode: 409 }, 409],                  // withSerializableRetry
  [{ statusCode: 404, expose: true }, 404],
  [{ status: 400, statusCode: 400 }, 400],
  [{ status: 503, statusCode: 409 }, 503],     // `status` wins when both are set
])('%p → %i', (err, expected) => {
  expect(errorStatus(err)).toBe(expected);
});

test.each([
  [new Error('boom')],
  [{}],
  [null],
  [undefined],
  [{ statusCode: 200 }],                       // never answer an error with a success
  [{ statusCode: 302 }],
  [{ statusCode: 999 }],
  [{ statusCode: '409' }],
  [{ status: 'oops' }],
])('%p → 500', (err) => {
  expect(errorStatus(err)).toBe(500);
});

test('an invalid status falls through to a valid statusCode', () => {
  expect(errorStatus({ status: 0, statusCode: 409 })).toBe(409);
});
