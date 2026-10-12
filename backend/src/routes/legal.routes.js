/**
 * Public legal pages.
 *
 *   GET /legal            index: every document + who operates the platform
 *   GET /legal/:slug      one document (privacy | terms | refunds | cookies)
 *   GET /api/v1/legal     the same facts as JSON, for the apps
 *
 * WHY THE API SERVES THESE: both apps and the admin panel need one public URL
 * for "Terms" and "Privacy Policy". They used to link to a website domain that
 * was never registered, so every legal link opened nothing while the consent
 * ledger recorded users as having accepted those documents. Serving them from
 * the API means the links work wherever the API does.
 *
 * DRAFT SAFETY: the documents in backend/legal/ ship as drafts with marked
 * gaps (`owner-todo`) wherever a fact or a decision must come from the owner.
 * A document is published only when ALL of these hold:
 *   - LEGAL_DOCS_APPROVED=true,
 *   - no unresolved `owner-todo` marker is left in its rendered output
 *     (a missing business fact renders as one, so it counts).
 * Otherwise production serves a short "being finalised" notice — never
 * unreviewed legal text — and development serves the draft with a banner so it
 * can be read and finished.
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENV } from '../config/env.js';
import {
  LEGAL_DOCS, LEGAL_DOCS_VERSION, LEGAL_INDEX_PATH, legalDocPath,
} from '../constants/legal.js';
import { sendSuccess } from '../utils/response.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGAL_DIR = path.resolve(__dirname, '../../legal');
const TODO_MARK = 'owner-todo';

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A fact the owner has not supplied yet — visible in drafts, blocks publishing. */
const todo = (what) => `<span class="${TODO_MARK}">[${esc(what)}]</span>`;

/** Placeholder name → [value, description shown when the value is missing]. */
function facts() {
  const L = ENV.LEGAL;
  return {
    entityName:           [L.entityName,           'registered legal name of the company'],
    registeredAddress:    [L.registeredAddress,    'registered office address'],
    cin:                  [L.cin,                  'CIN / LLPIN'],
    gstin:                [L.gstin,                'GSTIN'],
    supportEmail:         [L.supportEmail,         'customer-care email'],
    supportPhone:         [L.supportPhone,         'customer-care phone number'],
    supportHours:         [L.supportHours,         'customer-care hours'],
    grievanceName:        [L.grievanceName,        'name of the Grievance Officer'],
    grievanceDesignation: [L.grievanceDesignation, 'designation of the Grievance Officer'],
    grievanceEmail:       [L.grievanceEmail,       'Grievance Officer email'],
    grievancePhone:       [L.grievancePhone,       'Grievance Officer phone number'],
    effectiveDate:        [L.effectiveDate,        'effective date'],
    version:              [LEGAL_DOCS_VERSION,     'policy version'],
  };
}

/** Fill {{placeholders}} in a fragment. Unknown names are left for the reviewer to see. */
function fill(fragment) {
  const f = facts();
  return fragment.replace(/\{\{(\w+)\}\}/g, (whole, name) => {
    if (!(name in f)) return whole;
    const [value, missing] = f[name];
    return value ? esc(value) : todo(missing);
  });
}

// Fragments are read once in production; re-read per request elsewhere so an
// edit to a draft shows up without restarting the server.
const cache = new Map();
function readFragment(file) {
  if (!ENV.IS_DEV && cache.has(file)) return cache.get(file);
  let html = null;
  try {
    // Editor notes in HTML comments are for whoever maintains the document:
    // never sent to the public, and never counted as an unresolved marker.
    html = fs.readFileSync(path.join(LEGAL_DIR, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  } catch (err) {
    logger.error({ err, file }, '[Legal] document file is missing');
  }
  cache.set(file, html);
  return html;
}

/** Rendered body of one document plus whether it may be shown to the public. */
function renderDoc(doc) {
  const fragment = readFragment(doc.file);
  if (fragment == null) return { body: null, publishable: false };
  const body = fill(fragment);
  return { body, publishable: ENV.LEGAL.docsApproved && !body.includes(TODO_MARK) };
}

function entityBlock() {
  const f = facts();
  const row = (label, name) => `<dt>${esc(label)}</dt><dd>${f[name][0] ? esc(f[name][0]) : todo(f[name][1])}</dd>`;
  const optional = (label, name) => (f[name][0] ? `<dt>${esc(label)}</dt><dd>${esc(f[name][0])}</dd>` : '');
  return `
    <section aria-labelledby="who">
      <h2 id="who">Who operates KrushiSarva</h2>
      <dl>
        ${row('Legal entity', 'entityName')}
        ${row('Registered office', 'registeredAddress')}
        ${optional('CIN / LLPIN', 'cin')}
        ${optional('GSTIN', 'gstin')}
        ${row('Customer care', 'supportEmail')}
        ${optional('Phone', 'supportPhone')}
        ${optional('Hours', 'supportHours')}
      </dl>
      <h2 id="grievance">Grievance Officer</h2>
      <dl>
        ${row('Name', 'grievanceName')}
        ${optional('Designation', 'grievanceDesignation')}
        ${row('Email', 'grievanceEmail')}
        ${optional('Phone', 'grievancePhone')}
      </dl>
    </section>`;
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #faf4ec; color: #1f1a14; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
  h1 { font-size: 1.7rem; line-height: 1.25; margin: 0.5rem 0 0.25rem; }
  h2 { font-size: 1.2rem; margin: 2rem 0 0.5rem; }
  h3 { font-size: 1.02rem; margin: 1.4rem 0 0.4rem; }
  p, li, dd { max-width: 68ch; }
  a { color: #8a2c00; }
  a:focus-visible { outline: 3px solid #8a2c00; outline-offset: 2px; }
  nav ul { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; }
  .meta { color: #5c5145; font-size: 0.92rem; }
  table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
  th, td { border: 1px solid #d9cbb8; padding: 0.5rem 0.6rem; text-align: left; vertical-align: top; font-size: 0.95rem; }
  th { background: #f2e9de; }
  dl { display: grid; grid-template-columns: minmax(8rem, 14rem) 1fr; gap: 0.35rem 1rem; margin: 0.5rem 0 1rem; }
  dt { color: #5c5145; } dd { margin: 0; }
  .banner { background: #fff3cd; border: 1px solid #8a6d00; color: #3d3000; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 1rem; }
  .${TODO_MARK} { background: #ffe08a; color: #3d3000; padding: 0 0.2em; border-radius: 0.2em; }
  p.${TODO_MARK}, li.${TODO_MARK} { padding: 0.5rem 0.75rem; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #d9cbb8; }
  @media (max-width: 30rem) { dl { grid-template-columns: 1fr; } dt { margin-top: 0.5rem; } }
`;

function page({ title, body, draft }) {
  const links = LEGAL_DOCS
    .map((d) => `<li><a href="${legalDocPath(d.slug)}">${esc(d.title)}</a></li>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — KrushiSarva</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <nav aria-label="Legal documents"><ul><li><a href="${LEGAL_INDEX_PATH}">Legal &amp; contact</a></li>${links}</ul></nav>
  ${draft ? `<p class="banner" role="note"><strong>Draft — not yet approved.</strong> Highlighted text marks a fact or decision still needed from the owner. This page is not shown to the public until it is approved.</p>` : ''}
  ${body}
  <footer>
    <p class="meta">Policy version ${esc(LEGAL_DOCS_VERSION)}</p>
  </footer>
</main>
</body>
</html>`;
}

/** Shown in production in place of any document that is not publishable yet. */
function pendingPage(title) {
  return page({
    title,
    draft: false,
    body: `<h1>${esc(title)}</h1><p>This document is being finalised and will be published here shortly.</p>`,
  });
}

function send(res, status, html) {
  res.status(status);
  res.set('Content-Type', 'text/html; charset=utf-8');
  // Short cache: the text changes rarely, but an approval must show up quickly.
  res.set('Cache-Control', status === 200 ? 'public, max-age=300' : 'no-store');
  return res.send(html);
}

// ── HTML pages ────────────────────────────────────────────────────────────────
export const legalPagesRouter = Router();

legalPagesRouter.get('/', (_req, res) => {
  const title = 'Legal & contact';
  const body = `<h1>${title}</h1>${entityBlock()}
    <h2>Documents</h2>
    <ul>${LEGAL_DOCS.map((d) => `<li><a href="${legalDocPath(d.slug)}">${esc(d.title)}</a></li>`).join('')}</ul>`;
  const publishable = ENV.LEGAL.docsApproved && !body.includes(TODO_MARK);
  if (publishable) return send(res, 200, page({ title, body, draft: false }));
  if (ENV.IS_DEV) return send(res, 200, page({ title, body, draft: true }));
  return send(res, 503, pendingPage(title));
});

legalPagesRouter.get('/:slug', (req, res) => {
  const doc = LEGAL_DOCS.find((d) => d.slug === req.params.slug);
  if (!doc) return send(res, 404, pendingPage('Page not found'));
  const { body, publishable } = renderDoc(doc);
  if (body == null) return send(res, 503, pendingPage(doc.title));
  if (publishable) return send(res, 200, page({ title: doc.title, body, draft: false }));
  if (ENV.IS_DEV) return send(res, 200, page({ title: doc.title, body, draft: true }));
  return send(res, 503, pendingPage(doc.title));
});

// ── JSON for the apps ─────────────────────────────────────────────────────────
export const legalApiRouter = Router();

legalApiRouter.get('/', (_req, res) => {
  const f = facts();
  const entity = {};
  for (const [name, [value]] of Object.entries(f)) {
    if (name !== 'version' && name !== 'effectiveDate' && value) entity[name] = value;
  }
  return sendSuccess(res, {
    version: LEGAL_DOCS_VERSION,
    effectiveDate: ENV.LEGAL.effectiveDate || null,
    documents: LEGAL_DOCS.map((d) => ({
      slug: d.slug,
      title: d.title,
      path: legalDocPath(d.slug),
      published: renderDoc(d).publishable,
    })),
    entity,
  });
});

/** Boot-time note for operators: what still blocks publishing, if anything. */
export function logLegalStatus() {
  const pending = LEGAL_DOCS.filter((d) => !renderDoc(d).publishable).map((d) => d.slug);
  if (!pending.length) {
    logger.info('[Legal] all documents published at %s', LEGAL_INDEX_PATH);
    return;
  }
  const why = ENV.LEGAL.docsApproved
    ? 'unresolved owner-todo markers or missing LEGAL_* facts'
    : 'LEGAL_DOCS_APPROVED is not set';
  logger.warn('[Legal] not published (%s): %s', why, pending.join(', '));
}
