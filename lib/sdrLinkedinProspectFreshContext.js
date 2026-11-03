// The fresh read immediately before a prospect send. Same contract as createLinkedinFreshContext,
// without Pipedrive or Apollo: the candidate row, the local skip rules, then the seat reads.
import { linkedinControlMatch } from './sdrOutreachControls.js';
import { checkLinkedinProspectEligibility, validateLinkedinCampaign } from './sdrLinkedinPolicy.js';
import { linkedinHash, canonicalProfile } from './sdrLinkedinStore.js';
import { prospectSkipReason, defaultCustomerCheck } from './sdrLinkedinProspect.js';

const hold = reason => ({ allowed: false, reasons: [reason] });
const id = value => (value == null ? null : String(value?.value ?? value?.id ?? value));
const items = result => (Array.isArray(result?.items) && result.complete === true ? result.items : null);
const CACHE_MS = 5 * 60_000;

export function createLinkedinProspectFreshContext({ pool, client, customerCheck = defaultCustomerCheck, clock = () => Date.now() }) {
  // getAccount/getSelf are cached for 5 minutes to save seat reads; a profile never is.
  let cached = null;
  const accountReads = async () => {
    if (cached && clock() - cached.at < CACHE_MS) return cached.value;
    const value = await Promise.all([client.getAccount(), client.getSelf()]);
    cached = { at: clock(), value };
    return value;
  };
  return async ({ action, candidate, campaign, account, now = new Date() }) => {
    if (!pool || !client || !action || !candidate || !campaign || !account) return hold('source_unavailable');
    try {
      if (account.read_budget <= 0 || account.read_timezone !== campaign.config?.timezone) return hold('read_budget_unapproved');
      const row = (await pool.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1 AND company_id=$2 AND account_id=$3', [candidate.id, action.company_id, action.account_id])).rows[0];
      if (!row || row.source !== 'linkedin_prospect' || row.person_id !== action.person_id || row.owner_id !== candidate.owner_id || row.revision !== candidate.revision || row.lane !== candidate.lane || ['held', 'replied', 'staff_takeover', 'archived', 'opted_out', 'completed_no_reply', 'copy_review'].includes(row.state)) return hold('candidate_changed');
      const person = { personId: row.person_id, providerId: row.provider_id, profileUrl: row.profile_url, email: row.resolved_email, fullName: row.source_context?.fullName, company: row.firm };
      const skipReason = await prospectSkipReason(pool, { companyId: row.company_id, person, lane: row.lane, now, excludeCandidateId: row.id, customerCheck });
      if (skipReason) return hold('conversation_or_hold');
      const controls = (await pool.query(`SELECT 1 FROM sdr_outreach_controls c WHERE c.company_id=$1 AND c.status='active' AND ${linkedinControlMatch('c', 'NULL', '$2')} LIMIT 1`, [action.company_id, row.resolved_email || ''])).rows;
      if (controls.length) return hold('conversation_or_hold');
      const [[providerAccount, self], profile, chats] = await Promise.all([accountReads(), client.getProfile({ identifier: row.provider_id }), client.findChats({ attendeeId: row.provider_id, maxPages: 1 })]);
      const healthy = providerAccount?.id === row.account_id && providerAccount.type === 'LINKEDIN' && Array.isArray(providerAccount.sources) && providerAccount.sources.length > 0 && providerAccount.sources.every(source => source.status === 'OK');
      const profileUrl = profile?.profile_url || (profile?.public_identifier && `https://www.linkedin.com/in/${profile.public_identifier}/`);
      let canonical = null; try { canonical = canonicalProfile(profileUrl); } catch { canonical = null; }
      if (!healthy || id(self?.provider_id) !== account.sender_provider_id || !/^ACo/.test(id(self?.provider_id) || '') || id(profile?.provider_id) !== row.provider_id || canonical !== row.profile_url) { cached = null; return hold('provider_identity_unverified'); }
      const chatList = items(chats);
      if (!chatList || chatList.length > 5 || typeof profile?.is_relationship !== 'boolean') return hold('provider_history_partial');
      const relation = profile.is_relationship === true, invited = profile.invitation?.status === 'PENDING';
      // invite and InMail need no relation; DMs need one; a withdraw needs the invite still pending.
      if (action.step === 'withdraw') { if (relation || !invited) return hold('withdraw_not_pending'); }
      else if (action.step === 'invite') { if (relation || invited) return hold('relationship_changed'); }
      else if (action.step === 'inmail') { if (relation) return hold('relationship_changed'); }
      else if (!relation) return hold('relationship_changed');
      const messageHistory = [], verifiedChatIds = new Set();
      for (const chat of chatList) {
        const attendee = Array.isArray(chat.attendees_ids) ? chat.attendees_ids.includes(row.provider_id) : id(chat.attendee_provider_id) === row.provider_id;
        if (!chat.id || chat.account_id !== row.account_id || !attendee) return hold('chat_identity_unverified');
        verifiedChatIds.add(chat.id);
        const messages = items(await client.listMessages({ chatId: chat.id, maxPages: 1 }));
        if (!messages) return hold('message_history_partial');
        if (messages.some(message => !message?.id || typeof message.is_sender !== 'boolean' || (message.chat_id && message.chat_id !== chat.id) || (message.account_id && message.account_id !== row.account_id))) return hold('message_identity_unverified');
        messageHistory.push(...messages);
      }
      if (['followup1', 'followup2'].includes(action.step) && !verifiedChatIds.has(action.provider_chat_id)) return hold('continuation_chat_unverified');
      const knownReceipts = (await pool.query("SELECT provider_id FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND person_id=$3 AND state='confirmed'", [action.company_id, action.account_id, action.person_id])).rows.map(r => r.provider_id);
      if (messageHistory.some(m => m.is_sender !== true || !knownReceipts.includes(m.id))) return hold('conversation_changed');
      const campaignView = { companyId: campaign.company_id, accountId: campaign.account_id, revision: campaign.revision, status: campaign.status, approvalDigest: campaign.approval_digest, cohortDigest: campaign.cohort_digest, approvedBy: campaign.approved_by, approvedAt: campaign.approved_at, expiresAt: campaign.expires_at, config: campaign.config };
      const approval = validateLinkedinCampaign(campaignView);
      if (!approval.allowed || approval.digest !== campaign.approval_digest) return hold('approval_changed');
      const decision = checkLinkedinProspectEligibility({ identity: { companyId: row.company_id, accountId: row.account_id, personId: row.person_id, ownerId: row.owner_id, providerId: row.provider_id, product: row.product, source: row.source, lane: row.lane, segment: row.segment, territory: row.territory, revision: row.revision }, campaign: campaignView, skipReason: null, account: { status: 'healthy', product: 'classic' }, history: { complete: true, observedAt: now }, now });
      if (!decision.allowed) return decision;
      return { allowed: true, reasons: [], contextHash: linkedinHash({ candidateId: row.id, campaignId: campaign.id, revision: campaign.revision, ownerId: row.owner_id, profileUrl: row.profile_url, body: action.body }) };
    } catch (error) { return hold(error?.code === 'read_budget_exhausted' ? 'read_budget_exhausted' : 'fresh_context_unavailable'); }
  };
}
