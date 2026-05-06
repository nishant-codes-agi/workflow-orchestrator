export interface CronExpression {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

interface FieldSpec {
  min: number;
  max: number;
  name: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day-of-month' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 6, name: 'day-of-week' },
];

function parseField(token: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();

  for (const part of token.split(',')) {
    if (part === '*') {
      for (let i = spec.min; i <= spec.max; i++) values.add(i);
    } else if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(`Invalid step value in ${spec.name} field: ${part}`);
      }
      for (let i = spec.min; i <= spec.max; i += step) values.add(i);
    } else if (part.includes('-')) {
      const dashIdx = part.indexOf('-');
      const rangePart = part.slice(0, dashIdx);
      const rest = part.slice(dashIdx + 1);

      let end: number;
      let step = 1;

      if (rest.includes('/')) {
        const slashIdx = rest.indexOf('/');
        end = parseInt(rest.slice(0, slashIdx), 10);
        step = parseInt(rest.slice(slashIdx + 1), 10);
      } else {
        end = parseInt(rest, 10);
      }

      const start = parseInt(rangePart, 10);

      if (isNaN(start) || isNaN(end) || isNaN(step)) {
        throw new Error(`Invalid range in ${spec.name} field: ${part}`);
      }
      if (start < spec.min || start > spec.max || end < spec.min || end > spec.max) {
        throw new Error(
          `Value out of range for ${spec.name} (${spec.min}-${spec.max}): ${part}`,
        );
      }
      if (step <= 0) {
        throw new Error(`Invalid step value in ${spec.name} field: ${part}`);
      }

      for (let i = start; i <= end; i += step) values.add(i);
    } else {
      const val = parseInt(part, 10);
      if (isNaN(val)) {
        throw new Error(`Invalid value in ${spec.name} field: ${part}`);
      }
      if (val < spec.min || val > spec.max) {
        throw new Error(
          `Value out of range for ${spec.name} (${spec.min}-${spec.max}): ${val}`,
        );
      }
      values.add(val);
    }
  }

  return values;
}

export function parseCronExpression(expr: string): CronExpression {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields, got ${fields.length}: "${expr}"`,
    );
  }

  return {
    minutes: parseField(fields[0]!, FIELD_SPECS[0]!),
    hours: parseField(fields[1]!, FIELD_SPECS[1]!),
    daysOfMonth: parseField(fields[2]!, FIELD_SPECS[2]!),
    months: parseField(fields[3]!, FIELD_SPECS[3]!),
    daysOfWeek: parseField(fields[4]!, FIELD_SPECS[4]!),
  };
}
