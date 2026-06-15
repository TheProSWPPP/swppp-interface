// Brevo (Sendinblue) API v3 read wrapper for the Nurture lane.
// Key lives in process.env.BREVO_API_KEY — server-side only, never sent to the browser.
// Read-only in Phase 1. Quirks handled here so callers don't have to:
//   - list-level totalSubscribers is unreliable → real counts via the contacts sub-endpoint
//   - single-campaign stats return zero → stats come from the LIST endpoint with statistics=globalStats

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
  const block = plan.find((p) => /send/i.test(p.creditsType || "")) || plan.find((p) => p.type === "marketing") || plan[0] || {};
  return {
    email: a.email || null,
    companyName: a.companyName || null,
    credits: block.credits ?? null,
    creditsType: block.creditsType ?? null,
    planType: block.type ?? null,
  };
}

export async function listCampaigns({ limit = 50, offset = 0 } = {}) {
  const d = await brevoFetch("/emailCampaigns", { query: { statistics: "globalStats", limit, offset, sort: "desc" } });
  return (d.campaigns || []).map((c) => ({
    id: c.id,
    name: c.name,
    subject: c.subject || null,
    status: c.status,
    scheduledAt: c.scheduledAt || null,
    sentDate: c.sentDate || null,
    recipientsLists: c.recipients?.lists || [],
    stats: c.statistics?.globalStats || null,
  }));
}

export async function getCampaignLinks(id) {
  // best-effort: some accounts don't populate linksStats on the detail endpoint
  try {
    const d = await brevoFetch(`/emailCampaigns/${id}`, { query: { statistics: "linksStats" } });
    return d.statistics?.linksStats || [];
  } catch {
    return [];
  }
}

export async function listLists({ limit = 50 } = {}) {
  const d = await brevoFetch("/contacts/lists", { query: { limit, sort: "desc" } });
  return (d.lists || []).map((l) => ({ id: l.id, name: l.name, folderId: l.folderId ?? null }));
}

export async function listContactCount(listId) {
  const d = await brevoFetch(`/contacts/lists/${listId}/contacts`, { query: { limit: 1, count: true } });
  return d.count ?? 0;
}

export async function listContacts(listId, { limit = 50, offset = 0 } = {}) {
  const d = await brevoFetch(`/contacts/lists/${listId}/contacts`, { query: { limit, offset } });
  return { contacts: d.contacts || [], count: d.count ?? 0 };
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

export async function listTemplates({ limit = 50 } = {}) {
  const d = await brevoFetch("/smtp/templates", { query: { limit, sort: "desc" } });
  return d.templates || [];
}
