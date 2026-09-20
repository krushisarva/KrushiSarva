import { androidKeyboardInset, bottomSheetLift, revealScrollOffset } from '../keyboardInset';

describe('androidKeyboardInset', () => {
  test('keyboard closed → no padding', () => {
    expect(androidKeyboardInset({ keyboardHeight: 0, bottomInset: 48, restHeight: 780, height: 780 })).toBe(0);
  });

  test('edge-to-edge (window not resized) → keyboard plus the navigation bar under it', () => {
    expect(androidKeyboardInset({ keyboardHeight: 300, bottomInset: 48, restHeight: 780, height: 780 })).toBe(348);
  });

  test('gesture navigation has a thin bottom inset', () => {
    expect(androidKeyboardInset({ keyboardHeight: 290, bottomInset: 16, restHeight: 800, height: 800 })).toBe(306);
  });

  test('a window that DOES resize has already made the room → nothing is added twice', () => {
    expect(androidKeyboardInset({ keyboardHeight: 300, bottomInset: 48, restHeight: 780, height: 432 })).toBe(0);
  });

  test('a partial resize only pads the remainder', () => {
    expect(androidKeyboardInset({ keyboardHeight: 300, bottomInset: 48, restHeight: 780, height: 680 })).toBe(248);
  });

  test('unknown rest height (first layout already had the keyboard up) is treated as no resize', () => {
    expect(androidKeyboardInset({ keyboardHeight: 300, bottomInset: 48, restHeight: 780, height: 780 })).toBe(348);
  });

  test('bad input never produces a negative or NaN padding', () => {
    expect(androidKeyboardInset({ keyboardHeight: NaN, bottomInset: 48, restHeight: 780, height: 780 })).toBe(0);
    expect(androidKeyboardInset({ keyboardHeight: 300, bottomInset: undefined, restHeight: undefined, height: undefined })).toBe(300);
  });
});

describe('revealScrollOffset', () => {
  // A 432dp viewport: a 780dp screen with a 348dp keyboard.
  const viewportHeight = 432;

  test('already fully visible → does not move', () => {
    expect(revealScrollOffset({ blockTop: 100, blockHeight: 200, viewportHeight, scrollY: 0 })).toBeNull();
  });

  test('below the keyboard → scrolls down just far enough', () => {
    // Block spans 380–600 (+16 margin) → bottom 616 must reach 432 → scroll 184.
    expect(revealScrollOffset({ blockTop: 380, blockHeight: 220, viewportHeight, scrollY: 0 })).toBe(184);
  });

  test('taller than the viewport → aligns its top so the field stays visible', () => {
    expect(revealScrollOffset({ blockTop: 380, blockHeight: 500, viewportHeight, scrollY: 0 })).toBe(364);
  });

  test('scrolled past it → scrolls back up to its top', () => {
    expect(revealScrollOffset({ blockTop: 120, blockHeight: 100, viewportHeight, scrollY: 300 })).toBe(104);
  });

  test('never scrolls above the top of the content', () => {
    expect(revealScrollOffset({ blockTop: 4, blockHeight: 100, viewportHeight, scrollY: 50 })).toBe(0);
  });

  test('nothing measured yet → no scroll', () => {
    expect(revealScrollOffset({ blockTop: 100, blockHeight: 100, viewportHeight: 0 })).toBeNull();
    expect(revealScrollOffset({ blockTop: undefined, blockHeight: 100, viewportHeight })).toBeNull();
  });
});

describe('bottomSheetLift', () => {
  test('keyboard closed → clear of the navigation bar / home indicator, not a fixed 16', () => {
    expect(bottomSheetLift({ platform: 'android', keyboardHeight: 0, androidInset: 0, bottomInset: 48 })).toBe(48);
    expect(bottomSheetLift({ platform: 'ios', keyboardHeight: 0, bottomInset: 34 })).toBe(34);
  });

  test('Android keyboard open → the keyboard strip for the modal root (keyboard + nav bar)', () => {
    const androidInset = androidKeyboardInset({ keyboardHeight: 300, bottomInset: 48, restHeight: 780, height: 780 });
    expect(bottomSheetLift({ platform: 'android', keyboardHeight: 300, androidInset, bottomInset: 48 })).toBe(348);
  });

  test('Android window that resized for the keyboard → nothing added twice', () => {
    const androidInset = androidKeyboardInset({ keyboardHeight: 300, bottomInset: 48, restHeight: 780, height: 432 });
    expect(bottomSheetLift({ platform: 'android', keyboardHeight: 300, androidInset, bottomInset: 48 })).toBe(0);
  });

  test('iOS keyboard open → its height, which already covers the home indicator', () => {
    expect(bottomSheetLift({ platform: 'ios', keyboardHeight: 336, bottomInset: 34 })).toBe(336);
  });

  test('web has no keyboard events → just the inset; bad input is never negative or NaN', () => {
    expect(bottomSheetLift({ platform: 'web', keyboardHeight: 0, bottomInset: 0 })).toBe(0);
    expect(bottomSheetLift({ platform: 'android', keyboardHeight: NaN, bottomInset: undefined })).toBe(0);
    expect(bottomSheetLift({ platform: 'android', keyboardHeight: 300, androidInset: -20, bottomInset: 48 })).toBe(0);
  });
});
