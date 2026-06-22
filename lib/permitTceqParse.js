// Pure parser for TCEQ wq_dpa "Summary of Authorization" detail pages. No I/O.
// Accepts raw HTML (production plain-fetch) or already-clean text/markdown.

/** Convert TCEQ HTML to line-oriented text so the label parser works on both HTML and markdown. */
function htmlToText(s) {
  return String(s || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|label|legend|td|tr|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#?[a-z0-9]+;/gi, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

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

/**
 * Multi-segment permits return a results LIST page ("Your search returned N records")
 * instead of a detail page. The list has columns:
 * Permit # | Permittee/Applicant | SIC | Segment # | County | Region | City | Site Location.
 * No mailing contact (detail-only), but the operator + site address are mailable.
 */
function parseListPage(html, permit) {
  const rows = String(html).match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || []).map((c) =>
      c.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim()
    );
    // first DATA row = the one whose permit-# cell matches exactly (trim + case-insensitive)
    if (cells[0] && cells[0].trim().toUpperCase() === (permit || "").trim().toUpperCase()) {
      const site = cells[7] || null;
      const zipM = (site || "").match(/\bTX\s+(\d{5})/);
      return {
        permit, found: true, multi_record: true,
        status: "ACTIVE",
        site_name: null,
        operator_name: cells[1] || null,
        customer_number: null,
        contact_name: null,           // not available on the list page
        mailing_address: site,        // mail to the operator at the site address
        site_address: site,
        city: cells[6] ? cells[6].toUpperCase() : null,  // dedicated City column is authoritative
        zip: zipM ? zipM[1] : null,
        sic_code: cells[2] || null,
        sector: null,
      };
    }
  }
  return { permit, found: false, reason: "list_no_rows" };
}

export function parseTceqDetail(text, permit) {
  const raw = String(text || "");
  // Multi-segment permits land on a results list, not a detail page.
  if (/Your search returned\s+\d+\s+record/i.test(raw) && !/Summary of Authorization/i.test(raw)) {
    return parseListPage(raw, permit);
  }
  const t = htmlToText(text);
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
