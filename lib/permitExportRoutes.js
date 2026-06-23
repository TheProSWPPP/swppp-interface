// Self-contained export + phone-find routes for Derek's direct-mail / cold-call list.
// Kept in its own file (registered with one call from server.js) so it never collides
// with the hot permitRoutes.js / the email-only Leads pipeline.
//
//   GET  /api/permits/export/leads-full.csv  -> downloadable rich CSV (one row/operator,
//                                               phone + email + violation + priority)
//   POST /api/permits/phones/find {cap?,operator_keys?} -> fill phones (Apollo+Gemini),
//                                               capped + single-flight (bounded credit spend)
//
// The whole app sits behind basic auth already, so no extra auth here.

import { buildLeadsCsv, getLeadsRows } from "./permitLeadsCsv.js";
import { findPhonesForOperators, ensurePermitPhoneSchema } from "./permitPhoneFind.js";

let _phoneFindInFlight = false;

export function registerPermitExportRoutes(app, pool) {
  // Make sure the phone table exists even before the first find run (CSV LEFT JOINs it).
  if (process.env.DATABASE_URL) ensurePermitPhoneSchema(pool).catch(() => {});

  app.get("/api/permits/export/leads-full.csv", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const rows = await getLeadsRows(pool);
      const csv = buildLeadsCsv(rows);
      res.type("text/csv");
      res.set("Content-Disposition", 'attachment; filename="permit-leads.csv"');
      res.send(csv);
    } catch (err) {
      console.error("GET /api/permits/export/leads-full.csv error:", err);
      res.status(500).json({ error: "Export failed" });
    }
  });

  app.post("/api/permits/phones/find", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (!process.env.APOLLO_API_KEY) return res.status(503).json({ error: "Apollo not configured" });
    if (_phoneFindInFlight) return res.status(409).json({ error: "Phone finder already running" });
    _phoneFindInFlight = true;
    try {
      const result = await findPhonesForOperators(pool, {
        cap: req.body?.cap,
        operatorKeys: req.body?.operator_keys,
      });
      res.json(result);
    } catch (err) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      console.error("POST /api/permits/phones/find error:", err);
      res.status(500).json({ error: "Phone finder failed" });
    } finally {
      _phoneFindInFlight = false;
    }
  });
}
