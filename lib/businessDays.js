// Business-day date math on the America/Chicago calendar. Pure.
// Moved out of lib/bidFollowUpClock.js (the old before-bid task clock, removed 2026-11-03);
// that file re-exports both so existing imports keep working.
const TZ = "America/Chicago";

const iso = (d) => d.toISOString().slice(0, 10);
const utcDate = (ymd) => new Date(`${ymd}T00:00:00Z`);
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

// "YYYY-MM-DD" plus n weekdays (n may be negative). Weekends are skipped, holidays are not.
export function addBusinessDays(ymd, n) {
  const d = utcDate(ymd);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    if (!isWeekend(d)) left--;
  }
  return iso(d);
}

// Today's date and hour on the Chicago wall clock.
export function chicagoNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { today: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
