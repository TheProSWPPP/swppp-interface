// Build a sdr_drafts row from a Pipedrive lead + chosen trigger.
// Fetches lead/person/org via Pipedrive API, resolves sender → mailbox via
// the Pipedrive Launch_Sequence sender id, and renders the day-0 template.
//
// This module is the single source of "given a lead and a trigger, what's
// the draft we should queue for human approval?" — used by /api/sdr/drafts/generate.

import * as pd from "./pipedriveClient.js";
import { renderFirstTouch, renderTemplate, defaultSubject } from "./sdrTemplates.js";
import { resolveStateTerms } from "./stateGeoTerms.js";

// Pipedrive field keys (mirror of src/lib/pipedriveFields.ts — duplicated here so
// the backend doesn't import a frontend .ts file)
export const PD_FIELD = {
  sequenceStarted: "48c4bb758e8642d6372c7fff9df3c0ea716170f1",
  senderSignature: "7d0c154f9cf320c0632eff8f37acb5b5e73a275b",
  projectStage: "7c1852c27664d1118f75660223a6af9e99d10f2c",
  projectAddress: "8315f83413b4d585f9d3009fbbfc054f1a82386b",
  launchSequence: "ac01917c79bedd29218c9f980411b78a9dcea252",
  shortGeo: "6ab83c83a757ae6dc43d95d73fca19e76272494f",
  longGeo: "f39ffc033299b339f7e5dc5c8177b99bbec4b490",
  triggerAgc: "4e555902fff229d66c1a631ea2135e3676d710c4",
  triggerLba: "310a6cfbcf364587467a42835b369cd4bf1766fa",
  triggerCm: "5fd5cb8c79f7be331ae9af9b03285d9fe1756699",
  triggerPb: "61435d2e87311ced7c75007334828fa2de9e9628",
};

// Order matters — AGC > LBA > CM > PB (matches legacy SDR workflow priority).
// "Truthy" Pipedrive trigger field = checkbox set OR option id present.
function isTriggerSet(v) {
  if (v === null || v === undefined || v === "" || v === false || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}
export function inferTriggerType(lead) {
  if (isTriggerSet(lead[PD_FIELD.triggerAgc])) return "AGC";
  if (isTriggerSet(lead[PD_FIELD.triggerLba])) return "LBA";
  if (isTriggerSet(lead[PD_FIELD.triggerCm])) return "CM";
  if (isTriggerSet(lead[PD_FIELD.triggerPb])) return "PB";
  return null;
}

// Project Stage → trigger fallback (mirrors pipedriveSync STAGE_TRIGGER). Lets a
// Pipedrive-side trigger fire with just {pipedrive_lead_id} for the ~99% of leads that
// carry a Project Stage but no explicit Trigger_* field.
const STAGE_TRIGGER = { AGC: "AGC", LBA: "LBA", CM: "CM", PB: "PB", OB: "PB", "PRE-BID": "PB" };
export function triggerFromStage(stage) {
  if (!stage) return null;
  return STAGE_TRIGGER[String(stage).trim().toUpperCase()] || null;
}

// Launch_Sequence option id (Pipedrive) → SDR username (sdr_users.username)
export const SENDER_BY_OPTION_ID = {
  48: "derek",
  49: "michael",
  50: "josie",
  51: "terry",
  // 52 = "auto" — caller must pick a sender explicitly
};

// State-level acronyms. Prefer an explicit value (set by the n8n flow or a Pipedrive
// field), otherwise derive from the project's state the same way the n8n "State Geo Term
// Lookup" node did — so {ENV}/{SWPPP} read correctly per state (TCEQ/SWPPP in TX,
// ADEM/CBMPP in AL, ...) instead of defaulting everyone to EPA/SWPPP.
function resolveAcronyms(lead) {
  const fromState = resolveStateTerms(lead?.[PD_FIELD.projectAddress]);
  return {
    env: lead?.envAcronym || lead?.[PD_FIELD.shortGeo] || fromState.env,
    swppp: lead?.swpppAcronym || fromState.swppp,
  };
}

/**
 * Build a draft payload from a Pipedrive lead. Does NOT write to DB.
 *
 * @param {object} args
 * @param {string} args.pipedriveLeadId
 * @param {string} args.triggerType - "AGC" | "LBA" | "CM" | "PB"
 * @param {object} args.pool - pg pool for looking up sdr_users/sdr_mailboxes
 * @param {string} [args.assignedUserId] - override sender resolution
 * @param {string} [args.apolloSequenceId] - Apollo sequence to enroll into on approve
 * @returns {Promise<object>} payload ready to POST to /api/sdr/drafts
 */
export async function buildDraftFromLead({ pipedriveLeadId, triggerType, pool, assignedUserId, apolloSequenceId }) {
  if (!pipedriveLeadId) throw new Error("pipedriveLeadId required");

  // 1. Fetch the lead from Pipedrive
  const lead = await pd.getLead(pipedriveLeadId);
  if (!lead) throw new Error(`Pipedrive lead ${pipedriveLeadId} not found`);

  // 1a. Infer trigger_type from Pipedrive Trigger_* fields if caller didn't pass one
  let t = (triggerType || "").toUpperCase();
  if (!t) {
    t = inferTriggerType(lead) || triggerFromStage(lead[PD_FIELD.projectStage]) || "";
    if (!t) throw new Error(`Could not infer trigger_type from lead ${pipedriveLeadId} — set a Project Stage or Trigger_AGC/LBA/CM/PB in Pipedrive, or pass triggerType explicitly`);
  }
  if (!["AGC", "LBA", "CM", "PB"].includes(t)) {
    throw new Error(`Invalid triggerType: ${triggerType}`);
  }

  // 2. Resolve assigned SDR user — from override, then from lead's Launch_Sequence field
  let userId = assignedUserId || null;
  if (!userId) {
    const launchOptId = lead[PD_FIELD.launchSequence];
    const username = SENDER_BY_OPTION_ID[launchOptId];
    if (!username) {
      throw new Error(
        `Lead has no usable Launch_Sequence sender (got option id ${launchOptId}). Pass assignedUserId or set the lead's sender to a specific person.`,
      );
    }
    const { rows } = await pool.query(`SELECT id FROM sdr_users WHERE username = $1 LIMIT 1`, [username]);
    if (!rows[0]) throw new Error(`No sdr_users row for username "${username}"`);
    userId = rows[0].id;
  }

  // 3. Look up that user's mailbox
  const { rows: mbRows } = await pool.query(
    `SELECT id, email, warmup_status, active FROM sdr_mailboxes WHERE owner_user_id = $1 ORDER BY active DESC LIMIT 1`,
    [userId],
  );
  const mailbox = mbRows[0];
  if (!mailbox) throw new Error(`Assigned user ${userId} has no mailbox in sdr_mailboxes — connect their Apollo mailbox first`);
  if (!mailbox.active) throw new Error(`Mailbox ${mailbox.email} is inactive`);

  // 4. Fetch contact (Pipedrive person) for snapshot + first-name merge field
  if (!lead.person_id) throw new Error(`Lead ${pipedriveLeadId} has no person_id — can't generate draft without a contact`);
  const person = await pd.getPerson(lead.person_id);
  if (!person) throw new Error(`Pipedrive person ${lead.person_id} not found`);
  const email =
    person.primary_email ||
    person.email?.find?.((e) => e.primary)?.value ||
    person.email?.[0]?.value ||
    null;
  if (!email) throw new Error(`Person ${lead.person_id} has no email — can't enroll`);

  const firstName = (person.first_name || person.name || "there").split(" ")[0];

  // 5. Sender signature (lives on the lead's Sender_Signature field, per n8n workflow)
  const sig = lead[PD_FIELD.senderSignature] || "";

  // 6. Render template — prefer the admin-editable DB copy, fall back to the code
  // template so draft generation can never break on a missing/empty row.
  const acr = resolveAcronyms(lead);
  const ctx = { first: firstName, env: acr.env, swppp: acr.swppp, sig };
  let dbBody = null;
  try {
    const { rows } = await pool.query(`SELECT body FROM sdr_first_touch_templates WHERE trigger_type = $1`, [t]);
    dbBody = rows[0]?.body || null;
  } catch {
    /* table may not exist yet — fall back to code */
  }
  const body = dbBody ? renderTemplate(dbBody, ctx) : renderFirstTouch(t, ctx);
  const subject = defaultSubject(lead.title, acr.swppp);

  // 6.1 Auto-resolve Apollo sequence id from env vars if not passed
  const envSequenceId =
    apolloSequenceId ||
    process.env[`APOLLO_SEQ_${t}`] ||
    null;

  // 7. Snapshot identity fields (red-team race fix per Phase 3 plan)
  return {
    pipedrive_lead_id: String(pipedriveLeadId),
    pipedrive_contact_id: String(lead.person_id),
    pipedrive_org_id: lead.organization_id ? String(lead.organization_id) : null,
    contact_id_snapshot: String(lead.person_id),
    contact_email_snapshot: email,
    org_id_snapshot: lead.organization_id ? String(lead.organization_id) : null,
    trigger_type: t,
    apollo_sequence_id: envSequenceId,
    subject,
    body,
    assigned_mailbox_id: mailbox.id,
    assigned_user_id: userId,
    // Live dedup signal — captured from the same getPerson the draft build already
    // did, so the generate route can re-check freshness at zero extra API cost.
    person_last_outgoing: person.last_outgoing_mail_time || null,
    person_name: person.name || null,
    metadata: {
      pipedrive_lead_title: lead.title,
      pipedrive_owner_id: lead.owner_id,
      project_stage: lead[PD_FIELD.projectStage],
      launch_sequence_option_id: lead[PD_FIELD.launchSequence],
      env_acronym: acr.env,
      swppp_acronym: acr.swppp,
      generated_at: new Date().toISOString(),
    },
  };
}
