import { describe, it, expect } from 'vitest';
import { parseCronExpression } from '../../../src/cron/parser.js';
import { nextFire } from '../../../src/cron/next-fire.js';

describe('nextFire', () => {
  it('"*/15 * * * *" after 2024-01-01T00:00:00Z: next = 2024-01-01T00:15:00Z', () => {
    const expr = parseCronExpression('*/15 * * * *');
    const after = new Date('2024-01-01T00:00:00.002Z');
    const result = nextFire(expr, after, 'UTC');
    expect(result.toISOString()).toBe('2024-01-01T00:15:00.000Z');
  });

  it('"0 0 29 2 *" after 2024-03-01: next = 2028-02-29T00:00:00Z (leap year)', () => {
    const expr = parseCronExpression('0 0 29 2 *');
    const after = new Date('2024-03-01T00:00:00Z');
    const result = nextFire(expr, after, 'UTC');
    expect(result.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('"0 9 * * 1-5" after Friday 17:00: next = Monday 09:00', () => {
    const expr = parseCronExpression('0 9 * * 1-5');
    // 2024-01-05 is a Friday
    const after = new Date('2024-01-05T17:00:00Z');
    const result = nextFire(expr, after, 'UTC');
    // Next Monday is Jan 8
    expect(result.toISOString()).toBe('2024-01-08T09:00:00.000Z');
  });

  it('DST spring forward: "0 2 * * *" in America/New_York on March 10, 2024', () => {
    const expr = parseCronExpression('0 2 * * *');
    // March 10, 2024 is spring forward in America/New_York (2:00 AM doesn't exist)
    const after = new Date('2024-03-10T00:00:00Z');
    const result = nextFire(expr, after, 'America/New_York');
    // 2:00 AM local doesn't exist on March 10, so next should be March 11
    const resultLocalHour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false,
      }).formatToParts(result).find(p => p.type === 'hour')?.value ?? '',
      10,
    );
    expect(resultLocalHour).toBe(2);
    const resultLocalDay = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        day: 'numeric',
      }).formatToParts(result).find(p => p.type === 'day')?.value ?? '',
      10,
    );
    expect(resultLocalDay).toBe(11);
  });

  it('DST fall back: "0 1 * * *" in America/New_York on Nov 3, 2024', () => {
    const expr = parseCronExpression('0 1 * * *');
    // Nov 3, 2024 is fall back in America/New_York (1:00 AM happens twice)
    const after = new Date('2024-11-03T00:00:00Z');
    const result = nextFire(expr, after, 'America/New_York');
    // Should fire on first occurrence (05:00 UTC = 1:00 AM EDT)
    expect(result.toISOString()).toBe('2024-11-03T05:00:00.000Z');
  });

  it('"* * * * *" crosses midnight: correct date rollover', () => {
    const expr = parseCronExpression('* * * * *');
    const after = new Date('2024-01-01T23:59:00Z');
    const result = nextFire(expr, after, 'UTC');
    expect(result.toISOString()).toBe('2024-01-02T00:00:00.000Z');
  });

  it('"0 0 1 * *" fires monthly', () => {
    const expr = parseCronExpression('0 0 1 * *');
    const after = new Date('2024-01-01T00:01:00Z');
    const result = nextFire(expr, after, 'UTC');
    expect(result.toISOString()).toBe('2024-02-01T00:00:00.000Z');
  });

  it('"59 23 31 12 *" -> fires Dec 31 23:59', () => {
    const expr = parseCronExpression('59 23 31 12 *');
    const after = new Date('2024-01-01T00:00:00Z');
    const result = nextFire(expr, after, 'UTC');
    expect(result.toISOString()).toBe('2024-12-31T23:59:00.000Z');
  });
});
