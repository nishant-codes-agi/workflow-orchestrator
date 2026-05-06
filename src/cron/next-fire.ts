import type { CronExpression } from './parser.js';

interface LocalTimeParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hour12: false,
    });
    fmtCache.set(tz, fmt);
  }
  return fmt;
}

function toLocalParts(utcDate: Date, fmt: Intl.DateTimeFormat): LocalTimeParts {
  const parts = fmt.formatToParts(utcDate);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;

  return {
    minute: parseInt(get('minute'), 10),
    hour,
    day: parseInt(get('day'), 10),
    month: parseInt(get('month'), 10),
    weekday: WEEKDAY_MAP[get('weekday')] ?? 0,
  };
}

function matches(expr: CronExpression, local: LocalTimeParts): boolean {
  return (
    expr.minutes.has(local.minute) &&
    expr.hours.has(local.hour) &&
    expr.daysOfMonth.has(local.day) &&
    expr.months.has(local.month) &&
    expr.daysOfWeek.has(local.weekday)
  );
}

const ONE_MINUTE = 60_000;
const ONE_DAY = 24 * 60 * ONE_MINUTE;
const MAX_ITERATIONS = 4 * 366 * 24 * 60;

export function nextFire(
  expr: CronExpression,
  after: Date,
  timezone: string,
): Date {
  const fmt = getFormatter(timezone);
  let candidateMs = after.getTime() + ONE_MINUTE;
  candidateMs = candidateMs - (candidateMs % ONE_MINUTE);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const candidate = new Date(candidateMs);
    const local = toLocalParts(candidate, fmt);

    if (!expr.months.has(local.month)) {
      // Skip to start of next day - months won't match today
      candidateMs += ONE_DAY - ((local.hour * 60 + local.minute) * ONE_MINUTE);
      continue;
    }

    if (!expr.daysOfMonth.has(local.day) || !expr.daysOfWeek.has(local.weekday)) {
      // Skip to start of next day
      candidateMs += ONE_DAY - ((local.hour * 60 + local.minute) * ONE_MINUTE);
      continue;
    }

    if (!expr.hours.has(local.hour)) {
      // Skip to next hour
      candidateMs += (60 - local.minute) * ONE_MINUTE;
      continue;
    }

    if (expr.minutes.has(local.minute)) {
      return candidate;
    }

    candidateMs += ONE_MINUTE;
  }

  throw new Error('No fire time found within 1 year');
}
