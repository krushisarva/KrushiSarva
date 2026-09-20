import { countUpFrame, entranceDelay } from '../motion';

describe('entranceDelay', () => {
  it('staggers the first screenful', () => {
    expect(entranceDelay({ index: 0 })).toBe(0);
    expect(entranceDelay({ index: 1 })).toBe(45);
    expect(entranceDelay({ index: 4 })).toBe(180);
  });

  it('starts rows past the first screenful immediately', () => {
    // The old clamp left every one of these at opacity 0 for the full 260ms:
    // blank rows on a fast scroll and on each "load more" page.
    for (const index of [5, 6, 7, 20, 41, 300]) {
      expect(entranceDelay({ index })).toBe(0);
    }
  });

  it('never waits longer than maxDelay', () => {
    for (let index = 0; index < 60; index += 1) {
      const delay = entranceDelay({ index, stagger: 40, maxDelay: 260 });
      expect(delay).toBeLessThan(260);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('respects a custom stagger and cap', () => {
    expect(entranceDelay({ index: 2, stagger: 40, maxDelay: 260 })).toBe(80);
    expect(entranceDelay({ index: 6, stagger: 40, maxDelay: 260 })).toBe(0);
    expect(entranceDelay({ index: 1, stagger: 100, maxDelay: 150 })).toBe(0); // only row 0 fits
  });

  it('is 0 for a disabled stagger or a nonsense index', () => {
    expect(entranceDelay({ index: 3, stagger: 0 })).toBe(0);
    expect(entranceDelay({ index: 3, maxDelay: 0 })).toBe(0);
    expect(entranceDelay({ index: -2 })).toBe(0);
    expect(entranceDelay({ index: NaN })).toBe(0);
    expect(entranceDelay()).toBe(0);
  });
});

describe('countUpFrame', () => {
  it('starts at the previous value, not at 0', () => {
    // A dashboard refresh of ₹45,000 → ₹45,200 must not pass through ₹0.
    expect(countUpFrame({ from: 45000, to: 45200, progress: 0 })).toBe(45000);
    expect(countUpFrame({ from: 45000, to: 45200, progress: 0.5 })).toBeGreaterThan(45000);
    expect(countUpFrame({ from: 45000, to: 45200, progress: 1 })).toBe(45200);
  });

  it('counts up from 0 on a first mount', () => {
    expect(countUpFrame({ from: 0, to: 500, progress: 0 })).toBe(0);
    expect(countUpFrame({ from: 0, to: 500, progress: 1 })).toBe(500);
  });

  it('moves monotonically and stays inside the range', () => {
    let last = -Infinity;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const v = countUpFrame({ from: 100, to: 900, progress: p });
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThanOrEqual(900);
      last = v;
    }
  });

  it('counts down when the figure fell', () => {
    expect(countUpFrame({ from: 900, to: 100, progress: 0 })).toBe(900);
    expect(countUpFrame({ from: 900, to: 100, progress: 0.5 })).toBeLessThan(900);
    expect(countUpFrame({ from: 900, to: 100, progress: 1 })).toBe(100);
  });

  it('eases out — most of the distance is covered early', () => {
    expect(countUpFrame({ from: 0, to: 100, progress: 0.5 })).toBeGreaterThan(50);
  });

  it('clamps progress and tolerates missing arguments', () => {
    expect(countUpFrame({ from: 10, to: 20, progress: -1 })).toBe(10);
    expect(countUpFrame({ from: 10, to: 20, progress: 5 })).toBe(20);
    expect(countUpFrame({ from: 10, to: 20, progress: NaN })).toBe(10);
    expect(countUpFrame()).toBe(0);
  });
});
