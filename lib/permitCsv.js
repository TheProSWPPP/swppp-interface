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

export function buildDirectMailCsv(rows) {
  const out = [HEADERS.join(",")];
  for (const r of rows || []) {
    const exp = ymd(r.expiration_date);
    const hook = exp ? `Your TXR050000 stormwater permit expires ${exp} — is your SWPPP updated?` : "";
    out.push([
      cell(r.contact_name), cell(r.operator_name), cell(r.mailing_address),
      cell(r.city), cell(r.external_permit_nmbr), cell(exp), cell(hook),
    ].join(","));
  }
  return out.join("\n") + "\n";
}
