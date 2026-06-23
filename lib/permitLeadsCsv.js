// Rich direct-mail + cold-call leads CSV for permit operators (Derek's list).
// One row per addressable TX operator (has a TCEQ mailing address), with phone
// (from permit_operator_phone), email (from permit_operator_email), violation
// rollup, and a priority score. Sorted multi-plant-first per Derek's framing.
//
// Pure builder + a query helper. No phone sourcing here — that's permitPhoneFind.js.

const HEADERS = [
  "operator_name", "num_permits", "contact_name", "mailing_address", "city", "state", "zip",
  "sector", "sic_code", "violation", "violation_quarters", "penalties",
  "email", "email_contact", "phone", "phone_source", "tceq_status", "customer_number", "priority_score",
];

function cell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const STREET = /^(ST|DR|RD|BLVD|AVE|LN|CIR|PL|STE|HWY|FM|US|BOX|PO|N|S|E|W|NE|NW|SE|SW|APT|UNIT|RM|FL|SQUARE|SQ|PKWY|CT|WAY|TRL|LOOP|SPUR|HTS)$/i;
function parseAddr(s) {
  if (!s) return { city: "", state: "", zip: "" };
  const m = s.match(/^(.*?)\s+([A-Z]{2})\s+(\d{5})(?:[-\s]\d{4})?\s*$/);
  if (!m) { const z = s.match(/(\d{5})(?:[-\s]\d{4})?\s*$/); return { city: "", state: "", zip: z ? z[1] : "" }; }
  const words = m[1].replace(/[.,]/g, "").split(/\s+/).filter(Boolean);
  const city = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (/\d/.test(w) || STREET.test(w)) break;
    city.unshift(w);
    if (city.length >= 3) break;
  }
  return { city: city.join(" "), state: m[2], zip: m[3] };
}

/** Build the CSV string from the rows returned by getLeadsRows. */
export function buildLeadsCsv(rows) {
  const out = [HEADERS.join(",")];
  for (const x of rows || []) {
    const a = parseAddr(x.mailing_address);
    const contact = x.contact_name || x.email_contact || "";
    out.push([
      x.operator_name, x.facility_count, contact, x.mailing_address, a.city, a.state, a.zip,
      x.sector || "", x.sic_code || "",
      x.has_viol ? "Y" : "N", x.viol_q != null ? x.viol_q : "", x.penalties != null ? x.penalties : "",
      x.email || "", x.email_contact || "", x.phone || "", x.phone_source || "",
      x.tceq_status || "", x.customer_number || "", x.best_score || "",
    ].map(cell).join(","));
  }
  return out.join("\n") + "\n";
}

/** Query the addressable operators with all join fields, sorted multi-plant-first. */
export async function getLeadsRows(pool) {
  const { rows } = await pool.query(`
    WITH enr AS (
      SELECT DISTINCT ON (f.operator_key) f.operator_key, e.contact_name, e.mailing_address,
             e.tceq_status, e.customer_number, e.sector, e.sic_code
        FROM permit_facilities f
        JOIN permit_enrichment e ON e.external_permit_nmbr = f.external_permit_nmbr
       WHERE e.mailing_address <> ''
       ORDER BY f.operator_key, (e.contact_name IS NOT NULL) DESC, length(e.mailing_address) DESC
    ),
    viol AS (
      SELECT operator_key,
        bool_or((compliance_flags->>'vioLast4Q')::numeric>0 OR (compliance_flags->>'penalties')::numeric>0
                OR (compliance_flags->>'cv')::numeric>0 OR (compliance_flags->>'sv')::numeric>0) AS has_viol,
        max((compliance_flags->>'vioLast4Q')::numeric) AS viol_q,
        max((compliance_flags->>'penalties')::numeric) AS penalties
      FROM permit_facilities WHERE state='TX' GROUP BY operator_key
    ),
    em AS (
      SELECT DISTINCT ON (operator_key) operator_key, email, contact_name AS email_contact
        FROM permit_operator_email WHERE email <> '' ORDER BY operator_key, probed_at DESC NULLS LAST
    )
    SELECT o.operator_name, o.facility_count, o.best_score,
           enr.contact_name, enr.mailing_address, enr.tceq_status, enr.customer_number, enr.sector, enr.sic_code,
           em.email, em.email_contact, ph.phone, ph.source AS phone_source,
           COALESCE(viol.has_viol,false) AS has_viol, viol.viol_q, viol.penalties
      FROM permit_operators o
      JOIN enr ON enr.operator_key = o.operator_key
      LEFT JOIN em ON em.operator_key = o.operator_key
      LEFT JOIN permit_operator_phone ph ON ph.operator_key = o.operator_key
      LEFT JOIN viol ON viol.operator_key = o.operator_key
     WHERE o.state='TX'
     ORDER BY o.facility_count DESC, COALESCE(viol.has_viol,false) DESC, o.best_score DESC NULLS LAST`);
  return rows;
}
