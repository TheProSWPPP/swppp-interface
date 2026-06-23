import { parseTceqDetail } from "./permitTceqParse.js";
import { fetchTceqDetail } from "./permitTceqFetch.js";
import { findPhonesForOperators } from "./permitPhoneFind.js";

/** Enrich a single promoted facility. fetcher injectable for tests. */
export async function enrichOne(pool, permit, { fetcher = fetchTceqDetail } = {}) {
  const html = await fetcher(permit);
  if (!html) return { ok: false, permit, reason: "fetch_failed" };
  const d = parseTceqDetail(html, permit);
  if (!d.found) return { ok: false, permit, reason: "not_found" };

  await pool.query(
    `INSERT INTO permit_enrichment
       (external_permit_nmbr, customer_number, contact_name, mailing_address, site_address,
        sic_code, sector, channel, tceq_status, source, enriched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'mail',$8,'tceq',NOW())
     ON CONFLICT (external_permit_nmbr) DO UPDATE SET
       customer_number=EXCLUDED.customer_number, contact_name=EXCLUDED.contact_name,
       mailing_address=EXCLUDED.mailing_address, site_address=EXCLUDED.site_address,
       sic_code=EXCLUDED.sic_code, sector=EXCLUDED.sector, tceq_status=EXCLUDED.tceq_status,
       enriched_at=NOW(), updated_at=NOW()`,
    [permit, d.customer_number, d.contact_name, d.mailing_address, d.site_address, d.sic_code, d.sector, d.status]
  );
  await pool.query(
    `UPDATE permit_facilities
       SET status='enriched', city=COALESCE($2, city), sector_code=COALESCE($3, sector_code),
           site_address=COALESCE($4, site_address), updated_at=NOW()
     WHERE external_permit_nmbr=$1`,
    [permit, d.city, d.sic_code, d.site_address]
  );
  return { ok: true, permit, contact_name: d.contact_name, channel: "mail" };
}

/**
 * Enrich up to `cap` facilities from TCEQ, sequentially (gentle on TCEQ).
 *
 * scope:
 *   'promoted' (default) — top promoted permits by score (the UI batch behavior).
 *   'all'                — one best permit per operator that has NO enriched permit
 *                          yet, hottest first. This is the "enrich the whole pool"
 *                          path: every operator gets at least one mailing address.
 *
 * phoneFind: when true (and APOLLO_API_KEY is set), auto-fill phones for the operators
 *   just enriched (Apollo domain-enrich -> Gemini grounded fallback). This is the
 *   auto-wire: newly-enriched operators get a phone lookup without a separate trigger.
 */
export async function enrichBatch(pool, { cap = 50, fetcher = fetchTceqDetail, delayMs = 800, scope = "promoted", phoneFind = false } = {}) {
  const sql = scope === "all"
    ? `SELECT external_permit_nmbr FROM (
         SELECT DISTINCT ON (f.operator_key) f.external_permit_nmbr, f.score
           FROM permit_facilities f
          WHERE f.state='TX' AND f.operator_name IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM permit_enrichment e
              JOIN permit_facilities ff ON ff.external_permit_nmbr = e.external_permit_nmbr
             WHERE ff.operator_key = f.operator_key)
          ORDER BY f.operator_key, f.score DESC
       ) t ORDER BY t.score DESC LIMIT $1`
    : `SELECT external_permit_nmbr FROM permit_facilities WHERE status='promoted' ORDER BY score DESC LIMIT $1`;
  const { rows } = await pool.query(sql, [cap]);

  let ok = 0, fail = 0;
  const enrichedPermits = [];
  for (let i = 0; i < rows.length; i++) {
    const res = await enrichOne(pool, rows[i].external_permit_nmbr, { fetcher });
    if (res.ok) { ok++; enrichedPermits.push(rows[i].external_permit_nmbr); } else { fail++; }
    // Gentle pacing between facilities so TCEQ doesn't throttle rapid datacenter requests.
    if (i < rows.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  // Auto-wire: fill phones for the operators we just enriched. Best-effort — a phone
  // failure must never fail the enrich. Only runs when Apollo is configured (so unit
  // tests, which don't set the key, skip the network entirely).
  let phones = null;
  if (phoneFind && process.env.APOLLO_API_KEY && enrichedPermits.length) {
    try {
      const { rows: opRows } = await pool.query(
        `SELECT DISTINCT operator_key FROM permit_facilities WHERE external_permit_nmbr = ANY($1)`,
        [enrichedPermits]
      );
      const operatorKeys = opRows.map((r) => r.operator_key).filter(Boolean);
      if (operatorKeys.length) phones = await findPhonesForOperators(pool, { operatorKeys });
    } catch (e) {
      console.error("[enrichBatch] phone auto-find failed:", e.message);
    }
  }

  return { processed: rows.length, ok, fail, phones };
}
