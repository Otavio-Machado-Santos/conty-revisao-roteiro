import { DomainError } from './errors.js';

export const BRAND_TIME_ZONE = 'America/Sao_Paulo';

const calendar = new Intl.DateTimeFormat('en-US', {
  timeZone: BRAND_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function civilOrdinal(instant) {
  const parts = Object.fromEntries(
    calendar.formatToParts(instant)
      .filter(({ type }) => ['year', 'month', 'day'].includes(type))
      .map(({ type, value }) => [type, Number(value)]),
  );
  return parts.year * 10_000 + parts.month * 100 + parts.day;
}

function parseCivilDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DomainError('INVALID_INPUT', 'deadline deve ser um dia no formato YYYY-MM-DD.', 422, { field: 'deadline' });
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new DomainError('INVALID_INPUT', 'deadline deve ser uma data existente.', 422, { field: 'deadline' });
  }
  return date;
}

// First instant of the following civil day. Comparing calendar dates, instead
// of assuming UTC-03, also handles historical daylight-saving transitions.
export function deadlineBoundary(deadline) {
  const nextDay = parseCivilDay(deadline);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextOrdinal = nextDay.getUTCFullYear() * 10_000 + (nextDay.getUTCMonth() + 1) * 100 + nextDay.getUTCDate();
  const margin = 36 * 60 * 60 * 1000;
  let before = nextDay.getTime() - margin;
  let after = nextDay.getTime() + margin;
  while (after - before > 1) {
    const middle = before + Math.floor((after - before) / 2);
    if (civilOrdinal(new Date(middle)) >= nextOrdinal) after = middle;
    else before = middle;
  }
  return {
    deadline,
    time_zone: BRAND_TIME_ZONE,
    valid_until: new Date(after - 1).toISOString(),
    expires_at: new Date(after).toISOString(),
  };
}

export function isDeadlineExpired(boundary, now) {
  return now.getTime() >= Date.parse(boundary.expires_at);
}
