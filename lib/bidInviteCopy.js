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
import { parseLocation } from "./bidInvitePlan.js";
import { resolveStateTerms } from "./stateGeoTerms.js";

export const GROUPED_SUBJECT = "Your recent bids";
export const FLAG_GROUPED_FOLLOWUP = "grouped_followup_wording_not_on_page";
export const FLAG_MORE_PROJECTS = "more_projects_wording_not_on_page";
export const DEFAULT_TERM = "SWPPP";

// Compared with everything but letters removed, so "N.A.", "n/a" and "N A" are all "na".
const NOT_A_CITY = new Set(["na", "tbd", "tba", "none", "null", "nil", "undefined", "unknown", "notavailable", "notapplicable", "various", "multiple",
  "statewide", "nationwide", "usa", "us", "unitedstates", "unitedstatesofamerica", "city", "test"]);
const cityCase = (c) => (c === c.toUpperCase() || c === c.toLowerCase() ? c.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : c);

/**
 * A project address as the import stores it ("Wagoner, OK", "123 Main St, Houston, TX 77002",
 * "Houston TX") -> { city, state, term }. Strict on purpose (parseLocation): the state is read
 * only from the end of the address. Nothing clear -> no city and the plain word "SWPPP", so an
 * email never names a wrong place or a wrong state's term. Two different states in one address
 * give no state. A city that itself names a state, is a placeholder, a county or a street is left out.
 */
// Words that mean the text is an area or a street, not a city ("Mobile County", "Greater Houston
// Area", "Main Street").
const NOT_CITY_WORD = /\b(county|cnty|parish|borough|township|twp|area|region|district|metro|downtown|various|multiple|locations?|sites?|statewide|nationwide|plans?|drawings?|specs?|attached|see|refer|per)\b/i;
const STREET_END = /\s(street|st|road|rd|avenue|ave|boulevard|blvd|highway|hwy|drive|dr|lane|ln|way|parkway|pkwy|court|ct|circle|cir|trail|trl|place|pl|loop|plaza|terrace|suite|ste)\.?$/i;
function cityName(text) {
  const city = String(text ?? "").trim();
  if (!/^\p{L}[\p{L} .'-]{1,39}$/u.test(city)) return null;
  if (NOT_A_CITY.has(city.toLowerCase().replace(/[^a-z]/g, "")) || NOT_CITY_WORD.test(city) || STREET_END.test(city)) return null;
  // A "city" that itself names a state ("Mobile AL", "Alabama") is not printed.
  const inner = parseLocation(city);
  return inner.state || inner.clash ? null : cityCase(city);
}

export function projectPlace(address) {
  const loc = parseLocation(address);
  if (!loc.state || !loc.sure) return { city: null, state: null, term: DEFAULT_TERM };
  return { city: cityName(loc.cityPart), state: loc.state, term: resolveStateTerms(`x, ${loc.state}`).swppp || DEFAULT_TERM };
}

const letterCount = (t) => (String(t).match(/\p{L}/gu) || []).length;
const trimJoin = (t) => t.replace(/[\s,(\[\-\u2013\u2014|/:@]+$/, "").trim();
// A name that ends in one of these belongs with the place that follows it: "University of" +
// Houston, "Port" + Charlotte, "North" + Richland. Cutting the place off would break the name.
const BINDS_TO_PLACE = new Set(["of", "at", "in", "on", "the", "for", "and", "to", "near", "by", "de", "del", "la", "las", "los", "el", "san", "santa",
  "st", "saint", "port", "lake", "fort", "ft", "mount", "mt", "new", "old", "north", "south", "east", "west", "n", "s", "e", "w", "upper", "lower",
  "greater", "downtown", "city", "town", "village", "university", "college", "county", "point", "cape", "glen", "grand", "little", "big"]);
// The last word as typed, less a closing dot or comma: "LA11048" is a store number, not "la".
const endsBound = (t) => /&$/.test(t) || BINDS_TO_PLACE.has((t.split(/\s+/).pop() || "").toLowerCase().replace(/[.,]+$/, ""));
/**
 * The place is said once. A project name that ends in the city the email is about to print
 * ("7-Eleven Florence SC" + Florence) loses that ending: "this 7-Eleven over in Florence".
 * A name that has the city anywhere else ("City of Ocala Fire Station" + Ocala), or that would be
 * broken by the cut ("University of Houston"), already says where the job is: it stays whole and
 * "over in" is left out. A name at the length cap that ends in the first whole words of the city
 * ("... Carwash- La" + La Porte) was cut inside the place and loses that piece.
 * -> { name, say }: the name to print and whether to add "over in <city>".
 */
function nameForCity(name, city, state) {
  if (!city) return { name, say: false };
  const text = String(name);
  // "St. Johns" also matches "St Johns" and "St .Johns".
  const tokens = city.split(/[\s.]+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const word = `(?<!\\p{L})${tokens.join("[\\s.]+")}(?!\\p{L})`;
  const has = (t) => new RegExp(word, "iu").test(t);
  const end = text.match(new RegExp(`^(.*)${word}[\\s,.)\\]]*([\\p{L}. ]*?)[\\s.)\\]]*$`, "iu"));
  if (end && (!end[2].trim() || parseLocation(end[2].trim()).state === state)) {
    const cut = trimJoin(end[1]);
    if (letterCount(cut) < 3 || endsBound(cut)) return { name: text, say: false };
    // "Maple Grove Storage Maple Grove MN": the place goes, the name still says it.
    return { name: cut, say: !has(cut) };
  }
  if (has(text)) return { name: text, say: false };
  // Names are capped at 45 characters on a word; one that long ending in the first whole words of
  // a longer city name was cut inside the place.
  const cityWords = city.toLowerCase().replace(/\./g, "").split(/\s+/);
  if (text.length >= 38 && cityWords.length > 1) {
    const words = text.split(" ");
    for (let n = Math.min(cityWords.length - 1, words.length - 1); n >= 1; n--) {
      if (words.slice(-n).join(" ").toLowerCase().replace(/\./g, "") !== cityWords.slice(0, n).join(" ")) continue;
      const cut = trimJoin(words.slice(0, -n).join(" "));
      if (letterCount(cut) < 3 || endsBound(cut)) return { name: text, say: false };
      return { name: cut, say: true };
    }
  }
  return { name: text, say: true };
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
  const shown = single ? nameForCity(bare[0], city, places[0].state) : { name: bare[0], say: false };
  const over = shown.say ? ` over in ${city}` : "";
  const open = (line) => (first ? `${first}, ${line}` : upperFirst(line));
  const flags = [];
  let subject = null;
  let lines;
  if (extra) flags.push(FLAG_MORE_PROJECTS);
  if (step === "e1" && single) {
    subject = term === DEFAULT_TERM ? list[0] : list[0].replace(/SWPPP$/i, term);
    lines = [
      open(`did y'all win this ${shown.name}${over}?`),
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
    const what = single ? (step === "e2" ? `this ${shown.name}${over}` : `this ${bare[0]}`) : joinNames(bare, extra);
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
