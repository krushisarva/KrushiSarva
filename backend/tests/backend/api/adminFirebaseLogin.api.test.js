/**
 * Admin panel login through Firebase phone auth.
 *
 * The admin SPA posts the Firebase ID token to the SAME /auth/firebase-login the
 * apps use, plus `audience: 'admin'`. That field may only NARROW the route: a
 * session is issued only when the proven phone's EXISTING account is ADMIN, and
 * otherwise nothing at all is created — no farmer account, no signup consent, no
 * refresh token, no cookies. Role, scopes and tokenVersion still come from the
 * DB, never from the request body.
 *
 * The admin session must then behave exactly like one from the OTP path: cookie
 * transport + CSRF, refresh rotation, /admin/* reachable, scopes from the DB.
 * Like the OTP path's fresh code, the admin audience also needs a RECENT SMS:
 * it goes through verifyFirebaseReauth (auth_time gate), the apps do not.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import { getApp, createTestUser, cleanupTestData, prisma } from '../../fixtures/setup.js';
import { randomPhone } from '../../fixtures/factories.js';
import { resetRateLimitStore } from '../../../src/middleware/rateLimit.js';
import { recordOtpFailure, resetOtpLockoutStore } from '../../../src/services/otpLockout.service.js';
import { ENV } from '../../../src/config/env.js';

// Same pattern as authSessionEnd.api.test.js: the verifier hands back the phone
// the token "proved", without reaching Google. getApp() imports src/app.js
// dynamically, so this registers before the route is loaded.
const mockVerifyIdToken = jest.fn();
const mockVerifyReauth  = jest.fn();
jest.unstable_mockModule('../../../src/services/firebaseAuth.service.js', () => ({
  verifyFirebaseIdToken: mockVerifyIdToken,
  verifyFirebaseReauth:  mockVerifyReauth,
  isFirebaseAuthEnabled: () => true,
}));

const AUTH = '/api/v1/auth';
const FAKE_ID_TOKEN = 'f'.repeat(64);

let app;
const firebaseFlagBefore = ENV.FIREBASE_AUTH_ENABLED;

beforeAll(async () => {
  // The CSP additions are decided when app.js is evaluated, so the flag has to be
  // on before the (dynamic) import for the header assertion below.
  ENV.FIREBASE_AUTH_ENABLED = true;
  app = await getApp();
});
beforeEach(() => {
  resetRateLimitStore(); resetOtpLockoutStore(); mockVerifyIdToken.mockReset(); mockVerifyReauth.mockReset();
  // The real verifyFirebaseReauth is verifyFirebaseIdToken plus the auth_time
  // gate (unit-tested in firebaseAuth.test.js), so by default a "fresh" token
  // proves whatever mockVerifyIdToken says. Tests that need a stale one override it.
  mockVerifyReauth.mockImplementation((token) => mockVerifyIdToken(token));
});
afterAll(async () => {
  ENV.FIREBASE_AUTH_ENABLED = firebaseFlagBefore;
  await cleanupTestData();
});

function jwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function setCookies(res) {
  return (res.headers['set-cookie'] || []).join(' ; ');
}

function adminFirebaseLogin(agentOrApp, body = {}) {
  return agentOrApp.post(`${AUTH}/firebase-login`)
    .set('X-Auth-Transport', 'cookie') // what the admin SPA's axios instance sends
    .send({ idToken: FAKE_ID_TOKEN, audience: 'admin', ...body });
}

describe('admin Firebase login — an ADMIN gets a full admin session', () => {
  test('201 with cookie transport, ADMIN JWT, audited as a firebase login', async () => {
    const { user } = await createTestUser({ role: 'ADMIN' });
    mockVerifyIdToken.mockResolvedValue({ phone: user.phone, firebaseUid: 'fb-admin-1' });

    const res = await adminFirebaseLogin(request(app));

    expect(res.status).toBe(201);
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.user.role).toBe('ADMIN');
    expect(res.body.data.isNewUser).toBe(false);
    // Web transport: refresh token only in the httpOnly cookie, CSRF token in body.
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(res.body.data.csrfToken).toBeDefined();
    const cookies = setCookies(res);
    expect(cookies).toMatch(/(^|\W)rt=/);
    expect(cookies.toLowerCase()).toContain('httponly');

    const claims = jwtPayload(res.body.data.accessToken);
    expect(claims.sub).toBe(user.id);
    expect(claims.role).toBe('ADMIN');

    const login = await prisma.auditLog.findFirst({ where: { userId: user.id, action: 'AUTH_LOGIN' } });
    expect(login).not.toBeNull();
    expect(JSON.parse(login.metadata)).toMatchObject({ outcome: 'success', loginMethod: 'firebase', providerUid: 'fb-admin-1' });
  });

  test('the session reaches /admin/me, and refresh rotates it with the CSRF header', async () => {
    const { user } = await createTestUser({ role: 'ADMIN' });
    mockVerifyIdToken.mockResolvedValue({ phone: user.phone, firebaseUid: 'fb-admin-2' });
    const agent = request.agent(app);

    const login = await adminFirebaseLogin(agent);
    expect(login.status).toBe(201);
    const { accessToken, csrfToken } = login.body.data;

    const me = await agent.get('/api/v1/admin/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(user.id);
    expect(me.body.data.isSuperAdmin).toBe(true); // no scopes = legacy super admin

    // The refresh cookie without the CSRF header is refused, as on the OTP path.
    const noCsrf = await agent.post(`${AUTH}/refresh`).set('X-Auth-Transport', 'cookie').send({});
    expect(noCsrf.status).toBe(403);

    const refresh = await agent.post(`${AUTH}/refresh`)
      .set('X-Auth-Transport', 'cookie')
      .set('X-CSRF-Token', csrfToken)
      .send({});
    expect(refresh.status).toBe(200);
    expect(refresh.body.data.refreshToken).toBeUndefined();
    expect(refresh.body.data.csrfToken).toBeDefined();
    expect(setCookies(refresh)).toMatch(/(^|\W)rt=/);
    expect(jwtPayload(refresh.body.data.accessToken).role).toBe('ADMIN');
  });

  test('admin scopes come from the DB: a scoped admin is not a super admin', async () => {
    const { user } = await createTestUser({ role: 'ADMIN', adminScopes: ['KYC_REVIEWER'] });
    mockVerifyIdToken.mockResolvedValue({ phone: user.phone, firebaseUid: 'fb-admin-scoped' });

    // Client-supplied scopes are not a thing the route reads.
    const login = await adminFirebaseLogin(request(app), { scopes: ['SUPER_ADMIN'] });
    expect(login.status).toBe(201);
    const auth = { Authorization: `Bearer ${login.body.data.accessToken}` };

    const me = await request(app).get('/api/v1/admin/me').set(auth);
    expect(me.status).toBe(200);
    expect(me.body.data.scopes).toEqual(['KYC_REVIEWER']);
    expect(me.body.data.isSuperAdmin).toBe(false);

    // /admin/team is SUPER_ADMIN-only.
    const team = await request(app).get('/api/v1/admin/team').set(auth);
    expect(team.status).toBe(403);
  });
});

describe('admin Firebase login — anyone else gets nothing', () => {
  test('a FARMER phone is refused with 403 NOT_ADMIN, even claiming role ADMIN', async () => {
    const { user } = await createTestUser({ role: 'FARMER' });
    mockVerifyIdToken.mockResolvedValue({ phone: user.phone, firebaseUid: 'fb-farmer' });

    const res = await adminFirebaseLogin(request(app), { role: 'ADMIN', userId: user.id });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.details).toEqual({ code: 'NOT_ADMIN' });
    expect(res.body.data).toBeUndefined();
    expect(setCookies(res)).not.toMatch(/(^|\W)(rt|csrf)=/);
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);

    const actions = await prisma.auditLog.findMany({ where: { userId: user.id } });
    expect(actions.map((a) => a.action)).not.toContain('AUTH_LOGIN');
    const blocked = actions.find((a) => a.action === 'AUTH_LOGIN_BLOCKED');
    expect(blocked).toBeDefined();
    const meta = JSON.parse(blocked.metadata);
    expect(meta).toMatchObject({
      outcome: 'blocked', reason: 'role_required', requiredRole: 'ADMIN', loginMethod: 'firebase',
    });
    // Masked — never the full number in the audit trail.
    expect(meta.phone).toBe(`******${user.phone.slice(-4)}`);
  });

  test('a SELLER phone is refused the same way', async () => {
    const { user } = await createTestUser({ role: 'SELLER' });
    mockVerifyIdToken.mockResolvedValue({ phone: user.phone, firebaseUid: 'fb-seller' });

    const res = await adminFirebaseLogin(request(app));

    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual({ code: 'NOT_ADMIN' });
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
  });

  test('an unknown phone creates no account and no consent row', async () => {
    const phone = randomPhone();
    mockVerifyIdToken.mockResolvedValue({ phone, firebaseUid: 'fb-stranger' });
    const usersBefore    = await prisma.user.count();
    const consentsBefore = await prisma.consentRecord.count();

    const res = await adminFirebaseLogin(request(app), { name: 'Not An Admin' });

    expect(res.status).toBe(403);
    // Same answer as a registered non-admin: no oracle for which numbers exist.
    expect(res.body.error.details).toEqual({ code: 'NOT_ADMIN' });
    expect(setCookies(res)).not.toMatch(/(^|\W)(rt|csrf)=/);
    expect(await prisma.user.count({ where: { phone } })).toBe(0);
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.consentRecord.count()).toBe(consentsBefore);
  });

  test('an inactive ADMIN is refused with 403 ACCOUNT_INACTIVE and mints nothing', async () => {
    const { user } = await createTestUser({ role: 'ADMIN', isActive: false });
    mockVerifyIdToken.mockResolvedValue({ phone: user.phone, firebaseUid: 'fb-admin-inactive' });

    const res = await adminFirebaseLogin(request(app));

    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual({ code: 'ACCOUNT_INACTIVE' });
    expect(setCookies(res)).not.toMatch(/(^|\W)rt=/);
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
  });

  test('a locked ADMIN phone gets 423, not a session', async () => {
    const { user } = await createTestUser({ role: 'ADMIN' });
    for (let i = 0; i < ENV.OTP_LOCK_THRESHOLD; i++) await recordOtpFailure(user.phone);
    mockVerifyIdToken.mockResolvedValue({ phone: user.phone, firebaseUid: 'fb-admin-locked' });

    const res = await adminFirebaseLogin(request(app));

    expect(res.status).toBe(423);
    expect(res.headers['retry-after']).toBeDefined();
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
  });

  test('the admin audience needs a RECENT SMS: a stale token is a 401 and mints nothing', async () => {
    const since = new Date();
    const { user } = await createTestUser({ role: 'ADMIN' });
    mockVerifyIdToken.mockResolvedValue({ phone: user.phone, firebaseUid: 'fb-admin-stale' });
    mockVerifyReauth.mockRejectedValue(Object.assign(
      new Error('Please verify your phone number again to continue'), { staleReauth: true },
    ));

    const res = await adminFirebaseLogin(request(app));

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/request a new code/i);
    expect(mockVerifyReauth).toHaveBeenCalledWith(FAKE_ID_TOKEN);
    expect(mockVerifyIdToken).not.toHaveBeenCalled(); // the bare check is not enough here
    expect(setCookies(res)).not.toMatch(/(^|\W)(rt|csrf)=/);
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
    const failure = await prisma.auditLog.findFirst({
      where: { action: 'AUTH_OTP_FAILURE', createdAt: { gte: since }, metadata: { contains: 'firebase_auth_stale' } },
    });
    expect(failure).not.toBeNull();
  });

  test('a rejected Firebase token is a 401 whatever the audience', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('bad signature'));

    const res = await adminFirebaseLogin(request(app));

    expect(res.status).toBe(401);
  });

  test('any audience other than "admin" is a 400, before the token is checked', async () => {
    const res = await adminFirebaseLogin(request(app), { audience: 'seller' });

    expect(res.status).toBe(400);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });
});

describe('without an audience the route is exactly the apps\' route', () => {
  test('client-supplied role / userId are ignored: a FARMER stays a FARMER', async () => {
    const { user: farmer } = await createTestUser({ role: 'FARMER' });
    const { user: admin }  = await createTestUser({ role: 'ADMIN' });
    mockVerifyIdToken.mockResolvedValue({ phone: farmer.phone, firebaseUid: 'fb-farmer-app' });

    const res = await request(app).post(`${AUTH}/firebase-login`)
      .send({ idToken: FAKE_ID_TOKEN, role: 'ADMIN', userId: admin.id, scopes: ['SUPER_ADMIN'] });

    expect(res.status).toBe(201);
    expect(res.body.data.user.id).toBe(farmer.id);
    expect(jwtPayload(res.body.data.accessToken).role).toBe('FARMER');
    // The apps' path keeps the plain validity check (no auth_time gate).
    expect(mockVerifyReauth).not.toHaveBeenCalled();

    const adminApi = await request(app).get('/api/v1/admin/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(adminApi.status).toBe(403);
  });

  test('an unknown phone still signs up as a new farmer (app behaviour unchanged)', async () => {
    const phone = randomPhone();
    mockVerifyIdToken.mockResolvedValue({ phone, firebaseUid: 'fb-new-farmer' });

    const res = await request(app).post(`${AUTH}/firebase-login`).send({ idToken: FAKE_ID_TOKEN });

    expect(res.status).toBe(201);
    expect(res.body.data.isNewUser).toBe(true);
    expect(res.body.data.refreshToken).toBeDefined(); // mobile body transport
    const created = await prisma.user.findUnique({ where: { phone }, select: { role: true } });
    expect(created.role).toBe('FARMER');
  });
});

describe('CSP lets the admin page run Firebase phone auth when the flag is on', () => {
  const directiveOf = (csp) => (name) =>
    (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || '');

  test('everything outside /admin keeps the global CSP (no reCAPTCHA sources)', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'];

    expect(csp).toBeDefined();
    expect(csp).not.toContain('recaptcha');
    expect(csp).not.toContain('identitytoolkit');
    const directive = directiveOf(csp);
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('frame-src')).toBe('');
    expect(directive('connect-src')).toBe('');
  });

  test('/admin: reCAPTCHA scripts/frames and identitytoolkit are allowed; nothing else widened', async () => {
    // The SPA's own URL (Vite base '/admin/'); a bare /admin is express.static's
    // 301 to it, which carries serve-static's own minimal CSP.
    const res = await request(app).get('/admin/');
    const csp = res.headers['content-security-policy'];

    expect(csp).toBeDefined();
    // One policy, not two stacked (two would intersect and block reCAPTCHA).
    expect(csp.match(/(^|;\s*)script-src /g)).toHaveLength(1);
    const directive = directiveOf(csp);
    expect(directive('script-src')).toBe("script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/");
    expect(directive('frame-src')).toBe("frame-src 'self' https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/");
    expect(directive('connect-src')).toBe("connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com");
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('object-src')).toBe("object-src 'none'");
  });
});
