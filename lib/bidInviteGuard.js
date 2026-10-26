// Bid-tracker contacts (Pipedrive Lead Origin "Bid Invite" / "Bid Invite: <platform>") come from
// the estimator's bid sheet. Derek: "mostly customers or really warm leads", so the automatic cold
// drip never enrolls them. Staff can still email them by hand.
export const isBidInviteOrigin = value => /^\s*bid invite/i.test(String(value ?? ""));

// The person counts, not just the lead: someone on an open bid-sheet lead stays out of cold
// email and LinkedIn through any other lead too. Same person = same Pipedrive person or same
// address. `alias` is the sdr_lead_state row being checked.
const OPEN_BID_LEAD = `lower(btrim(coalesce(bid.lead_origin,''))) LIKE 'bid invite%' AND coalesce(bid.crm_status,'unknown') NOT IN ('archived','missing')`;
export const notOnOpenBidInviteLead = alias => `NOT EXISTS (SELECT 1 FROM sdr_lead_state bid WHERE ${OPEN_BID_LEAD}
          AND bid.pipedrive_person_id = ${alias}.pipedrive_person_id)
        AND NOT EXISTS (SELECT 1 FROM sdr_lead_state bid WHERE ${OPEN_BID_LEAD}
          AND lower(btrim(bid.person_email)) = nullif(lower(btrim(${alias}.person_email)),''))`;

export const BID_INVITE_MESSAGE = "This contact is on a Bid Invite lead (the estimator's bid sheet), so they are a customer or warm lead and never go into a cold Apollo sequence. Email them by hand instead.";
export const bidInviteRefusal = () => Object.assign(new Error(BID_INVITE_MESSAGE), { code: 'bid_invite_warm_lead', status: 409, preserveDraft: true });

// The bid-sheet lead that rules this out, or null: the lead itself is a Bid Invite lead, or its
// person (the lead's own, the given one) or any of the addresses is on an open one.
export async function bidInviteLeadFor(db, { leadId = null, personId = null, emails = [] } = {}) {
  const addresses = [...new Set(emails.map(e => String(e ?? '').trim().toLowerCase()).filter(Boolean))];
  const { rows } = await db.query(
    `WITH me AS (SELECT pipedrive_person_id, nullif(lower(btrim(person_email)),'') AS email FROM sdr_lead_state WHERE pipedrive_lead_id = $1)
     SELECT bid.pipedrive_lead_id FROM sdr_lead_state bid
      WHERE lower(btrim(coalesce(bid.lead_origin,''))) LIKE 'bid invite%'
        AND (bid.pipedrive_lead_id = $1 OR (${OPEN_BID_LEAD} AND (
          bid.pipedrive_person_id = $2 OR lower(btrim(bid.person_email)) = ANY($3::text[])
          OR bid.pipedrive_person_id IN (SELECT pipedrive_person_id FROM me)
          OR lower(btrim(bid.person_email)) IN (SELECT email FROM me))))
      LIMIT 1`,
    [leadId == null ? null : String(leadId), personId == null || personId === '' ? null : String(personId), addresses],
  );
  return rows[0]?.pipedrive_lead_id ?? null;
}
