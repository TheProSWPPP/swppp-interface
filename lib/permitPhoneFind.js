// Phone finder for permit operators (direct-mail + cold-call list).
//
// TCEQ (wq_dpa) and the TCEQ Central Registry public web view do NOT expose phone
// numbers, and Apollo's company-name search matches these small industrial operators
// only ~8% of the time. Two sources actually work here:
//   1. Apollo /organizations/enrich by a KNOWN domain  -> org main line (~90% when a
//      domain exists; we already store domains in permit_operator_email). High trust.
//   2. Gemini grounded Google Search by company name + city -> web-sourced phone
//      (covers the small local operators Apollo can't see). Lower trust; tagged so
//      Derek knows it came from the web, not a verified record.
//
// Idempotent: only fills operators that don't already have a phone, capped per call,
// persists to permit_operator_phone so we never re-spend on the same company.

export async function ensurePermitPhoneSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS permit_operator_phone (
    operator_key text PRIMARY KEY,
    phone        text,
    org_name     text,
    domain       text,
    source       text,          -- apollo_org_enrich | gemini_grounded
    found_at     timestamptz DEFAULT now()
  )`);
}

const LEGAL_SUFFIX = /\b(l\.?l\.?c|l\.?l\.?p|l\.?p|inc(orporated)?|corp(oration)?|co|ltd|limited|plc|pllc)\b\.?/gi;
const cleanCompany = (n) => String(n || "").replace(/[&,./]/g, " ").replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
const STREET = /^(ST|DR|RD|BLVD|AVE|LN|CIR|PL|STE|HWY|FM|US|BOX|PO|N|S|E|W|NE|NW|SE|SW|APT|UNIT|RM|FL|SQUARE|SQ|PKWY|CT|WAY|TRL|LOOP|SPUR|HTS)$/i;

/** Best-effort city from a USPS-style one-line address ("... HOUSTON TX 77036 6565"). */
function cityFrom(addr) {
  const m = String(addr || "").match(/^(.*?)\s+([A-Z]{2})\s+\d{5}/);
  if (!m) return "";
  const words = m[1].replace(/[.,]/g, "").split(/\s+/).filter(Boolean);
  const city = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (/\d/.test(w) || STREET.test(w)) break;
    city.unshift(w);
    if (city.length >= 3) break;
  }
  return city.join(" ");
}

/** Normalize any phone string to "(XXX) XXX-XXXX"; null if not a plausible US 10-digit. */
export function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length !== 10) return null;
  if (/^(0|1)/.test(d) || /^555/.test(d.slice(3)) || d === "0000000000") return null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

async function apolloOrgPhone(domain) {
  if (!domain) return "";
  const u = new URL("https://api.apollo.io/v1/organizations/enrich");
  u.searchParams.set("domain", domain);
  const r = await fetch(u, { headers: { "X-Api-Key": process.env.APOLLO_API_KEY, "Content-Type": "application/json", "Cache-Control": "no-cache" } });
  if (!r.ok) return "";
  const d = await r.json().catch(() => ({}));
  const o = d.organization || {};
  return o.sanitized_phone || o.phone || o.primary_phone?.number || "";
}

async function geminiPhone(name, city) {
  if (!process.env.GEMINI_API_KEY) return "";
  const prompt = `Find the main business phone number for the company "${name}"${city ? ` located near ${city}, Texas` : " in Texas"} (an industrial or construction operator holding a Texas stormwater permit). Reply with ONLY the phone number formatted as (XXX) XXX-XXXX, or exactly NONE if you cannot find a confident match.`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
  });
  if (!r.ok) return "";
  const d = await r.json().catch(() => ({}));
  return (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

/**
 * Fill phones for addressable operators that don't have one yet. Hottest-first.
 * @param {object} pool pg pool
 * @param {{cap?:number, operatorKeys?:string[]|null, useGemini?:boolean}} opts
 * @returns {Promise<{checked:number, apollo:number, gemini:number, none:number}>}
 */
export async function findPhonesForOperators(pool, { cap = 50, operatorKeys = null, useGemini = true } = {}) {
  if (!process.env.APOLLO_API_KEY) { const e = new Error("Apollo not configured."); e.status = 503; throw e; }
  await ensurePermitPhoneSchema(pool);

  const keys = Array.isArray(operatorKeys) && operatorKeys.length ? operatorKeys : null;
  const limit = keys ? Math.min(400, keys.length) : Math.min(400, Math.max(1, parseInt(cap, 10) || 50));

  // Addressable operators (have a TCEQ mailing address) without a stored phone, hottest first.
  // Join the best stored domain (if any) from permit_operator_email for the cheap Apollo path.
  const { rows } = await pool.query(
    `WITH enr AS (
       SELECT DISTINCT ON (f.operator_key) f.operator_key, e.mailing_address
         FROM permit_facilities f
         JOIN permit_enrichment e ON e.external_permit_nmbr = f.external_permit_nmbr
        WHERE e.mailing_address <> ''
        ORDER BY f.operator_key, length(e.mailing_address) DESC
     ),
     dom AS (
       SELECT DISTINCT ON (operator_key) operator_key, domain
         FROM permit_operator_email
        WHERE domain <> '' AND domain LIKE '%.%' AND length(split_part(domain,'.','1')) >= 3
        ORDER BY operator_key
     )
     SELECT o.operator_key, o.operator_name, o.best_score, enr.mailing_address, dom.domain
       FROM permit_operators o
       JOIN enr ON enr.operator_key = o.operator_key
       LEFT JOIN dom ON dom.operator_key = o.operator_key
       LEFT JOIN permit_operator_phone p ON p.operator_key = o.operator_key
      WHERE o.state = 'TX' AND p.operator_key IS NULL
        ${keys ? "AND o.operator_key = ANY($1::text[])" : ""}
      ORDER BY o.best_score DESC NULLS LAST, o.facility_count DESC
      LIMIT ${keys ? "$2" : "$1"}`,
    keys ? [keys, limit] : [limit],
  );

  let apollo = 0, gemini = 0, none = 0;
  for (const op of rows) {
    let phone = "", source = "", domain = op.domain || "";
    try {
      if (domain) phone = normalizePhone(await apolloOrgPhone(domain)) || "";
      if (phone) source = "apollo_org_enrich";
      else if (useGemini) {
        const g = await geminiPhone(op.operator_name, cityFrom(op.mailing_address));
        phone = normalizePhone(g) || "";
        if (phone) source = "gemini_grounded";
      }
    } catch { /* skip on error */ }

    if (phone) {
      await pool.query(
        `INSERT INTO permit_operator_phone (operator_key, phone, org_name, domain, source)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (operator_key) DO UPDATE SET phone=EXCLUDED.phone, org_name=EXCLUDED.org_name,
           domain=EXCLUDED.domain, source=EXCLUDED.source, found_at=now()`,
        [op.operator_key, phone, op.operator_name, domain, source],
      );
      if (source === "apollo_org_enrich") apollo++; else gemini++;
    } else {
      none++;
      // Record a "none found" marker (empty phone) so we never re-probe / re-spend on
      // this operator. Mirrors permit_operator_email's null-email discard. The selection
      // below excludes any operator that already has a row, found or not.
      await pool.query(
        `INSERT INTO permit_operator_phone (operator_key, phone, org_name, source)
         VALUES ($1, '', $2, 'none_found') ON CONFLICT (operator_key) DO NOTHING`,
        [op.operator_key, op.operator_name],
      );
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return { checked: rows.length, apollo, gemini, none };
}
