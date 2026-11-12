// Bid invite follow-ups: when each email is due, and who gets one email for which projects.
// Pure scheduling, no I/O. The rules are the ones on the client page (Part 1):
//   - nothing before the bid date;
//   - Email 1 right after upload if the bid date has passed, otherwise 2 business days after it;
//   - Email 2 about 4 weeks after the bid, Email 3 about 6 weeks (not customers). Derek's window
//     is 4 to 6 weeks after the bid: Email 2 is kept only if it can go by bid + 56 days and Email 3
//     only if by bid + 70 days. A follow-up that cannot make it is skipped (old bids simply end);
//   - early morning or late afternoon in the recipient's time zone, weekdays only;
//   - several bids for one contact = one email naming up to 3 projects ("and 2 more" for the rest);
//   - at most one bid email per company a Chicago day, across mailboxes;
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
// The last day (after the bid) each follow-up may still go out.
export const E2_LATEST_DAYS_AFTER_BID = 56;
export const E3_LATEST_DAYS_AFTER_BID = 70;
export const THREE_DAYS_MS = 72 * 60 * 60 * 1000;
export const MAX_NAMED_PROJECTS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const latest = (...dates) => dates.filter(Boolean).map((d) => new Date(d)).reduce((a, b) => (+b > +a ? b : a));

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const localMidnight = (ymd, tz) => {
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

// "TX", "tx", "Texas" -> "TX"; anything else (blank, "Ontario", "XX") -> null.
export function stateCode(state) {
  const raw = String(state ?? "").trim().replace(/\./g, "");
  if (!raw) return null;
  const code = raw.length === 2 ? raw.toUpperCase() : STATE_NAMES[raw.toLowerCase().replace(/\s+/g, " ")];
  return ZONE_BY_CODE[code] ? code : null;
}

const COUNTRY_TAIL = /[,\s]+(u\.?s\.?a\.?|u\.?s\.?|united states(?: of america)?)$/i;
const ZIP_TAIL = /[,\s]*\d{5}(-\d{4})?$/;
const NO_PLACE = Object.freeze({ state: null, cityPart: null, sure: false });

/**
 * The state a location names, read only from its end, and the text that may be its city.
 * One reader for the bid sheet import and the bid email, so the two always agree.
 *   "Mobile, AL 36602, USA" -> { state: "AL", cityPart: "Mobile", sure: true }
 *   "Houston TX"            -> { state: "TX", cityPart: "Houston", sure: true }  (capital code, no comma)
 *   "AL", "Alabama, USA"    -> { state: "AL", cityPart: null, sure: true }
 *   "Mobile Alabama", "Mobile al" -> { state: "AL", cityPart: null, sure: false }  (may be "Mount Washington")
 *   "Santa Fe", "Toronto, Ontario", "" -> no state
 * `sure: false` still counts as a state the row names (for a clash with a State column); the email
 * does not use it.
 */
export function parseLocation(text) {
  let raw = String(text ?? "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const before = raw;
    raw = raw.replace(ZIP_TAIL, "").replace(COUNTRY_TAIL, "").replace(/[,\s]+$/, "").trim();
    if (raw === before) break;
  }
  if (!raw || /^(u\.?s\.?a\.?|u\.?s\.?|united states(?: of america)?)$/i.test(raw)) return NO_PLACE;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return NO_PLACE;
  const last = parts[parts.length - 1];
  const whole = stateCode(last);
  if (whole) return { state: whole, cityPart: parts.length > 1 ? parts[parts.length - 2] : null, sure: true };
  // A two-letter code after the city with no comma: capitals are a state ("Houston TX"); lower or
  // mixed case ("Mobile al") is only a maybe.
  const coded = last.match(/^(.*\S)\s+([A-Za-z])\.?([A-Za-z])\.?$/);
  if (coded && stateCode(coded[2] + coded[3])) {
    const caps = (coded[2] + coded[3]) === (coded[2] + coded[3]).toUpperCase();
    return { state: stateCode(coded[2] + coded[3]), cityPart: caps && parts.length === 1 ? coded[1] : null, sure: caps };
  }
  const words = last.split(" ");
  for (const n of [3, 2, 1]) {
    if (words.length <= n) continue;
    const tail = words.slice(-n).join(" ");
    if (tail.replace(/\./g, "").length > 2 && stateCode(tail)) return { state: stateCode(tail), cityPart: null, sure: false };
  }
  return NO_PLACE;
}

export function stateTimezone(state) {
  return ZONE_BY_CODE[stateCode(state)] || DEFAULT_TZ;
}

// US area codes (NANP) by state. Canadian and Caribbean codes are left out on purpose: they
// fall back to Central. Deterministic, no lookup service.
const AREA_CODES = {
  AL: "205 251 256 334 659 938", AK: "907", AZ: "480 520 602 623 928", AR: "327 479 501 870",
  CA: "209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951",
  CO: "303 719 720 970 983", CT: "203 475 860 959", DE: "302", DC: "202 771",
  FL: "239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954",
  GA: "229 404 470 478 678 706 762 770 912 943", HI: "808", ID: "208 986",
  IL: "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872", IN: "219 260 317 463 574 765 812 930",
  IA: "319 515 563 641 712", KS: "316 620 785 913", KY: "270 364 502 606 859", LA: "225 318 337 504 985", ME: "207",
  MD: "227 240 301 410 443 667", MA: "339 351 413 508 617 774 781 857 978", MI: "231 248 269 313 517 586 616 679 734 810 906 947 989",
  MN: "218 320 507 612 651 763 924 952", MS: "228 601 662 769", MO: "235 314 417 557 573 636 660 816 975", MT: "406",
  NE: "308 402 531", NV: "702 725 775", NH: "603", NJ: "201 551 609 640 732 848 856 862 908 973", NM: "505 575",
  NY: "212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934",
  NC: "252 336 472 704 743 828 910 919 980 984", ND: "701", OH: "216 220 234 283 326 330 380 419 436 440 513 567 614 740 937",
  OK: "405 539 572 580 918", OR: "458 503 541 971", PA: "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878", RI: "401",
  SC: "803 821 839 843 854 864", SD: "605", TN: "423 615 629 731 865 901 931",
  TX: "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979",
  UT: "385 435 801", VT: "802", VA: "276 434 540 571 686 703 757 804 826 948", WA: "206 253 360 425 509 564", WV: "304 681",
  WI: "262 274 353 414 534 608 715 920", WY: "307",
};
const STATE_BY_AREA = Object.fromEntries(Object.entries(AREA_CODES).flatMap(([code, list]) => list.split(" ").map((a) => [a, code])));
// Area codes whose zone differs from their state's main zone (El Paso, East Tennessee, West
// Kentucky, Northwest Indiana).
const AREA_ZONE = { 915: "America/Denver", 423: "America/New_York", 865: "America/New_York", 270: "America/Chicago", 364: "America/Chicago", 219: "America/Chicago" };

// "(713) 555-0100", "+1 713-555-0100", "17135550100" -> "713". Anything that is not a 10-digit
// NANP number (after an optional leading 1) -> null.
export function areaCodeOf(phone) {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10 || !/^[2-9]\d{2}[2-9]/.test(digits)) return null;
  return digits.slice(0, 3);
}
export const areaCodeState = (phone) => STATE_BY_AREA[areaCodeOf(phone)] || null;

/**
 * The recipient's time zone: the organization's state, else the contact's phone area code
 * (first US number that maps), else Central. Returns { tz, source: 'state'|'phone'|'default' }.
 */
export function recipientTimezone({ state = null, phones = [] } = {}) {
  if (stateCode(state)) return { tz: stateTimezone(state), source: "state" };
  for (const phone of phones || []) {
    const area = areaCodeOf(phone);
    const code = STATE_BY_AREA[area];
    if (code) return { tz: AREA_ZONE[area] || ZONE_BY_CODE[code], source: "phone", areaCode: area, state: code };
  }
  return { tz: DEFAULT_TZ, source: "default" };
}

// Personal mailbox domains: never a company for the one-email-a-company-a-day rule.
export const FREE_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com", "aol.com", "outlook.com", "hotmail.com",
  "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "bellsouth.net", "cox.net",
  "charter.net", "earthlink.net", "protonmail.com", "proton.me", "mail.com", "gmx.com", "zoho.com", "windstream.net", "frontier.com", "optonline.net"]);
// The company domain of a recipient address, or null for personal mail.
export function companyDomain(email) {
  const domain = String(email ?? "").trim().toLowerCase().split("@")[1] || "";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || FREE_MAIL_DOMAINS.has(domain)) return null;
  return domain;
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

// End of the last day (recipient zone) a follow-up may go: bid + 56 days for Email 2, + 70 for Email 3.
export function followUpDeadline({ anchor, step, tz = DEFAULT_TZ }) {
  const days = step === "e2" ? E2_LATEST_DAYS_AFTER_BID : step === "e3" ? E3_LATEST_DAYS_AFTER_BID : null;
  return days == null ? null : localMidnight(addDays(anchor, days + 1), tz);
}
export const withinFollowUpWindow = ({ anchor, step, at, tz = DEFAULT_TZ }) => {
  const deadline = followUpDeadline({ anchor, step, tz });
  return !deadline || +new Date(at) < +deadline;
};

/**
 * The follow-up after `after` ('e1' or 'e2') was sent at `sentAt`, inside Derek's 4 to 6 week
 * window. Returns { step, dueAt, skipped } where step is null when nothing more goes out.
 * Email 2 that cannot go by bid + 56 is skipped and Email 3 is tried (2 weeks after Email 1);
 * Email 3 that cannot go by bid + 70 is skipped too. dueAt is the send window slot.
 */
export function planFollowUp({ anchor, after, sentAt, tz = DEFAULT_TZ, jitterKey = null }) {
  const skipped = [];
  const slot = (d) => nextWindowSlot(d, tz, { jitterKey });
  if (after === "e1") {
    const e2 = slot(e2DueAt({ anchor, e1SentAt: sentAt, tz }));
    if (withinFollowUpWindow({ anchor, step: "e2", at: e2, tz })) return { step: "e2", dueAt: e2, skipped };
    skipped.push("e2");
  }
  if (after === "e1" || after === "e2") {
    const e3 = slot(e3DueAt({ anchor, e2SentAt: sentAt, tz }));
    if (withinFollowUpWindow({ anchor, step: "e3", at: e3, tz })) return { step: "e3", dueAt: e3, skipped };
    skipped.push("e3");
  }
  return { step: null, dueAt: null, skipped };
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
 * A batch names up to 3 projects (newest bid first) and covers every lead in it. more: how many
 * other projects (distinct names) it covers without naming them ("and 2 more" in the email).
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
    const distinct = new Set(sorted.map((l) => String(l.shortName).toLowerCase()));
    batches.push({
      email,
      more: Math.max(0, distinct.size - named.length),
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
