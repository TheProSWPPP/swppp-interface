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

export function registerNurtureRoutes(app, pool) {
  const requireAdmin = (req, res) => {
    if (req.sdrUser?.role !== "admin") { res.status(403).json({ error: "Admin only" }); return false; }
    return true;
  };
  const audit = async (req, action, kind, id, summary) => {
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO nurture_audit (sdr_user, action, target_kind, target_id, summary) VALUES ($1,$2,$3,$4,$5)`,
        [req.sdrUser?.username || null, action, kind, String(id ?? ""), summary || null],
      );
    } catch (e) { console.error("nurture audit failed:", e.message); }
  };
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

  // ---------- Campaign write actions ----------
  app.post("/api/sdr/nurture/campaigns/:id/test", async (req, res) => {
    if (!guard(res)) return;
    const emailTo = req.body?.emailTo;
    if (!Array.isArray(emailTo) || !emailTo.length) return res.status(400).json({ error: "emailTo[] required (must be existing Brevo contacts)" });
    try { res.json(await brevo.sendCampaignTest(req.params.id, emailTo)); await audit(req, "campaign.test", "campaign", req.params.id, `test → ${emailTo.join(",")}`); }
    catch (e) { fail(res, e, "campaign-test"); }
  });

  app.post("/api/sdr/nurture/campaigns/:id/send", async (req, res) => {
    if (!guard(res)) return;
    if (!requireAdmin(req, res)) return;
    try { const r = await brevo.sendCampaignNow(req.params.id); await audit(req, "campaign.send", "campaign", req.params.id, "send now"); res.json(r || { ok: true }); }
    catch (e) { fail(res, e, "campaign-send"); }
  });

  app.patch("/api/sdr/nurture/campaigns/:id/schedule", async (req, res) => {
    if (!guard(res)) return;
    const scheduledAt = req.body?.scheduledAt;
    if (!scheduledAt) return res.status(400).json({ error: "scheduledAt required (RFC3339)" });
    try { const r = await brevo.scheduleCampaign(req.params.id, scheduledAt); await audit(req, "campaign.schedule", "campaign", req.params.id, scheduledAt); res.json(r || { ok: true }); }
    catch (e) { fail(res, e, "campaign-schedule"); }
  });

  app.post("/api/sdr/nurture/campaigns/:id/suspend", async (req, res) => {
    if (!guard(res)) return;
    try { const r = await brevo.setCampaignStatus(req.params.id, "suspended"); await audit(req, "campaign.suspend", "campaign", req.params.id, "suspend/cancel"); res.json(r || { ok: true }); }
    catch (e) { fail(res, e, "campaign-suspend"); }
  });

  app.post("/api/sdr/nurture/campaigns/:id/duplicate", async (req, res) => {
    if (!guard(res)) return;
    const { name, listIds, scheduledAt } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    try {
      const src = await brevo.getCampaign(req.params.id);
      const created = await brevo.createCampaign({ name, subject: src.subject || name, senderId: src.sender?.id || 1, htmlContent: src.htmlContent || "<p></p>", listIds: listIds || [], scheduledAt: scheduledAt || null });
      await audit(req, "campaign.duplicate", "campaign", created.id, `from ${req.params.id}`);
      res.status(201).json(created);
    } catch (e) { fail(res, e, "campaign-duplicate"); }
  });

  app.delete("/api/sdr/nurture/campaigns/:id", async (req, res) => {
    if (!guard(res)) return;
    if (!requireAdmin(req, res)) return;
    try { await brevo.deleteCampaign(req.params.id); await audit(req, "campaign.delete", "campaign", req.params.id, "delete draft"); res.json({ ok: true }); }
    catch (e) { fail(res, e, "campaign-delete"); }
  });

  // ---------- List write actions ----------
  app.get("/api/sdr/nurture/folders", async (req, res) => {
    if (!guard(res)) return;
    try { res.json({ folders: await brevo.listFolders() }); } catch (e) { fail(res, e, "folders"); }
  });

  app.post("/api/sdr/nurture/lists", async (req, res) => {
    if (!guard(res)) return;
    const name = req.body?.name;
    if (!name) return res.status(400).json({ error: "name required" });
    try {
      let folderId = req.body?.folderId;
      if (!folderId) { const f = await brevo.listFolders(); folderId = f[0]?.id; }
      const r = await brevo.createList({ name, folderId });
      await audit(req, "list.create", "list", r.id, name);
      res.status(201).json(r);
    } catch (e) { fail(res, e, "list-create"); }
  });

  app.patch("/api/sdr/nurture/lists/:id", async (req, res) => {
    if (!guard(res)) return;
    const name = req.body?.name;
    if (!name) return res.status(400).json({ error: "name required" });
    try { await brevo.renameList(req.params.id, name); await audit(req, "list.rename", "list", req.params.id, name); res.json({ ok: true }); }
    catch (e) { fail(res, e, "list-rename"); }
  });

  app.delete("/api/sdr/nurture/lists/:id", async (req, res) => {
    if (!guard(res)) return;
    if (!requireAdmin(req, res)) return;
    try { await brevo.deleteList(req.params.id); await audit(req, "list.delete", "list", req.params.id, "delete list"); res.json({ ok: true }); }
    catch (e) { fail(res, e, "list-delete"); }
  });

  app.post("/api/sdr/nurture/lists/:id/contacts/add", async (req, res) => {
    if (!guard(res)) return;
    const emails = req.body?.emails;
    if (!Array.isArray(emails) || !emails.length) return res.status(400).json({ error: "emails[] required" });
    try { const r = await brevo.addContactsToList(req.params.id, emails); await audit(req, "list.add", "list", req.params.id, emails.join(",")); res.json(r || { ok: true }); }
    catch (e) { fail(res, e, "list-add"); }
  });

  app.post("/api/sdr/nurture/lists/:id/contacts/remove", async (req, res) => {
    if (!guard(res)) return;
    const emails = req.body?.emails;
    if (!Array.isArray(emails) || !emails.length) return res.status(400).json({ error: "emails[] required" });
    try { const r = await brevo.removeContactsFromList(req.params.id, emails); await audit(req, "list.remove", "list", req.params.id, emails.join(",")); res.json(r || { ok: true }); }
    catch (e) { fail(res, e, "list-remove"); }
  });

  // ---------- Contact write actions ----------
  app.post("/api/sdr/nurture/contacts", async (req, res) => {
    if (!guard(res)) return;
    const { email, attributes, listIds } = req.body || {};
    if (!email) return res.status(400).json({ error: "email required" });
    try { const r = await brevo.createContact({ email, attributes, listIds }); await audit(req, "contact.create", "contact", email, ""); res.status(201).json(r || { ok: true }); }
    catch (e) { fail(res, e, "contact-create"); }
  });

  app.patch("/api/sdr/nurture/contacts/:id", async (req, res) => {
    if (!guard(res)) return;
    const { attributes, listIds } = req.body || {};
    try { await brevo.updateContact(req.params.id, { attributes, listIds }); await audit(req, "contact.update", "contact", req.params.id, ""); res.json({ ok: true }); }
    catch (e) { fail(res, e, "contact-update"); }
  });

  app.post("/api/sdr/nurture/contacts/:id/blocklist", async (req, res) => {
    if (!guard(res)) return;
    if (!requireAdmin(req, res)) return;
    const blocked = req.body?.blocked !== false;
    try { await brevo.updateContact(req.params.id, { emailBlacklisted: blocked }); await audit(req, "contact.blocklist", "contact", req.params.id, blocked ? "unsubscribe" : "resubscribe"); res.json({ ok: true }); }
    catch (e) { fail(res, e, "contact-blocklist"); }
  });

  app.delete("/api/sdr/nurture/contacts/:id", async (req, res) => {
    if (!guard(res)) return;
    if (!requireAdmin(req, res)) return;
    try { await brevo.deleteContact(req.params.id); await audit(req, "contact.delete", "contact", req.params.id, "delete contact"); res.json({ ok: true }); }
    catch (e) { fail(res, e, "contact-delete"); }
  });
}
