import { handleLinkedinReply } from './sdrLinkedinReplyStops.js';

const fail = code => Object.assign(new Error(code), { code });

// This callback runs after the local person hold has committed. A failed read leaves
// the source event unprocessed so the next bounded tick may retry the private draft.
export function createLinkedinInboundHandler({ pool, client, crm, apollo, mode = 'disabled' }) {
  return async ({ candidate, event }) => {
    if (!candidate?.person_id || !event?.source_message_id || !event.chat_id || event.direction !== 'in') throw fail('inbound_identity_unverified');
    const links = (await pool.query(`SELECT * FROM sdr_linkedin_links WHERE company_id=$1 AND account_id=$2 AND candidate_id=$3 AND person_id=$4 AND status='verified'`,
      [candidate.company_id, candidate.account_id, candidate.id, candidate.person_id])).rows;
    if (!links.length || links.some(link => !link.lead_id || !link.verified_email || link.owner_id !== candidate.owner_id || link.person_id !== candidate.person_id)) throw fail('inbound_link_unverified');
    const owners = (await pool.query(`SELECT DISTINCT pipedrive_sender_id::text AS id FROM sdr_mailboxes WHERE owner_user_id::text=$1 AND active IS TRUE AND pipedrive_sender_id IS NOT NULL`, [candidate.owner_id])).rows;
    if (owners.length !== 1 || owners[0].id !== candidate.pipedrive_owner_id) throw fail('inbound_owner_unverified');
    let draftGenerator;
    if (mode === 'dry_run' || mode === 'live') {
      if(!crm?.getPerson)throw fail('inbound_crm_unavailable');
      const chat = await client.getChat({ chatId: event.chat_id });
      const attendees = chat?.attendees_ids || [];
      if (chat?.account_id !== candidate.account_id || !attendees.includes(candidate.provider_id)) throw fail('inbound_chat_unverified');
      const history = await client.listMessages({ chatId: event.chat_id, maxPages: 1 });
      if (!history?.complete) throw fail('inbound_history_partial');
      const exact = history.items.filter(message => message.id === event.source_message_id && message.is_sender === false);
      if (exact.length !== 1 || !String(exact[0].text || '').trim()) throw fail('inbound_message_unverified');
      // A source-verified but deliberately generic private draft makes no claims
      // about price, bid scope, or promises. Staff must edit and send in LinkedIn.
      draftGenerator = async () => 'Thank you for your message. I will review this and get back to you.';
    }
    const latest=(await pool.query('SELECT * FROM sdr_linkedin_candidates WHERE id=$1 AND company_id=$2 AND account_id=$3',[candidate.id,candidate.company_id,candidate.account_id])).rows[0];
    if(!latest||latest.revision!==candidate.revision||latest.owner_id!==candidate.owner_id||latest.pipedrive_owner_id!==candidate.pipedrive_owner_id)throw fail('inbound_owner_changed');
    const verifyDraftOwner=async()=>{if(mode==='observe')return true;const person=await crm.getPerson(candidate.person_id);const value=v=>String(v?.value??v?.id??v??'');return value(person?.id)===candidate.person_id&&value(person?.owner_id)===candidate.pipedrive_owner_id&&value(person?.org_id)===candidate.organization_id};
    let memberships = [];
    if (apollo && mode === 'live' && (await pool.query("SELECT to_regclass('sdr_sends') AS name")).rows[0]?.name) {
      const sends = (await pool.query(`SELECT id,pipedrive_lead_id,apollo_contact_id,apollo_sequence_id FROM sdr_sends WHERE pipedrive_lead_id=ANY($1::text[]) AND apollo_contact_id=ANY($2::text[]) AND status IN ('enrolled','sent')`, [links.map(link=>link.lead_id),links.map(link=>link.apollo_contact_id)])).rows;
      memberships = sends.filter(send=>links.some(link=>link.lead_id===send.pipedrive_lead_id&&link.apollo_contact_id===send.apollo_contact_id)).map(send => ({ companyId: candidate.company_id, personId: candidate.person_id, leadId: send.pipedrive_lead_id, contactId: send.apollo_contact_id, campaignId: send.apollo_sequence_id, sendId: String(send.id) }));
    }
    return handleLinkedinReply({ pool, identity: { companyId: candidate.company_id, accountId: candidate.account_id, personId: candidate.person_id, candidateId: candidate.id, ownerId: candidate.owner_id, pipedriveOwnerId:candidate.pipedrive_owner_id,expectedRevision:candidate.revision }, observation: { sourceMessageId: event.source_message_id, direction: 'in', chatId: event.chat_id }, mode, draftGenerator, verifyDraftOwner, apollo, memberships });
  };
}
