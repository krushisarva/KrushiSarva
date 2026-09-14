import {
  activeOtpCell, arrivedWhole, isOtpComplete, sanitizeOtp, shouldAutoSubmitOtp, OTP_LENGTH,
} from '../otp';

describe('sanitizeOtp', () => {
  test('keeps digits', () => {
    expect(sanitizeOtp('482913')).toBe('482913');
  });
  test('strips the spaces and dashes an SMS app or clipboard may include', () => {
    expect(sanitizeOtp('482 913')).toBe('482913');
    expect(sanitizeOtp('482-913')).toBe('482913');
    expect(sanitizeOtp('Your code: 482913')).toBe('482913');
  });
  test('caps at the code length', () => {
    expect(sanitizeOtp('4829137')).toBe('482913');
  });
  test('handles empty and missing input', () => {
    expect(sanitizeOtp('')).toBe('');
    expect(sanitizeOtp(null)).toBe('');
    expect(sanitizeOtp(undefined)).toBe('');
  });
});

describe('arrivedWhole', () => {
  test('a keystroke is not an autofill', () => {
    expect(arrivedWhole('48', '482')).toBe(false);
    expect(arrivedWhole('', '4')).toBe(false);
  });
  test('backspace is not an autofill', () => {
    expect(arrivedWhole('482', '48')).toBe(false);
  });
  test('a whole code at once is', () => {
    expect(arrivedWhole('', '482913')).toBe(true);
    expect(arrivedWhole('4', '482 913')).toBe(true);
  });
});

describe('activeOtpCell', () => {
  test('points at the next empty cell', () => {
    expect(activeOtpCell('')).toBe(0);
    expect(activeOtpCell('482')).toBe(3);
  });
  test('stays on the last cell once full', () => {
    expect(activeOtpCell('482913')).toBe(OTP_LENGTH - 1);
  });
});

describe('isOtpComplete', () => {
  test('true only for exactly six digits', () => {
    expect(isOtpComplete('482913')).toBe(true);
    expect(isOtpComplete('48291')).toBe(false);
    expect(isOtpComplete('48291a')).toBe(false);
    expect(isOtpComplete('')).toBe(false);
    expect(isOtpComplete(null)).toBe(false);
  });
  test('still accepts a digit array', () => {
    expect(isOtpComplete(['4', '8', '2', '9', '1', '3'])).toBe(true);
    expect(isOtpComplete(['4', '8', '2', '9', '1', ''])).toBe(false);
  });
});

describe('shouldAutoSubmitOtp', () => {
  const full = '482913';

  test('fires once the code is complete', () => {
    expect(shouldAutoSubmitOtp({ code: full, verifying: false, lastSubmitted: null })).toBe(true);
  });
  test('does not fire on a partial code', () => {
    expect(shouldAutoSubmitOtp({ code: '48', verifying: false, lastSubmitted: null })).toBe(false);
  });
  test('does not fire while a verify is already in flight', () => {
    expect(shouldAutoSubmitOtp({ code: full, verifying: true, lastSubmitted: null })).toBe(false);
  });
  test('does not re-fire for a code it already submitted', () => {
    expect(shouldAutoSubmitOtp({ code: full, verifying: false, lastSubmitted: full })).toBe(false);
  });
  test('fires for a different code even if one was submitted before', () => {
    expect(shouldAutoSubmitOtp({ code: full, verifying: false, lastSubmitted: '111111' })).toBe(true);
  });
});
