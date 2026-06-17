// Pure direct-mail CSV builder (RFC-4180). No I/O.
const HEADERS = ["contact_name","operator_name","mailing_address","city","permit_number","permit_expires","deadline_hook"];

function cell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Format a date as YYYY-MM-DD whether it arrives as a string or a Date object
 *  (pg returns DATE columns as Date; String(Date) would yield "Thu Aug 13 ..."). */
function ymd(v) {
  if (!v) return "";
  if (v instanceof Date) {
    const y = v.getUTCFullYear(), m = String(v.getUTCMonth() + 1).padStart(2, "0"), d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

// Generic attention line so a piece still routes when TCEQ has no named billing contact
// (multi-record list pages give an operator + address but no person).
const DEFAULT_ADDRESSEE = "SWPPP / Environmental Manager";

/** Mailable only if the address carries a 5-digit ZIP. Some TCEQ "Site Location"
 *  values are narrative directions ("LOCATED APPROX 1.5 MILES EAST OF...") — undeliverable. */
function isMailable(addr) {
  return /\d{5}/.test(String(addr || ""));
}

export function buildDirectMailCsv(rows) {
  const out = [HEADERS.join(",")];
  for (const r of rows || []) {
    if (!isMailable(r.mailing_address)) continue; // skip undeliverable narrative addresses
    const exp = ymd(r.expiration_date);
    const hook = exp ? `Your TXR050000 stormwater permit expires ${exp} — is your SWPPP updated?` : "";
    const addressee = String(r.contact_name || "").trim() || DEFAULT_ADDRESSEE;
    out.push([
      cell(addressee), cell(r.operator_name), cell(r.mailing_address),
      cell(r.city), cell(r.external_permit_nmbr), cell(exp), cell(hook),
    ].join(","));
  }
  return out.join("\n") + "\n";
}
