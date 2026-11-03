// Bid invite follow-ups: when each email is due, and who gets one email for which projects.
// Pure scheduling, no I/O. The rules are the ones on the client page (Part 1):
//   - nothing before the bid date;
//   - Email 1 right after upload if the bid date has passed, otherwise 2 business days after it;
//   - Email 2 about 4 weeks after the bid, Email 3 about 6 weeks (not customers);
//   - early morning or late afternoon in the recipient's time zone, weekdays only;
//   - several bids for one contact = one email naming up to 3 projects;
//   - nobody gets two emails from us within 3 days, across every sequence.
import { addBusinessDays, chicagoNow } from "./businessDays.js";
import { wall, zonedInstant } from "./sdrReplyTask.js";

export const DEFAULT_TZ = "America/Chicago";
// [start, end) in minutes after local midnight.
export const SEND_WINDOWS = [[6 * 60 + 30, 8 * 60 + 30], [16 * 60, 17 * 60 + 30]];
export const MAX_JITTER_MINUTES = 45;
export const E2_DAYS_AFTER_BID = 28;
export const E3_DAYS_AFTER_BID = 42;
export const MIN_DAYS_BETWEEN_STEPS = 14;
export const THREE_DAYS_MS = 72 * 60 * 60 * 1000;
export const MAX_NAMED_PROJECTS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const latest = (...dates) => dates.filter(Boolean).map((d) => new Date(d)).reduce((a, b) => (+b > +a ? b : a));

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const localMidnight = (ymd, tz) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return zonedInstant(y, m, d, 0, tz);
};

// Stable 0..max from any string (FNV-1a), so a batch's dry-run time is the same on every run.
export function jitterMinutes(key, max = MAX_JITTER_MINUTES) {
  if (!key) return 0;
  let h = 0x811c9dc5;
  for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % (max + 1);
}

export function inSendWindow(at, tz = DEFAULT_TZ) {
  const w = wall(new Date(at), tz);
  const weekday = new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minutes = w.h * 60 + w.min;
  return SEND_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}

// `at` itself when it is inside a send window, otherwise the start of the next window plus a
// stable jitter (0-45 minutes, from jitterKey) so a batch of emails does not land at 06:30 sharp.
export function nextWindowSlot(at, tz = DEFAULT_TZ, { jitterKey = null } = {}) {
  const from = new Date(at);
  if (inSendWindow(from, tz)) return from;
  const w = wall(from, tz);
  for (let i = 0; i < 9; i++) {
    const day = new Date(Date.UTC(w.y, w.m - 1, w.d + i));
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const [start] of SEND_WINDOWS) {
      const open = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(start / 60), tz, start % 60);
      if (+open > +from) return new Date(+open + jitterMinutes(jitterKey) * 60000);
    }
  }
  throw new Error("no_send_window");
}

// Primary IANA zone per US state (the zone most of the state uses). Unknown -> Chicago.
const STATE_ZONES = {
  "America/New_York": ["CT", "DE", "DC", "FL", "GA", "KY", "ME", "MD", "MA", "NH", "NJ", "NY", "NC", "OH", "PA", "RI", "SC", "VT", "VA", "WV"],
  "America/Detroit": ["MI"],
  "America/Indiana/Indianapolis": ["IN"],
  "America/Chicago": ["AL", "AR", "IL", "IA", "KS", "LA", "MN", "MS", "MO", "NE", "ND", "OK", "SD", "TN", "TX", "WI"],
  "America/Denver": ["CO", "MT", "NM", "UT", "WY"],
  "America/Boise": ["ID"],
  "America/Phoenix": ["AZ"],
  "America/Los_Angeles": ["CA", "NV", "OR", "WA"],
  "America/Anchorage": ["AK"],
  "Pacific/Honolulu": ["HI"],
};
const STATE_NAMES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const ZONE_BY_CODE = Object.fromEntries(Object.entries(STATE_ZONES).flatMap(([zone, codes]) => codes.map((c) => [c, zone])));

export function stateTimezone(state) {
  const raw = String(state ?? "").trim().replace(/\./g, "");
  if (!raw) return DEFAULT_TZ;
  const code = raw.length === 2 ? raw.toUpperCase() : STATE_NAMES[raw.toLowerCase().replace(/\s+/g, " ")];
  return ZONE_BY_CODE[code] || DEFAULT_TZ;
}

// Email 1. Bid date already passed when the engine first saw the lead: due at that moment.
// Otherwise due on the second business day after the bid. Either way the send waits for the
// next window. The "has passed" test uses the Chicago calendar, like the rest of the CRM.
export function e1DueAt({ bidDate, firstSeenAt, tz = DEFAULT_TZ }) {
  if (!bidDate) return null;
  const { today } = chicagoNow(new Date(firstSeenAt));
  if (bidDate < today) return new Date(firstSeenAt);
  return localMidnight(addBusinessDays(bidDate, 2), tz);
}

// Email 2: about 4 weeks after the newest bid in the batch, and at least 2 weeks after Email 1.
export function e2DueAt({ anchor, e1SentAt, tz = DEFAULT_TZ }) {
  return latest(localMidnight(addDays(anchor, E2_DAYS_AFTER_BID), tz), +new Date(e1SentAt) + MIN_DAYS_BETWEEN_STEPS * DAY_MS);
}

// Email 3: about 6 weeks after the newest bid, and at least 2 weeks after Email 2.
export function e3DueAt({ anchor, e2SentAt, tz = DEFAULT_TZ }) {
  return latest(localMidnight(addDays(anchor, E3_DAYS_AFTER_BID), tz), +new Date(e2SentAt) + MIN_DAYS_BETWEEN_STEPS * DAY_MS);
}

// Nobody gets two emails from us within 3 days: not before 72h after our last email to the
// address from any source, nor within 72h of a sequence step already scheduled near it.
export function applyThreeDayRule(due, { lastOutboundAt = null, nextScheduledAt = null } = {}) {
  const candidates = [new Date(due)];
  if (lastOutboundAt) candidates.push(new Date(+new Date(lastOutboundAt) + THREE_DAYS_MS));
  if (nextScheduledAt) {
    const next = +new Date(nextScheduledAt);
    if (Math.abs(next - +new Date(due)) < THREE_DAYS_MS) candidates.push(new Date(next + THREE_DAYS_MS));
  }
  return latest(...candidates);
}

export const normalRecipient = (email) => String(email ?? "").trim().toLowerCase();

/**
 * Group leads whose Email 1 is due into one batch per recipient address.
 * leads: [{leadId, email, personId, bidDate, shortName, customer}]
 * A batch names up to 3 projects (newest bid first) and covers every lead in it.
 * customer: any lead of the contact is a customer. anchor: newest bid date.
 */
export function buildBatches(leads, { maxNamed = MAX_NAMED_PROJECTS } = {}) {
  const groups = new Map();
  for (const lead of leads) {
    const email = normalRecipient(lead.email);
    if (!email) continue;
    if (!groups.has(email)) groups.set(email, []);
    groups.get(email).push(lead);
  }
  const batches = [];
  for (const [email, list] of groups) {
    const sorted = [...list].sort((a, b) => (a.bidDate === b.bidDate ? String(a.leadId).localeCompare(String(b.leadId)) : a.bidDate < b.bidDate ? 1 : -1));
    // Two leads for the same project name are one project to the reader.
    const named = [];
    const seenNames = new Set();
    for (const lead of sorted) {
      if (named.length >= maxNamed) break;
      const key = String(lead.shortName).toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      named.push(lead);
    }
    batches.push({
      email,
      personId: sorted.find((l) => l.personId)?.personId ?? null,
      leadIds: sorted.map((l) => String(l.leadId)),
      namedLeadIds: named.map((l) => String(l.leadId)),
      names: named.map((l) => l.shortName),
      anchor: sorted[0].bidDate,
      customer: sorted.some((l) => Boolean(l.customer)),
      leads: sorted,
    });
  }
  return batches;
}
