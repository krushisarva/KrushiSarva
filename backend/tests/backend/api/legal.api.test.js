/**
 * Public legal pages (/legal, /legal/:slug) and GET /api/v1/legal.
 *
 * The rule under test is the publishing gate: a document reaches the public only
 * when it is approved AND nothing in it is still marked as needing the owner.
 * Everything else must fail closed in production, because the alternative is
 * unreviewed legal text served as the platform's policy.
 */
import request from 'supertest';
import app from '../../../src/app.js';
import { ENV } from '../../../src/config/env.js';
import { CONSENT_POLICY_VERSION } from '../../../src/constants/consent.js';

const FACTS = {
  entityName: 'Example Agri Private Limited',
  registeredAddress: '1 Market Road, Pune 411001',
  supportEmail: 'care@example.test',
  grievanceName: 'A. Officer',
  grievanceEmail: 'grievance@example.test',
  effectiveDate: '1 November 2026',
};

let saved;
beforeEach(() => {
  saved = { isDev: ENV.IS_DEV, legal: { ...ENV.LEGAL } };
});
afterEach(() => {
  ENV.IS_DEV = saved.isDev;
  Object.assign(ENV.LEGAL, saved.legal);
});

const asProduction = (legal = {}) => {
  ENV.IS_DEV = false;
  Object.assign(ENV.LEGAL, legal);
};

describe('legal pages — outside production', () => {
  test('a draft is readable, flagged as a draft, and shows what is still missing', async () => {
    const res = await request(app).get('/legal/privacy');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Draft — not yet approved');
    expect(res.text).toContain('owner-todo');
    expect(res.text).toContain('Privacy Policy');
  });

  test('every registered document and the index render', async () => {
    for (const path of ['/legal', '/legal/terms', '/legal/refunds', '/legal/cookies', '/legal/delete-account']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
    }
  });

  test('editor notes in HTML comments are never sent', async () => {
    const res = await request(app).get('/legal/privacy');
    expect(res.text).not.toContain('DRAFT for legal review');
  });

  test('404 for a document that does not exist', async () => {
    const res = await request(app).get('/legal/not-a-document');
    expect(res.status).toBe(404);
  });

  test('configured facts are HTML-escaped', async () => {
    Object.assign(ENV.LEGAL, { supportEmail: '<script>alert(1)</script>' });
    const res = await request(app).get('/legal/cookies');

    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('legal pages — production publishing gate', () => {
  test('503 and no draft text while the documents are not approved', async () => {
    asProduction({ ...FACTS, docsApproved: false });
    const res = await request(app).get('/legal/cookies');

    expect(res.status).toBe(503);
    expect(res.text).toContain('being finalised');
    expect(res.text).not.toContain('strictly necessary');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('approval alone does not publish a document that still has open owner decisions', async () => {
    asProduction({ ...FACTS, docsApproved: true });
    const res = await request(app).get('/legal/refunds');

    expect(res.status).toBe(503);
    expect(res.text).not.toContain('class="owner-todo"');
    expect(res.text).not.toContain('Owner decision needed');
  });

  test('approval does not publish a document whose business facts are missing', async () => {
    asProduction({ ...FACTS, supportEmail: '', docsApproved: true });
    const res = await request(app).get('/legal/cookies');

    expect(res.status).toBe(503);
  });

  test('an approved document with every fact supplied is published without the draft banner', async () => {
    asProduction({ ...FACTS, docsApproved: true });
    const res = await request(app).get('/legal/cookies');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Draft — not yet approved');
    expect(res.text).not.toContain('class="owner-todo"');
    expect(res.text).toContain('care@example.test');
    expect(res.text).toContain('1 November 2026');
  });

  // Google Play needs the privacy policy live: once approved with every fact
  // set, it must have no open owner decision left to hold it back.
  test('the privacy policy publishes once approved with every fact supplied', async () => {
    asProduction({ ...FACTS, docsApproved: true });
    const res = await request(app).get('/legal/privacy');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('class="owner-todo"');
    expect(res.text).not.toContain('Draft — not yet approved');
    expect(res.text).toContain('Example Agri Private Limited');
    expect(res.text).toContain('grievance@example.test');
    expect(res.text).toContain('24 hours');
    expect(res.text).toContain('Groq');
  });
});

// Google Play requires a public "delete your account" URL that works before
// the policies are signed off. That page alone skips LEGAL_DOCS_APPROVED; the
// rest of the gate — and the gate on every other document — must not move.
describe('legal pages — the delete-account page', () => {
  test('is published in production without approval, while the policies stay held back', async () => {
    asProduction({ ...FACTS, docsApproved: false });

    const del = await request(app).get('/legal/delete-account');
    expect(del.status).toBe(200);
    expect(del.headers['cache-control']).toBe('public, max-age=300');
    expect(del.text).not.toContain('Draft — not yet approved');
    expect(del.text).not.toContain('class="owner-todo"');
    expect(del.text).toContain('Delete your KrushiSarva account');
    expect(del.text).toContain('KrushiSarva Seller');
    // A configured support address wins over the page's fallback.
    expect(del.text).toContain('href="mailto:care@example.test"');
    expect(del.text).not.toContain('krushisarva@gmail.com');

    for (const slug of ['privacy', 'terms', 'refunds', 'cookies']) {
      const res = await request(app).get(`/legal/${slug}`);
      expect(res.status).toBe(503);
    }
    expect((await request(app).get('/legal')).status).toBe(503);
  });

  test('is live in production with no LEGAL_* fact set, showing the fallback email', async () => {
    const unset = Object.fromEntries(Object.keys(ENV.LEGAL).map((k) => [k, '']));
    asProduction({ ...unset, docsApproved: false });
    const res = await request(app).get('/legal/delete-account');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Option 2');
    expect(res.text).toContain('href="mailto:krushisarva@gmail.com"');
    expect(res.text).not.toContain('class="owner-todo"');
    expect((await request(app).get('/legal/privacy')).status).toBe(503);
  });

  test('its fallback email is not lent to any other document', async () => {
    asProduction({ ...FACTS, supportEmail: '', docsApproved: true });
    const res = await request(app).get('/legal/cookies');

    expect(res.status).toBe(503);
    expect(res.text).not.toContain('krushisarva@gmail.com');
  });

  test('the privacy policy links to it', async () => {
    const res = await request(app).get('/legal/privacy');
    expect(res.text).toContain('href="/legal/delete-account"');
  });

  test('the JSON lists it as published without approval', async () => {
    Object.assign(ENV.LEGAL, { ...FACTS, docsApproved: false });
    const res = await request(app).get('/api/v1/legal');

    const { documents } = res.body.data;
    expect(documents.find((d) => d.slug === 'delete-account'))
      .toMatchObject({ path: '/legal/delete-account', published: true });
    expect(documents.find((d) => d.slug === 'privacy').published).toBe(false);
  });
});

describe('GET /api/v1/legal', () => {
  test('lists the documents, the policy version and only the facts that are set', async () => {
    Object.assign(ENV.LEGAL, { ...FACTS, gstin: '', docsApproved: true });
    const res = await request(app).get('/api/v1/legal');

    expect(res.status).toBe(200);
    const { version, documents, entity } = res.body.data;
    expect(version).toBe(CONSENT_POLICY_VERSION);
    expect(documents.map((d) => d.slug)).toEqual(['privacy', 'terms', 'refunds', 'cookies', 'delete-account']);
    expect(documents.find((d) => d.slug === 'cookies')).toMatchObject({ path: '/legal/cookies', published: true });
    expect(documents.find((d) => d.slug === 'refunds').published).toBe(false);
    expect(entity.entityName).toBe('Example Agri Private Limited');
    expect(entity).not.toHaveProperty('gstin');
  });
});
