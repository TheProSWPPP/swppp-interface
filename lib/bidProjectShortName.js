// Short project name for bid invite follow-up emails. Pure and deterministic, no model call.
// The lead title is already shortened to about 40 characters at import (n8n Clean Phase);
// these rules run on top of that: scope words dropped, SWPPP at the end (Derek, 2026-11-02:
// "UTMB CLC Parking Lot, All Trades" becomes "UTMB CLC Parking Lot SWPPP").
//
// A title is split into segments on , ; | " - " "(" ")" and dashes. A segment that is only a
// scope phrase is dropped. Derek's own rules get appended to SCOPE_SEGMENTS as he sends them.

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

// Returns "<name> SWPPP", or null when nothing usable is left (fewer than 3 letters).
export function projectShortName(title) {
  if (title == null) return null;
  const clean = String(title).replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const kept = clean.split(SPLIT).map((s) => s.trim()).filter((s) => s && !isScope(s));
  let name = stripTail(kept.join(" ").replace(/\s+/g, " ").trim());
  name = stripTail(capOnWord(name, MAX_NAME_LENGTH));
  const letters = (name.match(/[a-z]/gi) || []).length;
  if (letters < 3) return null;
  return `${name} SWPPP`;
}
