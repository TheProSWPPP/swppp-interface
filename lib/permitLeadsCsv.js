// Direct-mail + cold-call leads CSV for permit operators (Derek's list).
// One row per addressable TX operator (has a TCEQ mailing address), with phone
// (from permit_operator_phone) and a violation rollup.
//
// Ordered by priority: violation severity first, then how reachable the company is
// (phone + mailing address), then size (# permits) and lead score. So the rows Derek
// should hit first sit at the top.
//
// Pure builder + a query helper. No phone sourcing here — that's permitPhoneFind.js.

const HEADERS = [
  "operator_name", "permit_number", "num_permits", "all_permit_numbers",
  "violation", "violation_quarters", "penalties",
  "phone", "contact_name", "mailing_address", "city", "state", "zip",
  "sector", "tceq_status", "customer_number", "priority_score",
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
    out.push([
      x.operator_name, x.permit_number || "", x.facility_count, x.all_permit_numbers || "",
      x.has_viol ? "Y" : "N", x.viol_q != null ? x.viol_q : "", x.penalties != null ? x.penalties : "",
      x.phone || "", x.contact_name || "", x.mailing_address, a.city, a.state, a.zip,
      x.sector || "", x.tceq_status || "", x.customer_number || "", x.best_score || "",
    ].map(cell).join(","));
  }
  return out.join("\n") + "\n";
}

/** Query the addressable operators, ordered by priority (violation -> reachable -> size). */
export async function getLeadsRows(pool) {
  const { rows } = await pool.query(`
    WITH enr AS (
      SELECT DISTINCT ON (f.operator_key) f.operator_key, e.external_permit_nmbr AS permit_number,
             e.contact_name, e.mailing_address, e.tceq_status, e.customer_number, e.sector
        FROM permit_facilities f
        JOIN permit_enrichment e ON e.external_permit_nmbr = f.external_permit_nmbr
       WHERE e.mailing_address <> ''
       ORDER BY f.operator_key, (e.contact_name IS NOT NULL) DESC, length(e.mailing_address) DESC
    ),
    perms AS (
      SELECT operator_key, string_agg(external_permit_nmbr, '; ' ORDER BY external_permit_nmbr) AS all_permit_numbers
        FROM permit_facilities WHERE state='TX' GROUP BY operator_key
    ),
    viol AS (
      SELECT operator_key,
        bool_or((compliance_flags->>'vioLast4Q')::numeric>0 OR (compliance_flags->>'penalties')::numeric>0
                OR (compliance_flags->>'cv')::numeric>0 OR (compliance_flags->>'sv')::numeric>0) AS has_viol,
        max((compliance_flags->>'pain')::numeric) AS max_pain,
        max((compliance_flags->>'vioLast4Q')::numeric) AS viol_q,
        max((compliance_flags->>'penalties')::numeric) AS penalties
      FROM permit_facilities WHERE state='TX' GROUP BY operator_key
    )
    SELECT o.operator_name, o.facility_count, o.best_score,
           enr.permit_number, perms.all_permit_numbers,
           enr.contact_name, enr.mailing_address, enr.tceq_status, enr.customer_number, enr.sector,
           ph.phone,
           COALESCE(viol.has_viol,false) AS has_viol, viol.viol_q, viol.penalties
      FROM permit_operators o
      JOIN enr ON enr.operator_key = o.operator_key
      LEFT JOIN perms ON perms.operator_key = o.operator_key
      LEFT JOIN permit_operator_phone ph ON ph.operator_key = o.operator_key
      LEFT JOIN viol ON viol.operator_key = o.operator_key
     WHERE o.state='TX'
     ORDER BY
       COALESCE(viol.max_pain, 0) DESC,
       ((CASE WHEN ph.phone IS NOT NULL AND ph.phone <> '' THEN 1 ELSE 0 END)
        + (CASE WHEN enr.mailing_address ~ '\\d{5}' THEN 1 ELSE 0 END)) DESC,
       o.facility_count DESC,
       o.best_score DESC NULLS LAST`);
  return rows;
}
