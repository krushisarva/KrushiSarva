/**
 * @jest-environment jsdom
 */
/**
 * ReviewSheet, rendered for real and tapped (react-native-web in jsdom — the
 * same setup as PopupHost.test.js).
 *
 * reviewUtils.test.js pins the rules. This pins the sheet a farmer touches:
 *   - "Post" is off until a star is tapped, and nothing is sent before that
 *   - what is sent is the stars tapped, the comment typed and the order line
 *   - a double tap on "Post" is one review
 *   - a failure shows inside the sheet and keeps what was typed
 *   - a line already rated opens on that rating, and saves as an edit
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ReviewSheet from '../ReviewSheet';
import { submitReview } from '../../screens/AgriStore/shopClient';

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
jest.mock('../../screens/AgriStore/shopClient', () => ({ submitReview: jest.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = {
  orderId: 'order-1', orderItemId: 'item-1', productId: 'prod-1',
  name: 'Khurpi Hand Weeder', review: null,
};

let container;
let root;

beforeEach(() => {
  submitReview.mockReset();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => { act(() => root.unmount()); });

// ── helpers ──────────────────────────────────────────────────────────────────
const byId = (id) => document.querySelector(`[data-testid="${id}"]`);
const star = (n) => byId(`review-star-${n}`);
const saveBtn = () => byId('review-save');
const commentBox = () => byId('review-comment');
const text = () => document.body.textContent;
const click = (el) => act(() => { el.click(); });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/** Type into the comment box the way a browser does, so React sees the change. */
const type = (value) => act(() => {
  const el = commentBox();
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
});

function open(target = TARGET, handlers = {}) {
  const onClose = handlers.onClose || jest.fn();
  const onSaved = handlers.onSaved || jest.fn();
  act(() => { root.render(<ReviewSheet target={target} onClose={onClose} onSaved={onSaved} />); });
  return { onClose, onSaved };
}

// ── tests ────────────────────────────────────────────────────────────────────
test('closed: nothing is drawn', () => {
  act(() => { root.render(<ReviewSheet target={null} onClose={() => {}} onSaved={() => {}} />); });
  expect(text()).not.toContain('Rate this product');
});

test('open: names the product and asks for a star', () => {
  open();
  expect(text()).toContain('Rate this product');
  expect(text()).toContain('Khurpi Hand Weeder');
  expect(text()).toContain('Tap a star to rate');
  expect(text()).toContain('Post review');
});

test('nothing can be posted until a star is tapped', async () => {
  open();
  expect(saveBtn().getAttribute('aria-disabled')).toBe('true');

  click(saveBtn());
  await flush();

  expect(submitReview).not.toHaveBeenCalled();
});

test('tapping a star says what it means, in words', () => {
  open();
  click(star(4));
  expect(text()).toContain('Good');
  expect(star(4).getAttribute('aria-checked')).toBe('true');
  expect(star(5).getAttribute('aria-checked')).toBe('false');

  click(star(2));
  expect(text()).toContain('Bad');
  expect(star(2).getAttribute('aria-checked')).toBe('true');
});

test('stars and no comment: posts exactly that, against the order line', async () => {
  submitReview.mockResolvedValue({ id: 'rev-1', rating: 5, comment: null, orderItemId: 'item-1' });
  const { onSaved } = open();

  click(star(5));
  click(saveBtn());
  await flush();

  expect(submitReview).toHaveBeenCalledTimes(1);
  expect(submitReview).toHaveBeenCalledWith('prod-1', { rating: 5, orderItemId: 'item-1' });
  expect(onSaved).toHaveBeenCalledWith(TARGET, { rating: 5, comment: null });
});

test('the comment typed is sent trimmed, and the server\'s copy is what comes back', async () => {
  submitReview.mockResolvedValue({ id: 'rev-1', rating: 4, comment: 'Strong blade', orderItemId: 'item-1' });
  const { onSaved } = open();

  click(star(4));
  type('  Strong <b>blade</b>  ');
  expect(text()).toContain('23/500');
  click(saveBtn());
  await flush();

  expect(submitReview).toHaveBeenCalledWith('prod-1', {
    rating: 4, comment: 'Strong <b>blade</b>', orderItemId: 'item-1',
  });
  // The server strips markup; the row in My Orders shows what was stored.
  expect(onSaved).toHaveBeenCalledWith(TARGET, { rating: 4, comment: 'Strong blade' });
});

test('a double tap on Post is one review', async () => {
  let finish;
  submitReview.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { onSaved } = open();

  click(star(3));
  click(saveBtn());
  click(saveBtn());
  expect(submitReview).toHaveBeenCalledTimes(1);

  await act(async () => { finish({ id: 'rev-1', rating: 3, comment: null }); });
  expect(onSaved).toHaveBeenCalledTimes(1);
});

test('it cannot be closed while the review is being saved', async () => {
  let finish;
  submitReview.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { onClose } = open();

  click(star(3));
  click(saveBtn());
  click(document.querySelector('[aria-label="Close"]'));
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => { finish({ id: 'rev-1', rating: 3, comment: null }); });
});

test('a failure is shown inside the sheet, and what was typed is still there', async () => {
  submitReview.mockRejectedValue({ userMessage: 'You can only review a product you have received.' });
  const { onSaved } = open();

  click(star(1));
  type('Bent on day one');
  click(saveBtn());
  await flush();

  expect(onSaved).not.toHaveBeenCalled();
  expect(text()).toContain('You can only review a product you have received.');
  expect(commentBox().value).toBe('Bent on day one');
  expect(star(1).getAttribute('aria-checked')).toBe('true');
  // …and it can be tried again.
  expect(saveBtn().getAttribute('aria-disabled')).not.toBe('true');
});

test('a failure with no message from the server still says something useful', async () => {
  submitReview.mockRejectedValue(new Error('Network Error'));
  open();
  click(star(5));
  click(saveBtn());
  await flush();
  expect(text()).toContain('Could not save your review. Check your connection and try again.');
});

test('a line already rated opens on that rating and comment, and saves as an edit', async () => {
  submitReview.mockResolvedValue({ id: 'rev-1', rating: 5, comment: 'Much better than I thought', orderItemId: 'item-1' });
  const target = { ...TARGET, review: { rating: 2, comment: 'Handle came loose' } };
  const { onSaved } = open(target);

  expect(text()).toContain('Change your rating');
  expect(text()).toContain('Save changes');
  expect(star(2).getAttribute('aria-checked')).toBe('true');
  expect(commentBox().value).toBe('Handle came loose');

  click(star(5));
  type('Much better than I thought');
  click(saveBtn());
  await flush();

  expect(submitReview).toHaveBeenCalledWith('prod-1', {
    rating: 5, comment: 'Much better than I thought', orderItemId: 'item-1',
  });
  expect(onSaved).toHaveBeenCalledWith(target, { rating: 5, comment: 'Much better than I thought' });
});

test('opening it for a different line starts a fresh form', () => {
  open({ ...TARGET, review: { rating: 2, comment: 'Handle came loose' } });
  expect(commentBox().value).toBe('Handle came loose');

  open({ ...TARGET, orderItemId: 'item-2', name: 'Urea 45 kg', review: null });
  expect(text()).toContain('Urea 45 kg');
  expect(commentBox().value).toBe('');
  expect(saveBtn().getAttribute('aria-disabled')).toBe('true');
});
