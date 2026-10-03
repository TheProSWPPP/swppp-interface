export async function readLiveOverview(pool,{preview=false}={}) {
 const [drafts,leads,senders,recent,trend]=await Promise.all([
 pool.query(`SELECT count(*) FILTER(WHERE status='pending')::int pending,count(*) FILTER(WHERE status='approved')::int ready,count(*) FILTER(WHERE status='failed' AND updated_at>=now()-interval '7 days')::int failed FROM sdr_drafts`),
 pool.query(`SELECT count(*)::int total,count(*) FILTER(WHERE outreach_status='clear')::int eligible FROM sdr_lead_state`),
 pool.query(`SELECT count(*)::int total,count(*) FILTER(WHERE active)::int active,count(*) FILTER(WHERE active AND (owner_user_id IS NULL OR apollo_mailbox_id IS NULL))::int incomplete FROM sdr_mailboxes`),
 pool.query(`SELECT count(*)::int count FROM sdr_sends WHERE sent_at>=now()-interval '7 days'`),
 pool.query(`SELECT day::date::text date,count(s.id)::int count FROM generate_series((now() AT TIME ZONE 'America/Chicago')::date-13,(now() AT TIME ZONE 'America/Chicago')::date,interval '1 day') day LEFT JOIN sdr_sends s ON (s.sent_at AT TIME ZONE 'America/Chicago')::date=day::date GROUP BY day ORDER BY day`)]);
 const queue={...drafts.rows[0],failedDays:7},sender=senders.rows[0],lead=leads.rows[0];
 const actions=[];
 if(queue.failed) actions.push({id:'failures',title:'Review recent failed drafts',description:'Check the error before retrying. Currently failed drafts updated within the last 7 days.',count:queue.failed,target:'queue-failed',severity:'warning'});
 if(sender.incomplete) actions.push({id:'sender-setup',title:'Check sender setup',description:'Active senders are missing an owner or Apollo connection.',count:sender.incomplete,target:'mailboxes',severity:'warning'});
 if(queue.pending) actions.push({id:'pending',title:'Review pending drafts',description:'Review the message and recipient before approving outreach.',count:queue.pending,target:'queue',severity:'info'});
 if(lead.eligible) actions.push({id:'fresh-leads',title:'Review fresh leads',description:'Marked fresh in the CRM. Verify contact details and suitability before outreach.',count:lead.eligible,target:'leads',severity:'info'});
 return {collectedAt:new Date().toISOString(),preview,queue,leads:lead,senders:sender,recentEnrollments:{count:recent.rows[0].count,days:7},actions,trend:trend.rows,note:`Enrollment records show contacts added to sequences, not emails delivered. ${preview?'Changes are disabled in this live preview.':''}`};
}
