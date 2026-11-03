// Short project name for bid invite follow-up emails. Pure and deterministic, no model call.
// The lead title is already shortened to about 40 characters at import (n8n Clean Phase);
// these rules run on top of that: scope words dropped, SWPPP at the end (Derek, 2026-11-02:
// "UTMB CLC Parking Lot, All Trades" becomes "UTMB CLC Parking Lot SWPPP").
//
// A title is split into segments on , ; | " - " "(" ")" and dashes. A segment that is only a
// scope phrase is dropped. Derek's own rules get appended to SCOPE_SEGMENTS as he sends them.
// When a later segment is an acronym that abbreviates or names the owner spelled out in an
// earlier segment ("University of Texas, UTMB, ..."), the spelled-out owner is dropped:
// "University of Texas, UTMB, CLC parking lot, all trades" -> "UTMB CLC Parking Lot SWPPP".
// Words typed all in lower case get a capital ("parking lot" -> "Parking Lot"), small joining
// words (of, and, the) excepted.

export const SCOPE_SEGMENTS = [
  /all trades/, /all bid packages/, /all packages/, /multiple trades/, /general trades/,
  /bid package \w+/, /bp ?\d+/, /package [a-z0-9]+/, /div(ision)? ?\d+.*/,
  /site ?work/, /site package/, /earthworks?/, /civil/,
  /re-?bid/, /addend(um|a).*/, /itb/, /ifb/, /rfp/, /rfq.*/, /gmp/, /cmar/, /cm at risk/,
  /(sub)?contractor bids?/,
  /swppp/, /storm ?water( pollution prevention plan)?s?/,
];

export const MAX_NAME_LENGTH = 45;
const SPLIT = /\s*(?:[,;|()]|\s[-–—]\s)\s*/;
const isScope = (segment) => {
  const s = segment.toLowerCase().replace(/\s+/g, " ").trim();
  return SCOPE_SEGMENTS.some((re) => new RegExp(`^(?:${re.source})$`, "i").test(s));
};

function capOnWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : text.slice(0, max)).trim();
}

const stripTail = (text) => {
  let s = text;
  for (;;) {
    const next = s.replace(/[\s\-,:;/]+$/, "").replace(/\s+swppp$/i, "").replace(/^swppp$/i, "");
    if (next === s) return s;
    s = next;
  }
};

// An ALL-CAPS title ("UTMB CLC PARKING LOT") reads as shouting in a subject line. Words become
// title case, except known acronyms (ISD, UTMB, TxDOT, TCEQ) and other words of up to 3 letters
// (FM, US, SH), which stay upper case unless they are common short words (Lot, Way, and, of).
// Words with digits ("US59", "SH-288") are left as typed.
const KNOWN_CASE = {
  TXDOT: "TxDOT", DOT: "DOT", ISD: "ISD", CISD: "CISD", UTMB: "UTMB", CLC: "CLC", HOA: "HOA", MUD: "MUD", LLC: "LLC", USACE: "USACE",
  TCEQ: "TCEQ", HCFCD: "HCFCD", YMCA: "YMCA", TAMU: "TAMU", UTSA: "UTSA", UTHSC: "UTHSC", HEB: "HEB", HISD: "HISD", KISD: "KISD",
  CFISD: "CFISD", FBISD: "FBISD", NASA: "NASA", METRO: "METRO", TXST: "TxST", UTEP: "UTEP", HCA: "HCA", VA: "VA", ER: "ER", EMS: "EMS",
  MOB: "MOB", WWTP: "WWTP", WTP: "WTP", HVAC: "HVAC", ADA: "ADA", CMU: "CMU", TI: "TI", UT: "UT", USPS: "USPS", FAA: "FAA", TXU: "TXU",
};
const SHORT_WORDS = new Set(["LOT", "WAY", "NEW", "AVE", "DAM", "GYM", "BAY", "OAK", "SAN", "LAS", "LOS", "DEL", "INN", "HUB", "LAB",
  "ART", "OLD", "BIG", "RED", "SUN", "ELM", "ASH", "FOX", "PAD", "PIT", "TEE", "ZOO", "SPA", "BAR", "BUS", "CAR", "LAW", "MAN", "TOP"]);
const LOWER_WORDS = new Set(["AND", "OF", "THE", "AT", "FOR", "IN", "ON", "TO", "A"]);
const titleWord = (word) => word.toLowerCase().replace(/(^|[-'/])([a-z])/g, (_, a, b) => a + b.toUpperCase());
export function softenCaps(text) {
  if (/[a-z]/.test(text) || !/[A-Z]{2}/.test(text)) return text;
  return text.split(" ").map((word, i) => {
    if (/\d/.test(word)) return word;
    const letters = word.replace(/[^A-Z]/g, "");
    if (KNOWN_CASE[letters] && letters === word.replace(/[^A-Z]/g, "")) return word.replace(letters, KNOWN_CASE[letters]);
    if (LOWER_WORDS.has(word)) return i > 0 ? word.toLowerCase() : titleWord(word);
    if (letters.length <= 3 && !SHORT_WORDS.has(word)) return word;
    return titleWord(word);
  }).join(" ");
}

// An acronym segment: one word, 2 to 8 letters (an "&" allowed), at least 2 capitals and at most
// one lower-case letter ("UTMB", "TxDOT", "HCFCD", "A&M").
const isAcronym = (segment) => /^[A-Za-z&]{2,8}$/.test(segment) && (segment.match(/[A-Z]/g) || []).length >= 2
  && (segment.match(/[a-z]/g) || []).length <= 1;
const JOINING = new Set(["of", "the", "and", "at", "for", "in", "on", "&", "de", "la"]);
// "University of Texas" -> "UT", "Texas Department of Transportation" -> "TDT".
const initialsOf = (segment) => segment.split(/[\s-]+/).filter((w) => w && !JOINING.has(w.toLowerCase()) && /^[A-Za-z]/.test(w))
  .map((w) => w[0].toUpperCase()).join("");
// The acronym's capitals contain the initials in order, starting with the first one:
// UTMB <- University of Texas (U,T), TxDOT <- Texas Department of Transportation (T,D,T),
// KISD <- Katy Independent School District. A one-word segment is never treated as spelled out.
function abbreviates(acronym, segment) {
  const initials = initialsOf(segment);
  if (initials.length < 2 || /\d/.test(segment)) return false;
  const letters = acronym.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters[0] !== initials[0]) return false;
  let i = 0;
  for (const ch of letters) if (ch === initials[i]) i++;
  return i === initials.length;
}
export function dropSpelledOutOwners(segments) {
  const drop = new Set();
  segments.forEach((segment, j) => {
    if (!isAcronym(segment)) return;
    for (let i = 0; i < j; i++) if (!drop.has(i) && !isAcronym(segments[i]) && abbreviates(segment, segments[i])) drop.add(i);
  });
  return segments.filter((_, i) => !drop.has(i));
}

const SMALL_WORDS = new Set(["of", "and", "the", "at", "for", "in", "on", "to", "a", "an", "or", "de", "la", "del", "y"]);
// Only words typed all in lower case: "parking lot" -> "Parking Lot", "wharton" -> "Wharton".
// Mixed or upper case words (TxDOT, iPad, US59) are left as typed.
const capitalizeLower = (text) => text.split(" ").map((word, i) => {
  if (!/^[a-z][a-z'-]*$/.test(word)) return word;
  if (i > 0 && SMALL_WORDS.has(word)) return word;
  return titleWord(word);
}).join(" ");

// Returns "<name> SWPPP", or null when nothing usable is left (fewer than 3 letters).
export function projectShortName(title) {
  if (title == null) return null;
  const clean = String(title).replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const kept = dropSpelledOutOwners(clean.split(SPLIT).map((s) => s.trim()).filter((s) => s && !isScope(s)));
  let name = stripTail(kept.join(" ").replace(/\s+/g, " ").trim());
  name = capitalizeLower(softenCaps(stripTail(capOnWord(name, MAX_NAME_LENGTH))));
  const letters = (name.match(/[a-z]/gi) || []).length;
  if (letters < 3) return null;
  return `${name} SWPPP`;
}
