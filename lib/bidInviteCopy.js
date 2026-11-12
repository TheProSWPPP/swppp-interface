// Bid invite follow-up email copy. Pure.
//
// The wording follows the client page (inboundonsteroids.com/shared/proswppp-plan-37386b43).
// Email 1 for one project is Derek's own rewrite there (2026-11-05): short paragraphs, the
// project's city, the state's own name for a SWPPP (CBMPP in Alabama), "We appreciate it." and
// the sender's signature. The other emails are in the same shape. Change the wording only after
// it changes on that page.
// Two things are NOT on that page and are flagged on every dry-run sample that uses them, so
// Ivan can get Derek's OK first:
//   - E2/E3 for several projects ("checking back on A, B and C");
//   - more than 3 projects for one contact: the first 3 are named, then "and 2 more".
import { stateCode } from "./bidInvitePlan.js";
import { resolveStateTerms } from "./stateGeoTerms.js";

export const GROUPED_SUBJECT = "Your recent bids";
export const FLAG_GROUPED_FOLLOWUP = "grouped_followup_wording_not_on_page";
export const FLAG_MORE_PROJECTS = "more_projects_wording_not_on_page";
export const DEFAULT_TERM = "SWPPP";

// Compared with everything but letters removed, so "N.A.", "n/a" and "N A" are all "na".
const NOT_A_CITY = new Set(["na", "tbd", "tba", "none", "null", "nil", "undefined", "unknown", "notavailable", "notapplicable", "various", "multiple",
  "statewide", "nationwide", "usa", "us", "city", "test"]);
const cityCase = (c) => (c === c.toUpperCase() || c === c.toLowerCase() ? c.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : c);

/**
 * A project address as the import stores it ("Wagoner, OK", "123 Main St, Houston, TX 77002",
 * "Houston TX") -> { city, state, term }. Strict on purpose: the state is read only from the end
 * of the address, never from a two-letter word in the middle. Nothing readable -> no city and
 * the plain word "SWPPP", so an email never names a wrong place or a wrong state's term.
 */
export function projectPlace(address) {
  const none = { city: null, state: null, term: DEFAULT_TERM };
  const parts = String(address ?? "").replace(/\s+/g, " ").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length && /^(usa|us|united states)$/i.test(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return none;
  const last = parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, "").trim();
  let state = stateCode(last);
  let city = state && parts.length >= 2 ? parts[parts.length - 2] : null;
  if (!state) {
    // "Houston TX": a capital two-letter state code after the city, no comma.
    const m = last.match(/^(.*\S)\s+([A-Z]{2})$/);
    if (!m || !stateCode(m[2])) return none;
    state = stateCode(m[2]);
    city = parts.length === 1 ? m[1] : null;
  }
  const okCity = city && /^\p{L}[\p{L} .'-]{1,39}$/u.test(city) && !NOT_A_CITY.has(city.toLowerCase().replace(/[^a-z]/g, ""));
  return { city: okCity ? cityCase(city) : null, state, term: resolveStateTerms(`x, ${state}`).swppp || DEFAULT_TERM };
}

// Words that mean the "name" is a placeholder, a role or a team, not a person: the email then
// opens with "Hey," instead of "Hey Estimating,".
export const NOT_A_NAME = new Set(["n/a", "tbd", "tba", "none", "unknown", "null", "test", "name", "contact", "first", "firstname",
  "estimating", "estimator", "estimators", "estimation", "department", "dept", "office", "team", "bids", "bid", "bidding", "info", "admin",
  "sales", "precon", "preconstruction", "project", "projects", "manager", "accounts", "purchasing", "procurement", "the", "general",
  "construction", "contractor", "operations", "support", "hello", "plans", "planroom"]);
const TITLES = /^(mr|mrs|ms|miss|mx|dr|prof|rev|sir|madam|mister)\.?$/i;
const SUFFIX = /^(jr|sr|ii|iii|iv|v|pe|p\.e|phd|esq|mba|cpa)\.?$/i;

// "rodger caffey" -> "Rodger", "RODGER" -> "Rodger", "Caffey, Rodger" -> "Rodger", "Dr. Jane Doe" -> "Jane".
// Blank, an address, a placeholder (N/A, TBD) or a role ("Estimating Department") -> null, and the
// email opens with "Hey,".
export function firstName(personName) {
  let raw = String(personName ?? "").replace(/\s+/g, " ").trim();
  if (!raw || raw.includes("@")) return null;
  // "NA" alone is a placeholder; "Na" inside a name ("Li Na") is a name.
  if (/^n\.?\s*\/?\s*a\.?$/i.test(raw)) return null;
  // "Last, First" and "Last, First, Jr." (suffix parts dropped first).
  const comma = raw.split(",").map((p) => p.trim()).filter(Boolean).filter((p) => !SUFFIX.test(p));
  if (comma.length === 2 && /[a-z]/i.test(comma[1])) raw = comma[1];
  else if (comma.length === 1) raw = comma[0];
  const words = raw.split(" ").map((w) => w.replace(/^[^\p{L}]+|[^\p{L}'.-]+$/gu, "")).filter(Boolean);
  if (words.some((w) => NOT_A_NAME.has(w.toLowerCase().replace(/\.$/, "")))) return null;
  const first = words.find((w) => !TITLES.test(w)) || "";
  const bare = first.replace(/\.$/, "");
  if (!/^\p{L}[\p{L}'-]*$/u.test(bare) || bare.replace(/[^\p{L}]/gu, "").length < 2) return null;
  const flat = bare === bare.toLowerCase() || bare === bare.toUpperCase();
  return flat ? bare[0].toUpperCase() + bare.slice(1).toLowerCase() : bare;
}

// "A", "A and B", "A, B and C"; with more: "A, B, C and 2 more".
export function joinNames(names, more = 0) {
  const list = names.filter(Boolean);
  const extra = Math.max(0, Math.floor(Number(more) || 0));
  if (extra && list.length) return `${list.join(", ")} and ${extra} more`;
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// "UTMB CLC Parking Lot SWPPP" -> "UTMB CLC Parking Lot": the body names the job, the subject the document.
const bareName = (n) => String(n).replace(/\s+SWPPP$/i, "").trim() || String(n);
const upperFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * step: "e1" | "e2" | "e3". names: short project names, newest bid first (1-3). more: projects
 * the email covers without naming them (a contact with more than 3 bids). addresses: each named
 * project's address, same order as names (blank is fine): gives the city (one project only) and
 * the state's term (only when every named project agrees on it).
 * Returns { subject, bodyText, bodyHtml, flags }. subject is null for E2/E3: they are replies
 * in the E1 thread, so the sender uses "Re: <E1 subject>".
 */
export function renderBidEmail({ step, firstName: first = null, names = [], signature = null, more = 0, addresses = [] }) {
  const list = (names || []).filter(Boolean);
  const extra = Math.max(0, Math.floor(Number(more) || 0));
  if (!list.length) throw new Error("bid_email_needs_a_project_name");
  if (!["e1", "e2", "e3"].includes(step)) throw new Error(`bid_email_unknown_step:${step}`);
  const single = list.length === 1 && !extra;
  const places = list.map((_, i) => projectPlace((addresses || [])[i]));
  const term = places.every((p) => p.term === places[0].term) && !extra ? places[0].term : DEFAULT_TERM;
  const city = single ? places[0].city : null;
  const bare = list.map(bareName);
  const open = (line) => (first ? `${first}, ${line}` : upperFirst(line));
  const flags = [];
  let subject = null;
  let lines;
  if (extra) flags.push(FLAG_MORE_PROJECTS);
  if (step === "e1" && single) {
    subject = term === DEFAULT_TERM ? list[0] : list[0].replace(/SWPPP$/i, term);
    lines = [
      open(`did y'all win this ${bare[0]}${city ? ` over in ${city}` : ""}?`),
      `You should have a bid from us on the ${term}.`,
      "If everything looks good on it, just let us know how quick you need it.",
      "We appreciate it.",
    ];
  } else if (step === "e1") {
    subject = GROUPED_SUBJECT;
    lines = [
      open("did y'all win any of these?"),
      `${bare.join(", ")}${extra ? ` and ${extra} more` : ""}.`,
      "You should have a bid from us on each one.",
      "If everything looks good on them, just let us know how quick you need them.",
      "We appreciate it.",
    ];
  } else {
    if (!single) flags.push(FLAG_GROUPED_FOLLOWUP);
    const what = single ? `this ${bare[0]}${city && step === "e2" ? ` over in ${city}` : ""}` : joinNames(bare, extra);
    lines = step === "e2"
      ? [open(`checking back on ${what}.`), `If it went your way, we can have the ${term} ready before you mobilize.`]
      : [open(`last one on ${what}.`), `If you won it, let's get the ${term} going. If not, we'll get 'em on the next one.`];
  }
  const sig = String(signature ?? "").replace(/\r\n/g, "\n").trim();
  const bodyText = [...lines, ...(sig ? [sig] : [])].join("\n\n");
  // Plain HTML, no tracking pixel, so it reads like a person typed it.
  const bodyHtml = `<div>${escapeHtml(bodyText).replace(/\n/g, "<br>")}</div>`;
  return { subject, bodyText, bodyHtml, flags };
}

export const replySubject = (firstSubject) => (/^re:/i.test(String(firstSubject || "")) ? firstSubject : `Re: ${firstSubject}`);
