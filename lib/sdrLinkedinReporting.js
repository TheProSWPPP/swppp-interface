const fail=code=>Object.assign(new Error(code),{code});
const unavailable={eligible:'Fresh connected eligibility has not been verified',interested:'Reply interest review is not available',bidderListAdditions:'Bidder-list evidence is not collected',invitationsToBid:'Bid invitation evidence is not collected'};
export async function readLinkedinMetrics(db,{companyId,accountId,cohort=null,from=null,to=null,viewer}={}){
 if(!viewer||viewer.machine||!['admin','sdr'].includes(viewer.role)||!viewer.sub)throw fail('session_required');
 if(!companyId||!accountId)throw fail('scope_required');
 const params=[companyId,accountId,cohort,viewer.role==='admin'?null:viewer.sub];
 const candidates=(await db.query(`SELECT id,person_id,state,created_at FROM sdr_linkedin_candidates WHERE company_id=$1 AND account_id=$2 AND ($3::text IS NULL OR segment=$3) AND ($4::text IS NULL OR owner_id=$4) AND source<>'synthetic_test'`,params)).rows;
 const ids=candidates.map(c=>c.id),people=[...new Set(candidates.map(c=>c.person_id).filter(Boolean))];
 const windowCandidates=candidates.filter(c=>(!from||new Date(c.created_at)>=new Date(from))&&(!to||new Date(c.created_at)<new Date(to)));
 const counts={staged:windowCandidates.length,reviewedCandidates:windowCandidates.filter(c=>!['staged','archived'].includes(c.state)).length,eligible:null,confirmedInvites:0,verifiedRelations:0,confirmedDms:0,inbound:0,interested:null,bidderListAdditions:null,invitationsToBid:null,quotes:null,orders:null,unknownOutcomes:0};
 const availability={...unavailable,quotes:'No independently reviewed LinkedIn deal attribution is recorded',orders:'No independently reviewed LinkedIn deal attribution is recorded'};
 if(ids.length){
  const actions=(await db.query(`SELECT step,state FROM sdr_linkedin_actions WHERE company_id=$1 AND account_id=$2 AND candidate_id=ANY($3::uuid[]) AND ($4::timestamptz IS NULL OR COALESCE(confirmed_at,network_started_at,created_at) >= $4) AND ($5::timestamptz IS NULL OR COALESCE(confirmed_at,network_started_at,created_at) < $5)`,[companyId,accountId,ids,from,to])).rows;
  counts.confirmedInvites=actions.filter(a=>a.step==='invite'&&a.state==='confirmed').length;
  counts.confirmedDms=actions.filter(a=>a.step!=='invite'&&a.state==='confirmed').length;
  counts.unknownOutcomes=actions.filter(a=>['uncertain_provider_result','network_started'].includes(a.state)).length;
  const events=(await db.query(`SELECT kind,direction,source,coverage,person_id,chat_id,source_message_id FROM sdr_linkedin_events WHERE company_id=$1 AND account_id=$2 AND person_id=ANY($3::text[]) AND ($4::timestamptz IS NULL OR observed_at >= $4) AND ($5::timestamptz IS NULL OR observed_at < $5)`,[companyId,accountId,people,from,to])).rows;
  counts.verifiedRelations=new Set(events.filter(e=>e.kind==='new_relation'&&['event','verified','poll'].includes(e.coverage)&&['webhook','poll','recovery'].includes(e.source)).map(e=>e.person_id)).size;
  counts.inbound=new Set(events.filter(e=>e.kind==='message_received'&&e.direction==='in').map(e=>`${e.person_id}:${e.chat_id||e.source_message_id}`)).size;
  if((await db.query("SELECT to_regclass('sdr_deal_facts') AS table_name")).rows[0]?.table_name){
   const outcome=(await db.query(`WITH touch AS (
      SELECT candidate_id,MIN(confirmed_at) AS first_at FROM sdr_linkedin_actions
      WHERE company_id=$1 AND account_id=$2 AND candidate_id=ANY($3::uuid[]) AND state='confirmed' AND confirmed_at IS NOT NULL
      GROUP BY candidate_id
    ), attributed AS (
      SELECT DISTINCT d.pipedrive_deal_id,d.qualified_quote,d.quote_evidence,d.quote_created_at,d.status,d.won_at,e.source_at,t.first_at
      FROM sdr_linkedin_events e JOIN touch t ON t.candidate_id=e.candidate_id
      JOIN sdr_linkedin_actions channel_action ON channel_action.id::text=e.safe_payload->>'channelActionId'
        AND channel_action.company_id=e.company_id AND channel_action.account_id=e.account_id AND channel_action.candidate_id=e.candidate_id
        AND channel_action.person_id=e.person_id AND channel_action.state='confirmed' AND channel_action.confirmed_at<=e.source_at
      JOIN sdr_linkedin_links l ON l.company_id=e.company_id AND l.account_id=e.account_id AND l.candidate_id=e.candidate_id AND l.person_id=e.person_id
        AND l.status='verified' AND l.lead_id=e.safe_payload->>'leadId'
      JOIN sdr_deal_facts d ON d.pipedrive_deal_id=e.safe_payload->>'dealId' AND d.pipedrive_lead_id=l.lead_id
      WHERE e.company_id=$1 AND e.account_id=$2 AND e.candidate_id=ANY($3::uuid[])
        AND e.kind='outcome_attribution' AND e.source='reviewed_crm' AND e.coverage='reviewed'
        AND e.safe_payload->>'channel'='linkedin' AND NULLIF(e.safe_payload->>'evidenceRef','') IS NOT NULL
        AND e.source_at IS NOT NULL AND e.source_at>=t.first_at
        AND d.link_status='verified' AND d.link_evidence IS NOT NULL AND NOT d.is_test
    ) SELECT COUNT(*) AS attributed,
      COUNT(DISTINCT pipedrive_deal_id) FILTER(WHERE qualified_quote IS TRUE AND quote_evidence IS NOT NULL AND quote_created_at>=first_at AND quote_created_at>=source_at AND ($4::timestamptz IS NULL OR quote_created_at >= $4) AND ($5::timestamptz IS NULL OR quote_created_at < $5)) AS quotes,
      COUNT(DISTINCT pipedrive_deal_id) FILTER(WHERE status='won' AND won_at IS NOT NULL AND won_at>=first_at AND won_at>=source_at AND ($4::timestamptz IS NULL OR won_at >= $4) AND ($5::timestamptz IS NULL OR won_at < $5)) AS orders
      FROM attributed`,[companyId,accountId,ids,from,to])).rows[0];
   if(Number(outcome.attributed)>0){counts.quotes=Number(outcome.quotes);counts.orders=Number(outcome.orders);delete availability.quotes;delete availability.orders}
  }
 }
 return {counts,availability,coverage:'partial',cohort,from,to};
}
