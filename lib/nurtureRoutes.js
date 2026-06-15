// Registers /api/sdr/nurture/* read endpoints. These inherit the existing
// basic-auth + JWT perimeter because server.js already gates every /api/sdr/* path.
import * as brevo from "./brevoClient.js";

function guard(res) {
  if (!process.env.BREVO_API_KEY) {
    res.status(503).json({ error: "Brevo not configured" });
    return false;
  }
  return true;
}

function fail(res, e, where) {
  console.error(`nurture ${where} error:`, e.message);
  res.status(e.status || 500).json({ error: e.message || "Brevo request failed" });
}

export function registerNurtureRoutes(app /*, { pool } */) {
  app.get("/api/sdr/nurture/account", async (req, res) => {
    if (!guard(res)) return;
    try { res.json(await brevo.getAccount()); } catch (e) { fail(res, e, "account"); }
  });

  app.get("/api/sdr/nurture/campaigns", async (req, res) => {
    if (!guard(res)) return;
    try { res.json({ campaigns: await brevo.listCampaigns({}) }); } catch (e) { fail(res, e, "campaigns"); }
  });

  app.get("/api/sdr/nurture/campaigns/:id/links", async (req, res) => {
    if (!guard(res)) return;
    try { res.json({ links: await brevo.getCampaignLinks(req.params.id) }); } catch (e) { fail(res, e, "links"); }
  });

  app.get("/api/sdr/nurture/lists", async (req, res) => {
    if (!guard(res)) return;
    try {
      const lists = await brevo.listLists({});
      const withCounts = await Promise.all(
        lists.map(async (l) => ({ ...l, count: await brevo.listContactCount(l.id).catch(() => null) })),
      );
      res.json({ lists: withCounts });
    } catch (e) { fail(res, e, "lists"); }
  });

  app.get("/api/sdr/nurture/lists/:id/contacts", async (req, res) => {
    if (!guard(res)) return;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    try { res.json(await brevo.listContacts(req.params.id, { limit, offset })); } catch (e) { fail(res, e, "list-contacts"); }
  });

  app.get("/api/sdr/nurture/contacts/attributes", async (req, res) => {
    if (!guard(res)) return;
    try { res.json({ attributes: await brevo.getAttributes() }); } catch (e) { fail(res, e, "attributes"); }
  });

  app.get("/api/sdr/nurture/contacts/:id", async (req, res) => {
    if (!guard(res)) return;
    try { res.json({ contact: await brevo.getContact(req.params.id) }); } catch (e) { fail(res, e, "contact"); }
  });

  app.get("/api/sdr/nurture/senders", async (req, res) => {
    if (!guard(res)) return;
    try { res.json({ senders: await brevo.listSenders() }); } catch (e) { fail(res, e, "senders"); }
  });

  app.get("/api/sdr/nurture/templates", async (req, res) => {
    if (!guard(res)) return;
    try { res.json({ templates: await brevo.listTemplates({}) }); } catch (e) { fail(res, e, "templates"); }
  });

  // Live status of the n8n workflow that feeds List 6 (Project Wrapping Up).
  // Degrades to { configured:false } if the n8n key isn't set — never throws.
  app.get("/api/sdr/nurture/automation-engine", async (req, res) => {
    const base = process.env.N8N_API_URL || "https://proswppp.app.n8n.cloud";
    const key = process.env.N8N_API_KEY;
    if (!key) return res.json({ configured: false });
    const wfId = "leHobBPAhlFaBpfc";
    try {
      const h = { "X-N8N-API-KEY": key, accept: "application/json" };
      const wf = await fetch(`${base}/api/v1/workflows/${wfId}`, { headers: h }).then((r) => r.json());
      const ex = await fetch(`${base}/api/v1/executions?workflowId=${wfId}&limit=1`, { headers: h }).then((r) => r.json());
      const last = (ex.data || [])[0] || null;
      res.json({
        configured: true,
        name: wf.name || "Brevo - Project Completion",
        active: !!wf.active,
        lastRun: last ? { status: last.status || (last.finished ? "success" : "running"), startedAt: last.startedAt || null } : null,
      });
    } catch (e) {
      res.json({ configured: true, error: e.message });
    }
  });
}
