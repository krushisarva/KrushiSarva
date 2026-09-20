/**
 * KYC re-review on identity / payout changes — PUT /api/v1/users/me
 * (and PUT /me/seller-profile, which writes the same fields).
 *
 * An admin's VERIFY or REJECT covers one specific Aadhaar, PAN and payout
 * account. Two bugs came from the profile routes never touching kycStatus:
 *   #12  a REJECTED seller who corrected their details stayed REJECTED and never
 *        re-entered the admin queue (which lists SUBMITTED);
 *   #13  a VERIFIED seller could swap their PAN or bank account and keep the badge.
 *
 * The stored values are AES-GCM ciphertext with a fresh IV per write, so "did it
 * change?" has to be decided on decrypted values — the no-op cases below (same
 * PAN retyped, holder name re-cased) are what a ciphertext comparison gets wrong.
 */
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestMachinery,
  cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const { encrypt, decrypt } = await import('../../../src/utils/encrypt.js');

const REVIEWED = {
  aadharNumber:      '234567890124',
  panNumber:         'ABCDE1234F',
  bankAccountNumber: '123456789012',
  bankIfsc:          'SBIN0012345',
  bankHolderName:    'Ramesh Patil',
  bankName:          'State Bank of India',
};
const REJECTION = 'PAN does not match the name on the bank account';

let app;

beforeAll(async () => {
  app = await getApp();
});

afterAll(async () => {
  await cleanupTestData();
});

/**
 * A seller an admin has already decided on, with the reviewed details stored
 * encrypted exactly as the routes store them. Each test gets its own seller: the
 * sensitive-PII limiter allows five changes an hour per user.
 */
async function decidedSeller(kycStatus) {
  const seller = await createTestSeller({ kycStatus });
  const decidedAt = new Date('2026-09-01T10:00:00Z');
  await prisma.sellerProfile.create({
    data: {
      userId: seller.user.id,
      ...Object.fromEntries(Object.entries(REVIEWED).map(([k, v]) => [k, encrypt(v)])),
      kycVerifiedAt:     kycStatus === 'VERIFIED' ? decidedAt : null,
      licenceVerifiedAt: kycStatus === 'VERIFIED' ? decidedAt : null,
      kycRejectedReason: kycStatus === 'REJECTED' ? REJECTION : null,
    },
  });
  return { ...seller, decidedAt };
}

/** The body BusinessProfileScreen sends (buildBusinessProfilePayload), plus `extra`. */
function screenPayload(extra = {}) {
  return {
    sellerConsent: true,
    businessType: 'individual_farmer',
    district: 'Pune',
    taluka: 'Haveli',
    village: 'Wagholi',
    state: 'Maharashtra',
    gstOptOut: true,
    gstNumber: '',
    ...extra,
  };
}

const putMe = (headers, body) => request(app).put('/api/v1/users/me').set(headers).send(body);

async function stateOf(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { kycStatus: true, role: true, sellerProfile: true },
  });
}

// The audit write is fire-and-forget after the commit, so it can land a moment
// after the response.
async function resubmitAudits(userId) {
  for (let i = 0; i < 20; i++) {
    const rows = await prisma.auditLog.findMany({ where: { userId, action: 'KYC_RESUBMIT' } });
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

describe('REJECTED seller corrects their details (bug #12)', () => {
  test('changing the PAN sends the account back to SUBMITTED and clears the reason', async () => {
    const seller = await decidedSeller('REJECTED');

    const res = await putMe(seller.headers, screenPayload({ panNumber: 'pqrst6789k' }));

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe('SUBMITTED');
    expect(res.body.data.sellerProfile.kycRejectedReason).toBeNull();
    expect(res.body.data.role).toBe('SELLER');

    const after = await stateOf(seller.user.id);
    expect(after.kycStatus).toBe('SUBMITTED');
    expect(after.role).toBe('SELLER');
    expect(after.sellerProfile.kycRejectedReason).toBeNull();
    expect(decrypt(after.sellerProfile.panNumber)).toBe('PQRST6789K');

    const [audit] = await resubmitAudits(seller.user.id);
    expect(audit).toBeDefined();
    expect(JSON.parse(audit.before)).toEqual({ kycStatus: 'REJECTED' });
    expect(JSON.parse(audit.after)).toEqual({ kycStatus: 'SUBMITTED' });
    // Field names only — never the values.
    expect(JSON.parse(audit.metadata)).toEqual({ changedFields: ['panNumber'] });
    expect(audit.metadata).not.toContain('PQRST');
  });

  test('the corrected seller shows up in the admin KYC queue', async () => {
    const seller = await decidedSeller('REJECTED');
    const admin = await createTestUser({ role: 'ADMIN' });

    await putMe(seller.headers, screenPayload({ aadharNumber: '345678901235' })).expect(200);

    const res = await request(app)
      .get('/api/v1/admin/kyc?status=SUBMITTED&limit=100')
      .set(admin.headers);

    expect(res.status).toBe(200);
    const row = res.body.data.items.find((i) => i.userId === seller.user.id);
    expect(row).toBeDefined();
    expect(row.kycRejectedReason).toBeNull();
  });

  test('re-saving the same details does not count as a correction', async () => {
    const seller = await decidedSeller('REJECTED');

    const res = await putMe(seller.headers, screenPayload({ panNumber: REVIEWED.panNumber }));

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe('REJECTED');
    const after = await stateOf(seller.user.id);
    expect(after.kycStatus).toBe('REJECTED');
    expect(after.sellerProfile.kycRejectedReason).toBe(REJECTION);
  });
});

describe('VERIFIED seller changes identity or payout details (bug #13)', () => {
  test('changing the bank account number removes the verification', async () => {
    const seller = await decidedSeller('VERIFIED');
    const listing = await createTestMachinery(seller.user.id);

    const res = await putMe(seller.headers, screenPayload({ bankAccountNumber: '999988887777' }));

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe('SUBMITTED');
    expect(res.body.data.sellerProfile.kycVerifiedAt).toBeNull();

    const after = await stateOf(seller.user.id);
    expect(after.kycStatus).toBe('SUBMITTED');
    expect(after.sellerProfile.kycVerifiedAt).toBeNull();
    expect(decrypt(after.sellerProfile.bankAccountNumber)).toBe('999988887777');
    // Not a demotion and not a takedown: the role and the listings stay as they were.
    expect(after.role).toBe('SELLER');
    // Licence fields are not editable here, so their verification is not touched.
    expect(after.sellerProfile.licenceVerifiedAt).toEqual(seller.decidedAt);
    const stillListed = await prisma.machineryListing.findUnique({ where: { id: listing.id } });
    expect(stillListed.status).toBe('ACTIVE');
  });

  test.each([
    ['aadharNumber', '345678901235'],
    ['panNumber', 'PQRST6789K'],
    ['bankIfsc', 'HDFC0001234'],
    ['bankHolderName', 'Suresh Jadhav'],
  ])('changing %s removes the verification', async (field, value) => {
    const seller = await decidedSeller('VERIFIED');

    const res = await putMe(seller.headers, { [field]: value });

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe('SUBMITTED');
    const after = await stateOf(seller.user.id);
    expect(after.kycStatus).toBe('SUBMITTED');
    expect(after.sellerProfile.kycVerifiedAt).toBeNull();
  });

  test('changing only the village keeps the verification', async () => {
    const seller = await decidedSeller('VERIFIED');

    const res = await putMe(seller.headers, screenPayload({ village: 'Lonikand' }));

    expect(res.status).toBe(200);
    expect(res.body.data.village).toBe('Lonikand');
    expect(res.body.data.kycStatus).toBe('VERIFIED');
    const after = await stateOf(seller.user.id);
    expect(after.kycStatus).toBe('VERIFIED');
    expect(after.sellerProfile.kycVerifiedAt).toEqual(seller.decidedAt);
    expect(await resubmitAudits(seller.user.id)).toEqual([]);
  });

  test('retyping the same details (other case / spacing) keeps the verification', async () => {
    const seller = await decidedSeller('VERIFIED');

    const res = await putMe(seller.headers, {
      aadharNumber:      REVIEWED.aadharNumber,
      panNumber:         REVIEWED.panNumber.toLowerCase(),
      bankAccountNumber: REVIEWED.bankAccountNumber,
      bankIfsc:          REVIEWED.bankIfsc.toLowerCase(),
      bankHolderName:    '  RAMESH   patil ',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe('VERIFIED');
    const after = await stateOf(seller.user.id);
    expect(after.kycStatus).toBe('VERIFIED');
    expect(after.sellerProfile.kycVerifiedAt).toEqual(seller.decidedAt);
  });

  test('renaming the bank (a display label) keeps the verification', async () => {
    const seller = await decidedSeller('VERIFIED');

    const res = await putMe(seller.headers, { bankName: 'SBI' });

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe('VERIFIED');
  });
});

describe('accounts with no KYC decision yet', () => {
  // PENDING is every account's default, not "awaiting review": the first PAN is
  // what submits it (sellerKycGate.api.test.js covers the whole onboarding path).
  test('a PENDING seller adding a PAN is submitted for review', async () => {
    const seller = await createTestSeller({ kycStatus: 'PENDING' });

    const res = await putMe(seller.headers, screenPayload({ panNumber: 'ABCDE1234F' }));

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe('SUBMITTED');
  });

  test('a SUBMITTED seller changing their PAN stays SUBMITTED', async () => {
    const seller = await createTestSeller({ kycStatus: 'SUBMITTED' });

    const res = await putMe(seller.headers, screenPayload({ panNumber: 'ABCDE1234F' }));

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe('SUBMITTED');
    expect(await resubmitAudits(seller.user.id)).toEqual([]);
  });
});

describe('PUT /me/seller-profile', () => {
  test('is not a way around the re-review: a new account number removes the verification', async () => {
    const seller = await decidedSeller('VERIFIED');

    const res = await request(app)
      .put('/api/v1/users/me/seller-profile')
      .set(seller.headers)
      .send({ bankAccountNumber: '999988887777' });

    expect(res.status).toBe(200);
    expect(res.body.data.kycVerifiedAt).toBeNull();
    const after = await stateOf(seller.user.id);
    expect(after.kycStatus).toBe('SUBMITTED');
    expect(after.sellerProfile.kycVerifiedAt).toBeNull();
  });

  test('a bank-name-only change keeps the verification', async () => {
    const seller = await decidedSeller('VERIFIED');

    const res = await request(app)
      .put('/api/v1/users/me/seller-profile')
      .set(seller.headers)
      .send({ bankName: 'SBI' });

    expect(res.status).toBe(200);
    expect((await stateOf(seller.user.id)).kycStatus).toBe('VERIFIED');
  });
});
