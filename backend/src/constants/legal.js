/**
 * Legal documents registry — the public policy pages served at /legal/:slug.
 *
 * The text of each document lives in backend/legal/<file> as an HTML fragment
 * (headings, paragraphs, lists — no <html>/<body>), so it can be edited and
 * reviewed without touching code. routes/legal.routes.js wraps a fragment in the
 * page layout and fills the {{placeholders}} below.
 *
 * `version` is the consent policy version: ConsentRecord rows store the version
 * a user accepted, so the published documents and the consent ledger must name
 * the same one. Bump CONSENT_POLICY_VERSION (constants/consent.js) whenever a
 * document changes materially — that is what re-prompts existing users.
 */
import { CONSENT_POLICY_VERSION } from './consent.js';

export const LEGAL_DOCS_VERSION = CONSENT_POLICY_VERSION;

export const LEGAL_DOCS = Object.freeze([
  { slug: 'privacy', file: 'privacy.html', title: 'Privacy Policy' },
  { slug: 'terms',   file: 'terms.html',   title: 'Terms of Service' },
  { slug: 'refunds', file: 'refunds.html', title: 'Refund, Cancellation & Return Policy' },
  { slug: 'cookies', file: 'cookies.html', title: 'Cookie Policy' },
  // Not a policy: how to delete an account, with or without the app. Google
  // Play requires a working public URL for it before either app can be listed.
  // It only describes what the app already does, so it does not wait for
  // LEGAL_DOCS_APPROVED. Its contact email falls back to the owner's published
  // address (also on website/index.html) while LEGAL_SUPPORT_EMAIL is unset: a
  // missing fact would otherwise take the page down, and Play rejects both
  // apps when this URL does not load. The fallback applies to this page only.
  {
    slug: 'delete-account', file: 'delete-account.html', title: 'Delete your account',
    needsApproval: false,
    fallbacks: { supportEmail: 'krushisarva@gmail.com' },
  },
]);

export const LEGAL_DOC_SLUGS = LEGAL_DOCS.map((d) => d.slug);

/** Path of the index page that lists every document and the business details. */
export const LEGAL_INDEX_PATH = '/legal';

/** Public path of one document. */
export const legalDocPath = (slug) => `${LEGAL_INDEX_PATH}/${slug}`;
