// Permit Engine read + promote API. registerPermitRoutes(app, pool).
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
}
