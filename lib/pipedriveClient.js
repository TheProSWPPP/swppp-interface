const PD_BASE = "https://api.pipedrive.com/v1";

function getToken() {
  const t = process.env.PIPEDRIVE_API_TOKEN;
  if (!t) throw new Error("PIPEDRIVE_API_TOKEN not set");
  return t;
}

async function pdFetch(path, { method = "GET", body, query } = {}) {
  const url = new URL(`${PD_BASE}${path}`);
  url.searchParams.set("api_token", getToken());
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data?.success === false) {
    const err = new Error(`Pipedrive ${method} ${path} → ${res.status}: ${data?.error || data?.message || text.slice(0, 200)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function getLead(leadId) {
  const { data } = await pdFetch(`/leads/${leadId}`);
  return data;
}

export async function updateLead(leadId, fields) {
  const { data } = await pdFetch(`/leads/${leadId}`, { method: "PATCH", body: fields });
  return data;
}

export async function getPerson(personId) {
  const { data } = await pdFetch(`/persons/${personId}`);
  return data;
}

export async function updatePerson(personId, fields) {
  const { data } = await pdFetch(`/persons/${personId}`, { method: "PUT", body: fields });
  return data;
}

export async function getOrganization(orgId) {
  const { data } = await pdFetch(`/organizations/${orgId}`);
  return data;
}

export async function addNote({ leadId, dealId, personId, orgId, content }) {
  const body = { content };
  if (leadId) body.lead_id = leadId;
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;
  if (orgId) body.org_id = orgId;
  const { data } = await pdFetch(`/notes`, { method: "POST", body });
  return data;
}

export async function searchLeads({ term, limit = 50 } = {}) {
  return pdFetch(`/leads/search`, { query: { term, limit } });
}

/**
 * List leads with pagination. Returns { data, pagination } where pagination has
 * next_start / more_items_in_collection for cursoring.
 */
export async function listLeads({ start = 0, limit = 100, archived_status = "not_archived" } = {}) {
  const data = await pdFetch(`/leads`, { query: { start, limit, archived_status } });
  return { data: data.data || [], pagination: data.additional_data?.pagination || {} };
}
