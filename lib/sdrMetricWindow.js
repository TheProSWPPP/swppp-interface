export function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invalid_date');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('invalid_date');
  return parsed;
}
export function parseMetricWindow(query = {}, now = new Date()) {
  const timezone = query.timezone ?? 'America/Chicago';
  if (timezone !== 'America/Chicago') throw new Error('unsupported_timezone');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const to = query.to ?? today;
  const end = calendarDate(to);
  const from = query.from ?? new Date(end.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const start = calendarDate(from);
  const days = (end - start) / 86400000;
  if (days <= 0 || days > 366) throw new Error('invalid_range');
  return { from, to, timezone, provisional: to > today };
}
