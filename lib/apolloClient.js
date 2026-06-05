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
 * Enroll contacts into a sequence with explicit sender mailbox.
 * @param {string} sequenceId - Apollo emailer_campaign id
 * @param {string[]} contactIds - Apollo contact ids
 * @param {string|string[]} sendEmailFromEmailAccountId - mailbox id(s); single id forces that sender, array enables rotation
 * @param {object} opts - {sendEmailFromEmailAddress?, sequenceNoEmail?, sequenceUnverifiedEmail?}
 */
export async function addContactsToSequence(sequenceId, contactIds, sendEmailFromEmailAccountId, opts = {}) {
  const body = {
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
 * Remove contacts from a sequence (used on reply/bounce/unsubscribe to pause Apollo side).
 */
export async function removeContactsFromSequence(sequenceId, emailerCampaignContactIds) {
  return apolloFetch(`/emailer_campaigns/${sequenceId}/remove_contact_ids`, {
    method: "POST",
    body: { emailer_campaign_contact_ids: emailerCampaignContactIds },
  });
}

/**
 * Match an Apollo contact by email (returns Apollo contact id we can use in add_contact_ids).
 */
export async function matchContactByEmail(email, opts = {}) {
  return apolloFetch("/people/match", {
    method: "POST",
    body: { email, ...opts },
  });
}
