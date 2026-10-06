import {protectCrmWrite} from './sdrCrmWriteProtection.js';
const PD_BASE = "https://api.pipedrive.com/v1";

function getToken() {
  const t = process.env.PIPEDRIVE_API_TOKEN;
  if (!t) throw new Error("PIPEDRIVE_API_TOKEN not set");
  return t;
}

async function pdFetch(path, { method = "GET", body, query } = {}) {
  const existing=path.match(/^\/(leads|persons|organizations|activities|notes)\/([^/]+)$/);
  if(existing&&['PUT','PATCH','DELETE'].includes(method))await protectCrmWrite({entity:({leads:'lead',persons:'person',organizations:'organization',activities:'activity',notes:'note'})[existing[1]],entityId:existing[2],fields:body||{deleted:true}});
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

// All persons attached to an organization (for the dead-email recovery cascade).
export async function listOrgPersons(orgId) {
  if (orgId == null) return [];
  const { data } = await pdFetch(`/organizations/${orgId}/persons`, { query: { limit: 100 } });
  return Array.isArray(data) ? data : [];
}

// Promote newEmail to primary on a person. If keepOld is provided, retain it as a secondary
// (non-primary) entry so we don't lose the record of the dead address.
export async function setPrimaryEmail(personId, newEmail, { keepOld } = {}) {
  if (!personId || !newEmail) throw new Error("person and email required");
  let person;
  try { person = await getPerson(personId); }
  catch (cause) { throw Object.assign(new Error("person email identity unverified", { cause }), { code: "email_identity_unverified" }); }
  if (String(person?.id) !== String(personId) || !Array.isArray(person.email)) {
    throw Object.assign(new Error("person email identity unverified"), { code: "email_identity_unverified" });
  }
  const existing = person.email.filter(e => e && typeof e.value === "string" && e.value.trim());
  const key = value => value.trim().toLowerCase();
  const oldPrimary = existing.find(e => e.primary) || existing[0];
  const match = existing.find(e => key(e.value) === key(newEmail));
  if (!match) throw Object.assign(new Error("candidate address no longer on person"), { code: "email_identity_changed" });
  const email = [{ ...match, value: newEmail, primary: true, label: match.label || oldPrimary?.label || "work" }];
  for (const entry of existing) {
    if (key(entry.value) !== key(newEmail)) email.push({ ...entry, primary: false });
  }
  // An absent old address may have been deliberately removed by staff. Never restore it.
  const { data } = await pdFetch(`/persons/${personId}`, { method: "PUT", body: { email } });
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

// Log an activity (call / task / meeting / email) on a lead or person.
export async function addActivity({ leadId, personId, subject, type = "call", dueDate, done = false, note, userId, strictAssignee = false }) {
  const body = { subject, type, done: done ? 1 : 0 };
  if (leadId) body.lead_id = leadId;
  if (personId) body.person_id = personId;
  if (dueDate) body.due_date = dueDate; // "YYYY-MM-DD"
  if (note) body.note = note;
  if (userId) body.user_id = userId; // assign the activity to a specific Pipedrive user
  try {
    const { data } = await pdFetch(`/activities`, { method: "POST", body });
    return data;
  } catch (e) {
    // A single-user API token can't always assign an activity to a DIFFERENT user
    // (e.g. dc's token creating a task owned by jg/mh/th). Rather than lose the activity,
    // retry assigned to the token owner so it still lands on someone's task list.
    if (userId && !strictAssignee) {
      delete body.user_id;
      const { data } = await pdFetch(`/activities`, { method: "POST", body });
      return data;
    }
    throw e;
  }
}

export async function searchLeads({ term, limit = 50 } = {}) {
  return pdFetch(`/leads/search`, { query: { term, limit } });
}

// All activities logged on a lead (calls, meetings, tasks, emails, contact attempts) —
// read-only, for the interface's unified outreach-history timeline. Newest-first by Pipedrive.
export async function listActivities(leadId, { limit = 100 } = {}) {
  const data = await pdFetch(`/activities`, { query: { lead_id: leadId, limit } });
  return data.data || [];
}

/**
 * List leads with pagination. Returns { data, pagination } where pagination has
 * next_start / more_items_in_collection for cursoring.
 */
export async function listLeads({ start = 0, limit = 100, archived_status = "not_archived" } = {}) {
  const data = await pdFetch(`/leads`, { query: { start, limit, archived_status } });
  return { data: data.data || [], pagination: data.additional_data?.pagination || {} };
}

// Paginated person list. Returns the SAME person fields as getPerson — crucially
// last_outgoing_mail_time — so the lead sync can sweep all persons in ~N/500
// calls instead of one getPerson per lead (~40x fewer Pipedrive requests).
export async function listPersons({ start = 0, limit = 500 } = {}) {
  const data = await pdFetch(`/persons`, { query: { start, limit } });
  return { data: data.data || [], pagination: data.additional_data?.pagination || {} };
}

// Paginated organization list. `label` carries the org label option id, which is how
// Derek's `Customer` tag is recorded (option id 1, set weekly by the n8n Customer Tag
// Auto-Assigner). Needed in bulk because the tag has to be resolved across DUPLICATE org
// records: Pipedrive holds ~15.8k org rows for ~13.1k distinct company names, so the tag
// often sits on a sibling record of the one a lead points at. See lib/customerSuppression.js.
export async function listOrganizations({ start = 0, limit = 500 } = {}) {
  const data = await pdFetch(`/organizations`, { query: { start, limit } });
  return { data: data.data || [], pagination: data.additional_data?.pagination || {} };
}

// All Pipedrive users (small, stable team) → used to map a lead's owner_id to a
// name so the interface can show WHO owns / is working a manually-contacted lead.
export async function listUsers() {
  const data = await pdFetch(`/users`, {});
  return data.data || [];
}

// Paginated mail threads in a folder ("sent"|"inbox"|"drafts"|"archive").
// Each thread carries lead_id/deal_id + parties.from (the actual sender) +
// last_message_sent_timestamp, so the sent folder is the per-lead outreach log:
// group by lead_id, take the latest. Returned newest-first by Pipedrive.
export async function listMailThreads({ folder = "sent", start = 0, limit = 100 } = {}) {
  const data = await pdFetch(`/mailbox/mailThreads`, { query: { folder, start, limit } });
  return { data: data.data || [], pagination: data.additional_data?.pagination || {} };
}

// Mailbox API v1: token-visible thread messages are metadata until a specific
// authorized message body is requested. No read-flag mutation is performed.
export async function listMailThreadMessages(threadId, { start = 0, limit = 100 } = {}) {
  // The public Mailbox reference says this endpoint returns all messages and
  // documents no paging input. Only send paging parameters if a response
  // unexpectedly advertises a next page; the collector keeps coverage partial
  // if that continuation cannot be exhausted.
  const data = await pdFetch(`/mailbox/mailThreads/${encodeURIComponent(threadId)}/mailMessages`,
    start ? { query: { start, limit } } : {});
  return { data: data.data || [], pagination: data.additional_data?.pagination || {} };
}

export async function getMailMessage(messageId, { includeBody = false } = {}) {
  const data = await pdFetch(`/mailbox/mailMessages/${encodeURIComponent(messageId)}`, {
    query: { include_body: includeBody ? 1 : 0 },
  });
  return data.data || null;
}

// Explicit all-users scope. The older listActivities() keeps its existing
// token-owner behavior for current callers.
export async function listActivitiesPage({ leadId, start = 0, limit = 100 } = {}) {
  const query = { user_id: 0, start, limit };
  if (leadId) query.lead_id = leadId;
  const data = await pdFetch('/activities', { query });
  return { data: data.data || [], pagination: data.additional_data?.pagination || {} };
}
