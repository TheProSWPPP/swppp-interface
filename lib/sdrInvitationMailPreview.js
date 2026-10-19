import {createHash} from 'node:crypto';

const clean=value=>String(value??'').trim();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deadlineMeaning=meaning=>/bid due|submission deadline/i.test(clean(meaning));

export function stageInvitationMailPreview({register,companyId,asOf}={}){
 if(!companyId||register?.companyId!==companyId)throw new Error('company_scope_mismatch');
 if(!Array.isArray(register.entries)||!Number.isFinite(Date.parse(asOf)))throw new Error('invalid_preview_source');
 const candidates=[],byKey=new Map();
 let excluded=0;
 for(const entry of register.entries){
  if(entry.classification!=='real_project_invitation'||entry.marketingOnly===true){excluded++;continue;}
  const source=entry.source||{};
  if(source.provider!=='pipedrive'||!clean(source.accountId)||!clean(source.messageId)||!clean(source.threadId)||!clean(source.subject))throw new Error('invalid_message_identity');
  const key=[companyId,source.provider,source.accountId,source.messageId].join(':');
  const printedDates=Array.isArray(entry.due)?entry.due.map(item=>({date:item.date||null,time:item.time||null,timezone:item.timezone||null,meaning:item.meaning||null})):[];
  const sourceFacts={subject:source.subject,bodySha256:source.bodySha256||null,sourceLinks:source.invitationSourceLinks||[],printedDates,platform:entry.platform};
  const prior=byKey.get(key);
  if(prior){if(prior.sourceDigest!==digest(sourceFacts)){prior.sourceConflict=true;prior.governingDeadline=null;prior.printedDeadlineReview='source_conflict';}continue;}
  const dates=[...new Set(printedDates.filter(item=>deadlineMeaning(item.meaning)).map(item=>item.date).filter(Boolean))];
  const printedBidDate=dates.length===1?dates[0]:null;
  const printedDeadlineReview=dates.length>1?'conflicting_printed_deadlines':!printedBidDate?'missing_printed_deadline':printedBidDate<asOf.slice(0,10)?'past_printed_deadline':printedBidDate===asOf.slice(0,10)?'same_day_printed_deadline':'future_printed_deadline';
  const candidate={key,platform:entry.platform,projectTitle:source.subject,contractor:null,buyer:null,invitationAt:source.recordedMessageTime||null,sourceMessage:{provider:source.provider,accountId:source.accountId,threadId:String(source.threadId),messageId:String(source.messageId),bodySha256:source.bodySha256||null},sourceLinks:source.invitationSourceLinks||[],sourceDigest:digest(sourceFacts),printedDates,printedBidDate,governingDeadline:null,printedDeadlineReview,currentOpen:'unverified',submission:'unknown',quote:{sent:'unknown'},crmMatch:{status:'unresolved',reason:'no_verified_project_link'},websiteOrderMatch:{status:'unresolved',reason:'no_verified_order_link'},estimator:null,serviceFit:entry.tradeFitEvidence||'unverified',nextAction:'Confirm current portal/buyer status, scope, existing estimator work, CRM project and website order before any outreach.',sourceConflict:false};
  byKey.set(key,candidate);candidates.push(candidate);
 }
 return {asOf,companyId,mode:'offline_review_only',candidates,counts:{sourceMessages:register.entries.length,uniqueCandidates:candidates.length,excluded,confirmedOpen:0}};
}
