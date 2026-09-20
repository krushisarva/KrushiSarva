/**
 * Minors cannot store identity or payout details through PUT /users/me (bug #34).
 *
 * PUT /me/seller-profile and POST /me/kyc-documents sit behind blockMinors, but
 * PUT /me accepts and encrypts the same Aadhaar / PAN / bank fields — so a minor
 * went around the rule with the general profile route. PUT /me now refuses those
 * fields with blockMinors' 403 when the account is a minor on file, or becomes
 * one through this request's dateOfBirth. Everything else still saves.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { getApp, createTestUser, cleanupTestData, prisma } from '../../fixtures/setup.js';

const MINOR_MESSAGE =
  'This action is restricted for users under 18 (DPDP Act §9). Please contact support if you believe this is an error.';
const MINOR_DOB = new Date(Date.now() - 15 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);

let app;

beforeAll(async () => { app = await getApp(); });
afterAll(async () => { await cleanupTestData(); });

const putMe = (headers, body) => request(app).put('/api/v1/users/me').set(headers).send(body);
const minor = () => createTestUser({ isMinor: true, dateOfBirth: new Date(MINOR_DOB) });
const profileOf = (userId) => prisma.sellerProfile.findUnique({ where: { userId } });

describe('PUT /me — minor on file', () => {
  test.each([
    ['aadharNumber', '234567890124'],
    ['panNumber', 'ABCDE1234F'],
    ['bankAccountNumber', '123456789012'],
    ['bankIfsc', 'SBIN0012345'],
    ['bankHolderName', 'Ramesh Patil'],
    ['bankName', 'State Bank of India'],
  ])('%s is refused with blockMinors\' 403, and nothing in the request is saved', async (field, value) => {
    const kid = await minor();

    const res = await putMe(kid.headers, { name: 'Changed Name', [field]: value });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(MINOR_MESSAGE);
    expect(await profileOf(kid.user.id)).toBeNull();
    const after = await prisma.user.findUnique({ where: { id: kid.user.id }, select: { name: true } });
    expect(after.name).toBe(kid.user.name);
  });

  test('other profile fields still save', async () => {
    const kid = await minor();

    const res = await putMe(kid.headers, { name: 'Asha Patil', village: 'Wagholi', language: 'mr' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Asha Patil', village: 'Wagholi', language: 'mr' });
  });

  test('blank bank fields (sent for unfilled inputs) are dropped, not refused', async () => {
    const kid = await minor();

    const res = await putMe(kid.headers, { village: 'Lonikand', bankHolderName: '', bankName: '', bankIfsc: '' });

    expect(res.status).toBe(200);
    expect(res.body.data.village).toBe('Lonikand');
    expect(await profileOf(kid.user.id)).toBeNull();
  });

  test('declaring an adult dob in the same request does not unlock it', async () => {
    const kid = await minor();

    const res = await putMe(kid.headers, { dateOfBirth: '1990-01-01', panNumber: 'ABCDE1234F' });

    expect(res.status).toBe(403);
    expect(await profileOf(kid.user.id)).toBeNull();
  });
});

describe('PUT /me — becoming a minor in this request', () => {
  test('a minor dob sent with an Aadhaar is refused', async () => {
    const user = await createTestUser();

    const res = await putMe(user.headers, { dateOfBirth: MINOR_DOB, aadharNumber: '234567890124' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(MINOR_MESSAGE);
    expect(await profileOf(user.user.id)).toBeNull();
    const after = await prisma.user.findUnique({ where: { id: user.user.id }, select: { isMinor: true } });
    expect(after.isMinor).toBe(false);
  });
});

describe('PUT /me — adults are unaffected', () => {
  test('an adult can still store their PAN', async () => {
    const user = await createTestUser({ dateOfBirth: new Date('1990-01-01') });

    const res = await putMe(user.headers, { panNumber: 'ABCDE1234F' });

    expect(res.status).toBe(200);
    expect((await profileOf(user.user.id)).panNumber).toBeTruthy();
  });
});
