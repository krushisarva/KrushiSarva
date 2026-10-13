/**
 * @jest-environment jsdom
 */
/**
 * PopupHost, rendered for real.
 *
 * utils/__tests__/popup.test.js pins the queue. This pins the part a farmer
 * touches: the REAL component, drawn by the installed react-native-web into a
 * DOM, and clicked. It is the browser build of the app, which is also the only
 * place the layering rule below can be seen without a phone.
 *
 * What a broken host would do with the queue tests still green — and what this
 * file exists to catch:
 *   - the wrong button's handler runs
 *   - Escape / back confirms instead of cancelling
 *   - the pop-up is drawn UNDER the sheet it was raised from
 *   - a double tap answers a question before it has been read
 *   - a tap outside dismisses a pop-up that was not cancelable
 *
 * The rest of this suite runs on a react-native stub in plain node (see
 * jest.config.js); this one file swaps in react-native-web and jsdom. Nothing
 * was installed for it: react-dom and react-native-web are the app's own web
 * dependencies, and the jsdom environment comes with jest-expo.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal, Text, View } from 'react-native';
import PopupHost, { POPUP_SETTLE_MS } from '../PopupHost';
import {
  __resetPopupsForTests, currentPopup, popupCount, showPopup,
} from '../../utils/popup';

jest.mock('react-native', () => jest.requireActual('react-native-web/dist/cjs/index.js'));
jest.mock('@krushisarva/shared/context/LanguageContext', () => ({
  // 'ok' comes back in Marathi so the test can tell a translated OK from a
  // hard-coded one; everything else falls back to its English default.
  useLanguage: () => ({
    t: (key, fallback) => (key === 'ok' ? 'ठीक आहे' : (typeof fallback === 'string' ? fallback : key)),
  }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;
let mounted;
let now;

beforeEach(() => {
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  __resetPopupsForTests();
  jest.restoreAllMocks();
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Every Modal on the page, in the order the browser paints them (last = on top). */
const modals = () => [...document.body.children].filter((el) => el !== container && el.textContent);
const topModal = () => modals()[modals().length - 1];
const button = (index) => document.querySelector(`[data-testid="popup-button-${index}"]`);
const backdrop = () => document.querySelector('[data-testid="popup-backdrop"]');
const click = (el) => act(() => { el.click(); });
const raise = (...args) => { let id; act(() => { id = showPopup(...args); }); return id; };
/** Let the "this press is too soon to be an answer" window pass. */
const settle = () => { now += POPUP_SETTLE_MS; };
/** react-native-web only treats a Modal as open once its fade has finished. */
const finishFade = () => act(() => {
  for (const modal of modals()) {
    modal.firstElementChild?.dispatchEvent(new window.Event('animationend', { bubbles: true }));
  }
});
const pressEscape = () => act(() => {
  document.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
});

function Sheet() {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => {}}>
      <View><Text>SHEET edit profile</Text></View>
    </Modal>
  );
}

/** The app as far as the host is concerned: a screen, maybe its sheet, and the host at the root. */
function App({ sheet = false, overlay = false }) {
  return (
    <>
      <View>
        <Text>Screen</Text>
        {sheet ? <Sheet /> : null}
        {overlay ? (
          <Modal visible transparent animationType="fade">
            <View><Text>OVERLAY confirming your payment</Text></View>
          </Modal>
        ) : null}
      </View>
      <PopupHost />
    </>
  );
}

const render = (props) => act(() => { root.render(<App {...props} />); });

const cancelOrder = (onKeep, onCancel) => [
  { text: 'Keep order', style: 'cancel', onPress: onKeep },
  { text: 'Cancel order', style: 'destructive', onPress: onCancel },
];

// ── tests ────────────────────────────────────────────────────────────────────

describe('what is drawn', () => {
  test('nothing at all until there is a pop-up, and nothing again once it is answered', () => {
    render();
    expect(modals()).toHaveLength(0);

    raise('Cancel this order?', 'No money has been taken.', cancelOrder());
    expect(modals()).toHaveLength(1);
    expect(topModal().textContent).toContain('Cancel this order?');
    expect(topModal().textContent).toContain('No money has been taken.');
    expect(button(0).textContent).toBe('Keep order');
    expect(button(1).textContent).toBe('Cancel order');

    settle();
    click(button(0));
    expect(modals()).toHaveLength(0);
  });

  test('a notice with no buttons says OK in the farmer\'s language', () => {
    render();
    raise('Saved');
    expect(button(0).textContent).toBe('ठीक आहे');
    expect(button(1)).toBeNull();
  });
});

describe('pressing a button', () => {
  test('runs THAT button\'s handler, once, and closes the pop-up', () => {
    const onKeep = jest.fn();
    const onCancel = jest.fn();
    render();
    raise('Cancel this order?', '', cancelOrder(onKeep, onCancel));
    settle();

    click(button(1));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
    expect(currentPopup()).toBeNull();
  });

  test('a press in the first moment after it appears is not an answer', () => {
    const onCancel = jest.fn();
    render();
    raise('Cancel this order?', '', cancelOrder(undefined, onCancel));

    click(button(1));                                  // the second half of a double tap
    expect(onCancel).not.toHaveBeenCalled();
    expect(currentPopup()).not.toBeNull();

    settle();
    click(button(1));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('a double tap on "Delete" in a menu cannot answer the "Delete farm?" that replaces it', () => {
    const removeFarm = jest.fn();
    render();
    raise('Nashik plot', '', [
      { text: 'Edit' },
      { text: 'Delete', style: 'destructive', onPress: () => showPopup('Delete farm?', 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: removeFarm },
      ]) },
      { text: 'Cancel', style: 'cancel' },
    ]);
    settle();

    click(button(1));                                  // first tap: the menu's Delete
    expect(currentPopup().title).toBe('Delete farm?');
    click(button(1));                                  // second tap lands on the question's Delete

    expect(removeFarm).not.toHaveBeenCalled();
    expect(currentPopup().title).toBe('Delete farm?');

    settle();
    click(button(1));                                  // a deliberate answer still works
    expect(removeFarm).toHaveBeenCalledTimes(1);
  });
});

describe('leaving without choosing', () => {
  test('Escape takes the cancel way out — it never cancels the order', () => {
    const onKeep = jest.fn();
    const onCancel = jest.fn();
    render();
    raise('Cancel this order?', '', cancelOrder(onKeep, onCancel));
    finishFade();
    settle();

    pressEscape();

    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(currentPopup()).toBeNull();
  });

  test('a tap outside does nothing unless the pop-up was raised as cancelable', () => {
    render();
    raise('Pick one', '', [{ text: 'A' }, { text: 'B' }]);
    expect(backdrop()).toBeNull();                     // nothing there to press
  });

  test('…and for a cancelable one it closes it, running onDismiss and no button', () => {
    const a = jest.fn();
    const onDismiss = jest.fn();
    render();
    raise('Pick one', '', [{ text: 'A', onPress: a }, { text: 'B' }], { cancelable: true, onDismiss });
    settle();

    click(backdrop());

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    expect(currentPopup()).toBeNull();
  });
});

// In a browser every Modal is a <div> at the end of <body>, all at one z-index:
// the LAST one is on top. A pop-up is only readable if it is last.
describe('it is drawn on top of what it was raised from', () => {
  test('a sheet opened after the app started, then a pop-up from inside it', () => {
    render();                                          // the host is mounted first, at app start…
    render({ sheet: true });                           // …the sheet much later
    raise('Error', 'Name cannot be empty');

    expect(modals()).toHaveLength(2);
    expect(modals()[0].textContent).toContain('SHEET');
    expect(topModal().textContent).toContain('Name cannot be empty');
  });

  test('a pop-up that was waiting its turn still comes out above an overlay opened meanwhile', () => {
    render();
    const first = raise('Payment received');
    raise('We could not confirm your payment', 'Check My Orders before paying again.');
    render({ overlay: true });                         // "Confirming your payment" appears
    expect(topModal().textContent).toContain('OVERLAY');

    settle();
    click(button(0));                                  // the first pop-up is answered

    expect(currentPopup().id).not.toBe(first);
    expect(topModal().textContent).toContain('We could not confirm your payment');
  });
});

describe('the host going away', () => {
  test('what was still waiting is dropped — it belonged to screens that no longer exist', () => {
    const onPress = jest.fn();
    render();
    raise('One', '', [{ text: 'OK', onPress }]);
    raise('Two');
    expect(popupCount()).toBe(2);

    act(() => root.unmount());
    mounted = false;

    expect(popupCount()).toBe(0);
    expect(onPress).not.toHaveBeenCalled();
    expect(modals()).toHaveLength(0);
  });
});
