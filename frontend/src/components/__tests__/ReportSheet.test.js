/**
 * @jest-environment jsdom
 */
/**
 * ReportSheet, rendered for real and tapped (react-native-web in jsdom — the
 * same setup as ReviewSheet.test.js).
 *
 * Pins what Google Play's AI-content and user-content policies need from it,
 * and what the server contract (POST /reports) expects:
 *   - "Send report" is off until a reason is picked, and nothing is sent before
 *   - the body is exactly { targetType, targetId?, reason, details?, snapshot? }
 *   - a double tap on "Send report" is one report
 *   - success closes the sheet and thanks the farmer with a pop-up
 *   - a failure stays inside the sheet with the choice kept; 429 says so in words
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ReportSheet, { reportPayload, REPORT_MAX_SNAPSHOT } from '../ReportSheet';
import api from '@krushisarva/shared/services/api';
import { showPopup } from '../../utils/popup';

jest.mock('react-native', () => jest.requireActual('react-native-web/dist/cjs/index.js'));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@krushisarva/shared/context/LanguageContext', () => ({
  useLanguage: () => ({
    t: (key, fallbackOrVars) => {
      if (typeof fallbackOrVars === 'string') return fallbackOrVars;
      const text = fallbackOrVars?.defaultValue ?? key;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(fallbackOrVars?.[name] ?? ''));
    },
  }),
}));
jest.mock('@krushisarva/shared/services/api', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));
jest.mock('../../utils/popup', () => ({ showPopup: jest.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const AI_TARGET = {
  targetType: 'AI_MESSAGE',
  snapshot: 'Spray 5 litres of monocrotophos per acre.',
};
const USER_TARGET = { targetType: 'USER', targetId: 'user-42' };

let container;
let root;

beforeEach(() => {
  api.post.mockReset();
  showPopup.mockReset();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => { act(() => root.unmount()); });

// ── helpers ──────────────────────────────────────────────────────────────────
const byId = (id) => document.querySelector(`[data-testid="${id}"]`);
const reason = (key) => byId(`report-reason-${key}`);
const sendBtn = () => byId('report-send');
const detailsBox = () => byId('report-details');
const text = () => document.body.textContent;
const click = (el) => act(() => { el.click(); });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const type = (value) => act(() => {
  const el = detailsBox();
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
});

function open(target = AI_TARGET, handlers = {}) {
  const onClose = handlers.onClose || jest.fn();
  const onReported = handlers.onReported || jest.fn();
  act(() => { root.render(<ReportSheet target={target} onClose={onClose} onReported={onReported} />); });
  return { onClose, onReported };
}

/** An axios-shaped failure with an HTTP status. */
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), {
  response: { status, data: { error: { message: 'server text' } }, headers: {} },
});

// ── the body ─────────────────────────────────────────────────────────────────
describe('reportPayload', () => {
  test('an AI answer with no id carries its text as the snapshot', () => {
    expect(reportPayload(AI_TARGET, 'harmful_or_dangerous', '')).toEqual({
      targetType: 'AI_MESSAGE',
      reason: 'harmful_or_dangerous',
      snapshot: 'Spray 5 litres of monocrotophos per acre.',
    });
  });

  test('an id is sent as a string; details and snapshot are trimmed and capped', () => {
    const long = 'x'.repeat(REPORT_MAX_SNAPSHOT + 50);
    const body = reportPayload({ targetType: 'PRODUCT_REVIEW', targetId: 123, snapshot: `  ${long}  ` }, 'spam_or_fraud', '  fake  ');
    expect(body.targetId).toBe('123');
    expect(body.details).toBe('fake');
    expect(body.snapshot).toHaveLength(REPORT_MAX_SNAPSHOT);
  });

  test('nothing the server could act on is not sent', () => {
    expect(reportPayload(AI_TARGET, 'not_a_reason', '')).toBeNull();
    expect(reportPayload({ targetType: 'AI_MESSAGE', snapshot: '   ' }, 'other', '')).toBeNull();
    expect(reportPayload(null, 'other', '')).toBeNull();
  });
});

// ── the sheet ────────────────────────────────────────────────────────────────
test('closed: nothing is drawn', () => {
  act(() => { root.render(<ReportSheet target={null} onClose={() => {}} />); });
  expect(text()).not.toContain('Send report');
});

test('open on an AI answer: says it was written by AI and lists the reasons', () => {
  open();
  expect(text()).toContain('Report this answer');
  expect(text()).toContain('written by AI');
  expect(text()).toContain('Harmful or dangerous');
  expect(text()).toContain('Wrong or misleading information');
  expect(text()).toContain('Harassment or bullying');
});

test('nothing can be sent until a reason is picked', async () => {
  open();
  expect(sendBtn().getAttribute('aria-disabled')).toBe('true');
  click(sendBtn());
  await flush();
  expect(api.post).not.toHaveBeenCalled();
});

test('sends exactly the contract body, then closes and says thank you', async () => {
  api.post.mockResolvedValue({ status: 201, data: { success: true, data: { id: 'rep-1' } } });
  const { onClose, onReported } = open();

  click(reason('wrong_information'));
  expect(reason('wrong_information').getAttribute('aria-checked')).toBe('true');
  type('  Banned pesticide  ');
  click(sendBtn());
  await flush();

  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/reports', {
    targetType: 'AI_MESSAGE',
    reason: 'wrong_information',
    details: 'Banned pesticide',
    snapshot: 'Spray 5 litres of monocrotophos per acre.',
  });
  expect(onReported).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(showPopup).toHaveBeenCalledWith('Thank you', expect.stringContaining('Our team will review it'));
});

test('a user report sends the id and no snapshot when none was given', async () => {
  api.post.mockResolvedValue({ status: 201, data: { success: true } });
  open(USER_TARGET);
  expect(text()).toContain('Report user');

  click(reason('harassment'));
  click(sendBtn());
  await flush();

  expect(api.post).toHaveBeenCalledWith('/reports', {
    targetType: 'USER', targetId: 'user-42', reason: 'harassment',
  });
});

test('a double tap on Send is one report', async () => {
  let finish;
  api.post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { onClose } = open();

  click(reason('offensive'));
  click(sendBtn());
  click(sendBtn());
  expect(api.post).toHaveBeenCalledTimes(1);

  // …and it cannot be closed while sending.
  click(byId('report-close'));
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => { finish({ status: 201, data: {} }); });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('rate limited (429): says so inside the sheet and keeps the choice', async () => {
  api.post.mockRejectedValue(httpError(429));
  const { onClose } = open();

  click(reason('spam_or_fraud'));
  type('Again and again');
  click(sendBtn());
  await flush();

  expect(onClose).not.toHaveBeenCalled();
  expect(showPopup).not.toHaveBeenCalled();
  expect(text()).toContain('You have sent many reports in a short time');
  expect(reason('spam_or_fraud').getAttribute('aria-checked')).toBe('true');
  expect(detailsBox().value).toBe('Again and again');
  expect(sendBtn().getAttribute('aria-disabled')).not.toBe('true');
});

test('gone (404) or not reportable (400): says so, not "check your connection"', async () => {
  api.post.mockRejectedValueOnce(httpError(404));
  const { onClose } = open(USER_TARGET);

  click(reason('harassment'));
  click(sendBtn());
  await flush();
  expect(onClose).not.toHaveBeenCalled();
  expect(text()).toContain('This is no longer available');
  expect(text()).not.toContain('Check your connection');

  api.post.mockRejectedValueOnce(httpError(400));
  click(sendBtn());
  await flush();
  expect(text()).toContain('This cannot be reported.');
  expect(text()).not.toContain('Check your connection');
});

test('any other failure: a useful message, and it can be tried again', async () => {
  api.post.mockRejectedValueOnce(new Error('Network Error'));
  open();

  click(reason('other'));
  click(sendBtn());
  await flush();
  expect(text()).toContain('Could not send your report. Check your connection and try again.');

  api.post.mockResolvedValueOnce({ status: 201, data: {} });
  click(sendBtn());
  await flush();
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(showPopup).toHaveBeenCalledTimes(1);
});

test('opening it for something else starts a fresh form', () => {
  open();
  click(reason('offensive'));
  type('rude');

  open(USER_TARGET);
  expect(reason('offensive').getAttribute('aria-checked')).toBe('false');
  expect(detailsBox().value).toBe('');
  expect(sendBtn().getAttribute('aria-disabled')).toBe('true');
});
