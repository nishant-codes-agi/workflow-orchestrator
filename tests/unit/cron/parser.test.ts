import { describe, it, expect } from 'vitest';
import { parseCronExpression } from '../../../src/cron/parser.js';

describe('parseCronExpression', () => {
  it('1. "* * * * *" -> every minute (all sets full)', () => {
    const expr = parseCronExpression('* * * * *');
    expect(expr.minutes.size).toBe(60);
    expect(expr.hours.size).toBe(24);
    expect(expr.daysOfMonth.size).toBe(31);
    expect(expr.months.size).toBe(12);
    expect(expr.daysOfWeek.size).toBe(7);
  });

  it('2. "*/15 * * * *" -> minutes {0,15,30,45}', () => {
    const expr = parseCronExpression('*/15 * * * *');
    expect([...expr.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('3. "0 * * * *" -> minute 0 only', () => {
    const expr = parseCronExpression('0 * * * *');
    expect([...expr.minutes]).toEqual([0]);
  });

  it('4. "0 9 * * *" -> 09:00 daily', () => {
    const expr = parseCronExpression('0 9 * * *');
    expect([...expr.minutes]).toEqual([0]);
    expect([...expr.hours]).toEqual([9]);
    expect(expr.daysOfMonth.size).toBe(31);
  });

  it('5. "0 9 * * 1-5" -> 09:00 weekdays only', () => {
    const expr = parseCronExpression('0 9 * * 1-5');
    expect([...expr.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('6. "30 8,12,17 * * *" -> 08:30, 12:30, 17:30', () => {
    const expr = parseCronExpression('30 8,12,17 * * *');
    expect([...expr.minutes]).toEqual([30]);
    expect([...expr.hours].sort((a, b) => a - b)).toEqual([8, 12, 17]);
  });

  it('7. "0 0 1 * *" -> midnight on 1st of each month', () => {
    const expr = parseCronExpression('0 0 1 * *');
    expect([...expr.minutes]).toEqual([0]);
    expect([...expr.hours]).toEqual([0]);
    expect([...expr.daysOfMonth]).toEqual([1]);
  });

  it('8. "0 0 29 2 *" -> midnight Feb 29 (leap year)', () => {
    const expr = parseCronExpression('0 0 29 2 *');
    expect([...expr.daysOfMonth]).toEqual([29]);
    expect([...expr.months]).toEqual([2]);
  });

  it('9. "0 0 1 1 *" -> midnight Jan 1', () => {
    const expr = parseCronExpression('0 0 1 1 *');
    expect([...expr.months]).toEqual([1]);
    expect([...expr.daysOfMonth]).toEqual([1]);
  });

  it('10. "*/5 * * * *" -> every 5 minutes', () => {
    const expr = parseCronExpression('*/5 * * * *');
    expect([...expr.minutes].sort((a, b) => a - b)).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ]);
  });

  it('11. "0 0 * * 0" -> midnight every Sunday', () => {
    const expr = parseCronExpression('0 0 * * 0');
    expect([...expr.daysOfWeek]).toEqual([0]);
  });

  it('12. "0 6-18 * * 1-5" -> every hour 6AM-6PM weekdays', () => {
    const expr = parseCronExpression('0 6-18 * * 1-5');
    const hours = [...expr.hours].sort((a, b) => a - b);
    expect(hours).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect([...expr.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('13. "0 0 15,30 * *" -> midnight on 15th and 30th', () => {
    const expr = parseCronExpression('0 0 15,30 * *');
    expect([...expr.daysOfMonth].sort((a, b) => a - b)).toEqual([15, 30]);
  });

  it('14. "59 23 31 12 *" -> 23:59 Dec 31', () => {
    const expr = parseCronExpression('59 23 31 12 *');
    expect([...expr.minutes]).toEqual([59]);
    expect([...expr.hours]).toEqual([23]);
    expect([...expr.daysOfMonth]).toEqual([31]);
    expect([...expr.months]).toEqual([12]);
  });

  it('15. "0,30 * * * *" -> every half hour', () => {
    const expr = parseCronExpression('0,30 * * * *');
    expect([...expr.minutes].sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it('16. handles combinations: "1-5,10,15 * * * *" -> {1,2,3,4,5,10,15}', () => {
    const expr = parseCronExpression('1-5,10,15 * * * *');
    expect([...expr.minutes].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 10, 15]);
  });

  it('17. Invalid: "60 * * * *" -> throws error (out of range)', () => {
    expect(() => parseCronExpression('60 * * * *')).toThrow();
  });

  it('18. Invalid: "* * * * * *" (6 fields) -> throws error', () => {
    expect(() => parseCronExpression('* * * * * *')).toThrow(/5 fields/);
  });

  it('19. range with step: "0-30/10 * * * *" -> {0,10,20,30}', () => {
    const expr = parseCronExpression('0-30/10 * * * *');
    expect([...expr.minutes].sort((a, b) => a - b)).toEqual([0, 10, 20, 30]);
  });
});
