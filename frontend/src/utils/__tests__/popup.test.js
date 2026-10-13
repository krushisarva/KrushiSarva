/**
 * The in-app pop-up queue (utils/popup.js) — the app's replacement for
 * Alert.alert. These pin the behaviours a screen relies on without thinking:
 * the same arguments as Alert.alert, one pop-up at a time, a handler that runs
 * exactly once, and a back button that takes the safe way out.
 */
import {
  __resetPopupsForTests, buttonLooks, clearPopups, currentPopup, dismissPopup, normalizeButtons,
  popupCount, pressPopupButton, showPopup, subscribePopups,
} from '../popup';

beforeEach(() => __resetPopupsForTests());

// The cancel-order question exactly as MyOrdersScreen raises it.
const cancelOrder = (onKeep, onCancel) => [
  { text: 'Keep order', style: 'cancel', onPress: onKeep },
  { text: 'Cancel order', style: 'destructive', onPress: onCancel },
];

describe('showPopup takes what Alert.alert took', () => {
  test('title, message and buttons', () => {
    showPopup('Cancel this order?', 'No money has been taken.', cancelOrder());
    expect(currentPopup()).toMatchObject({
      title: 'Cancel this order?',
      message: 'No money has been taken.',
      cancelable: false,
    });
    expect(currentPopup().buttons.map((b) => [b.text, b.style])).toEqual([
      ['Keep order', 'cancel'], ['Cancel order', 'destructive'],
    ]);
  });

  test('a title alone: one OK button, its word left to the host to translate', () => {
    showPopup('Saved');
    expect(currentPopup()).toMatchObject({ title: 'Saved', message: '' });
    expect(currentPopup().buttons).toEqual([{ text: null, style: 'default', onPress: null }]);
  });

  test('a message that is not a string is shown, not dropped or crashed on', () => {
    showPopup('Error', 404);
    expect(currentPopup().message).toBe('404');
    showPopup(undefined, null);
    expect(popupCount()).toBe(2);
  });

  test('options: cancelable and onDismiss', () => {
    const onDismiss = jest.fn();
    showPopup('t', 'm', [{ text: 'A' }, { text: 'B' }], { cancelable: true, onDismiss });
    expect(currentPopup().cancelable).toBe(true);
    expect(currentPopup().onDismiss).toBe(onDismiss);
  });
});

describe('normalizeButtons', () => {
  test('unknown styles become default; junk entries are dropped', () => {
    expect(normalizeButtons([{ text: ' Yes ', style: 'positive' }, null, 'x'])).toEqual([
      { text: 'Yes', style: 'default', onPress: null },
    ]);
  });

  test('nothing usable → the single OK', () => {
    expect(normalizeButtons(undefined)).toHaveLength(1);
    expect(normalizeButtons([])).toHaveLength(1);
    expect(normalizeButtons([null])).toHaveLength(1);
  });
});

describe('pressing a button', () => {
  test('runs that button\'s handler and closes the pop-up', () => {
    const onKeep = jest.fn();
    const onCancel = jest.fn();
    const id = showPopup('Cancel this order?', '', cancelOrder(onKeep, onCancel));

    expect(pressPopupButton(id, 1)).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
    expect(currentPopup()).toBeNull();
  });

  test('a double tap cannot run the handler twice', () => {
    const onCancel = jest.fn();
    const id = showPopup('q', '', cancelOrder(undefined, onCancel));
    pressPopupButton(id, 1);
    expect(pressPopupButton(id, 1)).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('the pop-up is gone BEFORE its handler runs, so a follow-up shows at once', () => {
    let seenInside = 'unset';
    const id = showPopup('Cancel?', '', [{
      text: 'Yes',
      onPress: () => {
        seenInside = currentPopup();
        showPopup('Order cancelled');
      },
    }]);
    pressPopupButton(id, 0);
    expect(seenInside).toBeNull();
    expect(currentPopup().title).toBe('Order cancelled');
  });

  test('a handler that throws does not leave the pop-up stuck on screen', () => {
    const id = showPopup('x', '', [{ text: 'Go', onPress: () => { throw new Error('boom'); } }]);
    expect(() => pressPopupButton(id, 0)).toThrow('boom');
    expect(currentPopup()).toBeNull();
  });

  test('a button with no handler just closes', () => {
    const id = showPopup('Saved');
    expect(pressPopupButton(id, 0)).toBe(true);
    expect(currentPopup()).toBeNull();
  });
});

describe('one at a time, oldest first', () => {
  test('a second pop-up waits behind the first', () => {
    const first = showPopup('First');
    showPopup('Second');
    expect(currentPopup().title).toBe('First');
    expect(popupCount()).toBe(2);

    pressPopupButton(first, 0);
    expect(currentPopup().title).toBe('Second');
  });

  test('a pop-up raised by a handler waits behind the ones already queued', () => {
    const first = showPopup('First', '', [{ text: 'Go', onPress: () => showPopup('Raised by First') }]);
    showPopup('Second');

    pressPopupButton(first, 0);
    expect(currentPopup().title).toBe('Second');
    expect(popupCount()).toBe(2);
  });

  // useSyncExternalStore reads this on every render: a fresh object each time
  // would re-render the host for ever.
  test('the pop-up on screen is the SAME object until something changes', () => {
    showPopup('First');
    const seen = currentPopup();
    expect(currentPopup()).toBe(seen);

    showPopup('Second');                     // queued behind — the one on screen is untouched
    expect(currentPopup()).toBe(seen);
  });
});

describe('clearPopups — the host went away', () => {
  test('everything waiting is dropped, and no handler runs', () => {
    const onPress = jest.fn();
    const onDismiss = jest.fn();
    showPopup('One', '', [{ text: 'OK', onPress }]);
    showPopup('Two', '', [{ text: 'A' }, { text: 'B' }], { cancelable: true, onDismiss });

    clearPopups();

    expect(popupCount()).toBe(0);
    expect(currentPopup()).toBeNull();
    expect(onPress).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('a host listening is told once; an empty queue tells nobody', () => {
    const listener = jest.fn();
    subscribePopups(listener);
    clearPopups();
    expect(listener).not.toHaveBeenCalled();

    showPopup('x');
    clearPopups();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('the same pop-up is not raised twice', () => {
  test('a double tap on "Cancel order" is one question, answered once', () => {
    const first = jest.fn();
    const second = jest.fn();

    const id = showPopup('Cancel this order?', 'No money has been taken.', cancelOrder(undefined, first));
    const again = showPopup('Cancel this order?', 'No money has been taken.', cancelOrder(undefined, second));

    expect(again).toBe(id);
    expect(popupCount()).toBe(1);

    pressPopupButton(id, 1);
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);   // one cancel request, not two
    expect(currentPopup()).toBeNull();                                    // nothing reappears behind it
  });

  test('two quick taps on two rows act on the row tapped LAST, as the system alert did', () => {
    const deleteRowA = jest.fn();
    const deleteRowB = jest.fn();
    const ask = (onDelete) => showPopup('Delete address?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);

    const id = ask(deleteRowA);
    ask(deleteRowB);
    pressPopupButton(id, 1);

    expect(deleteRowB).toHaveBeenCalledTimes(1);
    expect(deleteRowA).not.toHaveBeenCalled();
  });

  test('the host is told when the handlers are swapped, and sees a new snapshot', () => {
    const listener = jest.fn();
    subscribePopups(listener);
    showPopup('Error', 'Failed', [{ text: 'Retry', onPress: () => {} }]);
    const before = currentPopup();
    showPopup('Error', 'Failed', [{ text: 'Retry', onPress: () => {} }]);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(currentPopup()).not.toBe(before);
    expect(currentPopup().id).toBe(before.id);
  });

  test('five failed taps are one message, including one still waiting its turn', () => {
    showPopup('Something else first');
    for (let i = 0; i < 5; i += 1) showPopup('Error', 'Could not update quantity');
    expect(popupCount()).toBe(2);
  });

  test('a different message, or different buttons, is a different pop-up', () => {
    showPopup('Error', 'Could not update quantity');
    showPopup('Error', 'Could not remove item');
    showPopup('Error', 'Could not remove item', [{ text: 'Retry' }]);
    expect(popupCount()).toBe(3);
  });

  test('once answered it can be raised again — a retry that fails the same way still says so', () => {
    const id = showPopup('Error', 'Could not update quantity');
    pressPopupButton(id, 0);
    const next = showPopup('Error', 'Could not update quantity');
    expect(next).not.toBe(id);
    expect(currentPopup().id).toBe(next);
  });

  test('…including from inside its own handler', () => {
    const id = showPopup('Error', 'Failed', [{ text: 'Retry', onPress: () => showPopup('Error', 'Failed', [{ text: 'Retry' }]) }]);
    pressPopupButton(id, 0);
    expect(popupCount()).toBe(1);
    expect(currentPopup().id).not.toBe(id);
  });
});

describe('leaving without choosing (Android back, Escape)', () => {
  test('a question with a cancel button: the cancel button is what is pressed', () => {
    const onKeep = jest.fn();
    const onCancel = jest.fn();
    const id = showPopup('Cancel this order?', '', cancelOrder(onKeep, onCancel));

    expect(dismissPopup(id)).toBe(true);
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();     // back must never cancel the order
    expect(currentPopup()).toBeNull();
  });

  test('a notice: its one button is pressed', () => {
    const onOk = jest.fn();
    const id = showPopup('Saved', '', [{ text: 'OK', onPress: onOk }]);
    expect(dismissPopup(id)).toBe(true);
    expect(onOk).toHaveBeenCalledTimes(1);
  });

  test('two choices and no cancel: it must be answered — back does nothing', () => {
    const a = jest.fn();
    const b = jest.fn();
    const id = showPopup('Pick', '', [{ text: 'A', onPress: a }, { text: 'B', onPress: b }]);
    expect(dismissPopup(id)).toBe(false);
    expect(currentPopup()).not.toBeNull();
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  test('…unless it was raised as cancelable: it closes and onDismiss runs, no button does', () => {
    const a = jest.fn();
    const onDismiss = jest.fn();
    const id = showPopup('Pick', '', [{ text: 'A', onPress: a }, { text: 'B' }], { cancelable: true, onDismiss });
    expect(dismissPopup(id)).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    expect(currentPopup()).toBeNull();
  });

  test('cancelable AND a cancel button: the cancel button is pressed, onDismiss is not called', () => {
    const onCancel = jest.fn();
    const onDismiss = jest.fn();
    const id = showPopup('Replace photo', '', [
      { text: 'Take photo' }, { text: 'From gallery' }, { text: 'Cancel', style: 'cancel', onPress: onCancel },
    ], { cancelable: true, onDismiss });

    expect(dismissPopup(id)).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('dismissing a pop-up that is already gone is harmless', () => {
    const id = showPopup('x');
    pressPopupButton(id, 0);
    expect(dismissPopup(id)).toBe(false);
  });
});

describe('buttonLooks — exactly one filled button', () => {
  const looks = (...styles) => buttonLooks(styles.map((style) => ({ style })));

  test('a notice is one primary button', () => {
    expect(looks('default')).toEqual(['primary']);
  });

  test('cancel is quiet; the action is filled, red when destructive', () => {
    expect(looks('cancel', 'destructive')).toEqual(['cancel', 'destructive']);
    expect(looks('cancel', 'default')).toEqual(['cancel', 'primary']);
    expect(looks('default', 'cancel')).toEqual(['primary', 'cancel']);
  });

  test('two plain choices: only the last is filled', () => {
    expect(looks('default', 'default')).toEqual(['secondary', 'primary']);
  });

  test('a destructive choice that is not the action is outlined in red, not plain', () => {
    expect(looks('destructive', 'default')).toEqual(['danger', 'primary']);
    expect(looks('default', 'destructive')).toEqual(['secondary', 'destructive']);
  });

  // Three or more are drawn stacked: a menu, read from the top.
  test('a menu: the first ordinary choice is filled', () => {
    // CropScanScreen / AIChatScreen: Take photo / From gallery / Cancel.
    expect(looks('default', 'default', 'cancel')).toEqual(['primary', 'secondary', 'cancel']);
    expect(looks('default', 'cancel', 'default')).toEqual(['primary', 'cancel', 'secondary']);
  });

  test('a menu: "Delete" is never the filled button while another choice exists', () => {
    // FarmListScreen long-press: Set active / Edit / Delete / Cancel.
    expect(looks('default', 'default', 'destructive', 'cancel'))
      .toEqual(['primary', 'secondary', 'danger', 'cancel']);
    expect(looks('destructive', 'default', 'cancel')).toEqual(['danger', 'primary', 'cancel']);
  });

  test('a menu of only destructive choices: still exactly one filled', () => {
    expect(looks('destructive', 'destructive', 'cancel')).toEqual(['danger', 'destructive', 'cancel']);
  });

  test('one action between two ways out stays filled, red if destructive', () => {
    expect(looks('cancel', 'destructive', 'cancel')).toEqual(['cancel', 'destructive', 'cancel']);
  });

  test('only a cancel button: nothing is filled', () => {
    expect(looks('cancel')).toEqual(['cancel']);
  });
});

describe('subscribePopups', () => {
  test('the host is told when a pop-up is raised and when it closes', () => {
    const listener = jest.fn();
    const unsubscribe = subscribePopups(listener);

    const id = showPopup('x');
    expect(listener).toHaveBeenCalledTimes(1);
    pressPopupButton(id, 0);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    showPopup('y');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('a pop-up raised before any host is listening is kept for it', () => {
    showPopup('Raised early');
    const listener = jest.fn();
    subscribePopups(listener);
    expect(currentPopup().title).toBe('Raised early');
  });
});
