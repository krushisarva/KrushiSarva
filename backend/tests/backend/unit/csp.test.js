/**
 * utils/csp.js — the Firebase phone-auth CSP additions for the admin page.
 *
 * Off (FIREBASE_AUTH_ENABLED=false) app.js passes helmet's directives through
 * untouched; on, the /admin page's script-src / frame-src / connect-src gain
 * Google's reCAPTCHA and identitytoolkit sources (every other response keeps the
 * global policy) and every other directive is identical.
 */
import helmet from 'helmet';
import { withFirebasePhoneAuthCsp } from '../../../src/utils/csp.js';

const base = () => ({
  ...helmet.contentSecurityPolicy.getDefaultDirectives(),
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
});

describe('withFirebasePhoneAuthCsp', () => {
  test('adds reCAPTCHA + identitytoolkit sources and keeps \'self\'', () => {
    const out = withFirebasePhoneAuthCsp(base());

    expect(out['script-src']).toEqual([
      "'self'", 'https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/',
    ]);
    // frame-src / connect-src were unset (fell back to default-src 'self') —
    // they start from that fallback, so nothing else is newly allowed.
    expect(out['frame-src']).toEqual([
      "'self'", 'https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/',
    ]);
    expect(out['connect-src']).toEqual([
      "'self'", 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com',
    ]);
  });

  test('every other directive is passed through unchanged', () => {
    const input = base();
    const out = withFirebasePhoneAuthCsp(input);

    for (const name of Object.keys(input)) {
      if (name === 'script-src') continue;
      expect(out[name]).toEqual(input[name]);
    }
    expect(Object.keys(out).sort()).toEqual(
      [...Object.keys(input), 'frame-src', 'connect-src'].sort(),
    );
  });

  test('does not mutate its input (the flag-off path uses it as-is)', () => {
    const input = base();
    const snapshot = JSON.parse(JSON.stringify(input));

    withFirebasePhoneAuthCsp(input);

    expect(input).toEqual(snapshot);
    expect(input['frame-src']).toBeUndefined();
    expect(input['connect-src']).toBeUndefined();
  });

  test('extends an existing connect-src rather than replacing it', () => {
    const out = withFirebasePhoneAuthCsp({ ...base(), 'connect-src': ["'self'", 'https://api.example.test'] });

    expect(out['connect-src']).toEqual([
      "'self'", 'https://api.example.test',
      'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com',
    ]);
  });
});
