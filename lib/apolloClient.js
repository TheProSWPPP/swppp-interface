const APOLLO_BASE = "https://api.apollo.io/v1";

function getKey() {
  const k = process.env.APOLLO_API_KEY;
  if (!k) throw new Error("APOLLO_API_KEY not set");
  return k;
}

async function apolloFetch(path, { method = "GET", body, query } = {}) {
  const url = new URL(`${APOLLO_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      "X-Api-Key": getKey(),
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Apollo ${method} ${path} → ${res.status}: ${data?.error || data?.message || text.slice(0, 200)}`);
    err.status = res.status;
    err.data = data;
    // Apollo rate-limits PER ENDPOINT (2000/day, 400/hr, 200/min on
    // /emailer_messages/search). On a 429 it returns `retry-after` in SECONDS —
    // surface it so callers can open a circuit breaker instead of hot-retrying,
    // which is what kept the daily bucket pinned at 0.
    err.retryAfterSec = Number(res.headers.get("retry-after")) || null;
    const quotaHeader = (name) => {
      const value = res.headers.get(name);
      if (value == null || value.trim() === '') return null;
      const count = Number(value);
      return Number.isFinite(count) && count >= 0 ? count : null;
    };
    err.rateLimit = {
      dayLimit: Number(res.headers.get("x-rate-limit-24-hour")) || null,
      dayUsed: Number(res.headers.get("x-24-hour-usage")) || null,
      dayLeft: quotaHeader("x-24-hour-requests-left"),
      hourLeft: quotaHeader("x-hourly-requests-left"),
      minuteLeft: quotaHeader("x-minute-requests-left"),
    };
    throw err;
  }
  return data;
}

export async function getAuthHealth() {
  return apolloFetch("/auth/health");
}

// Read-only receipt reconciliation. Callers must verify identity and the returned
// campaign-status array; a missing/unsupported response is not proof of removal.
export async function getContact(contactId) {
  if (!contactId || typeof contactId !== 'string') throw new Error('invalid_contact_id');
  const data = await apolloFetch(`/contacts/${encodeURIComponent(contactId)}`);
  return data.contact || data;
}

export async function updateEmailAccountSignature(emailAccountId, signatureHtml) {
  return apolloFetch(`/email_accounts/${emailAccountId}`, {
    method: "PATCH",
    body: { signature_html: signatureHtml },
  });
}

export async function listEmailAccounts() {
  const data = await apolloFetch("/email_accounts");
  return data.email_accounts || [];
}

export async function searchUsers({ page = 1, perPage = 25 } = {}) {
  return apolloFetch("/users/search", {
    method: "POST",
    body: { page, per_page: perPage },
  });
}

export async function searchSequences({ page = 1, perPage = 25 } = {}) {
  return apolloFetch("/emailer_campaigns/search", {
    method: "POST",
    body: { page, per_page: perPage },
  });
}

/**
 * Create a new (inactive by default) Apollo sequence shell. POST /emailer_campaigns (verified live 2026-06-17).
 * Steps/templates are added later in Apollo's UI; this only creates the named container.
 */
export async function createSequence(name, { permissions = "team_can_use", active = false } = {}) {
  return apolloFetch("/emailer_campaigns", { method: "POST", body: { name, permissions, active } });
}

/**
 * Enroll contacts into a sequence with explicit sender mailbox.
 * @param {string} sequenceId - Apollo emailer_campaign id
 * @param {string[]} contactIds - Apollo contact ids
 * @param {string|string[]} sendEmailFromEmailAccountId - mailbox id(s); single id forces that sender, array enables rotation
 * @param {object} opts - {sendEmailFromEmailAddress?, sequenceNoEmail?, sequenceUnverifiedEmail?}
 */
export async function addContactsToSequence(sequenceId, contactIds, sendEmailFromEmailAccountId, opts = {}) {
  const body = {
    // Apollo 422s without the campaign id repeated in the body (verified live 2026-06-11)
    emailer_campaign_id: sequenceId,
    contact_ids: contactIds,
    send_email_from_email_account_id: sendEmailFromEmailAccountId,
    ...opts,
  };
  return apolloFetch(`/emailer_campaigns/${sequenceId}/add_contact_ids`, {
    method: "POST",
    body,
  });
}

/**
 * Re-assign the sending mailbox on contacts already in a sequence.
 */
export async function editSendingMailbox(sequenceId, emailerCampaignContactIds, sendEmailFromEmailAccountId) {
  return apolloFetch(`/emailer_campaigns/${sequenceId}/update_emailer_campaign_contact_ids`, {
    method: "POST",
    body: {
      emailer_campaign_contact_ids: emailerCampaignContactIds,
      send_email_from_email_account_id: sendEmailFromEmailAccountId,
    },
  });
}

/**
 * Remove or stop contacts in a sequence (used on reply/bounce/unsubscribe to pause Apollo side).
 * Documented endpoint: POST /emailer_campaigns/remove_or_stop_contact_ids (master key required).
 * @param {string} sequenceId - Apollo emailer_campaign id
 * @param {string[]} contactIds - Apollo CONTACT ids (not emailer_campaign_contact ids)
 * @param {"remove"|"stop"|"mark_as_finished"} mode
 */
export async function removeContactsFromSequence(sequenceId, contactIds, mode = "remove") {
  return apolloFetch(`/emailer_campaigns/remove_or_stop_contact_ids`, {
    method: "POST",
    body: {
      emailer_campaign_ids: [sequenceId],
      contact_ids: contactIds,
      mode,
    },
  });
}

/**
 * Find (or create) an Apollo ACCOUNT CONTACT by email and return its contact id.
 *
 * IMPORTANT: do NOT use /people/match here. That endpoint resolves a record in
 * Apollo's GLOBAL People database and returns a person id that is NOT a valid
 * contact id — PUT /contacts/{id} (custom fields) and sequence enrollment both
 * require an account contact id, so a person id 422s with "Contact does not
 * exist". We search the account's contacts and create one if the email isn't a
 * contact yet.
 *
 * @returns {Promise<{ id: string, contact: object, created: boolean }>}
 */
export async function matchContactByEmail(email) {
  const lower = String(email).toLowerCase();
  const search = await apolloFetch("/contacts/search", {
    method: "POST",
    body: { q_keywords: email, page: 1, per_page: 25 },
  });
  const hit = (search.contacts || []).find(
    (c) => (c.email || "").toLowerCase() === lower,
  );
  if (hit) return { id: hit.id, contact: hit, created: false };

  // Not an account contact yet — create one so we can set custom fields + enroll.
  const created = await apolloFetch("/contacts", {
    method: "POST",
    body: { email },
  });
  const contact = created.contact || created;
  return { id: contact?.id, contact, created: true };
}

/**
 * Find people at a company by email domain. Used by the dead-address recovery cascade.
 * v1 does NO paid reveal — Apollo may return a masked "email_not_unlocked@domain" sentinel;
 * the caller keeps only candidates whose email is actually usable.
 */
export async function searchPeopleByDomain(domain, { titles, perPage = 10 } = {}) {
  const body = { q_organization_domains: domain, page: 1, per_page: perPage };
  if (titles?.length) body.person_titles = titles;
  const data = await apolloFetch("/mixed_people/search", { method: "POST", body });
  const people = data?.people || data?.contacts || [];
  return people.map((p) => ({
    id: p.id,
    name: p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || null,
    title: p.title || null,
    email: p.email || null,
  }));
}

/**
 * Set custom field values on a contact. Used to carry the approved draft's
 * subject/body into Apollo so the sequence's step-1 template can merge them —
 * this is what makes queue edits actually reach the sent email.
 * @param {string} contactId
 * @param {Record<string,string>} typedCustomFields - { fieldId: value }
 */
export async function updateContactCustomFields(contactId, typedCustomFields, standardFields = {}) {
  // standardFields carries plain contact attributes (first_name/last_name) so the FOLLOW-UP
  // templates' native {{contact.first_name}} merge doesn't fail "required variable missing".
  const clean = {};
  for (const [k, v] of Object.entries(standardFields)) if (v != null && v !== "") clean[k] = v;
  return apolloFetch(`/contacts/${contactId}`, {
    method: "PUT",
    body: { ...clean, typed_custom_fields: typedCustomFields },
  });
}

/**
 * Activate ("approve") an inactive sequence. Documented endpoint.
 */
export async function activateSequence(sequenceId) {
  return apolloFetch(`/emailer_campaigns/${sequenceId}/approve`, {
    method: "POST",
    body: {},
  });
}

/**
 * Search emailer messages for one or more sequences. Each message carries per-contact
 * status incl. `replied`, `reply_class`, `bounce`, `spam_blocked`, `to_email`.
 * (Per-contact opens/clicks are NOT exposed here — those need the Professional webhook.)
 */
export async function searchEmailerMessages({ campaignIds, page = 1, perPage = 100 } = {}) {
  return apolloFetch("/emailer_messages/search", {
    method: "POST",
    body: { emailer_campaign_ids: campaignIds, page, per_page: perPage },
  });
}

/**
 * Full sequence detail incl. emailer_steps, emailer_touches, emailer_templates.
 * Templates hold the editable subject + body_html per step.
 */
export async function getSequenceDetail(sequenceId) {
  return apolloFetch(`/emailer_campaigns/${sequenceId}`);
}

/**
 * Update a sequence step's email template (subject + HTML body). Verified: PUT
 * /emailer_templates/{id} with {subject, body_html} returns 200.
 */
export async function updateEmailerTemplate(templateId, { subject, body_html }) {
  const body = {};
  if (subject !== undefined) body.subject = subject;
  if (body_html !== undefined) body.body_html = body_html;
  return apolloFetch(`/emailer_templates/${templateId}`, { method: "PUT", body });
}

/** Read-only catalog. Pagination/detail failures stay visible beside healthy rows. */
export async function listSequenceCatalog({ search = searchSequences, detail = getSequenceDetail,
  perPage = 50, maxPages = 20, timeoutMs = 25_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let errorCategory = null;
  const catalog = new Map();
  const safeCategory = (e) => e?.category === 'time_budget' ? 'time_budget' : e?.status === 429 ? 'apollo_429' : 'provider_error';
  const read = async (work) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('time_budget'), { category: 'time_budget' });
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('time_budget'), { category: 'time_budget' })), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  for (let page = 1; page <= maxPages; page++) {
    let response;
    try { response = await read(() => search({ page, perPage })); }
    catch (e) { errorCategory = safeCategory(e); break; }
    const rows = response?.emailer_campaigns;
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.id !== 'string' || !r.id)) {
      errorCategory = 'invalid_catalog'; break;
    }
    for (const row of rows) catalog.set(row.id, row);
    const totalPages = response?.pagination?.total_pages;
    const hasPageCount = Number.isInteger(totalPages) && totalPages > 0;
    if ((hasPageCount && page >= totalPages) || (!hasPageCount && rows.length < perPage)) break;
    if (page === maxPages) errorCategory = 'catalog_page_limit';
  }
  const sequences = [];
  for (const row of catalog.values()) {
    const sequence = { id: row.id, name: row.name || row.id, active: typeof row.active === 'boolean' ? row.active : null,
      num_steps: Number.isInteger(row.num_steps) ? row.num_steps : null, steps: [], omitted_steps: [], coverage: 'complete', errorCategory: null };
    try {
      const response = await read(() => detail(row.id));
      const steps = response?.emailer_steps;
      const touches = response?.emailer_touches;
      const templates = response?.emailer_templates;
      if (!Array.isArray(steps) || !Array.isArray(touches) || !Array.isArray(templates)
        || steps.some((s) => !s || !s.id) || touches.some((t) => !t || !t.emailer_step_id)
        || templates.some((t) => !t || !t.id)) {
        sequence.errorCategory = 'invalid_detail';
      } else {
        sequence.num_steps = new Set(steps.map((s) => s.id)).size;
        for (const step of steps) {
          const stepTouches = touches.filter((t) => t.emailer_step_id === step.id);
          let mapped = false;
          for (const touch of stepTouches) {
            const template = templates.find((t) => t.id === touch.emailer_template_id);
            if (!template || typeof template.subject !== 'string' || typeof template.body_html !== 'string') {
              // Calls/tasks normally have a touch but no email template. Only
              // an email step or an explicit unresolved reference is broken.
              if (String(step.type || '').includes('email') || touch.emailer_template_id != null) sequence.errorCategory = 'template_links_incomplete';
              continue;
            }
            mapped = true;
            sequence.steps.push({ position: step.position ?? null, step_type: step.type || null,
              template_id: template.id, subject: template.subject, body_html: template.body_html });
          }
          if (!mapped) {
            const isEmail = String(step.type || '').includes('email');
            sequence.omitted_steps.push({ position: step.position ?? null, step_type: step.type || null, reason: isEmail ? 'missing_template' : 'non_email' });
            if (isEmail) sequence.errorCategory = 'template_links_incomplete';
          }
        }
        if (touches.some((t) => !steps.some((s) => s.id === t.emailer_step_id))) sequence.errorCategory = 'template_links_incomplete';
        sequence.steps.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
      }
    } catch (e) { sequence.errorCategory = safeCategory(e); }
    if (sequence.errorCategory) {
      sequence.coverage = 'partial';
      errorCategory ||= sequence.errorCategory;
    }
    sequences.push(sequence);
  }
  return { sequences, coverage: errorCategory ? 'partial' : 'complete', errorCategory };
}
