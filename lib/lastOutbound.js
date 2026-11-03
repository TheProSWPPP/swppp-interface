// Our newest email to an address, from every source, for the 3-day rule (Derek, 2026-11-02:
// "make sure we don't email the same person on any automation within three days"). Shared by
// the bid invite engine (lib/bidInviteEngine.js) and the LinkedIn prospect lanes
// (lib/sdrLinkedinProspect.js), so both read the same history:
//   - bid invite emails (a claimed or uncertain one counts from its claim time: it may have gone);
//   - Apollo cold sends (send rows that have delivery evidence) and Apollo message facts;
//   - Apollo "email sent" engagement events on a lead with this address;
//   - the .com mail Pipedrive synced (a rep's own email or a Pipedrive automation);
//   - permit sends;
//   - optionally the person's live Pipedrive "last outgoing mail" (pd + personId).
// Read only. Tables that do not exist yet are skipped.
import { presentTables, sendWithoutEmail } from "./outreachHistory.js";

const normal = (email) => String(email ?? "").trim().toLowerCase();
const validDate = (d) => (d && Number.isFinite(+new Date(d)) ? new Date(d) : null);
const pdTime = (v) => (v ? new Date(`${String(v).replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(String(v)) ? "" : "Z"}`) : null);

export const THREE_DAYS_MS = 72 * 60 * 60 * 1000;

export async function lastOutboundAt(db, { email, personId = null, pd = null } = {}) {
  const address = normal(email);
  if (!address) return null;
  // Optional columns are checked too ("table.column"), so an older or partial schema reads what it has.
  const tables = await presentTables(db, ["sdr_message_facts", "sdr_engagement_events", "sdr_reply_messages", "sdr_conversation_messages",
    "bid_invite_sends", "sdr_sends", "sdr_drafts", "permit_sends", "permit_drafts", "sdr_lead_state", "sdr_outreach_log",
    "sdr_message_facts.provider_status", "sdr_sends.draft_id", "sdr_sends.sent_at", "sdr_sends.apollo_emailer_message_id", "sdr_sends.step_status",
    "sdr_drafts.contact_email_snapshot"]);
  const parts = [];
  if (tables.has("bid_invite_sends")) parts.push(`SELECT max(coalesce(sent_at, claimed_at)) AS t FROM bid_invite_sends WHERE lower(recipient_email)=$1 AND status IN ('sent','uncertain','claimed')`);
  if (["sdr_sends.draft_id", "sdr_sends.sent_at", "sdr_drafts.contact_email_snapshot"].every((c) => tables.has(c))) {
    // A send row that never produced an email (Apollo refused or dropped it) is not an email.
    const evidence = ["sdr_outreach_log", "sdr_sends.apollo_emailer_message_id", "sdr_sends.step_status"].every((c) => tables.has(c));
    parts.push(`SELECT max(s.sent_at) FROM sdr_sends s JOIN sdr_drafts d ON d.id=s.draft_id WHERE lower(trim(d.contact_email_snapshot))=$1${evidence ? ` AND NOT ${sendWithoutEmail("s", tables)}` : ""}`);
  }
  if (tables.has("sdr_message_facts"))
    parts.push(`SELECT max(occurred_at) FROM sdr_message_facts WHERE direction='out'${tables.has("sdr_message_facts.provider_status") ? " AND provider_status='completed'" : ""} AND lower(trim(prospect_email))=$1`);
  if (tables.has("sdr_engagement_events") && tables.has("sdr_lead_state"))
    parts.push(`SELECT max(e.occurred_at) FROM sdr_engagement_events e JOIN sdr_lead_state ls ON ls.pipedrive_lead_id=e.pipedrive_lead_id
      WHERE e.event_type='email_sent' AND lower(btrim(ls.person_email))=$1`);
  if (tables.has("sdr_conversation_messages"))
    parts.push(`SELECT max(occurred_at) FROM sdr_conversation_messages c WHERE c.direction='out'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.to_addresses || c.cc_addresses) a WHERE position($1 IN lower(a)) > 0)`);
  if (tables.has("permit_sends") && tables.has("permit_drafts"))
    parts.push(`SELECT max(ps.sent_at) FROM permit_sends ps JOIN permit_drafts pdr ON pdr.id=ps.draft_id WHERE lower(trim(pdr.email))=$1 AND ps.status<>'failed'`);
  let last = null;
  if (parts.length) last = validDate((await db.query(`SELECT max(x.t) AS t FROM (${parts.join(" UNION ALL ")}) AS x(t)`, [address])).rows[0]?.t);
  if (pd && personId) {
    const person = await pd.getPerson(personId);
    const pdLast = validDate(pdTime(person?.last_outgoing_mail_time));
    if (pdLast && (!last || +pdLast > +last)) last = pdLast;
  }
  return last;
}

// True when we emailed the address in the 72 hours before `now`, from any source above.
export async function emailedWithinThreeDays(db, { email, now = new Date(), personId = null, pd = null } = {}) {
  const last = await lastOutboundAt(db, { email, personId, pd });
  return Boolean(last && +new Date(now) - +last < THREE_DAYS_MS);
}
