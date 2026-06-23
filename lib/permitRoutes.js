// Permit Engine read + promote API. registerPermitRoutes(app, pool).
import { enrichBatch } from "./permitEnrich.js";
import { createSequence } from "./apolloClient.js";
import { companyKey, crossRefIndex } from "./permitMatch.js";
import { findEmailsForPromoted } from "./permitEmailFind.js";
import {
  ensurePermitDraftSchema,
  generatePermitDrafts,
  listPermitDrafts,
  editPermitDraft,
  rejectPermitDraft,
  approveAndSendPermitDraft,
} from "./permitDrafts.js";

// Cross-ref cache: maps soft company keys to customer/CRM sets (5-min TTL)
let _crossRefCache = null;
let _crossRefAt = 0;
const CROSS_REF_TTL_MS = 5 * 60 * 1000;

// Single-flight guard for the TCEQ enrichment batch (prevents parallel IP-ban risk)
let _enrichInFlight = false;
// Single-flight guard for the Apollo email-finder (prevents parallel credit burn)
let _findEmailsInFlight = false;

async function getCrossRefSets(pool) {
  const now = Date.now();
  if (_crossRefCache && now - _crossRefAt < CROSS_REF_TTL_MS) return _crossRefCache;

  let custSet = new Set();
  let crmSet = new Set();

  try {
    const { rows } = await pool.query(
      `SELECT name FROM projects WHERE archived = false AND name IS NOT NULL`
    );
    custSet = crossRefIndex(rows, (r) => r.name);
  } catch (e) {
    console.error("[cross-ref] projects query failed:", e.message);
  }

  try {
    const { rows } = await pool.query(
      `SELECT lead_title FROM sdr_lead_state WHERE lead_title IS NOT NULL`
    );
    crmSet = crossRefIndex(rows, (r) => r.lead_title);
  } catch (e) {
    console.error("[cross-ref] sdr_lead_state query failed:", e.message);
  }

  _crossRefCache = { custSet, crmSet };
  _crossRefAt = now;
  return _crossRefCache;
}

/** Map max_pain score to compliance tier label. */
function complianceTier(maxPain) {
  if (maxPain >= 18) return "snc";
  if (maxPain >= 12) return "violation";
  if (maxPain > 0) return "inspected";
  return "clean";
}

/** Map aggregated operator row to stage label. Email-only: a picked company gets
 *  probed for an email — found = email_ready, none = discarded (hidden by default). */
function operatorStage(row) {
  if (row.mailed) return "mailed";
  if (row.emailable) return "email_ready";
  if (row.discarded) return "discarded";
  if (row.any_promoted) return "promoted";
  return "pool";
}

export function registerPermitRoutes(app, pool) {
  // Bootstrap the permit-draft queue schema (permit_drafts/permit_sends/permit_operator_email).
  // Idempotent; lives here so the feature is self-contained in its own files.
  ensurePermitDraftSchema(pool).catch((e) =>
    console.error("[permit-drafts] schema bootstrap failed:", e.message),
  );

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

  // GET /api/permits/operators-list — operator-centric list with filters, funnel counts, soft cross-ref
  app.get("/api/permits/operators-list", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
      const offset = (page - 1) * pageSize;

      const stage = req.query.stage || "all";         // pool|promoted|enriched|mailed|all
      const compliance = req.query.compliance || "all"; // snc|violation|any|all
      const hideContacted = req.query.hideContacted;   // any truthy string
      const search = req.query.search || "";

      // Build dynamic WHERE and HAVING clauses
      const params = [];

      // Base WHERE: TX state only
      const where = [`f.state = 'TX'`];

      // Search filter in WHERE (on operator_name)
      if (search) {
        params.push(`%${search}%`);
        where.push(`f.operator_name ILIKE $${params.length}`);
      }

      const whereClause = `WHERE ${where.join(" AND ")}`;

      // HAVING clauses (built after GROUP BY)
      const having = [];

      // Compliance filter
      if (compliance === "snc") {
        having.push(`COALESCE(MAX((f.compliance_flags->>'pain')::int), 0) >= 18`);
      } else if (compliance === "violation") {
        having.push(`COALESCE(MAX((f.compliance_flags->>'pain')::int), 0) >= 12`);
      } else if (compliance === "any") {
        having.push(`COALESCE(MAX((f.compliance_flags->>'pain')::int), 0) > 0`);
      }

      // Stage filter (all in HAVING via subquery conditions). Email-only + mutually
      // exclusive: pick a company -> probe for an email -> email_ready (found) or
      // discarded (none). Discarded is hidden everywhere except its own chip.
      const HAS_EMAIL = `EXISTS (SELECT 1 FROM permit_operator_email pe WHERE pe.operator_key = f.operator_key AND pe.email IS NOT NULL AND pe.email <> '')`;
      const IS_DISCARDED = `EXISTS (SELECT 1 FROM permit_operator_email pe WHERE pe.operator_key = f.operator_key AND (pe.email IS NULL OR pe.email = ''))`;
      const PROBED = `EXISTS (SELECT 1 FROM permit_operator_email pe WHERE pe.operator_key = f.operator_key)`;
      if (stage === "pool") {
        having.push(`BOOL_OR(f.status IN ('promoted','enriched')) = false`);
      } else if (stage === "promoted") {
        having.push(`BOOL_OR(f.status IN ('promoted','enriched')) = true AND NOT ${PROBED}`);
      } else if (stage === "email_ready") {
        having.push(HAS_EMAIL);
      } else if (stage === "discarded") {
        having.push(IS_DISCARDED);
      } else if (stage === "mailed") {
        having.push(
          `EXISTS (SELECT 1 FROM permit_outreach o WHERE o.operator_key = f.operator_key AND o.status IN ('mailed','emailed'))`
        );
      }
      // Hide discarded (probed, no email) from every view except the Discarded chip.
      if (stage !== "discarded") having.push(`NOT ${IS_DISCARDED}`);

      // hideContacted filter
      if (hideContacted) {
        having.push(
          `(SELECT COUNT(*) FROM permit_outreach o WHERE o.operator_key = f.operator_key) = 0`
        );
      }

      const havingClause = having.length ? `HAVING ${having.join(" AND ")}` : "";

      // Main aggregate query
      const aggSql = `
        SELECT f.operator_key,
               MIN(f.operator_name) AS operator_name,
               COUNT(*) AS permit_count,
               COALESCE(MAX((f.compliance_flags->>'pain')::int), 0) AS max_pain,
               MAX(f.score) AS best_score,
               MIN(f.expiration_date) AS earliest_expiry,
               BOOL_OR(f.status = 'enriched') AS any_enriched,
               BOOL_OR(f.status IN ('promoted','enriched')) AS any_promoted,
               (SELECT COUNT(*) FROM permit_outreach o WHERE o.operator_key = f.operator_key) AS outreach_count,
               (SELECT MAX(created_at) FROM permit_outreach o WHERE o.operator_key = f.operator_key) AS last_outreach_at,
               EXISTS(
                 SELECT 1 FROM permit_outreach o
                 WHERE o.operator_key = f.operator_key
                   AND o.status IN ('mailed','emailed')
               ) AS mailed,
               EXISTS(
                 SELECT 1 FROM permit_operator_email pe
                 WHERE pe.operator_key = f.operator_key
                   AND pe.email IS NOT NULL AND pe.email <> ''
               ) AS emailable,
               EXISTS(
                 SELECT 1 FROM permit_operator_email pe
                 WHERE pe.operator_key = f.operator_key
                   AND (pe.email IS NULL OR pe.email = '')
               ) AS discarded
          FROM permit_facilities f
          ${whereClause}
         GROUP BY f.operator_key
         ${havingClause}
         ORDER BY max_pain DESC, best_score DESC`;

      // Total count query (wrap aggregate in subquery)
      const countSql = `SELECT COUNT(*) AS n FROM (${aggSql}) t`;

      // Paginated data query
      params.push(pageSize);
      params.push(offset);
      const dataSql = `${aggSql} LIMIT $${params.length - 1} OFFSET $${params.length}`;

      // Execute count + data (params are shared — same param list up to pageSize/offset)
      // Count uses params up to (length-2), data uses all params
      const countParams = params.slice(0, params.length - 2);
      const [countResult, dataResult, complianceFreshnessResult] = await Promise.all([
        pool.query(countSql, countParams),
        pool.query(dataSql, params),
        pool.query(
          `SELECT to_char(max(updated_at), 'YYYY-MM-DD') AS last_refreshed
             FROM permit_facilities WHERE compliance_flags ? 'pain'`
        ),
      ]);

      let operators = dataResult.rows;

      // Load cross-ref sets
      const { custSet, crmSet } = await getCrossRefSets(pool);

      // Annotate each operator
      operators = operators.map((r) => ({
        ...r,
        permit_count: Number(r.permit_count),
        max_pain: Number(r.max_pain),
        best_score: r.best_score != null ? Number(r.best_score) : null,
        outreach_count: Number(r.outreach_count),
        emailable: r.emailable === true,
        discarded: r.discarded === true,
        stage: operatorStage(r),
        compliance_tier: complianceTier(Number(r.max_pain)),
        possible_customer: custSet.has(companyKey(r.operator_name)),
        possible_crm: crmSet.has(companyKey(r.operator_name)),
        contacted: Number(r.outreach_count) > 0,
      }));

      // Funnel counts: per-operator status rollup (lightweight single query).
      // Email-only + mutually exclusive (matches operatorStage precedence).
      let counts = { pool: 0, promoted: 0, email_ready: 0, discarded: 0, mailed: 0 };
      try {
        const funnelSql = `
          SELECT f.operator_key,
                 BOOL_OR(f.status IN ('promoted','enriched')) AS any_promoted,
                 EXISTS(
                   SELECT 1 FROM permit_outreach o
                   WHERE o.operator_key = f.operator_key
                     AND o.status IN ('mailed','emailed')
                 ) AS mailed,
                 EXISTS(
                   SELECT 1 FROM permit_operator_email pe
                   WHERE pe.operator_key = f.operator_key
                     AND pe.email IS NOT NULL AND pe.email <> ''
                 ) AS emailable,
                 EXISTS(
                   SELECT 1 FROM permit_operator_email pe
                   WHERE pe.operator_key = f.operator_key
                     AND (pe.email IS NULL OR pe.email = '')
                 ) AS discarded
            FROM permit_facilities f
           WHERE f.state = 'TX'
           GROUP BY f.operator_key`;
        const funnelResult = await pool.query(funnelSql);
        for (const r of funnelResult.rows) {
          if (r.mailed) counts.mailed++;
          else if (r.emailable) counts.email_ready++;
          else if (r.discarded) counts.discarded++;
          else if (r.any_promoted) counts.promoted++;
          else counts.pool++;
        }
      } catch (e) {
        console.error("[operators-list] funnel counts failed:", e.message);
      }

      const total = Number(countResult.rows[0].n);
      const compliance_last_refreshed = complianceFreshnessResult.rows[0]?.last_refreshed || null;

      res.json({ operators, total, page, pageSize, counts, compliance_last_refreshed });
    } catch (err) {
      console.error("GET /api/permits/operators-list error:", err);
      res.status(500).json({ error: "Failed to list operators" });
    }
  });

  // GET /api/permits/operator/:operatorKey — full operator detail (permits + enrichment + outreach)
  app.get("/api/permits/operator/:operatorKey", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const opKey = req.params.operatorKey;

      // Summary aggregate for this operator
      const summaryResult = await pool.query(
        `SELECT f.operator_key,
                MIN(f.operator_name) AS operator_name,
                COUNT(*) AS permit_count,
                COALESCE(MAX((f.compliance_flags->>'pain')::int), 0) AS max_pain,
                MAX(f.score) AS best_score
           FROM permit_facilities f
          WHERE f.operator_key = $1
          GROUP BY f.operator_key`,
        [opKey]
      );
      if (!summaryResult.rows.length) {
        return res.status(404).json({ error: "Operator not found" });
      }
      const summary = summaryResult.rows[0];

      // Cross-ref annotation
      const { custSet, crmSet } = await getCrossRefSets(pool);
      const operator = {
        ...summary,
        permit_count: Number(summary.permit_count),
        max_pain: Number(summary.max_pain),
        best_score: summary.best_score != null ? Number(summary.best_score) : null,
        possible_customer: custSet.has(companyKey(summary.operator_name)),
        possible_crm: crmSet.has(companyKey(summary.operator_name)),
      };

      // Permits list
      const permitsResult = await pool.query(
        `SELECT external_permit_nmbr, status, score,
                to_char(expiration_date, 'YYYY-MM-DD') AS expiration_date,
                compliance_flags
           FROM permit_facilities
          WHERE operator_key = $1
          ORDER BY score DESC`,
        [opKey]
      );

      // Best enrichment record for this operator: prefer one with contact_name + mailable address
      const enrichResult = await pool.query(
        `SELECT e.contact_name, e.mailing_address, e.site_address, e.sic_code, e.sector, e.channel
           FROM permit_enrichment e
           JOIN permit_facilities f ON f.external_permit_nmbr = e.external_permit_nmbr
          WHERE f.operator_key = $1
          ORDER BY (e.contact_name IS NOT NULL) DESC,
                   (e.mailing_address ~ '\\d{5}') DESC
          LIMIT 1`,
        [opKey]
      );
      const enrichment = enrichResult.rows[0] || null;
      const mailable = enrichment
        ? /\d{5}/.test(String(enrichment.mailing_address || ""))
        : false;

      // Found email (Apollo) — the priority channel.
      const emailResult = await pool.query(
        `SELECT email, contact_name, title FROM permit_operator_email
          WHERE operator_key = $1 AND email IS NOT NULL AND email <> '' LIMIT 1`,
        [opKey]
      );
      const email = emailResult.rows[0] || null;

      // Outreach history
      const outreachResult = await pool.query(
        `SELECT status, channel, note, created_at
           FROM permit_outreach
          WHERE operator_key = $1
          ORDER BY created_at DESC`,
        [opKey]
      );

      res.json({
        operator,
        permits: permitsResult.rows,
        enrichment,
        mailable,
        email,
        emailable: !!email,
        outreach: outreachResult.rows,
      });
    } catch (err) {
      console.error("GET /api/permits/operator/:operatorKey error:", err);
      res.status(500).json({ error: "Failed to load operator detail" });
    }
  });

  // POST /api/permits/operator/:operatorKey/promote — promote all pool permits for this operator
  app.post("/api/permits/operator/:operatorKey/promote", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const result = await pool.query(
        `UPDATE permit_facilities SET status = 'promoted', updated_at = NOW()
          WHERE operator_key = $1 AND status = 'pool'
          RETURNING external_permit_nmbr`,
        [req.params.operatorKey]
      );
      res.json({ promoted: result.rowCount });
    } catch (err) {
      console.error("POST /api/permits/operator/:operatorKey/promote error:", err);
      res.status(500).json({ error: "Failed to promote operator" });
    }
  });

  // POST /api/permits/operator/:operatorKey/outreach — log an outreach event for this operator
  app.post("/api/permits/operator/:operatorKey/outreach", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    const VALID_STATUSES = ["exported", "mailed", "emailed", "replied", "skipped"];
    const VALID_CHANNELS = ["mail", "email"];
    const { status, channel, note } = req.body || {};
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }
    // Validate channel: accept only 'mail' or 'email' (default 'mail'); reject invalid non-empty value
    const resolvedChannel = channel || "mail";
    if (!VALID_CHANNELS.includes(resolvedChannel)) {
      return res.status(400).json({
        error: `channel must be one of: ${VALID_CHANNELS.join(", ")}`,
      });
    }
    try {
      const result = await pool.query(
        `INSERT INTO permit_outreach (operator_key, channel, status, note)
         VALUES ($1, $2, $3, $4)
         RETURNING id, operator_key, channel, status, note, created_at`,
        [req.params.operatorKey, resolvedChannel, status, note || null]
      );
      res.json({ outreach: result.rows[0] });
    } catch (err) {
      console.error("POST /api/permits/operator/:operatorKey/outreach error:", err);
      res.status(500).json({ error: "Failed to log outreach" });
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
    // Single-flight lock: prevent two parallel TCEQ batches (IP-ban risk)
    if (_enrichInFlight) {
      return res.status(409).json({ error: "Enrichment already running" });
    }
    // No BROWSERLESS_TOKEN gate: plain fetch is the default transport; Browserless is used
    // automatically only if BROWSERLESS_TOKEN is set (see lib/permitTceqFetch.js).
    // Enrichment + direct-mail export are NOT gated by the master switch — they only read
    // public data (TCEQ scrape) and export a CSV; nothing is sent. The switch gates SENDING.
    _enrichInFlight = true;
    try {
      const cap = Math.min(200, Math.max(1, parseInt(req.body?.cap) || 50));
      const result = await enrichBatch(pool, { cap });
      res.json(result);
    } catch (err) {
      console.error("POST /api/permits/enrich error:", err);
      res.status(500).json({ error: "Enrichment failed" });
    } finally {
      _enrichInFlight = false;
    }
  });

  // POST /api/permits/find-emails { cap?: number } — Apollo email reveal on picked
  // companies (~1 credit each, capped). Stores a row per probed company; no email =
  // discarded. User-triggered + capped + single-flight so credit spend stays bounded.
  app.post("/api/permits/find-emails", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (!process.env.APOLLO_API_KEY) return res.status(503).json({ error: "Apollo not configured" });
    if (_findEmailsInFlight) return res.status(409).json({ error: "Email finder already running" });
    _findEmailsInFlight = true;
    try {
      const result = await findEmailsForPromoted(pool, { cap: req.body?.cap });
      res.json(result);
    } catch (err) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      console.error("POST /api/permits/find-emails error:", err);
      res.status(500).json({ error: "Email finder failed" });
    } finally {
      _findEmailsInFlight = false;
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

  // GET /api/permits/settings — engine state + per-mailbox flags
  app.get("/api/permits/settings", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      // Permit cold sending shares each mailbox's daily limit with regular outreach — there is
      // no separate permit cap. The per-mailbox daily_send_limit (SDR → Mailboxes) is the one cap.
      const s = await pool.query(`SELECT active FROM permit_engine_settings WHERE id = 1`);
      const m = await pool.query(`SELECT id, email, display_name, permit_enabled, daily_send_limit FROM sdr_mailboxes ORDER BY email ASC`);
      res.json({ settings: s.rows[0] || { active: false }, mailboxes: m.rows });
    } catch (err) {
      console.error("GET /api/permits/settings error:", err);
      res.status(500).json({ error: "Failed to load settings" });
    }
  });

  // PATCH /api/permits/settings { active?, daily_enroll_cap? }
  app.patch("/api/permits/settings", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      // Only the master send switch is settable here; the daily limit is per-mailbox (shared).
      if (typeof req.body?.active !== "boolean") return res.status(400).json({ error: "Provide active (boolean)" });
      const r = await pool.query(
        `UPDATE permit_engine_settings SET active = $1, updated_at = NOW() WHERE id = 1 RETURNING active`,
        [req.body.active]
      );
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
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ error: "Invalid mailbox id — must be a UUID" });
    }
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

  // GET /api/permits/msgp-template — the editable MSGP renewal email copy
  app.get("/api/permits/msgp-template", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const r = await pool.query(`SELECT subject, body_html, apollo_sequence_id, updated_at FROM permit_msgp_template WHERE id = 1`);
      res.json({ template: r.rows[0] || { subject: "", body_html: "", apollo_sequence_id: null } });
    } catch (err) {
      console.error("GET /api/permits/msgp-template error:", err);
      res.status(500).json({ error: "Failed to load template" });
    }
  });

  // PUT /api/permits/msgp-template { subject, body_html } — save copy (does NOT send anything)
  app.put("/api/permits/msgp-template", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    const { subject, body_html } = req.body || {};
    if (typeof subject !== "string" || typeof body_html !== "string") {
      return res.status(400).json({ error: "subject and body_html (strings) required" });
    }
    try {
      const r = await pool.query(
        `UPDATE permit_msgp_template SET subject = $1, body_html = $2, updated_at = NOW() WHERE id = 1
         RETURNING subject, body_html, apollo_sequence_id, updated_at`,
        [subject, body_html]
      );
      res.json({ template: r.rows[0] });
    } catch (err) {
      console.error("PUT /api/permits/msgp-template error:", err);
      res.status(500).json({ error: "Failed to save template" });
    }
  });

  // POST /api/permits/msgp-sequence/create — create an INACTIVE test Apollo sequence shell, store its id.
  // Creates no steps and sends nothing; enrollment is intentionally not implemented.
  app.post("/api/permits/msgp-sequence/create", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    if (!process.env.APOLLO_API_KEY) return res.status(503).json({ error: "Apollo not configured" });
    try {
      const seq = await createSequence("MSGP Renewal (TEST) — do not activate", { active: false });
      const id = seq?.emailer_campaign?.id || seq?.id || null;
      if (!id) return res.status(502).json({ error: "Apollo did not return a sequence id" });
      const r = await pool.query(
        `UPDATE permit_msgp_template SET apollo_sequence_id = $1, updated_at = NOW() WHERE id = 1 RETURNING apollo_sequence_id`,
        [id]
      );
      res.json({ apollo_sequence_id: r.rows[0]?.apollo_sequence_id || id });
    } catch (err) {
      console.error("POST /api/permits/msgp-sequence/create error:", err);
      res.status(500).json({ error: "Failed to create sequence" });
    }
  });

  // ── Permit email draft queue ────────────────────────────────────────────────
  // Helper: map a thrown httpError (status/code) to a JSON response.
  const sendErr = (res, err, fallback) => {
    if (err?.status) {
      const { status, message, ...rest } = err;
      delete rest.stack;
      return res.status(status).json({ error: message, ...rest });
    }
    console.error(fallback, err);
    return res.status(500).json({ error: fallback });
  };

  // POST /api/permits/drafts/generate { cap? } — render MSGP copy for email-able
  // operators into the queue as 'pending'. Never sends. Idempotent (skips operators
  // already contacted or already queued).
  app.post("/api/permits/drafts/generate", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const result = await generatePermitDrafts(pool, { cap: req.body?.cap });
      res.json(result);
    } catch (err) {
      sendErr(res, err, "Failed to generate drafts");
    }
  });

  // GET /api/permits/drafts?status=pending — list drafts + per-status counts.
  app.get("/api/permits/drafts", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const result = await listPermitDrafts(pool, { status: req.query.status || "pending" });
      res.json(result);
    } catch (err) {
      sendErr(res, err, "Failed to list drafts");
    }
  });

  // PATCH /api/permits/drafts/:id { subject?, body? } — edit a pending draft.
  app.patch("/api/permits/drafts/:id", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const draft = await editPermitDraft(pool, req.params.id, req.body || {});
      res.json({ draft });
    } catch (err) {
      sendErr(res, err, "Failed to edit draft");
    }
  });

  // POST /api/permits/drafts/:id/reject { reason? } — drop a draft from the queue.
  app.post("/api/permits/drafts/:id/reject", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const draft = await rejectPermitDraft(pool, req.params.id, req.body?.reason);
      res.json({ draft });
    } catch (err) {
      sendErr(res, err, "Failed to reject draft");
    }
  });

  // POST /api/permits/drafts/:id/approve-and-send — the ONLY send path. Gated by the
  // master switch + shared per-mailbox daily cap + per-operator dedup, then Apollo enroll.
  app.post("/api/permits/drafts/:id/approve-and-send", async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
    try {
      const result = await approveAndSendPermitDraft(pool, req.params.id);
      res.json(result);
    } catch (err) {
      sendErr(res, err, "Failed to send draft");
    }
  });
}
