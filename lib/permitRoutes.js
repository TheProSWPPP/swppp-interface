// Permit Engine read + promote API. registerPermitRoutes(app, pool).
import { enrichBatch } from "./permitEnrich.js";
import { buildDirectMailCsv } from "./permitCsv.js";
import { engineGateError } from "./permitGate.js";

export function registerPermitRoutes(app, pool) {
  // GET /api/permits/pool?status=&city=&search=&page=1&pageSize=50
  app.get("/api/permits/pool", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
      const params = [];
      const where = [];
      const status = req.query.status;
      if (status) { params.push(status); where.push(`status = $${params.length}`); }
      if (req.query.city) { params.push(req.query.city); where.push(`city ILIKE '%' || $${params.length} || '%'`); }
      if (req.query.search) { params.push(req.query.search); where.push(`operator_name ILIKE '%' || $${params.length} || '%'`); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const totalQ = await pool.query(`SELECT COUNT(*) AS n FROM permit_facilities ${clause}`, params);
      params.push(pageSize); params.push((page - 1) * pageSize);
      const rowsQ = await pool.query(
        `SELECT * FROM permit_facilities ${clause}
         ORDER BY score DESC, operator_name ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      res.json({ rows: rowsQ.rows, total: Number(totalQ.rows[0].n), page, pageSize });
    } catch (err) {
      console.error("GET /api/permits/pool error:", err);
      res.status(500).json({ error: "Failed to list pool" });
    }
  });

  // GET /api/permits/operators?limit=50 — deduped rollup, ranked
  app.get("/api/permits/operators", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
      const { rows } = await pool.query(
        `SELECT * FROM permit_operators ORDER BY best_score DESC LIMIT $1`, [limit]
      );
      res.json({ operators: rows });
    } catch (err) {
      console.error("GET /api/permits/operators error:", err);
      res.status(500).json({ error: "Failed to list operators" });
    }
  });

  // POST /api/permits/promote { ids: [external_permit_nmbr,...] }  OR  { topN: 100 }
  app.post("/api/permits/promote", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const { ids, topN } = req.body || {};
      let result;
      if (Array.isArray(ids) && ids.length) {
        result = await pool.query(
          `UPDATE permit_facilities SET status='promoted', updated_at=NOW()
           WHERE external_permit_nmbr = ANY($1) AND status='pool' RETURNING external_permit_nmbr`,
          [ids]
        );
      } else if (Number.isInteger(topN) && topN > 0) {
        result = await pool.query(
          `UPDATE permit_facilities SET status='promoted', updated_at=NOW()
           WHERE external_permit_nmbr IN (
             SELECT external_permit_nmbr FROM permit_facilities WHERE status='pool'
             ORDER BY score DESC LIMIT $1
           ) RETURNING external_permit_nmbr`,
          [topN]
        );
      } else {
        return res.status(400).json({ error: "Provide ids[] or topN" });
      }
      res.json({ promoted: result.rowCount });
    } catch (err) {
      console.error("POST /api/permits/promote error:", err);
      res.status(500).json({ error: "Failed to promote" });
    }
  });

  // POST /api/permits/enrich { cap?: number }  — enrich promoted batch from TCEQ
  app.post("/api/permits/enrich", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    // No BROWSERLESS_TOKEN gate: plain fetch is the default transport; Browserless is used
    // automatically only if BROWSERLESS_TOKEN is set (see lib/permitTceqFetch.js).
    try {
      const s = await pool.query(`SELECT active FROM permit_engine_settings WHERE id = 1`);
      const gate = engineGateError(s.rows[0]);
      if (gate) return res.status(409).json({ error: gate });
      const cap = Math.min(200, Math.max(1, parseInt(req.body?.cap) || 50));
      const result = await enrichBatch(pool, { cap });
      res.json(result);
    } catch (err) {
      console.error("POST /api/permits/enrich error:", err);
      res.status(500).json({ error: "Enrichment failed" });
    }
  });

  // GET /api/permits/enriched?page=&pageSize= — enriched facilities joined with contact
  app.get("/api/permits/enriched", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
      const totalQ = await pool.query(`SELECT COUNT(*) AS n FROM permit_enrichment`);
      const rowsQ = await pool.query(
        `SELECT f.external_permit_nmbr, f.operator_name, f.city, to_char(f.expiration_date,'YYYY-MM-DD') AS expiration_date, f.score,
                e.contact_name, e.mailing_address, e.sic_code, e.channel
           FROM permit_enrichment e
           JOIN permit_facilities f ON f.external_permit_nmbr = e.external_permit_nmbr
          ORDER BY f.score DESC LIMIT $1 OFFSET $2`,
        [pageSize, (page - 1) * pageSize]
      );
      res.json({ rows: rowsQ.rows, total: Number(totalQ.rows[0].n), page, pageSize });
    } catch (err) {
      console.error("GET /api/permits/enriched error:", err);
      res.status(500).json({ error: "Failed to list enriched" });
    }
  });

  // GET /api/permits/export/direct-mail.csv — download the direct-mail list (channel='mail')
  app.get("/api/permits/export/direct-mail.csv", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const { rows } = await pool.query(
        `SELECT f.external_permit_nmbr, f.operator_name, to_char(f.expiration_date,'YYYY-MM-DD') AS expiration_date,
                e.contact_name, e.mailing_address, f.city
           FROM permit_enrichment e
           JOIN permit_facilities f ON f.external_permit_nmbr = e.external_permit_nmbr
          WHERE e.channel = 'mail' AND e.mailing_address IS NOT NULL
          ORDER BY f.score DESC`
      );
      const csv = buildDirectMailCsv(rows);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="permit-direct-mail.csv"');
      res.send(csv);
    } catch (err) {
      console.error("GET /api/permits/export/direct-mail.csv error:", err);
      res.status(500).json({ error: "Export failed" });
    }
  });

  // GET /api/permits/settings — engine state + per-mailbox flags
  app.get("/api/permits/settings", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const s = await pool.query(`SELECT active, daily_enroll_cap FROM permit_engine_settings WHERE id = 1`);
      const m = await pool.query(`SELECT id, email, display_name, permit_enabled FROM sdr_mailboxes ORDER BY email ASC`);
      res.json({ settings: s.rows[0] || { active: false, daily_enroll_cap: 50 }, mailboxes: m.rows });
    } catch (err) {
      console.error("GET /api/permits/settings error:", err);
      res.status(500).json({ error: "Failed to load settings" });
    }
  });

  // PATCH /api/permits/settings { active?, daily_enroll_cap? }
  app.patch("/api/permits/settings", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const sets = [], params = [];
      if (typeof req.body?.active === "boolean") { params.push(req.body.active); sets.push(`active = $${params.length}`); }
      if (Number.isInteger(req.body?.daily_enroll_cap)) {
        params.push(Math.min(500, Math.max(0, req.body.daily_enroll_cap))); sets.push(`daily_enroll_cap = $${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: "Provide active and/or daily_enroll_cap" });
      sets.push(`updated_at = NOW()`);
      const r = await pool.query(`UPDATE permit_engine_settings SET ${sets.join(", ")} WHERE id = 1 RETURNING active, daily_enroll_cap`, params);
      res.json({ settings: r.rows[0] });
    } catch (err) {
      console.error("PATCH /api/permits/settings error:", err);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // PATCH /api/permits/mailboxes/:id { permit_enabled: boolean }
  app.patch("/api/permits/mailboxes/:id", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (typeof req.body?.permit_enabled !== "boolean") return res.status(400).json({ error: "permit_enabled (boolean) required" });
    try {
      const r = await pool.query(
        `UPDATE sdr_mailboxes SET permit_enabled = $2, updated_at = NOW() WHERE id = $1 RETURNING id, email, permit_enabled`,
        [req.params.id, req.body.permit_enabled]
      );
      if (!r.rowCount) return res.status(404).json({ error: "Mailbox not found" });
      res.json({ mailbox: r.rows[0] });
    } catch (err) {
      console.error("PATCH /api/permits/mailboxes/:id error:", err);
      res.status(500).json({ error: "Failed to update mailbox" });
    }
  });
}
