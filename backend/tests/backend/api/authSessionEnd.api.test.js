/**
 * How a session ENDS — and how a dead account is kept from starting one.
 *
 *   #35  A deactivated account could log in. issueSessionForVerifiedPhone never
 *        looked at isActive, so login minted a fresh pair, the very next request
 *        401'd in the auth middleware, and the app sat "logged in" with every
 *        screen failing. Both login paths now refuse it with a clear 403.
 *   #36  Logout is only a server-side logout if the refresh token is revoked.
 *        The app posted no body, so the route had nothing to revoke and the
 *        lineage outlived the logout.
 *   #37  Logout now also drops this device's push token for the caller, so the
 *        account that left stops getting pushes on the handset.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import { getApp, createTestUser, cleanupTestData, prisma } from '../../fixtures/setup.js';
import { resetRateLimitStore } from '../../../src/middleware/rateLimit.js';

// /firebase-login is exercised without reaching Google: the verifier hands back
// the phone the token "proved". getApp() imports src/app.js dynamically, so this
// registers before the route is loaded.
const mockVerifyIdToken = jest.fn();
jest.unstable_mockModule('../../../src/services/firebaseAuth.service.js', () => ({
  verifyFirebaseIdToken: mockVerifyIdToken,
  verifyFirebaseReauth:  jest.fn(),
  isFirebaseAuthEnabled: () => true,
}));

const AUTH = '/api/v1/auth';
const FAKE_ID_TOKEN = 'f'.repeat(64);

let app;

beforeAll(async () => { app = await getApp(); });
beforeEach(() => { resetRateLimitStore(); mockVerifyIdToken.mockReset(); });
afterAll(async () => { await cleanupTestData(); });

async function otpLogin(phone) {
  await request(app).post(`${AUTH}/send-otp`).send({ phone });
  return request(app).post(`${AUTH}/verify-otp`).send({ phone, otp: '000000' });
}

describe('a deactivated account cannot log in (#35)', () => {
  test('verify-otp refuses it with 403 ACCOUNT_INACTIVE and mints nothing', async () => {
    const { user } = await createTestUser({ isActive: false });

    const res = await otpLogin(user.phone);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.details).toEqual({ code: 'ACCOUNT_INACTIVE' });
    expect(res.body.error.message).toMatch(/deactivated/i);
    expect(res.body.data).toBeUndefined();
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);

    // Audited as a blocked login — NOT as AUTH_LOGIN, which login risk and geo
    // anomaly read back as the account's previous successful logins.
    const actions = (await prisma.auditLog.findMany({ where: { userId: user.id } })).map((a) => a.action);
    expect(actions).toContain('AUTH_LOGIN_BLOCKED');
    expect(actions).not.toContain('AUTH_LOGIN');
  });

  test('firebase-login refuses it the same way', async () => {
    const { user } = await createTestUser({ isActive: false });
    mockVerifyIdToken.mockResolvedValue({ phone: user.phone, firebaseUid: 'fb-inactive' });

    const res = await request(app).post(`${AUTH}/firebase-login`).send({ idToken: FAKE_ID_TOKEN });

    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual({ code: 'ACCOUNT_INACTIVE' });
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
  });

  test('an active account still logs in, and the gate is not leaked in the body', async () => {
    const { user } = await createTestUser();
    mockVerifyIdToken.mockResolvedValue({ phone: user.phone, firebaseUid: 'fb-active' });

    const otp = await otpLogin(user.phone);
    const fb  = await request(app).post(`${AUTH}/firebase-login`).send({ idToken: FAKE_ID_TOKEN });

    for (const res of [otp, fb]) {
      expect(res.status).toBe(201);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.user.id).toBe(user.id);
      expect(res.body.data.user).not.toHaveProperty('isActive');
      expect(res.body.data.user).not.toHaveProperty('tokenVersion');
    }
  });
});

describe('logout revokes the refresh token it is given (#36)', () => {
  test('after logout with the token in the body, that token can no longer refresh', async () => {
    const { user } = await createTestUser();
    const { accessToken, refreshToken } = (await otpLogin(user.phone)).body.data;

    const out = await request(app).post(`${AUTH}/logout`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });
    expect(out.status).toBe(200);

    const refresh = await request(app).post(`${AUTH}/refresh`).send({ userId: user.id, refreshToken });
    expect(refresh.status).toBe(401);
  });

  test('a body-less logout (what the app used to send) left the lineage alive', async () => {
    const { user } = await createTestUser();
    const { accessToken, refreshToken } = (await otpLogin(user.phone)).body.data;

    await request(app).post(`${AUTH}/logout`).set('Authorization', `Bearer ${accessToken}`).send({});

    // Documents why the client must send it: the server has nothing to revoke.
    const refresh = await request(app).post(`${AUTH}/refresh`).send({ userId: user.id, refreshToken });
    expect(refresh.status).toBe(200);
  });
});

describe('logout unmaps this device\'s push token (#37)', () => {
  const expoToken = (tag) => `ExponentPushToken[${tag}-${Date.now()}-${Math.round(Math.random() * 1e6)}]`;

  test('the caller\'s row for the token is deleted; their other devices are kept', async () => {
    const { user } = await createTestUser();
    const { accessToken, refreshToken } = (await otpLogin(user.phone)).body.data;
    const thisDevice  = expoToken('this');
    const otherDevice = expoToken('other');
    await prisma.pushToken.createMany({
      data: [
        { token: thisDevice,  userId: user.id, platform: 'android' },
        { token: otherDevice, userId: user.id, platform: 'android' },
      ],
    });

    const res = await request(app).post(`${AUTH}/logout`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken, pushToken: thisDevice });

    expect(res.status).toBe(200);
    const left = await prisma.pushToken.findMany({ where: { userId: user.id }, select: { token: true } });
    expect(left.map((r) => r.token)).toEqual([otherDevice]);
  });

  test('a token that belongs to someone else is left alone', async () => {
    const { user } = await createTestUser();
    const { user: other } = await createTestUser();
    const { accessToken } = (await otpLogin(user.phone)).body.data;
    const theirs = expoToken('theirs');
    await prisma.pushToken.create({ data: { token: theirs, userId: other.id, platform: 'android' } });

    const res = await request(app).post(`${AUTH}/logout`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ pushToken: theirs });

    expect(res.status).toBe(200);
    expect(await prisma.pushToken.count({ where: { token: theirs, userId: other.id } })).toBe(1);
  });

  test('a malformed pushToken does not fail the logout', async () => {
    const { user } = await createTestUser();
    const { accessToken, refreshToken } = (await otpLogin(user.phone)).body.data;

    const res = await request(app).post(`${AUTH}/logout`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken, pushToken: { not: 'a string' } });

    expect(res.status).toBe(200);
    const refresh = await request(app).post(`${AUTH}/refresh`).send({ userId: user.id, refreshToken });
    expect(refresh.status).toBe(401);
  });
});
