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
    throw err;
  }
  return data;
}

export async function getAuthHealth() {
  return apolloFetch("/auth/health");
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
