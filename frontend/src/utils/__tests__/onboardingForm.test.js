import { acresOrNull, cleanAcres, cleanPincode, digitsOnly, findCrop } from '../onboardingForm';

describe('cleanPincode', () => {
  test.each([
    ['411001', '411001'],
    ['411 001', '411001'],
    ['41.10-01', '411001'],
    ['4110019', '411001'],
    ['४११००१', '411001'],
    ['', ''],
    [null, ''],
  ])('%p → %p', (input, out) => {
    expect(cleanPincode(input)).toBe(out);
  });
});

describe('digitsOnly', () => {
  test('caps at max after dropping non-digits', () => {
    expect(digitsOnly('a1b2c3', 2)).toBe('12');
  });
});

describe('cleanAcres', () => {
  test.each([
    ['12', '12'],
    ['12.5', '12.5'],
    ['2,5', '2.5'],
    ['2.', '2.'],
    ['.5', '0.5'],
    ['1.2.3', '1.23'],
    ['3.14159', '3.14'],
    ['-4', '4'],
    ['12 acres', '12'],
    ['1234567', '12345'],
    ['', ''],
    [undefined, ''],
  ])('%p → %p', (input, out) => {
    expect(cleanAcres(input)).toBe(out);
  });
});

describe('acresOrNull', () => {
  test.each([
    ['2,5', 2.5],
    ['12', 12],
    ['2.', 2],
    ['.', null],
    ['0', null],
    ['', null],
  ])('%p → %p', (input, out) => {
    expect(acresOrNull(input)).toBe(out);
  });
});

describe('findCrop', () => {
  const crops = ['Rice', 'Wheat', 'Dragon fruit'];

  test('matches regardless of case and surrounding spaces', () => {
    expect(findCrop('  rice ', crops)).toBe('Rice');
    expect(findCrop('DRAGON FRUIT', crops)).toBe('Dragon fruit');
  });

  test('returns null for a new crop or an empty name', () => {
    expect(findCrop('Garlic', crops)).toBeNull();
    expect(findCrop('   ', crops)).toBeNull();
  });
});
