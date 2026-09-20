/**
 * A DEACTIVATED account must not be promotable to ADMIN.
 *
 * Deactivation (PATCH /admin/users/:id { isActive: false }) is how an account is
 * pulled — the auth middleware rejects every request it makes, and the seller
 * paths already refuse to treat it as a live account (services/buyBox
 * activeSellerWhere). POST /admin/team/invite looked the user up by phone and
 * promoted whatever it found, without ever reading `isActive`. So a banned
 * account could be handed the ADMIN role and full scopes; it appeared in GET
 * /team as a colleague, and the moment anyone flipped isActive back it was an
 * administrator — the deactivation no longer held.
 *
 * The three other /team queries DELIBERATELY still see deactivated accounts, and
 * the tests below pin that too: an admin console that hides records from admins
 * is worse than one that shows a disabled row.
 *   - GET /team            must LIST a deactivated admin (it ships isActive so
 *                          the SPA can mark it), otherwise the only admin who
 *                          still holds scopes is the one nobody can see.
 *   - PATCH /:id/scopes    must still narrow a deactivated admin's scopes —
 *                          refusing it would mean the only way to reduce them is
 *                          to reactivate the account first.
 *   - POST  /:id/revoke    must still work, for exactly the same reason: the
 *                          deactivated admin is the one you most want to demote.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { getApp, createTestUser, cleanupTestData, prisma } from '../../fixtures/setup.js';

const TEAM = '/api/v1/admin/team';

let app; let superAdmin;

beforeAll(async () => {
  app = await getApp();
  // adminScopes = [] is SUPER_ADMIN (loadAdminContext), which /team requires.
  superAdmin = await createTestUser({ role: 'ADMIN', name: 'Team Super Admin' });
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

const roleOf = (id) =>
  prisma.user.findUnique({ where: { id }, select: { role: true, adminScopes: true, tokenVersion: true } });

// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /admin/team/invite — a deactivated account cannot be made an admin', () => {
  test('refuses the promotion, leaves the role and scopes untouched', async () => {
    const banned = await createTestUser({ name: 'Banned Farmer', isActive: false });
    const before = await roleOf(banned.user.id);

    const res = await request(app)
      .post(`${TEAM}/invite`)
      .set(superAdmin.headers)
      .send({ phone: banned.user.phone, scopes: ['SUPPORT'], reason: 'audit test' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/deactivat/i);

    const after = await roleOf(banned.user.id);
    expect(after.role).toBe('FARMER');
    expect(after.adminScopes).toEqual([]);
    // No tokenVersion bump either — nothing about the account changed.
    expect(after.tokenVersion).toBe(before.tokenVersion);
  });

  test('writes no TEAM_INVITE audit row for the refused promotion', async () => {
    const banned = await createTestUser({ name: 'Banned Farmer Audit', isActive: false });

    await request(app)
      .post(`${TEAM}/invite`)
      .set(superAdmin.headers)
      .send({ phone: banned.user.phone, scopes: ['SUPPORT'] })
      .expect(409);

    const audits = await prisma.auditLog.count({
      where: { action: 'ADMIN_TEAM_INVITE', entityId: banned.user.id },
    });
    expect(audits).toBe(0);
  });

  test('an ACTIVE account is still promoted normally', async () => {
    const candidate = await createTestUser({ name: 'Willing Farmer' });

    const res = await request(app)
      .post(`${TEAM}/invite`)
      .set(superAdmin.headers)
      .send({ phone: candidate.user.phone, scopes: ['SUPPORT'] });

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('ADMIN');
    expect(res.body.data.adminScopes).toEqual(['SUPPORT']);
    expect((await roleOf(candidate.user.id)).role).toBe('ADMIN');
  });

  test('an unknown phone is still a 404, not the new 409', async () => {
    const res = await request(app)
      .post(`${TEAM}/invite`)
      .set(superAdmin.headers)
      .send({ phone: '6000000001', scopes: ['SUPPORT'] });

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('The /team queries that must KEEP seeing a deactivated admin', () => {
  let ghost;

  beforeAll(async () => {
    ghost = await createTestUser({
      role: 'ADMIN', name: 'Deactivated Admin', isActive: false, adminScopes: ['SUPPORT'],
    });
  });

  test('GET /team lists them, flagged inactive — an admin console hides nothing', async () => {
    const res = await request(app).get(`${TEAM}?limit=50`).set(superAdmin.headers);
    expect(res.status).toBe(200);
    const row = res.body.data.items.find((u) => u.id === ghost.user.id);
    expect(row).toBeDefined();
    expect(row.isActive).toBe(false);
    expect(row.adminScopes).toEqual(['SUPPORT']);
  });

  test('PATCH /team/:id/scopes can still narrow their scopes', async () => {
    const res = await request(app)
      .patch(`${TEAM}/${ghost.user.id}/scopes`)
      .set(superAdmin.headers)
      .send({ scopes: [] });

    expect(res.status).toBe(200);
    expect((await roleOf(ghost.user.id)).adminScopes).toEqual([]);
  });

  test('POST /team/:id/revoke can still demote them', async () => {
    const res = await request(app)
      .post(`${TEAM}/${ghost.user.id}/revoke`)
      .set(superAdmin.headers)
      .send({ reason: 'account was pulled' });

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('FARMER');
    expect((await roleOf(ghost.user.id)).role).toBe('FARMER');
  });
});
