// What a rep sees on a "Reply received" Pipedrive task: who wrote, which company and
// project, what they said, what the classifier made of it, and when to act. Pure helpers;
// the reply-action client (lib/inboxReplyWatch.js) does the reads and the write.

const TIME_ZONE = 'America/Chicago';
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|aol|outlook|hotmail|live|msn|icloud|me|mac|comcast|att|sbcglobal|verizon|bellsouth|protonmail)\./i;

const wall = (date, timeZone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, min: +parts.minute, s: +parts.second };
};
// UTC instant of a wall-clock time in timeZone (DST-correct: offset re-read at the result).
function zonedInstant(y, m, d, h, timeZone) {
  let guess = Date.UTC(y, m - 1, d, h);
  for (let i = 0; i < 2; i++) {
    const w = wall(new Date(guess), timeZone);
    const offset = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - guess;
    guess = Date.UTC(y, m - 1, d, h) - offset;
  }
  return new Date(guess);
}

// The next 9:00 Chicago time on a weekday that is still ahead: Monday 07:00 -> Monday 09:00,
// Monday 14:00 -> Tuesday 09:00, Friday 14:00 or the weekend -> Monday 09:00. Pipedrive
// stores due_date/due_time in UTC, so both are returned in UTC.
export function nextBusinessMorning(now = new Date(), { timeZone = TIME_ZONE, hour = 9 } = {}) {
  const today = wall(now, timeZone);
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const at = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, timeZone);
    if (+at <= +now) continue;
    const iso = at.toISOString();
    return { at, dueDate: iso.slice(0, 10), dueTime: iso.slice(11, 16) };
  }
  throw new Error('no_business_morning');
}

export const addressOf = value => {
  const raw = String(value || '').trim().toLowerCase();
  return (raw.match(/<([^<>\s]+@[^<>\s]+)>/) || raw.match(/([^\s<>"']+@[^\s<>"']+)/) || [])[1] || null;
};
export const displayNameOf = value => {
  const name = String(value || '').replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  return name && !name.includes('@') ? name : null;
};

const decode = text => String(text || '')
  .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&');

export function htmlToText(html) {
  return decode(String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
}

// The buyer's own words only: quoted history, forwarded headers and long signatures cut.
export function replyExcerpt(text, max = 1200) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^on .{4,200} wrote:$/i.test(t) || /^-{2,}\s*(original|forwarded) message/i.test(t) || /^from:\s.+/i.test(t) && kept.some(Boolean) || /^_{5,}$/.test(t)) break;
    if (t.startsWith('>')) continue;
    kept.push(t);
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

const escape = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function companyFrom({ orgName, email }) {
  if (orgName) return orgName;
  const domain = String(addressOf(email) || '').split('@')[1];
  return domain && !FREE_MAIL.test(domain) ? domain : 'company unknown';
}

// Subject "Reply received: <Contact> (<Company>) - <Project>" (no ids, no raw address).
// The action marker that reconciliation looks for lives in the note.
export function buildReplyTask({ contact, company, project, intent, intentReason, from, subject, excerpt, link, marker, matched }) {
  const title = `Reply received: ${contact || 'Unknown contact'} (${company || 'company unknown'}) - ${matched ? (project || 'project') : 'match it to a project'}`;
  const what = intent === 'left_company'
    ? 'Auto-reply says this contact has left. Follow up with the replacement they name, if any.'
    : intent === 'unknown'
      ? `Not classified automatically${intentReason ? ` (${intentReason})` : ''}. Read it before answering.`
      : `Intent: ${intent}${intentReason ? ` (${intentReason})` : ''}.`;
  const lines = [
    escape(what),
    matched ? null : escape('It could not be matched to exactly one project; link it in the interface.'),
    escape(`From ${from || 'unknown sender'}, subject "${subject || 'none'}".`),
    excerpt ? `<b>What they wrote:</b><br>${escape(excerpt).replace(/\n/g, '<br>')}` : null,
    `Open in interface: <a href="${escape(link)}">${escape(link)}</a>`,
    escape(marker),
  ].filter(Boolean);
  return { subject: title.slice(0, 250), note: lines.join('<br><br>') };
}
