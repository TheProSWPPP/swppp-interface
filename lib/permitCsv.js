// Pure direct-mail CSV builder (RFC-4180). No I/O.
const HEADERS = ["contact_name","operator_name","mailing_address","city","permit_number","permit_expires","deadline_hook"];

function cell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function buildDirectMailCsv(rows) {
  const out = [HEADERS.join(",")];
  for (const r of rows || []) {
    const exp = r.expiration_date ? String(r.expiration_date).slice(0, 10) : "";
    const hook = exp ? `Your TXR050000 stormwater permit expires ${exp} — is your SWPPP updated?` : "";
    out.push([
      cell(r.contact_name), cell(r.operator_name), cell(r.mailing_address),
      cell(r.city), cell(r.external_permit_nmbr), cell(exp), cell(hook),
    ].join(","));
  }
  return out.join("\n") + "\n";
}
