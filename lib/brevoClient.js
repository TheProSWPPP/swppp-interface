// Brevo (Sendinblue) API v3 read wrapper for the Nurture lane.
// Key lives in process.env.BREVO_API_KEY — server-side only, never sent to the browser.
// List-level subscriber totals are deprecated; use the contacts sub-endpoint.
// Campaign-list statistics cover events from the last six months.

const BREVO_BASE = "https://api.brevo.com/v3";

function getKey() {
  const k = process.env.BREVO_API_KEY;
  if (!k) {
    const e = new Error("BREVO_API_KEY not set");
    e.status = 503;
    throw e;
  }
  return k;
}

async function brevoFetch(path, { method = "GET", body, query } = {}) {
  const url = new URL(`${BREVO_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { "api-key": getKey(), "Content-Type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Brevo ${method} ${path} → ${res.status}: ${data?.message || data?.code || text.slice(0, 200)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function getAccount() {
  const a = await brevoFetch("/account");
  const plan = a.plan || [];
  // marketing email credits live in the plan block whose creditsType is a send limit
  const block = plan.find((p) => p.type !== "sms" && /send/i.test(p.creditsType || "")) || plan.find((p) => p.type === "marketing") || {};
  return {
    email: a.email || null,
    companyName: a.companyName || null,
    credits: block.credits ?? null,
    creditsType: block.creditsType ?? null,
    planType: block.type ?? null,
  };
}

function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function collection(path, field, { limit = 50, offset = 0, ...query } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0) {
    throw new Error("Invalid Brevo pagination");
  }
  const rows = [], seen = new Set();
  for (let page = 0; page < 100; page++) {
    const data = await brevoFetch(path, { query: { ...query, limit, offset, sort: "desc" } });
    const items = data[field] ?? (data.count === 0 ? [] : null);
    if (!Array.isArray(items)) throw new Error("Brevo returned an unexpected collection response");
    for (const item of items) {
      if (item?.id == null || seen.has(String(item.id))) throw new Error("Brevo collection is incomplete; refresh to try again");
      seen.add(String(item.id)); rows.push(item);
    }
    offset += items.length;
    const count = nonnegative(data.count);
    if (count !== null && offset >= count) return rows;
    if (items.length < limit) {
      if (count !== null && offset < count) throw new Error("Brevo collection is incomplete; refresh to try again");
      return rows;
    }
  }
  throw new Error("Brevo collection is incomplete; page limit reached");
}

export async function listCampaigns(options = {}) {
  const campaigns = await collection("/emailCampaigns", "campaigns", { ...options, statistics: "globalStats", excludeHtmlContent: true });
  const cutoff = new Date(); cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  return campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    subject: c.subject || null,
    status: c.status,
    scheduledAt: c.scheduledAt || null,
    sentDate: c.sentDate || null,
    recipientsLists: c.recipients?.lists || [],
    stats: c.statistics?.globalStats && (!c.sentDate || new Date(c.sentDate) >= cutoff) && !(c.statistics.globalStats.delivered === 0 && (c.statistics.globalStats.uniqueViews > 0 || c.statistics.globalStats.uniqueClicks > 0)) ? Object.fromEntries(
      ["sent", "delivered", "uniqueViews", "uniqueClicks", "softBounces", "hardBounces", "unsubscriptions", "complaints", "appleMppOpens", "opensRate"].map(key => [key, nonnegative(c.statistics.globalStats[key])]),
    ) : null,
    statsWindow: "last_six_months",
  }));
}

export async function getCampaignLinks(id) {
  const d = await brevoFetch(`/emailCampaigns/${encodeURIComponent(id)}`, { query: { statistics: "linksStats" } });
  return d.statistics?.linksStats ?? {};
}

export async function listLists(options = {}) {
  const lists = await collection("/contacts/lists", "lists", options);
  return lists.map((l) => ({ id: l.id, name: l.name, folderId: l.folderId ?? null }));
}

export async function listContactCount(listId) {
  const d = await brevoFetch(`/contacts/lists/${encodeURIComponent(listId)}/contacts`, { query: { limit: 1 } });
  return nonnegative(d.count);
}

export async function listContacts(listId, { limit = 50, offset = 0 } = {}) {
  const d = await brevoFetch(`/contacts/lists/${encodeURIComponent(listId)}/contacts`, { query: { limit, offset } });
  if (!Array.isArray(d.contacts) && d.count !== 0) throw new Error("Brevo returned an unexpected contact response");
  return { contacts: d.contacts || [], count: nonnegative(d.count) };
}

export async function getContact(identifier) {
  return brevoFetch(`/contacts/${encodeURIComponent(identifier)}`);
}

export async function getAttributes() {
  const d = await brevoFetch("/contacts/attributes");
  return d.attributes || [];
}

export async function listSenders() {
  const d = await brevoFetch("/senders");
  return d.senders || [];
}

export async function listTemplates(options = {}) {
  return collection("/smtp/templates", "templates", options);
}

// ---- Write functions (Phase 2/3). Verified request shapes 2026-06-15. ----

export async function createCampaign({ name, subject, senderId, htmlContent, listIds, scheduledAt }) {
  const body = { name, subject, sender: { id: senderId }, htmlContent, recipients: { listIds: listIds || [] } };
  if (scheduledAt) body.scheduledAt = scheduledAt;
  return brevoFetch("/emailCampaigns", { method: "POST", body });
}
export async function getCampaign(id) {
  return brevoFetch(`/emailCampaigns/${encodeURIComponent(id)}`);
}
export async function scheduleCampaign(id, scheduledAt) {
  return brevoFetch(`/emailCampaigns/${encodeURIComponent(id)}`, { method: "PUT", body: { scheduledAt } });
}
export async function setCampaignStatus(id, status) {
  return brevoFetch(`/emailCampaigns/${encodeURIComponent(id)}/status`, { method: "PUT", body: { status } });
}
export async function sendCampaignTest(id, emailTo) {
  return brevoFetch(`/emailCampaigns/${encodeURIComponent(id)}/sendTest`, { method: "POST", body: { emailTo } });
}
export async function sendCampaignNow(id) {
  return brevoFetch(`/emailCampaigns/${encodeURIComponent(id)}/sendNow`, { method: "POST" });
}
export async function deleteCampaign(id) {
  return brevoFetch(`/emailCampaigns/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listFolders(options = {}) {
  return collection("/contacts/folders", "folders", options);
}
export async function createList({ name, folderId }) {
  return brevoFetch("/contacts/lists", { method: "POST", body: { name, folderId } });
}
export async function renameList(id, name) {
  return brevoFetch(`/contacts/lists/${encodeURIComponent(id)}`, { method: "PUT", body: { name } });
}
export async function deleteList(id) {
  return brevoFetch(`/contacts/lists/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function addContactsToList(id, emails) {
  return brevoFetch(`/contacts/lists/${encodeURIComponent(id)}/contacts/add`, { method: "POST", body: { emails } });
}
export async function removeContactsFromList(id, emails) {
  return brevoFetch(`/contacts/lists/${encodeURIComponent(id)}/contacts/remove`, { method: "POST", body: { emails } });
}

export async function createContact({ email, attributes, listIds }) {
  return brevoFetch("/contacts", { method: "POST", body: { email, attributes: attributes || {}, listIds: listIds || [], updateEnabled: true } });
}
export async function updateContact(id, { attributes, emailBlacklisted, listIds }) {
  const body = {};
  if (attributes) body.attributes = attributes;
  if (typeof emailBlacklisted === "boolean") body.emailBlacklisted = emailBlacklisted;
  if (listIds) body.listIds = listIds;
  return brevoFetch(`/contacts/${encodeURIComponent(id)}`, { method: "PUT", body });
}
export async function deleteContact(id) {
  return brevoFetch(`/contacts/${encodeURIComponent(id)}`, { method: "DELETE" });
}
