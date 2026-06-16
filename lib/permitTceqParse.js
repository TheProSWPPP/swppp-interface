// Pure parser for TCEQ wq_dpa "Summary of Authorization" detail pages. No I/O.

/** Grab the text immediately following a label (same line or next non-empty line). */
function after(text, label) {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:?\\s*([^\\n]*)", "i");
  const m = text.match(re);
  if (!m) return null;
  let val = (m[1] || "").trim();
  if (val) return val;
  const idx = m.index + m[0].length;
  const rest = text.slice(idx).split("\n").map((s) => s.trim()).filter(Boolean);
  return rest.length ? rest[0] : null;
}

/** Operator line looks like "CN605404029 - Stephenville Iron And Metal, LLC". */
function splitOperator(raw) {
  if (!raw) return { customer_number: null, operator_name: null };
  const m = raw.match(/(CN\d+)\s*-\s*(.+)/i);
  if (m) return { customer_number: m[1].toUpperCase(), operator_name: m[2].trim() };
  return { customer_number: null, operator_name: raw.trim() };
}

/** "CITY TX 76401 0012" -> { city, zip }. */
function cityZip(addr) {
  if (!addr) return { city: null, zip: null };
  const m = addr.match(/([A-Za-z][A-Za-z .]+?)\s+TX\s+(\d{5})/);
  return m ? { city: m[1].trim().toUpperCase(), zip: m[2] } : { city: null, zip: null };
}

/**
 * Parse the billing block: the line after "Annual Fee Billing Address:" is the
 * contact person; the remaining line(s) up to the next label are the mailing address.
 */
function billing(text) {
  const m = text.match(/Annual Fee Billing Address\s*:?\s*\n?([\s\S]*?)(?:\n\s*(?:Permitted Site Information|Site Location|RN:|Regulated Entity|Permittee))/i);
  if (!m) return { contact_name: null, mailing_address: null };
  const lines = m[1].split("\n").map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { contact_name: null, mailing_address: null };
  const contact = /\d/.test(lines[0]) ? null : lines[0];
  const addrLines = contact ? lines.slice(1) : lines;
  return {
    contact_name: contact,
    mailing_address: addrLines.length ? addrLines.join(", ") : null,
  };
}

export function parseTceqDetail(text, permit) {
  const t = String(text || "");
  const found = /Summary of Authorization/i.test(t);
  if (!found) return { permit, found: false };
  const op = splitOperator(after(t, "Operator"));
  const { contact_name, mailing_address } = billing(t);
  const { city, zip } = cityZip(mailing_address || after(t, "Address"));
  return {
    permit,
    found: true,
    status: after(t, "Authorization Status"),
    site_name: after(t, "Site Name on Permit"),
    operator_name: op.operator_name,
    customer_number: op.customer_number,
    contact_name: contact_name || null,
    mailing_address: mailing_address || null,
    site_address: after(t, "Site Location"),
    city: city || null,
    zip: zip || null,
    sic_code: after(t, "Primary SIC Code"),
    sector: after(t, "sector"),
  };
}
