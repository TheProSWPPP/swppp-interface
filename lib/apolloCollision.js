// Apollo dedups by CONTACT, we sell by PROJECT, and the two disagree.
//
// Measured 2026-09-03: 10,331 leads resolve to 7,503 distinct contacts, and 1,601 of those
// contacts carry 4,364 leads between them. Estimators bid constantly, so the same address turns
// up on job after job. Apollo refuses to enroll a contact that is already in a campaign — it
// answers HTTP 200 with the id under `skipped_contact_ids` rather than erroring — and the draft
// is then marked 'failed', which the auto-outreach exclusion turns into a burial. 140 of 201
// failed drafts are this collision. It is a large part of why Derek's 1,499-lead July import
// only reached 685 leads.
//
// TWO THINGS APOLLO'S ERROR STRING GETS WRONG, both confirmed against the live API on
// 2026-09-03 by reading `contact_campaign_statuses` for 12 blocked contacts:
//
//   1. "in_OTHER_campaigns" is routinely the SAME campaign we are enrolling into. 7 of the 12
//      had the target sequence as their only campaign membership. So the release must include
//      the target sequence; excluding it fixes almost nothing.
//   2. "contacts_ACTIVE_in_other_campaigns" does not mean the contact is active. 5 contacts
//      carrying that error were `finished`, and 1 was `failed`. The error string cannot be used
//      to decide whether it is safe to release someone.
//
// So the decision is made from `contact_campaign_statuses`, which Apollo returns on the contact
// record we already fetch during enrollment. Only a contact whose every membership reads
// `finished` is released. Anything else — active, paused, or the `failed` state Apollo uses when
// a contact REPLIED — is left alone, because that is a live thread or a person mid-sequence.

const RELEASABLE_STATUS = "finished";

/**
 * Is this Apollo skip reason a campaign-membership collision at all?
 *
 * Deliberately matches both the "active" and "finished" spellings: the word in between is not
 * trustworthy (see note 2 above), so both route to the same evidence-based decision.
 *
 * @param reason the value Apollo put in `skipped_contact_ids[contactId]`
 */
export function isCampaignCollision(reason) {
  return typeof reason === "string" && reason.includes("in_other_campaigns");
}

/**
 * Which campaigns to pull this contact out of before retrying the enrollment.
 *
 * Reads Apollo's own `contact_campaign_statuses`, so it sees campaigns our ledger knows nothing
 * about — the ones Derek ran by hand, and the retired n8n sequences. That is the difference
 * between recovering 14 of the blocked leads and recovering all of them.
 *
 * The target sequence is INCLUDED when present: removing a finished contact and re-adding them
 * is the whole point, and Apollo will not accept the add while the old membership stands.
 *
 * @param contact an Apollo contact record
 * @returns {{release: string[], blockedBy: string|null}} blockedBy names the membership that
 *          made this unsafe, and is non-null whenever release is empty for a reason worth logging
 */
export function campaignsToRelease(contact) {
  const statuses = contact?.contact_campaign_statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) {
    // Apollo refused over a membership it will not show us. Nothing safe to do but fail.
    return { release: [], blockedBy: "no_campaign_membership_visible" };
  }
  const release = [];
  for (const s of statuses) {
    if (s?.status !== RELEASABLE_STATUS) {
      // One live or replied membership disqualifies the whole contact. A contact halfway
      // through another sequence must not be yanked out of it to start a second pitch.
      return { release: [], blockedBy: String(s?.status || "unknown") };
    }
    const id = s?.emailer_campaign_id;
    if (id && !release.includes(id)) release.push(id);
  }
  return release.length ? { release, blockedBy: null } : { release: [], blockedBy: "no_campaign_ids" };
}

/**
 * Days since the most recent send to this contact, across every project.
 *
 * The existing contact cooldown cannot see this: it reads the Pipedrive person's
 * `last_outgoing_mail_time`, which 84% of our .co sends never stamp (measured over 1,013 sends),
 * and the outreach ledger it falls back to is keyed by LEAD. So before releasing a contact in
 * order to pitch them a second project, ask our own send ledger how long ago we emailed the
 * human. Of the same-contact collisions seen to date, 14 were inside two weeks.
 *
 * @param sends [{sent_at}] prior sends recorded against this Apollo contact
 * @returns whole days, or null when nothing is dated
 */
export function lastSendDaysAgo(sends, now = Date.now()) {
  let newest = null;
  for (const s of sends || []) {
    const t = s?.sent_at ? new Date(s.sent_at).getTime() : NaN;
    if (Number.isNaN(t)) continue;
    if (newest === null || t > newest) newest = t;
  }
  if (newest === null) return null;
  return Math.floor((now - newest) / 86400000);
}
