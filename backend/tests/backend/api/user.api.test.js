/**
 * API tests for /api/v1/users/*
 * Covers: profile, seller profile, farm details, push tokens, PII masking
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller,
  cleanupTestData, prisma,
} from '../../fixtures/setup.js';
import { XSS_PAYLOADS } from '../../fixtures/factories.js';

// Account erasure re-authenticates through a FRESH Firebase SMS challenge, so the
// suite stubs the verifier rather than reaching Google. getApp() imports src/app.js
// dynamically, so registering the mock here still lands before the route loads.
const mockVerifyReauth = jest.fn();
jest.unstable_mockModule('../../../src/services/firebaseAuth.service.js', () => ({
  verifyFirebaseReauth:   mockVerifyReauth,
  verifyFirebaseIdToken:  jest.fn(),
  isFirebaseAuthEnabled:  () => true,
}));

// Any string long enough to clear the validator; the stub decides pass/fail.
const FAKE_ID_TOKEN = 'f'.repeat(64);

let app;
let farmer, seller;

beforeAll(async () => {
  app = await getApp();
  farmer = await createTestUser();
  seller = await createTestSeller();
});

afterAll(async () => {
  await cleanupTestData();
});

// ── GET /me ──────────────────────────────────────────────────────────────────
describe('GET /api/v1/users/me', () => {
  test('200 — returns authenticated user profile', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set(farmer.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(farmer.user.id);
    expect(res.body.data.phone).toBe(farmer.user.phone);
  });

  test('401 — unauthenticated', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });

  test('401 — invalid token', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer invalid-token-here');
    expect(res.status).toBe(401);
  });

  test('PII masking — Aadhaar, bank account, PAN are masked in response', async () => {
    // Set up seller profile with PII
    await request(app)
      .put('/api/v1/users/me')
      .set(seller.headers)
      .send({
        aadharNumber: '123456789012',
        panNumber: 'ABCDE1234F',
        bankAccountNumber: '12345678901234',
        bankIfsc: 'SBIN0012345',
        bankHolderName: 'Test Seller',
        bankName: 'SBI',
      });

    const res = await request(app)
      .get('/api/v1/users/me')
      .set(seller.headers);

    expect(res.status).toBe(200);

    if (res.body.data.sellerProfile) {
      const sp = res.body.data.sellerProfile;
      // Should be masked
      if (sp.aadharNumber) {
        expect(sp.aadharNumber).toContain('••••');
        expect(sp.aadharNumber).not.toBe('123456789012');
      }
      if (sp.bankAccountNumber) {
        expect(sp.bankAccountNumber).toContain('••••');
        expect(sp.bankAccountNumber).not.toBe('12345678901234');
      }
      if (sp.panNumber) {
        expect(sp.panNumber).toContain('•••');
        expect(sp.panNumber).not.toBe('ABCDE1234F');
      }
    }
  });

  test('response does not contain password hashes or internal IDs', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set(farmer.headers);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('$2b$'); // bcrypt prefix
    expect(body).not.toContain('password');
    expect(body).not.toContain('otpSession');
  });
});

// ── PUT /me ──────────────────────────────────────────────────────────────────
describe('PUT /api/v1/users/me', () => {
  test('200 — update name', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ name: 'Updated Farmer' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated Farmer');
  });

  test('200 — update location fields', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({
        district: 'Nashik',
        taluka: 'Dindori',
        village: 'Vani',
        pincode: '422305',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.district).toBe('Nashik');
  });

  test('400 — invalid pincode (not 6 digits)', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ pincode: '1234' });

    expect(res.status).toBe(400);
  });

  // A stored PIN that no longer resolves blocks the seller form until the field
  // is emptied, so emptying it has to be a real clear. A fresh user keeps this
  // out of the shared farmer's write quota.
  test('200 — an empty pincode clears the stored one and leaves the district', async () => {
    const { headers } = await createTestUser();

    const set = await request(app)
      .put('/api/v1/users/me')
      .set(headers)
      .send({ pincode: '422305', district: 'Nashik' });
    expect(set.status).toBe(200);
    expect(set.body.data.pincode).toBe('422305');

    const cleared = await request(app)
      .put('/api/v1/users/me')
      .set(headers)
      .send({ pincode: '' });

    expect(cleared.status).toBe(200);
    expect(cleared.body.data.pincode).toBeNull();
    expect(cleared.body.data.district).toBe('Nashik');
  });

  test('400 — invalid language', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ language: 'french' });

    expect(res.status).toBe(400);
  });

  test('400 — invalid GST format', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ gstNumber: 'INVALID_GST' });

    expect(res.status).toBe(400);
  });

  test('200 — valid GST number accepted', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ gstNumber: '27ABCDE1234F1Z5' });

    expect(res.status).toBe(200);
  });

  test('200 — gstOptOut clears gstNumber', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ gstOptOut: true, gstNumber: '' });

    expect(res.status).toBe(200);
    expect(res.body.data.gstOptOut).toBe(true);
  });

  test('400 — invalid Aadhaar (not 12 digits)', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ aadharNumber: '12345' });

    expect(res.status).toBe(400);
  });

  test('400 — invalid IFSC format', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ bankIfsc: 'NOTVALID' });

    expect(res.status).toBe(400);
  });

  test('XSS — HTML stripped from name', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ name: '<script>alert(1)</script>Farmer' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).not.toContain('<script>');
    expect(res.body.data.name).toContain('Farmer');
  });

  test('XSS — HTML stripped from statusQuote', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ statusQuote: '<img src=x onerror=alert(1)>Hello' });

    expect(res.status).toBe(200);
    expect(res.body.data.statusQuote).not.toContain('<img');
  });

  test('mass assignment — role field is ignored', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({ name: 'Hacker', role: 'ADMIN' });

    expect(res.status).toBe(200);
    // Role should NOT change
    const profile = await request(app)
      .get('/api/v1/users/me')
      .set(farmer.headers);

    expect(profile.body.data.role).toBe('FARMER');
  });

  // The seller app sends every account that isn't already a seller to
  // BusinessProfile, and this save is the consent that promotes it. Only FARMER
  // was promoted, so a LABOUR_PROVIDER or MACHINERY_OWNER was told "not a seller
  // account yet" on every save and every seller route kept 403-ing. The roles
  // accepted here mirror SELLER_FLIP_FROM in routes/admin/kyc.routes.js.
  const consentSave = {
    sellerConsent: true,
    businessType: 'individual_farmer',
    district: 'Pune', taluka: 'Haveli', village: 'Wagholi', state: 'Maharashtra',
    gstOptOut: true, gstNumber: '',
  };

  test.each(['FARMER', 'VERIFIED_FARMER', 'LABOUR_PROVIDER', 'MACHINERY_OWNER'])(
    '200 — %s opting in is promoted to SELLER, with fresh tokens',
    async (role) => {
      const { user, headers } = await createTestUser({ role });

      const res = await request(app).put('/api/v1/users/me').set(headers).send(consentSave);

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('SELLER');
      // The role lives in the JWT, so the flip has to re-issue it or every
      // seller request keeps presenting the old role.
      expect(res.body.data.tokens?.accessToken).toBeTruthy();
      expect((await prisma.user.findUnique({ where: { id: user.id } })).role).toBe('SELLER');
    },
  );

  test('an ADMIN is never demoted to SELLER by opting in', async () => {
    const { user, headers } = await createTestUser({ role: 'ADMIN' });

    const res = await request(app).put('/api/v1/users/me').set(headers).send(consentSave);

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('ADMIN');
    expect(res.body.data.tokens).toBeUndefined();
    expect((await prisma.user.findUnique({ where: { id: user.id } })).role).toBe('ADMIN');
  });

  test('400 — no fields to update', async () => {
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(farmer.headers)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ── PUT /me/farm ─────────────────────────────────────────────────────────────
describe('PUT /api/v1/users/me/farm', () => {
  test('200 — create/update farm details', async () => {
    const res = await request(app)
      .put('/api/v1/users/me/farm')
      .set(farmer.headers)
      .send({
        village: 'Shrigonda',
        district: 'Ahmednagar',
        landAcres: 5.5,
        cropTypes: ['Wheat', 'Soybean'],
        soilType: 'Black',
        irrigationType: 'Drip',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.landAcres).toBe(5.5);
    expect(res.body.data.cropTypes).toContain('Wheat');
  });

  test('400 — cropTypes with more than 20 items', async () => {
    const crops = Array.from({ length: 21 }, (_, i) => `Crop${i}`);
    const res = await request(app)
      .put('/api/v1/users/me/farm')
      .set(farmer.headers)
      .send({ cropTypes: crops });

    expect(res.status).toBe(400);
  });

  test('400 — negative landAcres', async () => {
    const res = await request(app)
      .put('/api/v1/users/me/farm')
      .set(farmer.headers)
      .send({ landAcres: -10 });

    expect(res.status).toBe(400);
  });

  // The same clear-by-empty-string contract PUT /me honours for the user's own
  // address. `pincode` and `landAcres` were answered with a 400 here, because
  // their format validators ran on '' — so a PIN typed wrong once was on the
  // farm for good. Fresh users keep these off the shared farmer's write quota.
  test('200 — an empty pincode clears the stored one and leaves the village', async () => {
    const { headers } = await createTestUser();

    const set = await request(app)
      .put('/api/v1/users/me/farm')
      .set(headers)
      .send({ pincode: '422305', village: 'Vani' });
    expect(set.status).toBe(200);
    expect(set.body.data.pincode).toBe('422305');

    const cleared = await request(app)
      .put('/api/v1/users/me/farm')
      .set(headers)
      .send({ pincode: '' });

    expect(cleared.status).toBe(200);
    expect(cleared.body.data.pincode).toBeNull();
    expect(cleared.body.data.village).toBe('Vani');
  });

  test('200 — an empty landAcres clears it, and 0 acres is stored as 0', async () => {
    const { headers } = await createTestUser();

    const set = await request(app)
      .put('/api/v1/users/me/farm')
      .set(headers)
      .send({ landAcres: 4.25 });
    expect(set.status).toBe(200);
    expect(set.body.data.landAcres).toBe(4.25);

    const cleared = await request(app)
      .put('/api/v1/users/me/farm')
      .set(headers)
      .send({ landAcres: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.landAcres).toBeNull();

    // 0 is inside the validator's own `min: 0`, so it must survive the handler —
    // the old `landAcres ? parseFloat(...) : undefined` dropped it on create.
    const zero = await request(app)
      .put('/api/v1/users/me/farm')
      .set(headers)
      .send({ landAcres: 0 });
    expect(zero.status).toBe(200);
    expect(zero.body.data.landAcres).toBe(0);
  });

  // Emptying a free-text box always returned 200, but stored '' — so "cleared"
  // and "never filled in" were two different rows and every reader had to know
  // about both. They clear to NULL now, like every other field on this route.
  test('200 — emptied text fields are stored as NULL, not the empty string', async () => {
    const { headers } = await createTestUser();

    const set = await request(app)
      .put('/api/v1/users/me/farm')
      .set(headers)
      .send({ village: 'Vani', district: 'Nashik', state: 'Maharashtra', soilType: 'Black', irrigationType: 'Drip' });
    expect(set.status).toBe(200);

    const cleared = await request(app)
      .put('/api/v1/users/me/farm')
      .set(headers)
      .send({ village: '', district: '', state: '', soilType: '', irrigationType: '' });

    expect(cleared.status).toBe(200);
    expect(cleared.body.data.village).toBeNull();
    expect(cleared.body.data.district).toBeNull();
    expect(cleared.body.data.state).toBeNull();
    expect(cleared.body.data.soilType).toBeNull();
    expect(cleared.body.data.irrigationType).toBeNull();
  });

  // A whitespace-only box is an emptied box: `.trim()` sanitises it to '' before
  // the handler sees it, so it must take the same NULL path.
  test('200 — a whitespace-only village clears to NULL', async () => {
    const { headers } = await createTestUser();

    await request(app).put('/api/v1/users/me/farm').set(headers).send({ village: 'Vani' });
    const cleared = await request(app)
      .put('/api/v1/users/me/farm')
      .set(headers)
      .send({ village: '   ' });

    expect(cleared.status).toBe(200);
    expect(cleared.body.data.village).toBeNull();
  });

  // Clearing must stay a deliberate act: a body that omits a field leaves it be.
  test('200 — an omitted field is left alone, not cleared', async () => {
    const { headers } = await createTestUser();

    await request(app)
      .put('/api/v1/users/me/farm')
      .set(headers)
      .send({ pincode: '422305', village: 'Vani', landAcres: 3 });

    const res = await request(app)
      .put('/api/v1/users/me/farm')
      .set(headers)
      .send({ village: 'Dindori' });

    expect(res.status).toBe(200);
    expect(res.body.data.village).toBe('Dindori');
    expect(res.body.data.pincode).toBe('422305');
    expect(res.body.data.landAcres).toBe(3);
  });

  // The escape hatch is for EMPTY, not for malformed: a non-empty PIN of the
  // wrong shape is still refused.
  test('400 — a non-empty pincode still has to be six digits', async () => {
    const res = await request(app)
      .put('/api/v1/users/me/farm')
      .set(farmer.headers)
      .send({ pincode: '1234' });

    expect(res.status).toBe(400);
  });
});

// ── POST /me/push-token ──────────────────────────────────────────────────────
describe('POST /api/v1/users/me/push-token', () => {
  test('200 — valid Expo push token', async () => {
    const res = await request(app)
      .post('/api/v1/users/me/push-token')
      .set(farmer.headers)
      .send({
        token: 'ExponentPushToken[xxxxxx-test-token]',
        platform: 'android',
      });

    expect(res.status).toBe(200);
  });

  test('400 — invalid token format', async () => {
    const res = await request(app)
      .post('/api/v1/users/me/push-token')
      .set(farmer.headers)
      .send({ token: 'not-a-push-token', platform: 'ios' });

    expect(res.status).toBe(400);
  });

  test('400 — invalid platform', async () => {
    const res = await request(app)
      .post('/api/v1/users/me/push-token')
      .set(farmer.headers)
      .send({
        token: 'ExponentPushToken[valid-token]',
        platform: 'windows',
      });

    expect(res.status).toBe(400);
  });
});

// ── Profile write rate limiting (M1) ──────────────────────────────────────────
describe('Profile write rate limiting', () => {
  test('429 with Retry-After after exceeding the per-user write cap (20 / 15 min)', async () => {
    // Fresh user so its quota is independent of the shared farmer/seller above.
    const { headers } = await createTestUser();

    let limitedRes;
    for (let i = 0; i < 22; i++) {
      const res = await request(app)
        .put('/api/v1/users/me')
        .set(headers)
        .send({ name: `Rate Test ${i}` });
      if (res.status === 429) { limitedRes = res; break; }
    }

    expect(limitedRes).toBeDefined();
    expect(limitedRes.status).toBe(429);
    expect(Number(limitedRes.headers['retry-after'])).toBeGreaterThan(0);
    expect(limitedRes.body.success).toBe(false);
    expect(limitedRes.body.error.details.retryAfter).toBeGreaterThan(0);
  }, 30000);

  test('a different user is not affected by another user hitting the cap', async () => {
    // The previous test saturated its own user; a brand-new user still writes.
    const { headers } = await createTestUser();
    const res = await request(app)
      .put('/api/v1/users/me')
      .set(headers)
      .send({ name: 'Independent User' });

    expect(res.status).toBe(200);
  });
});

// ── DELETE /me — account erasure (DPDP Act §8) ───────────────────────────────
// Each test uses a throwaway user: erasure is irreversible, so reusing the
// shared `farmer` above would poison every test that runs after it.
describe('DELETE /api/v1/users/me', () => {
  // The route accepts the erasure only when the token proves THIS user's phone
  // and the SMS behind it is recent. Each case programmes the stub accordingly.
  const reauthResolvesTo = (phone) => mockVerifyReauth.mockResolvedValue({ phone, firebaseUid: 'uid-test' });
  const reauthRejectsWith = (err) => mockVerifyReauth.mockRejectedValue(err);
  beforeEach(() => mockVerifyReauth.mockReset());

  test('401 — unauthenticated', async () => {
    const res = await request(app).delete('/api/v1/users/me').send({ idToken: FAKE_ID_TOKEN });
    expect(res.status).toBe(401);
  });

  // The shared `validate` middleware answers malformed input with 400 (several
  // older tests in this file still assert 422 and fail — see the suite notes).
  test('400 — rejects a missing or malformed token', async () => {
    const { headers } = await createTestUser();
    for (const body of [{}, { idToken: 'short' }, { idToken: 123 }]) {
      const res = await request(app).delete('/api/v1/users/me').set(headers).send(body);
      expect(res.status).toBe(400);
    }
  });

  test('401 — rejects an invalid token and leaves the account intact', async () => {
    const { user, headers } = await createTestUser();
    reauthRejectsWith(new Error('Firebase token is invalid'));

    const res = await request(app)
      .delete('/api/v1/users/me')
      .set(headers)
      .send({ idToken: FAKE_ID_TOKEN });

    expect(res.status).toBe(401);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.phone).toBe(user.phone);
    expect(after.isActive).toBe(true);
  });

  test('200 — erases PII, deactivates the account and revokes tokens', async () => {
    const { user, headers } = await createTestUser({
      name: 'Erase Me', village: 'Testpur', district: 'Pune', state: 'Maharashtra',
    });
    // Personal rows that must be hard-deleted by the cascade.
    await prisma.pushToken.create({ data: { userId: user.id, token: `ExponentPushToken[${user.id}]`, platform: 'android' } });
    reauthResolvesTo(user.phone);

    const res = await request(app)
      .delete('/api/v1/users/me')
      .set(headers)
      .send({ idToken: FAKE_ID_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.data.erased).toBe(true);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after).not.toBeNull();               // row kept, not hard-deleted
    expect(after.phone).toBe(`deleted_${user.id}`);
    expect(after.name).toBe('Deleted User');
    expect(after.isActive).toBe(false);
    expect(after.village).toBeNull();
    expect(after.district).toBeNull();
    expect(after.state).toBeNull();
    // tokenVersion bump is what invalidates already-issued JWTs.
    expect(after.tokenVersion).toBeGreaterThan(user.tokenVersion);

    expect(await prisma.pushToken.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
  }, 30000);

  test('the erased user’s access token no longer authenticates', async () => {
    const { user, headers } = await createTestUser();
    reauthResolvesTo(user.phone);

    await request(app).delete('/api/v1/users/me').set(headers).send({ idToken: FAKE_ID_TOKEN });

    // Same token, now stale: tokenVersion was bumped and the account deactivated.
    const res = await request(app).get('/api/v1/users/me').set(headers);
    expect(res.status).toBe(401);
  }, 30000);

  test('the freed phone number can register a new account', async () => {
    const { user, headers } = await createTestUser();
    const originalPhone = user.phone;
    reauthResolvesTo(originalPhone);

    await request(app).delete('/api/v1/users/me').set(headers).send({ idToken: FAKE_ID_TOKEN });

    // The sentinel released the unique constraint on the real number.
    const reborn = await prisma.user.create({ data: { phone: originalPhone, name: 'New Owner' } });
    expect(reborn.id).not.toBe(user.id);
  }, 30000);
});
