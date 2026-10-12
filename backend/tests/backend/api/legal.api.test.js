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
    for (const path of ['/legal', '/legal/terms', '/legal/refunds', '/legal/cookies']) {
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
});

describe('GET /api/v1/legal', () => {
  test('lists the documents, the policy version and only the facts that are set', async () => {
    Object.assign(ENV.LEGAL, { ...FACTS, gstin: '', docsApproved: true });
    const res = await request(app).get('/api/v1/legal');

    expect(res.status).toBe(200);
    const { version, documents, entity } = res.body.data;
    expect(version).toBe(CONSENT_POLICY_VERSION);
    expect(documents.map((d) => d.slug)).toEqual(['privacy', 'terms', 'refunds', 'cookies']);
    expect(documents.find((d) => d.slug === 'cookies')).toMatchObject({ path: '/legal/cookies', published: true });
    expect(documents.find((d) => d.slug === 'refunds').published).toBe(false);
    expect(entity.entityName).toBe('Example Agri Private Limited');
    expect(entity).not.toHaveProperty('gstin');
  });
});
