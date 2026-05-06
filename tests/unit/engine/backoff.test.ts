import { describe, it, expect } from 'vitest';
import { computeNextSleep } from '../../../src/engine/backoff.js';

describe('computeNextSleep', () => {
  it('base=1000, cap=30000, lastSleep=0: result in [1000, 3000]', () => {
    for (let i = 0; i < 100; i++) {
      const result = computeNextSleep(1000, 30000, 0);
      expect(result).toBeGreaterThanOrEqual(1000);
      expect(result).toBeLessThanOrEqual(3000);
    }
  });

  it('base=1000, cap=30000, lastSleep=1000: result in [1000, 3000]', () => {
    for (let i = 0; i < 100; i++) {
      const result = computeNextSleep(1000, 30000, 1000);
      expect(result).toBeGreaterThanOrEqual(1000);
      expect(result).toBeLessThanOrEqual(3000);
    }
  });

  it('base=1000, cap=30000, lastSleep=10000: result in [1000, 30000]', () => {
    for (let i = 0; i < 100; i++) {
      const result = computeNextSleep(1000, 30000, 10000);
      expect(result).toBeGreaterThanOrEqual(1000);
      expect(result).toBeLessThanOrEqual(30000);
    }
  });

  it('cap is respected: never returns > cap', () => {
    for (let i = 0; i < 1000; i++) {
      const result = computeNextSleep(1000, 5000, 10000);
      expect(result).toBeLessThanOrEqual(5000);
    }
  });

  it('1000 runs: distribution spread (no clustering at 0 or cap)', () => {
    const results: number[] = [];
    for (let i = 0; i < 1000; i++) {
      results.push(computeNextSleep(1000, 30000, 5000));
    }
    const min = Math.min(...results);
    const max = Math.max(...results);

    expect(min).toBeGreaterThanOrEqual(1000);
    expect(max).toBeLessThanOrEqual(30000);
    expect(max - min).toBeGreaterThan(1000);
  });
});
