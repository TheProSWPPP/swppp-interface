// Historical observations only. No reply-action imports or provider writes.
import * as gmailInbox from './gmailInbox.js';
import * as pipedriveClient from './pipedriveClient.js';

const email = value => String(value || '').trim().toLowerCase();
const bounded = (value, fallback, max) => Math.min(max, Math.max(1, Number.isInteger(Number(value)) ? Number(value) : fallback));
const addresses = value => Array.isArray(value) ? value.filter(Boolean).map(String) : value ? [String(value)] : [];
const party = value => typeof value === 'string' ? value : value?.email_address ?
  (value.name ? `${value.name} <${value.email_address}>` : value.email_address) : null;
const parties = value => (Array.isArray(value) ? value : value ? [value] : []).map(party).filter(Boolean);
const time = value => {
  if (!value) return null;
  const v = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const date = new Date(v);
  if (!Number.isFinite(+date)) throw new Error('invalid_message_time');
  return date.toISOString();
};
const category = error => error?.status === 401 || error?.status === 403 ? 'permission' : error?.status === 429 ? 'rate_limit' : error?.status >= 500 ? 'provider' : 'unavailable';

export async function observeConversationMessage(pool, message) {
  const provider = String(message.provider || '');
  const account = email(message.account);
  const id = String(message.id || '');
  if (!['gmail','pipedrive'].includes(provider) || !account || !id) throw new Error('invalid_message_identity');
  if ((message.leadId || message.dealId) && !message.linkEvidence) throw new Error('unverified_project_link');
  if (['Manual','Automatic'].includes(message.origin) && !message.originEvidence) throw new Error('unverified_origin');
  const evidence={leadLinkObserved:message.leadLinkObserved===true,dealLinkObserved:message.dealLinkObserved===true,leadId:message.leadId ? String(message.leadId):null,dealId:message.dealId ? String(message.dealId):null,personId:message.personId ? String(message.personId):null,threadId:message.threadId ? String(message.threadId):null,evidence:message.linkEvidence || null};
  const sourceEvidence=[evidence,...(message.sourceEvidence || [])];
  const conflicting=message.linkConflict===true;
  const params=[provider,account,id,message.threadId ? String(message.threadId) : null,
    message.internetMessageId || null,message.from || null,JSON.stringify(addresses(message.to)),JSON.stringify(addresses(message.cc)),
    time(message.occurredAt),['in','out'].includes(message.direction) ? message.direction : 'unknown',
    ['Manual','Automatic'].includes(message.origin) ? message.origin : 'Unknown',message.personId ? String(message.personId) : null,
    message.leadId ? String(message.leadId) : null,message.dealId ? String(message.dealId) : null,conflicting?'conflict:source_observations':message.linkEvidence || null,message.originEvidence || null,JSON.stringify(sourceEvidence)];
  const {rows}=await pool.query(`INSERT INTO sdr_conversation_messages
    (provider,account_key,provider_message_id,provider_thread_id,internet_message_id,from_address,to_addresses,cc_addresses,
     occurred_at,direction,origin,person_id,pipedrive_lead_id,pipedrive_deal_id,link_evidence,origin_evidence,source_evidence)
    VALUES (${params.map((_,i)=>`$${i+1}`).join(',')})
    ON CONFLICT (provider,account_key,provider_message_id) DO UPDATE SET
      provider_thread_id=COALESCE(EXCLUDED.provider_thread_id,sdr_conversation_messages.provider_thread_id),
      internet_message_id=COALESCE(EXCLUDED.internet_message_id,sdr_conversation_messages.internet_message_id),
      from_address=COALESCE(EXCLUDED.from_address,sdr_conversation_messages.from_address),
      to_addresses=CASE WHEN EXCLUDED.to_addresses='[]'::jsonb THEN sdr_conversation_messages.to_addresses ELSE EXCLUDED.to_addresses END,
      cc_addresses=CASE WHEN EXCLUDED.cc_addresses='[]'::jsonb THEN sdr_conversation_messages.cc_addresses ELSE EXCLUDED.cc_addresses END,
      occurred_at=COALESCE(EXCLUDED.occurred_at,sdr_conversation_messages.occurred_at),
      direction=CASE WHEN EXCLUDED.direction='unknown' THEN sdr_conversation_messages.direction ELSE EXCLUDED.direction END,
      origin=CASE WHEN EXCLUDED.origin='Unknown' THEN sdr_conversation_messages.origin ELSE EXCLUDED.origin END,
      origin_evidence=COALESCE(EXCLUDED.origin_evidence,sdr_conversation_messages.origin_evidence),
      person_id=COALESCE(sdr_conversation_messages.person_id,EXCLUDED.person_id),
      pipedrive_lead_id=COALESCE(sdr_conversation_messages.pipedrive_lead_id,EXCLUDED.pipedrive_lead_id),
      pipedrive_deal_id=COALESCE(sdr_conversation_messages.pipedrive_deal_id,EXCLUDED.pipedrive_deal_id),
      source_evidence=(SELECT COALESCE(jsonb_agg(DISTINCT entry),'[]'::jsonb) FROM jsonb_array_elements(sdr_conversation_messages.source_evidence || EXCLUDED.source_evidence) entry),
      link_evidence=CASE WHEN sdr_conversation_messages.link_evidence='conflict:source_observations' OR EXCLUDED.link_evidence='conflict:source_observations'
        OR (sdr_conversation_messages.pipedrive_lead_id IS NOT NULL AND EXCLUDED.pipedrive_lead_id IS NULL AND EXCLUDED.source_evidence @> '[{"leadLinkObserved":true}]'::jsonb)
        OR (sdr_conversation_messages.pipedrive_deal_id IS NOT NULL AND EXCLUDED.pipedrive_deal_id IS NULL AND EXCLUDED.source_evidence @> '[{"dealLinkObserved":true}]'::jsonb)
        OR (sdr_conversation_messages.pipedrive_lead_id IS NOT NULL AND EXCLUDED.pipedrive_lead_id IS NOT NULL AND sdr_conversation_messages.pipedrive_lead_id<>EXCLUDED.pipedrive_lead_id)
        OR (sdr_conversation_messages.pipedrive_deal_id IS NOT NULL AND EXCLUDED.pipedrive_deal_id IS NOT NULL AND sdr_conversation_messages.pipedrive_deal_id<>EXCLUDED.pipedrive_deal_id)
        OR (sdr_conversation_messages.provider_thread_id IS NOT NULL AND EXCLUDED.provider_thread_id IS NOT NULL AND sdr_conversation_messages.provider_thread_id<>EXCLUDED.provider_thread_id)
        OR (sdr_conversation_messages.person_id IS NOT NULL AND EXCLUDED.person_id IS NOT NULL AND sdr_conversation_messages.person_id<>EXCLUDED.person_id)
        THEN 'conflict:source_observations' ELSE COALESCE(sdr_conversation_messages.link_evidence,EXCLUDED.link_evidence) END,observed_at=now()
    RETURNING (xmax = 0) AS inserted`,params);
  return {inserted:rows[0]?.inserted?1:0};
}

export function pipedriveMessageObservation(m,thread,account) {
  const key=value=>value===null || value===undefined ? null : String(value);
  const sourceEvidence=[{leadId:key(m.lead_id),dealId:key(m.deal_id),personId:key(m.person_id),threadId:key(m.mail_thread_id),evidence:'pipedrive:message'},
    {leadId:key(thread.lead_id),dealId:key(thread.deal_id),personId:key(thread.person_id),threadId:key(thread.id),evidence:'pipedrive:thread'}];
  const conflict=['leadId','dealId','personId','threadId'].some(field=>sourceEvidence[0][field] && sourceEvidence[1][field] && sourceEvidence[0][field]!==sourceEvidence[1][field]);
  const leadId=m.lead_id || thread.lead_id || null,dealId=m.deal_id || thread.deal_id || null;
  return {provider:'pipedrive',account:m.account_id||thread.account_id ? `pipedrive-account:${m.account_id||thread.account_id}`:account,
    id:m.id,threadId:m.mail_thread_id||thread.id,internetMessageId:m.mua_message_id || null,
    from:parties(m.from)[0]||null,to:parties(m.to),cc:parties(m.cc),occurredAt:m.message_time||m.timestamp,
    direction:m.sent_flag===true || m.sent_flag===1 ? 'out':m.sent_flag===false || m.sent_flag===0 ? 'in':'unknown',origin:'Unknown',
    leadLinkObserved:Object.hasOwn(m,'lead_id')||Object.hasOwn(thread,'lead_id'),dealLinkObserved:Object.hasOwn(m,'deal_id')||Object.hasOwn(thread,'deal_id'),
    personId:m.person_id || thread.person_id || null,leadId,dealId,sourceEvidence,linkConflict:conflict,
    linkEvidence:leadId||dealId?'pipedrive:explicit-thread-or-message-id':null};
}

async function checkpoint(pool,{provider,account,scope,status,cursor,pages,messages,errorCategory}) {
  await pool.query(`INSERT INTO sdr_conversation_coverage(provider,account_key,scope,status,cursor,pages,messages,error_category)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(provider,account_key,scope) DO UPDATE SET
    status=EXCLUDED.status,cursor=EXCLUDED.cursor,pages=EXCLUDED.pages,messages=EXCLUDED.messages,
    error_category=EXCLUDED.error_category,checked_at=now()`,[provider,account,scope,status,cursor||null,pages,messages,errorCategory||null]);
}

export async function backfillGmailHistory(pool,{accounts,getToken,gmail=gmailInbox,maxPages=4,pageSize=100}={}) {
  const result=[];
  for(const raw of accounts || []) {
    const account=email(raw),scope='all-mail';
    const saved=(await pool.query('SELECT cursor,pages,messages FROM sdr_conversation_coverage WHERE provider=$1 AND account_key=$2 AND scope=$3',['gmail',account,scope])).rows[0];
    let cursor=saved?.cursor||null,pages=Number(saved?.pages||0),messages=Number(saved?.messages||0),status='partial',errorCategory=null;
    try {
      const token=await getToken(account);
      const seen=new Set();
      for(let i=0;i<bounded(maxPages,4,20);i++) {
        const page=await gmail.listThreadPage(token,{query:'in:anywhere',pageToken:cursor||undefined,maxResults:bounded(pageSize,100,100)});
        if(!Array.isArray(page.threads)) throw new Error('invalid_gmail_page');
        for(const thread of page.threads) for(const m of thread.messages||[]) {
          const savedMessage=await observeConversationMessage(pool,{provider:'gmail',account,id:m.id,threadId:thread.id,internetMessageId:m.messageId,
            from:m.from,to:m.to,cc:m.cc,occurredAt:m.receivedAt,direction:m.lastOutbound?'out':'in',origin:'Unknown'});
          messages+=savedMessage.inserted;
        }
        pages++; cursor=page.nextPageToken||null;
        status=cursor?'partial':'complete';
        await checkpoint(pool,{provider:'gmail',account,scope,status,cursor,pages,messages});
        if(!cursor) break;
        if(seen.has(cursor)) {status='partial';break;}
        seen.add(cursor);
      }
    } catch(error) {status='error';errorCategory=category(error);await checkpoint(pool,{provider:'gmail',account,scope,status,cursor,pages,messages,errorCategory});}
    result.push({account,status,pages,messages,...(errorCategory?{errorCategory}:{})});
  }
  return {status:result.every(r=>r.status==='complete')?'complete':'partial',accounts:result};
}

export async function backfillPipedriveHistory(pool,{account,folders=['sent','inbox','archive'],pipedrive=pipedriveClient,maxPages=4,maxMessagePages=20,pageSize=100,resolvePersonId,classifyOrigin}={}) {
  const key=email(account);
  if(!key) throw new Error('account_required');
  const coverage=[];
  for(const folder of folders) {
    if(!['sent','inbox','archive'].includes(folder)) throw new Error('invalid_folder');
    const scope=`folder:${folder}`;
    const saved=(await pool.query('SELECT cursor,pages,messages FROM sdr_conversation_coverage WHERE provider=$1 AND account_key=$2 AND scope=$3',['pipedrive',key,scope])).rows[0];
    let start=Number(saved?.cursor||0),pages=Number(saved?.pages||0),messages=Number(saved?.messages||0),status='partial',errorCategory=null;
    try {
      for(let i=0;i<bounded(maxPages,4,20);i++) {
        const page=await pipedrive.listMailThreads({folder,start,limit:bounded(pageSize,100,500)});
        if(!Array.isArray(page.data)) throw new Error('invalid_pipedrive_page');
        let nestedPartial=false;
        for(const thread of page.data) {
          let messageStart=0,messageComplete=false;
          const seenStarts=new Set([0]);
          for(let mp=0;mp<bounded(maxMessagePages,20,100);mp++) {
            const mail=await pipedrive.listMailThreadMessages(thread.id,{start:messageStart,limit:bounded(pageSize,100,500)});
            if(!Array.isArray(mail.data)) throw new Error('invalid_pipedrive_messages');
            for(const m of mail.data) {
            const observation=pipedriveMessageObservation(m,thread,key);
            const personId=observation.leadId&&resolvePersonId?await resolvePersonId(observation.leadId):observation.personId;
            const origin=classifyOrigin ? classifyOrigin(m,thread) : null;
            const savedMessage=await observeConversationMessage(pool,{...observation,personId,
              origin:origin?.origin||'Unknown',originEvidence:origin?.evidence||null});
              messages+=savedMessage.inserted;
            }
            const pagination=mail.pagination||{};
            if(!pagination.more_items_in_collection) {messageComplete=true;break;}
            const next=Number(pagination.next_start);
            if(!Number.isInteger(next)||next<=messageStart||seenStarts.has(next)) break;
            seenStarts.add(next);messageStart=next;
          }
          if(!messageComplete) {nestedPartial=true;break;}
        }
        if(nestedPartial) {status='partial';await checkpoint(pool,{provider:'pipedrive',account:key,scope,status,cursor:String(start),pages,messages});break;}
        pages++;
        const p=page.pagination||{};
        start=Number(p.next_start ?? (start+page.data.length));
        status=p.more_items_in_collection?'partial':'complete';
        await checkpoint(pool,{provider:'pipedrive',account:key,scope,status,cursor:status==='partial'?String(start):null,pages,messages});
        if(status==='complete') break;
      }
    } catch(error) {status='error';errorCategory=category(error);await checkpoint(pool,{provider:'pipedrive',account:key,scope,status,cursor:String(start),pages,messages,errorCategory});}
    coverage.push({folder,status,pages,messages,...(errorCategory?{errorCategory}:{})});
  }
  return {status:coverage.every(c=>c.status==='complete')?'complete':'partial',folders:coverage};
}

export async function backfillPipedriveActivities(pool,{account,pipedrive=pipedriveClient,maxPages=4,pageSize=100,leadId,resolvePersonId}={}) {
  const key=email(account);
  if(!key) throw new Error('account_required');
  const scope=leadId?`activities:lead:${leadId}`:'activities:all-users';
  const saved=(await pool.query('SELECT cursor,pages,messages FROM sdr_conversation_coverage WHERE provider=$1 AND account_key=$2 AND scope=$3',['pipedrive',key,scope])).rows[0];
  let start=Number(saved?.cursor||0),pages=Number(saved?.pages||0),events=Number(saved?.messages||0),status='partial',errorCategory=null;
  try {
    for(let i=0;i<bounded(maxPages,4,20);i++) {
      const page=await pipedrive.listActivitiesPage({leadId,start,limit:bounded(pageSize,100,500)});
      if(!Array.isArray(page.data)) throw new Error('invalid_pipedrive_page');
      for(const activity of page.data) {
        const personId=activity.person_id||activity.lead?.person_id||
          (activity.lead_id&&resolvePersonId?await resolvePersonId(activity.lead_id):null);
        const {rows}=await pool.query(`INSERT INTO sdr_conversation_events
          (provider,account_key,provider_event_id,event_type,occurred_at,actor_id,person_id,pipedrive_lead_id,pipedrive_deal_id,status)
          VALUES('pipedrive',$1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(provider,account_key,provider_event_id) DO UPDATE SET
          event_type=EXCLUDED.event_type,occurred_at=COALESCE(EXCLUDED.occurred_at,sdr_conversation_events.occurred_at),
          actor_id=COALESCE(EXCLUDED.actor_id,sdr_conversation_events.actor_id),
          person_id=COALESCE(EXCLUDED.person_id,sdr_conversation_events.person_id),
          pipedrive_lead_id=COALESCE(EXCLUDED.pipedrive_lead_id,sdr_conversation_events.pipedrive_lead_id),
          pipedrive_deal_id=COALESCE(EXCLUDED.pipedrive_deal_id,sdr_conversation_events.pipedrive_deal_id),
          status=EXCLUDED.status,observed_at=now() RETURNING (xmax = 0) AS inserted`,[key,String(activity.id),activity.type||'activity',
            time(activity.marked_as_done_time||activity.add_time),activity.user_id?String(activity.user_id):null,
            personId?String(personId):null,activity.lead_id?String(activity.lead_id):null,
            activity.deal_id?String(activity.deal_id):null,activity.done?'completed':'pending']);
        events+=rows[0]?.inserted?1:0;
      }
      pages++;
      const p=page.pagination||{};
      start=Number(p.next_start??(start+page.data.length));
      status=p.more_items_in_collection?'partial':'complete';
      await checkpoint(pool,{provider:'pipedrive',account:key,scope,status,cursor:status==='partial'?String(start):null,pages,messages:events});
      if(status==='complete') break;
    }
  } catch(error) {status='error';errorCategory=category(error);await checkpoint(pool,{provider:'pipedrive',account:key,scope,status,cursor:String(start),pages,messages:events,errorCategory});}
  return {status,pages,events,...(errorCategory?{errorCategory}:{})};
}

function decodeCursor(cursor) {
  let before=null;
  if(cursor) {
    try {
      if(!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new Error();
      before=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
      if(!before||typeof before.provider!=='string'||typeof before.account!=='string'||typeof before.id!=='string'||
         (before.at!==null&&(!before.at||!Number.isFinite(+new Date(before.at))))) throw new Error();
    } catch {throw new Error('invalid_cursor');}
  }
  return before;
}
const encodeCursor = row => Buffer.from(JSON.stringify({at:row.occurred_at?.toISOString()||null,
  provider:row.provider,account:row.account_key,id:row.provider_message_id})).toString('base64url');

export async function readContactConversation(pool,{personId,visibleAccounts=[],includePipedrive=false,projectId,limit=100,cursor,eventCursor}={}) {
  if(!personId) throw new Error('person_required');
  const before=decodeCursor(cursor);
  const accounts=visibleAccounts.map(email);
  const count=bounded(limit,100,500);
  const {rows}=await pool.query(`SELECT provider,account_key,provider_message_id,provider_thread_id,internet_message_id,
    from_address,to_addresses,cc_addresses,occurred_at,direction,origin,origin_evidence,person_id,pipedrive_lead_id,pipedrive_deal_id,link_evidence
    FROM sdr_conversation_messages WHERE person_id=$1 AND
      ((provider='gmail' AND account_key=ANY($2::text[])) OR (provider='pipedrive' AND $3::boolean))
      AND ($4::text IS NULL OR pipedrive_lead_id=$4 OR pipedrive_lead_id IS NULL)
      AND ($5::boolean=false OR (COALESCE(occurred_at,'-infinity'::timestamptz),provider,account_key,provider_message_id)
        < (COALESCE($6::timestamptz,'-infinity'::timestamptz),$7,$8,$9))
    ORDER BY COALESCE(occurred_at,'-infinity'::timestamptz) DESC,provider DESC,account_key DESC,provider_message_id DESC LIMIT $10`,
    [String(personId),accounts,Boolean(includePipedrive),projectId||null,Boolean(before),before?.at||null,
      before?.provider||'',before?.account||'',before?.id||'',count+1]);
  const hasOlder=rows.length>count;
  const page=rows.slice(0,count);
  const last=page.at(-1);
  const nextCursor=hasOlder&&last?encodeCursor(last):null;
  const messages=[];
  for(const row of page.reverse()) {
    const reference={provider:row.provider,account:row.account_key,id:row.provider_message_id};
    const mirror=row.internet_message_id&&row.occurred_at?messages.find(existing=>
      existing.internet_message_id===row.internet_message_id&&
      existing.direction===row.direction&&
      email(existing.from_address)===email(row.from_address)&&
      existing.occurred_at?.getTime()===row.occurred_at.getTime()&&
      (!existing.pipedrive_lead_id||!row.pipedrive_lead_id||existing.pipedrive_lead_id===row.pipedrive_lead_id)&&
      (!existing.pipedrive_deal_id||!row.pipedrive_deal_id||existing.pipedrive_deal_id===row.pipedrive_deal_id)) : null;
    if(mirror) {
      mirror.sourceReferences.push(reference);
      if(!mirror.pipedrive_lead_id&&row.pipedrive_lead_id) {
        mirror.pipedrive_lead_id=row.pipedrive_lead_id;mirror.link_evidence=row.link_evidence;
      }
      if(!mirror.pipedrive_deal_id&&row.pipedrive_deal_id) mirror.pipedrive_deal_id=row.pipedrive_deal_id;
    } else messages.push({...row,sourceReferences:[reference]});
  }
  const eventBefore=decodeCursor(eventCursor);
  const eventRows=includePipedrive?(await pool.query(`SELECT provider,account_key,provider_event_id,event_type,occurred_at,actor_id,person_id,pipedrive_lead_id,pipedrive_deal_id,status
    FROM sdr_conversation_events WHERE person_id=$1 AND ($2::text IS NULL OR pipedrive_lead_id=$2 OR pipedrive_lead_id IS NULL)
    AND ($3::boolean=false OR (COALESCE(occurred_at,'-infinity'::timestamptz),provider,account_key,provider_event_id)
      < (COALESCE($4::timestamptz,'-infinity'::timestamptz),$5,$6,$7))
    ORDER BY COALESCE(occurred_at,'-infinity'::timestamptz) DESC,provider DESC,account_key DESC,provider_event_id DESC LIMIT $8`,
    [String(personId),projectId||null,Boolean(eventBefore),eventBefore?.at||null,eventBefore?.provider||'',
      eventBefore?.account||'',eventBefore?.id||'',count+1])).rows:[];
  const events=eventRows.slice(0,count);
  const eventLast=events.at(-1);
  const eventNextCursor=eventRows.length>count&&eventLast?Buffer.from(JSON.stringify({at:eventLast.occurred_at?.toISOString()||null,
    provider:eventLast.provider,account:eventLast.account_key,id:eventLast.provider_event_id})).toString('base64url'):null;
  events.reverse();
  const {rows:threads}=await pool.query(`SELECT m.account_key,m.provider_thread_id,
    MAX(m.occurred_at) FILTER (WHERE m.direction='in') AS latest_inbound_at,
    MAX(m.occurred_at) FILTER (WHERE m.direction='out') AS latest_outbound_at,
    MAX(h.handled_at) AS handled_at
    FROM sdr_conversation_messages m LEFT JOIN sdr_inbox_handled h
      ON h.thread_id=m.provider_thread_id AND h.mailbox_email=m.account_key
    WHERE m.provider='gmail' AND m.person_id=$1 AND m.account_key=ANY($2::text[])
    GROUP BY m.account_key,m.provider_thread_id`,[String(personId),accounts]);
  const threadStates=threads.map(row=>({account:row.account_key,threadId:row.provider_thread_id,
    latestInboundAt:row.latest_inbound_at,latestOutboundAt:row.latest_outbound_at,handledAt:row.handled_at,
    newInboundAfterHandled:Boolean(row.handled_at&&row.latest_inbound_at&&row.latest_inbound_at>row.handled_at)}));
  return {personId:String(personId),messages,events,threadStates,nextCursor,eventNextCursor,
    projects:[...new Set([...messages,...events].map(r=>r.pipedrive_lead_id).filter(Boolean))]};
}

export async function readUnlinkedMessages(pool,{visibleAccounts=[],limit=100,cursor}={}) {
  const before=decodeCursor(cursor);
  const count=bounded(limit,100,500);
  const {rows}=await pool.query(`SELECT provider,account_key,provider_message_id,provider_thread_id,internet_message_id,
    from_address,to_addresses,cc_addresses,occurred_at,direction,origin,person_id,pipedrive_lead_id,pipedrive_deal_id
    FROM sdr_conversation_messages WHERE provider='gmail' AND person_id IS NULL AND account_key=ANY($1::text[])
    AND ($2::boolean=false OR (COALESCE(occurred_at,'-infinity'::timestamptz),provider,account_key,provider_message_id)
      < (COALESCE($3::timestamptz,'-infinity'::timestamptz),$4,$5,$6))
    ORDER BY COALESCE(occurred_at,'-infinity'::timestamptz) DESC,provider DESC,account_key DESC,provider_message_id DESC LIMIT $7`,
    [visibleAccounts.map(email),Boolean(before),before?.at||null,before?.provider||'',before?.account||'',before?.id||'',count+1]);
  const page=rows.slice(0,count);
  const nextCursor=rows.length>count&&page.length?encodeCursor(page.at(-1)):null;
  return {messages:page.reverse().map(row=>({...row,reviewReason:'unlinked_identity'})),nextCursor};
}

export async function readSharedAddressCandidates(pool,{address}={}) {
  const key=email(address);
  if(!key.includes('@')) throw new Error('invalid_address');
  const {rows}=await pool.query(`SELECT pipedrive_person_id AS person_id,
    array_agg(pipedrive_lead_id ORDER BY pipedrive_lead_id) AS lead_ids
    FROM sdr_lead_state WHERE lower(person_email)=$1 AND pipedrive_person_id IS NOT NULL
    GROUP BY pipedrive_person_id ORDER BY pipedrive_person_id`,[key]);
  return rows.map(row=>({personId:row.person_id,leadIds:row.lead_ids}));
}

export async function readMessageBody(pool,{provider,account,id,visibleAccounts=[],includePipedrive=false,getGmailToken,gmail=gmailInbox,pipedrive=pipedriveClient}={}) {
  const key=email(account);
  if(provider==='gmail'&&!visibleAccounts.map(email).includes(key)) throw new Error('mailbox_not_visible');
  if(provider==='pipedrive'&&!includePipedrive) throw new Error('mailbox_not_visible');
  const row=(await pool.query('SELECT provider_thread_id FROM sdr_conversation_messages WHERE provider=$1 AND account_key=$2 AND provider_message_id=$3',[provider,key,String(id)])).rows[0];
  if(!row) throw new Error('message_not_found');
  if(provider==='gmail') {
    const token=await getGmailToken(key);
    const thread=await gmail.getThread(token,row.provider_thread_id);
    const message=thread.messages?.find(m=>String(m.id)===String(id));
    if(!message) throw new Error('message_not_found');
    return message;
  }
  if(provider==='pipedrive') return pipedrive.getMailMessage(id,{includeBody:true});
  throw new Error('invalid_provider');
}
