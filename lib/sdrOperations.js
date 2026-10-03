const WEEK_MS=7*24*60*60*1000;
const READ_TIMEOUT_MS=4000;
const MAX_SNAPSHOT_LENGTH=8192;
const MAX_CURSOR_LENGTH=16384;
const unknownCoverage=()=>({state:'unknown',lastCollectedAt:null,note:'Connected inbox coverage is unknown. Local records may omit staff, other inbox and call responses; project, owner and action evidence is latest locally recorded evidence.'});
function invalid() {throw new Error('invalid_reply_query');}
// Preserve database microseconds in continuation keys; JS Date alone truncates them.
function iso(value) {
 if(typeof value!=='string') invalid();
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!match) invalid();
 const [,year,month,day,hour,minute,second,fraction='',zone]=match;
 const local=new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
 if(!Number.isFinite(+local)||local.getUTCFullYear()!==Number(year)||local.getUTCMonth()+1!==Number(month)||local.getUTCDate()!==Number(day)||Number(hour)>23||Number(minute)>59||Number(second)>59) invalid();
 if(zone!=='Z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4,6))>59)) invalid();
 const date=new Date(value);if(!Number.isFinite(+date)) invalid();
 const tail=fraction.padEnd(6,'0').slice(3).replace(/0+$/,'');
 return {text:date.toISOString().replace('Z',`${tail}Z`),ms:+date+Number(`0.${tail||'0'}`)};
}
// pg_snapshot uses full-width decimal xid8 values, never JS numbers.
function visibility(value) {
 if(typeof value!=='string'||value.length>MAX_SNAPSHOT_LENGTH||!/^([1-9]\d{0,19}):([1-9]\d{0,19}):(?:[1-9]\d{0,19}(?:,[1-9]\d{0,19})*)?$/.test(value)) invalid();
 const [min,max,active]=value.split(':');
 const xmin=BigInt(min),xmax=BigInt(max);
 if(xmin>xmax||xmax>18446744073709551615n) invalid();
 let previous=xmin-1n;
 for(const part of active?active.split(','):[]) {
  const xid=BigInt(part);
  if(xid<xmin||xid>=xmax||xid<=previous) invalid();
  previous=xid;
 }
 return value;
}
export function validateReplyRead({visibleMailboxes=[],mailbox,asOf,visibilitySnapshot,cursor,limit=25,now=new Date()}={}, {checkScope=true}={}) {
 const scope=[...new Set(visibleMailboxes.map(v=>v.toLowerCase()))].sort();
 const selected=mailbox===undefined?null:mailbox;
 if(selected!==null&&(typeof selected!=='string'||selected.length>254||!/^\S+@\S+\.\S+$/.test(selected))) invalid();
 const normalized=selected?.toLowerCase()??null;
 if(!Number.isInteger(Number(limit))||!/^\d+$/.test(String(limit))||Number(limit)<1||Number(limit)>25) invalid();
 let continuation=null;
 if(cursor!==undefined) {
  if(typeof cursor!=='string'||!cursor.length||cursor.length>MAX_CURSOR_LENGTH||!/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();
  try {
   const raw=Buffer.from(cursor,'base64url');if(raw.toString('base64url')!==cursor) invalid();
   continuation=JSON.parse(raw.toString('utf8'));
  } catch {invalid();}
  if(!continuation||Object.keys(continuation).sort().join(',')!=='asOf,id,mailbox,receivedAt,scope,v,visibilitySnapshot'||continuation.v!==2||continuation.mailbox!==normalized||!Array.isArray(continuation.scope)||continuation.scope.some(v=>typeof v!=='string')||(checkScope&&JSON.stringify(continuation.scope)!==JSON.stringify(scope))||typeof continuation.id!=='string'||!continuation.id.length||continuation.id.length>4096) invalid();
 }
 if(visibilitySnapshot!==undefined&&asOf===undefined) invalid();
 const snapshot=visibilitySnapshot===undefined?(continuation?visibility(continuation.visibilitySnapshot):null):visibility(visibilitySnapshot);
 if(continuation&&visibility(continuation.visibilitySnapshot)!==snapshot) invalid();
 const end=iso(asOf===undefined?(continuation?.asOf??now.toISOString()):asOf);
 if(end.ms>+now||end.ms<+now-WEEK_MS) invalid();
 if(continuation&&iso(continuation.asOf).text!==end.text) invalid();
 const from=new Date(Math.floor(end.ms)-WEEK_MS).toISOString().replace('Z',`${end.text.split('.')[1].slice(3,-1)}Z`);
 if(continuation) {
  const received=iso(continuation.receivedAt);
  if(received.ms<end.ms-WEEK_MS||received.ms>=end.ms) invalid();
  continuation.receivedAt=received.text;
 }
 if(checkScope&&normalized&&!scope.includes(normalized)) throw new Error('mailbox_not_visible');
 return {scope,mailboxes:normalized?[normalized]:scope,context:{asOf:end.text,from,to:end.text,mailbox:normalized,visibilitySnapshot:snapshot},continuation,limit:Number(limit)};
}
function response(context,state='available') {
 return {state,context,total:state==='available'?0:null,items:[],nextCursor:null,coverage:unknownCoverage()};
}
async function connectBounded(pool) {
 let timer,expired=false;
 const connecting=pool.connect();
 try {
  return await Promise.race([connecting,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('replies_timeout'));},READ_TIMEOUT_MS);})]);
 } finally {
  clearTimeout(timer);
  if(expired) connecting.then(client=>client.release(),()=>{});
 }
}
const timestamp=value=>value==null?null:new Date(value).toISOString();
export async function readRecentReplies(pool,options={}) {
 const validated=validateReplyRead(options);
 const {scope,mailboxes,context,continuation,limit}=validated;
 const result=response(context);
 if(!mailboxes.length) return result;
 let client,releaseError;
 try {
  client=await connectBounded(pool);
  const query=(text,values)=>client.query({text,values,query_timeout:READ_TIMEOUT_MS});
  await query('BEGIN READ ONLY');
  await query("SET LOCAL statement_timeout = '3000ms'");
  const receipts=(await query("SELECT to_regclass('sdr_job_runs') IS NOT NULL AS available")).rows[0].available;
  // Capture visibility once in this statement and retain it across later reads.
  // The immutable insertion XID excludes transactions that commit after this snapshot.
  // One SQL snapshot for membership count and page. Enrichment is latest local evidence,
  // not an as-of business-state snapshot, and cannot suppress a durable reply.
  const {rows}=await query(`WITH visibility_context AS MATERIALIZED (
   SELECT COALESCE($7::pg_snapshot,pg_current_snapshot()) AS snapshot
  ), membership AS MATERIALIZED (
   SELECT m.* FROM sdr_reply_messages m CROSS JOIN visibility_context v WHERE reply_kind='human' AND mailbox_email=ANY($1::text[])
    AND received_at >= $2::timestamptz AND received_at < $3::timestamptz AND detected_at <= $3::timestamptz
    AND pg_visible_in_snapshot(m.ingestion_xid,v.snapshot)
  ), page AS (
   SELECT * FROM membership WHERE $4::timestamptz IS NULL OR (received_at,provider_message_id)<($4::timestamptz,$5::text)
   ORDER BY received_at DESC,provider_message_id DESC LIMIT $6
  ), enriched AS (
   SELECT p.provider_message_id,p.received_at,
    to_char(p.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_key,
    jsonb_build_object('id',p.provider_message_id,'receivedAt',p.received_at,'mailbox',p.mailbox_email,
     'source',p.source,'sourceMessageId',p.source_message_id,'threadId',p.thread_id,'prospectEmail',f.prospect_email,
     'project',jsonb_build_object('status',p.link_status,'id',CASE WHEN p.link_status='verified' THEN p.pipedrive_lead_id END,
      'title',l.lead_title,'basis',p.link_evidence),
     'owner',jsonb_build_object('status',CASE WHEN r.pipedrive_user_id IS NOT NULL THEN 'verified' ELSE 'unassigned' END,
      'pipedriveUserId',r.pipedrive_user_id,'label',CASE WHEN r.pipedrive_user_id IS NOT NULL THEN 'Pipedrive owner #'||r.pipedrive_user_id END),
     'response',jsonb_build_object('status',CASE WHEN p.staff_response_at IS NULL THEN 'unknown' ELSE 'recorded' END,
      'at',p.staff_response_at,'source',CASE WHEN p.staff_response_at IS NOT NULL THEN 'Connected inbox observation' END,'coverage','partial'),
     'intent',p.intent,'actions',COALESCE(a.actions,'[]'::jsonb)) AS item
   FROM page p
   LEFT JOIN sdr_message_facts f ON p.source='gmail' AND f.provider=p.source AND f.provider_message_id=p.source_message_id AND f.mailbox_email=p.mailbox_email AND f.direction='in'
   LEFT JOIN sdr_lead_state l ON p.link_status='verified' AND l.pipedrive_lead_id=p.pipedrive_lead_id
   LEFT JOIN sdr_reply_routes r ON r.mailbox_email=p.mailbox_email AND r.active AND r.verified_at IS NOT NULL
    AND r.pipedrive_user_id>0 AND r.pipedrive_user_id<=9007199254740991
   LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('kind',kind,'status',status,'requiresReview',requires_review,'receiptAt',receipt_at) ORDER BY created_at,id) AS actions
    FROM sdr_reply_actions WHERE provider_message_id=p.provider_message_id AND mailbox_email=p.mailbox_email
   ) a ON true
  )
  SELECT (SELECT snapshot::text FROM visibility_context) AS visibility_snapshot,
   (SELECT count(*)::int FROM membership) AS total,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('item',item,'receivedKey',received_key) ORDER BY received_at DESC,provider_message_id DESC) FROM enriched),'[]'::jsonb) AS records,
   ${receipts?`(SELECT CASE WHEN count(*)=cardinality($1::text[]) THEN min(last_complete) END FROM (
    SELECT scope,max(finished_at) AS last_complete FROM sdr_job_runs WHERE job='gmail_watch' AND scope=ANY($1::text[]) AND status='complete' AND finished_at<=$3::timestamptz GROUP BY scope
   ) collected)`:'NULL::timestamptz'} AS last_collected`,[mailboxes,context.from,context.asOf,continuation?.receivedAt??null,continuation?.id??null,limit+1,context.visibilitySnapshot]);
  await query('COMMIT');
  const row=rows[0],records=row.records.slice(0,limit);
  try {context.visibilitySnapshot=visibility(row.visibility_snapshot);} catch {throw new Error('replies_context_unavailable');}
  result.total=row.total;
  result.items=records.map(({item})=>({...item,receivedAt:timestamp(item.receivedAt),response:{...item.response,at:timestamp(item.response.at)},actions:item.actions.map(a=>({...a,receiptAt:timestamp(a.receiptAt)}))}));
  if(row.records.length>limit) {
   const last=records.at(-1);
   result.nextCursor=Buffer.from(JSON.stringify({v:2,asOf:context.asOf,visibilitySnapshot:context.visibilitySnapshot,mailbox:context.mailbox,scope,receivedAt:last.receivedKey,id:last.item.id})).toString('base64url');
   if(result.nextCursor.length>MAX_CURSOR_LENGTH||typeof last.item.id!=='string'||!last.item.id.length||last.item.id.length>4096) throw new Error('replies_context_unavailable');
  }
  if(row.last_collected) result.coverage={state:'partial',lastCollectedAt:timestamp(row.last_collected),note:'Connected inbox observations are partial. Staff, other inbox and call responses may be missing; project, owner and action evidence is latest locally recorded evidence.'};
  return result;
 } catch(error) {
  if(client) await client.query({text:'ROLLBACK',query_timeout:READ_TIMEOUT_MS}).catch(()=>{releaseError=error;});
  if(['42P01','42703'].includes(error.code)) return response(context,'unavailable');
  throw error;
 } finally {client?.release(releaseError);}
}
