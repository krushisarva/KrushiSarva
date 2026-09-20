import { formatCurrency } from '../index';

describe('formatCurrency', () => {
  it('keeps both paise digits on a fractional amount', () => {
    // "₹1,234.5" reads as a broken price; ₹0.1 as a broken one too.
    expect(formatCurrency('1234.50')).toBe('₹1,234.50');
    expect(formatCurrency(1234.5)).toBe('₹1,234.50');
    expect(formatCurrency('0.10')).toBe('₹0.10');
    expect(formatCurrency(0.1)).toBe('₹0.10');
  });

  it('prints whole rupees without paise', () => {
    expect(formatCurrency(1234)).toBe('₹1,234');
    expect(formatCurrency('1234.00')).toBe('₹1,234');
    expect(formatCurrency(0)).toBe('₹0');
  });

  it('groups in the Indian system', () => {
    expect(formatCurrency(1000000)).toBe('₹10,00,000');
  });

  it('normalises a value that rounds to minus zero', () => {
    expect(formatCurrency('-0.004')).toBe('₹0');
    expect(formatCurrency(-0.004)).toBe('₹0');
    expect(formatCurrency(-0)).toBe('₹0');
  });

  it('puts a real negative sign outside the symbol', () => {
    expect(formatCurrency(-1234.567)).toBe('-₹1,234.57');
    expect(formatCurrency(-50)).toBe('-₹50');
    expect(formatCurrency(-50, { withSymbol: false })).toBe('-50');
  });

  it('rounds to paise rather than printing more digits', () => {
    expect(formatCurrency(0.125)).toBe('₹0.13');
    expect(formatCurrency(99.999)).toBe('₹100');
  });

  it('shows a dash for a value that is not a number', () => {
    expect(formatCurrency(null)).toBe('₹—');
    expect(formatCurrency(undefined)).toBe('₹—');
    expect(formatCurrency(NaN)).toBe('₹—');
    expect(formatCurrency('')).toBe('₹—');
    expect(formatCurrency('abc')).toBe('₹—');
    expect(formatCurrency(Infinity)).toBe('₹—');
    expect(formatCurrency(null, { withSymbol: false })).toBe('—');
  });

  it('reads a value that arrives as a formatted string', () => {
    // Prisma Decimals and API strings both turn up here.
    expect(formatCurrency('₹1,234.50')).toBe('₹1,234.50');
  });
});
