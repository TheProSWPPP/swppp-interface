import { parseTceqDetail } from "./permitTceqParse.js";
import { fetchTceqDetail } from "./permitTceqFetch.js";

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

/** Enrich up to `cap` promoted facilities. Sequential to be gentle on Browserless + TCEQ. */
export async function enrichBatch(pool, { cap = 50, fetcher = fetchTceqDetail } = {}) {
  const { rows } = await pool.query(
    `SELECT external_permit_nmbr FROM permit_facilities WHERE status='promoted' ORDER BY score DESC LIMIT $1`,
    [cap]
  );
  let ok = 0, fail = 0;
  for (const r of rows) {
    const res = await enrichOne(pool, r.external_permit_nmbr, { fetcher });
    res.ok ? ok++ : fail++;
  }
  return { processed: rows.length, ok, fail };
}
