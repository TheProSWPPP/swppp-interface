import { createHash } from 'node:crypto';

// The page's pace: week 1 = 5 invites a day, week 2 = 10, then 15. Counted in local calendar
// days from ramp_started_on, which the runtime stamps on the first live tick.
export const LINKEDIN_WEEKLY_INVITE_CAP = 80; // LinkedIn's ceiling is about 100 a week; this keeps a margin.
export const LINKEDIN_OUTSTANDING_INVITE_CAP = 200;
export const LINKEDIN_WINDOW_MINUTES = 540; // 08:00 to 17:00

const parts = (date, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  .formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));

export function localDayString(date, timeZone = 'America/Chicago') {
  const p = parts(new Date(date), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Calendar days between two local dates (YYYY-MM-DD or Date), never fractional.
function dayNumber(value, timeZone) {
  const text = value instanceof Date ? localDayString(value, timeZone) : String(value).slice(0, 10);
  const [y, m, d] = text.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

// node-pg parses a `date` column as local midnight, so its local parts are the stored day.
export const rampStartDay = value => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value || '').slice(0, 10);

export function rampDay({ rampStartedOn, now = new Date(), tz = 'America/Chicago' }) {
  if (!rampStartedOn) return null;
  const start = rampStartDay(rampStartedOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  return dayNumber(now, tz) - dayNumber(start, tz);
}

export function rampInviteBudget({ rampStartedOn, now = new Date(), tz = 'America/Chicago' } = {}) {
  const day = rampDay({ rampStartedOn, now, tz });
  if (day === null || day < 0) return 0;
  if (day <= 6) return 5;
  if (day <= 13) return 10;
  return 15;
}

export const rampWeek = args => { const day = rampDay(args); return day === null || day < 0 ? null : Math.floor(day / 7) + 1; };

export function effectiveInviteBudget(campaignBudget, rampBudget) {
  if (!Number.isInteger(campaignBudget) || !Number.isInteger(rampBudget)) return 0;
  return Math.max(0, Math.min(campaignBudget, rampBudget));
}

// A deterministic factor in [0.7, 1.3] so the spacing is jittered but reproducible.
export function spacingJitter(seed) {
  const n = parseInt(createHash('sha256').update(String(seed)).digest('hex').slice(0, 8), 16) / 0xffffffff;
  return 0.7 + 0.6 * n;
}

// The next invite is not before lastInviteAt + (540 min / budget) x U(0.7, 1.3).
export function nextInviteAllowedAt({ lastInviteAt, budget, seed }) {
  if (!lastInviteAt || !Number.isInteger(budget) || budget <= 0) return null;
  const interval = (LINKEDIN_WINDOW_MINUTES / budget) * 60_000;
  return new Date(new Date(lastInviteAt).getTime() + interval * spacingJitter(seed));
}

// 00:00 local time on the next calendar day.
export function nextLocalDayStart(date, timeZone = 'America/Chicago') {
  const p = parts(new Date(date), timeZone);
  const target = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0);
  let cursor = target;
  for (let i = 0; i < 3; i++) { const seen = parts(new Date(cursor), timeZone); cursor += target - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second); }
  return new Date(cursor);
}
