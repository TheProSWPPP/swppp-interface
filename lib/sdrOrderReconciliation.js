export const PAID_FIELD_ID='6a0e348d6e8edc38fa3f7271';
const COMPLETED_LIST_ID='64a5d86069f88711715b27fd';

export function resolveProjectCard(project,cards) {
 let ref;
 try {
  const url=new URL(project.data?.trelloLink||'');
  if(!['trello.com','www.trello.com'].includes(url.hostname)) throw new Error('invalid_host');
  ref=url.pathname.match(/^\/c\/([A-Za-z0-9]+)(?:\/|$)/)?.[1];
  if(!ref||!/^(?:[a-fA-F0-9]{24}|[A-Za-z0-9]{8})$/.test(ref)) throw new Error('invalid_card_ref');
 }catch{return {state:'unmatched',cardId:null};}
 const hits=[...new Map((cards||[]).filter(c=>c?.id&&(c.id===ref||c.shortLink===ref)).map(c=>[c.id,c])).values()];
 return {state:hits.length===1?'verified':hits.length?'ambiguous':'unmatched',cardId:hits.length===1?hits[0].id:null};
}

export function invoicePaidState(items,paidOptions) {
 const idValue=(items||[]).find(i=>i.idCustomField===PAID_FIELD_ID)?.idValue;
 const value=(paidOptions||{})[idValue];
 return value==='Y'?'paid':value==='N'?'unpaid':'unknown';
}

function validObservationTime(value) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ||!Number.isFinite(Date.parse(value))) return false;
 const parts=value.slice(0,19).match(/\d+/g).map(Number);
 const [year,month,day,hour,minute,second]=parts;
 return new Date(Date.UTC(year,month-1,day,hour,minute,second)).toISOString().slice(0,19)===value.slice(0,19);
}

function coverageOf(source,expectedKind,rows,retainedKind) {
 if(!source||!Array.isArray(rows)||!validObservationTime(source.observedAt)
  ||![expectedKind,retainedKind].includes(source.kind))
  return {kind:'unavailable',complete:false,stale:null,observedAt:null};
 const complete=source.kind===expectedKind&&source.complete===true;
 return {kind:source.kind,complete,stale:!complete,observedAt:source.observedAt,
  ...(source.listId?{listId:source.listId}:{})};
}

function validLinkEvidence(link,projectId,cardId) {
 const evidence=link.evidence;
 if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)) return false;
 if(evidence.type==='exact_project_id') return String(link.projectId||'')===String(projectId)
  &&String(evidence.value||'')===String(projectId);
 if(evidence.type==='exact_card_id') return Boolean(cardId&&link.cardId===cardId&&evidence.value===cardId);
 if(evidence.type==='documented_review') return ['invoice_id','order_confirmation_id','signed_quote_id'].includes(evidence.referenceType)
  &&typeof evidence.referenceId==='string'&&Boolean(evidence.referenceId.trim())
  &&typeof evidence.reviewRecordId==='string'&&Boolean(evidence.reviewRecordId.trim());
 return false;
}

function resolveReviewedDeal(projectId,cardId,deals,dealLinks) {
 const accepted=(dealLinks||[]).filter(link=>link?.reviewed===true&&link.dealId&&
  (String(link.projectId||'')===String(projectId)||Boolean(cardId&&link.cardId===cardId))
  &&validLinkEvidence(link,projectId,cardId));
 const uniqueIds=[...new Set(accepted.map(link=>String(link.dealId)))];
 if(uniqueIds.length>1) return {state:'ambiguous',deal:null};
 const deal=uniqueIds.length===1?(deals||[]).find(item=>String(item.id)===uniqueIds[0]):null;
 return {state:deal?'verified':'unmatched',deal:deal||null};
}

export function reconcileOrderProjects(projects,{
 cards,cardCoverage,paidOptions={},completedListId=COMPLETED_LIST_ID,deals,dealLinks=[],dealCoverage,now=new Date()
}={}) {
 const readAt=new Date(now).toISOString();
 const cardSource=coverageOf(cardCoverage,'current_board',cards,'retained_one_list');
 const dealSource=coverageOf(dealCoverage,'current_deals',deals,'retained_deals');
 const observedCards=cardSource.kind==='unavailable'?null:cards;
 const observedDeals=dealSource.kind==='unavailable'?null:deals;
 const items=(projects||[]).map(project=>{
  const data=project.data||{};
  const id=String(project.id??data.id);
  const identity=resolveProjectCard(project,observedCards||[]);
  const card=identity.cardId?observedCards?.find(c=>c.id===identity.cardId):null;
  const cardLinkState=!observedCards?'unobserved':identity.state;
  const dealLink=resolveReviewedDeal(id,identity.cardId,observedDeals,dealLinks);
  const dealLinkState=!observedDeals?'unobserved':dealLink.state;
  const hasCurrentCard=Boolean(card&&cardSource.complete);
  const jobCompleted=hasCurrentCard&&card.idList?card.idList===completedListId:null;
  const invoicePaid=card?invoicePaidState(card.customFieldItems,paidOptions):'unknown';
  const reasons=[];
  if(!data.trelloLink) reasons.push('project_trello_link_absent');
  else if(!observedCards) reasons.push('card_source_unavailable');
  else if(cardLinkState==='ambiguous') reasons.push('card_identity_ambiguous');
  else if(cardLinkState==='unmatched') reasons.push(cardSource.complete?'card_identity_unmatched':'outside_card_sample_or_unmatched');
  if(card&&!cardSource.complete) reasons.push('card_snapshot_partial_or_stale');
  if(jobCompleted===null) reasons.push('job_completion_unknown');
  if(invoicePaid==='unknown') reasons.push('invoice_payment_unknown');
  if(dealLinkState!=='verified') reasons.push(dealLinkState==='ambiguous'?'deal_link_ambiguous':'deal_link_unverified');
  return {projectId:id,projectName:data.projectName||project.name||null,companyName:data.companyName||null,
   contactName:data.contactName||null,documentStatus:project.status||data.status||null,
   cardLinkState,cardId:identity.cardId,trelloListId:card?.idList||null,jobCompleted,invoicePaid,
   crmStatus:dealLink.deal?.status||null,dealId:dealLink.deal?String(dealLink.deal.id):null,dealLinkState,
   observedAt:{document:readAt,trello:card?cardSource.observedAt:null,crm:dealLink.deal?.observedAt||dealSource.observedAt},
   exceptionReasons:reasons};
 });
 return {state:'available',coverage:{documents:{kind:'current_database',complete:true,observedAt:readAt},cards:cardSource,
  deals:dealSource,retainedAudit:{cards:1110,scope:'one_follow_up_list',observedAt:'2026-10-03T17:00:53.112Z',
   exactProjectCardLinks:214,availableAsRowSource:false}},items};
}

export async function readOrderReconciliation(pool,{limit=50,offset=0,readCards,readDeals}={}) {
 const {rows}=await pool.query('SELECT id, name, status, data FROM projects WHERE archived = FALSE ORDER BY id DESC');
 const [cardsRead,dealsRead]=await Promise.allSettled([
  readCards?Promise.resolve().then(readCards):null,
  readDeals?Promise.resolve().then(readDeals):null
 ]);
 const cardSource=cardsRead.status==='fulfilled'?cardsRead.value:null;
 const dealSource=dealsRead.status==='fulfilled'?dealsRead.value:null;
 const sourceFailures=[...(cardsRead.status==='rejected'?['cards']:[]),...(dealsRead.status==='rejected'?['deals']:[])];
 const result=reconcileOrderProjects(rows,{
  cards:cardSource?.cards,cardCoverage:cardSource?.coverage,paidOptions:cardSource?.paidOptions,
  completedListId:cardSource?.completedListId,deals:dealSource?.deals,dealLinks:dealSource?.links,
  dealCoverage:dealSource?.coverage});
 const exceptions=result.items.filter(item=>item.exceptionReasons.length);
 return {...result,sourceFailures,total:exceptions.length,limit,offset,items:exceptions.slice(offset,offset+limit)};
}
