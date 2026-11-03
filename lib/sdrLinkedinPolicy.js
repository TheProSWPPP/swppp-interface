import {linkedinHash} from './sdrLinkedinStore.js';
const missing=value=>value===null||value===undefined||value==='';
export const LINKEDIN_PROSPECT_SOURCE='linkedin_prospect';
const nonNegative=value=>Number.isInteger(value)&&value>=0;
export const linkedinBudgetsValid=b=>Boolean(b)&&nonNegative(b.invite)&&nonNegative(b.dm)&&nonNegative(b.inmail)&&nonNegative(b.withdraw);
// One lane: dm1 plus one follow-up per follow-up day (1 or 2, strictly increasing), and an
// InMail subject and body only for lanes A and B with config.inmail===true.
export function linkedinSequenceValid(c){
 if(!c||!['A','B','C','D'].includes(c.lane)||typeof c.inmail!=='boolean')return false;
 const days=c.followupDays;if(!Array.isArray(days)||days.length<1||days.length>2||days.some((day,index)=>!Number.isInteger(day)||day<=0||day>365||index>0&&day<=days[index-1]))return false;
 const copy=c.copy||{};const text=v=>typeof v==='string'&&v.trim().length>0;
 if(!text(copy.dm1)||!text(copy.followup1))return false;
 if(days.length===2?!text(copy.followup2):copy.followup2!==undefined&&copy.followup2!==null)return false;
 if(c.inmail&&(!['A','B'].includes(c.lane)||!text(copy.inmail?.subject)||!text(copy.inmail?.body)))return false;
 return true;
}
export const linkedinFollowupSteps=config=>Array.isArray(config?.followupDays)&&config.followupDays.length===1?['followup1']:['followup1','followup2'];
export const linkedinCopySteps=config=>['dm1',...linkedinFollowupSteps(config),...(config?.inmail?['inmail']:[])];
export function validateLinkedinCampaign(campaign){
 const reasons=[],c=campaign?.config||{};
 if(campaign?.status!=='approved'||!campaign.approvalDigest||!campaign.cohortDigest||!campaign.approvedBy||!campaign.approvedAt)reasons.push('approval_required');
 if(!campaign?.companyId||!campaign?.accountId||!Number.isInteger(campaign?.revision))reasons.push('identity_required');
 const window=c.sendWindow;let timezoneValid=false;try{new Intl.DateTimeFormat('en-US',{timeZone:c.timezone}).format();timezoneValid=true}catch{}
 if(!/^ACo[A-Za-z0-9_-]+$/.test(c.senderProviderId||'')||!timezoneValid||!window||window.weekdays?.join(',')!=='1,2,3,4,5'||window.start!=='08:00'||window.end!=='17:00'||!['hold','send_on_verified_observation'].includes(c.lateAcceptancePolicy)||!linkedinSequenceValid(c)||!Array.isArray(c.segments)||!c.segments.length||!Array.isArray(c.territories)||!c.territories.length||!Array.isArray(c.sources)||!c.sources.length||!Array.isArray(c.candidateSourceIds)||!c.candidateSourceIds.length||!Array.isArray(c.ownerIds)||!c.ownerIds.length||c.stopPolicy!=='any_inbound')reasons.push('config_incomplete');
 // The Pipedrive/AGC/LBA LinkedIn path is retired (Derek, 2026-11-03): only prospect lanes run.
 if(!Array.isArray(c.sources)||c.sources.length!==1||c.sources[0]!==LINKEDIN_PROSPECT_SOURCE)reasons.push('source_retired');
 if(!linkedinBudgetsValid(c.budgets))reasons.push('budget_unapproved');
 const expiry=campaign?.expiresAt?new Date(campaign.expiresAt):null;
 if(!expiry||!Number.isFinite(expiry.getTime())||expiry<=new Date())reasons.push('approval_expired');
 return {allowed:reasons.length===0,reasons,digest:linkedinHash({companyId:campaign?.companyId,accountId:campaign?.accountId,revision:campaign?.revision,config:c,cohort:campaign?.cohortDigest,expiresAt:expiry&&Number.isFinite(expiry.getTime())?expiry.toISOString():null})}
}
const fillFacts=(text,{identity,facts})=>text.replace(/\{([a-zA-Z]+)\}/g,(_,field)=>{if(field==='firstName'&&identity?.firstNameVerified&&identity.firstName)return identity.firstName;const fact=facts?.[field];if(!fact?.verified||missing(fact.value))throw Error('unverified_fact');return String(fact.value)});
// [[ ... ]] is an optional clause: dropped whole when any fact inside it is missing or
// unverified. A required fact outside one throws, so the person holds.
export function renderLinkedinText(text,{identity={},facts={}}={}){
 if(typeof text!=='string'||!text)throw Error('copy_unapproved');
 const out=[];let last=0;
 for(const match of text.matchAll(/\[\[([\s\S]*?)\]\]/g)){out.push(fillFacts(text.slice(last,match.index),{identity,facts}));try{out.push(fillFacts(match[1],{identity,facts}))}catch{/* optional clause dropped */}last=match.index+match[0].length}
 out.push(fillFacts(text.slice(last),{identity,facts}));return out.join('');
}
export function renderLinkedinInmail({campaign,identity,facts={}}){const copy=campaign?.config?.copy?.inmail;if(!campaign?.config?.inmail||!copy?.subject||!copy?.body)throw Error('copy_unapproved');return {subject:renderLinkedinText(copy.subject,{identity,facts}),body:renderLinkedinText(copy.body,{identity,facts})}}
// The InMail body is stored as JSON {subject,body}, so the action context hash covers both.
export function renderLinkedinStep({campaign,identity,facts={},step}){if(step==='inmail')return JSON.stringify(renderLinkedinInmail({campaign,identity,facts}));const copy=campaign?.config?.copy?.[step];if(typeof copy!=='string'||!copy)throw Error('copy_unapproved');return renderLinkedinText(copy,{identity,facts})}
const localParts=(date,timezone)=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
const localDay=(date,timezone)=>{const p=localParts(date,timezone);return `${p.year}-${p.month}-${p.day}`};
export const sameLinkedinLocalDay=(first,second,timezone)=>localDay(new Date(first),timezone)===localDay(new Date(second),timezone);
export function addBusinessDays(date,days,timezone='America/Chicago'){
 const original=new Date(date),parts=localParts(original,timezone);
 let day=new Date(Date.UTC(parts.year,parts.month-1,parts.day)),counted=0;
 while(counted<days){day=new Date(day.getTime()+86_400_000);if(![0,6].includes(day.getUTCDay()))counted++}
 const target=Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate(),parts.hour,parts.minute,parts.second,original.getUTCMilliseconds());
 let cursor=target;
 for(let i=0;i<3;i++){const seen=localParts(new Date(cursor),timezone);const local=Date.UTC(seen.year,seen.month-1,seen.day,seen.hour,seen.minute,seen.second,original.getUTCMilliseconds());cursor+=target-local}
 return new Date(cursor)
}
export function linkedinWindowOpen(date,config){try{const p=localParts(new Date(date),config.timezone),day=new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay();return config.sendWindow?.weekdays?.includes(day)&&p.hour>=8&&p.hour<17}catch{return false}}
export function nextLinkedinWindow(date,config){
 const start=new Date(date);if(linkedinWindowOpen(start,config))return start;
 const p=localParts(start,config.timezone);let day=new Date(Date.UTC(p.year,p.month-1,p.day));
 for(let i=0;i<8;i++){const weekday=day.getUTCDay();if(config.sendWindow?.weekdays?.includes(weekday)){
  const target=Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate(),8,0,0);let cursor=target;
  for(let n=0;n<3;n++){const seen=localParts(new Date(cursor),config.timezone);cursor+=target-Date.UTC(seen.year,seen.month-1,seen.day,seen.hour,seen.minute,seen.second)}
  if(cursor>=start.getTime())return new Date(cursor);
 }day=new Date(day.getTime()+86_400_000)}throw Error('send_window_unavailable')
}
// send_on_verified_observation: DM1 goes out within one business day of the first send
// window after the acceptance was observed; anything later waits for staff review.
export const linkedinDm1Deadline=(observedAt,config)=>addBusinessDays(nextLinkedinWindow(new Date(observedAt),config),1,config.timezone);
// The page: InMail for lanes A and B not accepted after 14 days; an unaccepted invite is
// withdrawn after 21 days. Each has its own switch (observations.inmailEnabled/withdrawEnabled).
export const LINKEDIN_INMAIL_AFTER_DAYS=14,LINKEDIN_WITHDRAW_AFTER_DAYS=21;
export function planLinkedinNextAction({candidate,campaign,observations={},now=new Date()}){
 if(!candidate||!campaign)return {step:null,held:true,reasons:['missing_context']};
 if(observations.inbound||observations.staffOutbound||candidate.state==='held'||candidate.state==='replied')return {step:null,held:true,reasons:['conversation_active']};
 const config=campaign.config;
 if(observations.withdrawConfirmed)return {step:null,held:true,reasons:['invite_withdrawn']};
 if(observations.pendingInvite){
  const sentAt=observations.inviteConfirmedAt?new Date(observations.inviteConfirmedAt):null;
  const age=sentAt&&Number.isFinite(sentAt.getTime())?now.getTime()-sentAt.getTime():null;
  if(age!==null&&config?.inmail===true&&observations.inmailEnabled===true&&!observations.inmailDone&&age>=LINKEDIN_INMAIL_AFTER_DAYS*86_400_000)return {step:'inmail',held:false,dueAt:nextLinkedinWindow(now,config)};
  if(age!==null&&observations.withdrawEnabled===true&&!observations.withdrawDone&&age>=LINKEDIN_WITHDRAW_AFTER_DAYS*86_400_000){
   // An old uncertain receipt has no invitation id; it is never guessed from the sent list.
   if(!observations.invitationId)return {step:null,held:true,reasons:['invitation_id_unknown']};
   return {step:'withdraw',held:false,dueAt:nextLinkedinWindow(now,config)};
  }
  return {step:null,held:true,reasons:[observations.inmailConfirmed?'inmail_sent':'pending_invite']};
 }
 if(observations.alreadyConnected&&!observations.relationReviewed)return {step:null,held:true,reasons:['existing_relation_review']};
 if(!observations.relationVerified)return {step:'invite',held:false,dueAt:nextLinkedinWindow(now,config)};
 // Someone who accepts after an InMail already has our message: staff decides what comes next.
 if(observations.inmailConfirmed)return {step:null,held:true,reasons:['accepted_after_inmail']};
 if(!observations.dm1Confirmed){const observedAt=new Date(observations.relationObservedAt||now);let held;if(config.lateAcceptancePolicy==='hold'){const unknown=observations.acceptanceDayUnknown||!observations.acceptanceAt;const late=observations.acceptanceAt&&localDay(new Date(observations.acceptanceAt),config.timezone)!==localDay(now,config.timezone);held=unknown||late}else held=now>linkedinDm1Deadline(observedAt,config);return {step:'dm1',held,reasons:held?['late_acceptance_review']:[],dueAt:nextLinkedinWindow(observedAt,config)}}
 // Follow-ups are counted from M1. The sequence ends after followupDays.length follow-ups.
 const steps=linkedinFollowupSteps(config);const index=steps.findIndex(step=>observations[`${step}Confirmed`]!==true);
 if(index===-1)return {step:null,held:true,reasons:['sequence_complete']};
 return {step:steps[index],held:false,dueAt:nextLinkedinWindow(addBusinessDays(new Date(observations.dm1ConfirmedAt),config.followupDays[index],config.timezone),config)};
}
// Prospect lanes have no Pipedrive person, owner route or email sequence. skipReason is the
// local prospectSkipReason result, re-read immediately before this check.
export function checkLinkedinProspectEligibility({identity,campaign,skipReason,account,history,now=new Date()}){
 const reasons=[...validateLinkedinCampaign(campaign).reasons];
 if(!identity||identity.companyId!==campaign?.companyId||identity.accountId!==campaign?.accountId||!/^li:ACo[A-Za-z0-9_-]+$/.test(identity.personId||'')||identity.personId!==`li:${identity.providerId}`||!/^ACo[A-Za-z0-9_-]+$/.test(identity.providerId||'')||identity.product!=='classic'||identity.source!==LINKEDIN_PROSPECT_SOURCE||identity.lane!==campaign?.config?.lane)reasons.push('identity_unverified');
 if(!identity?.ownerId||!campaign?.config?.ownerIds?.includes(identity.ownerId))reasons.push('identity_unverified');
 if(skipReason!==null)reasons.push('conversation_or_hold');
 if(account?.status!=='healthy'||account?.product!=='classic')reasons.push('account_unhealthy');
 if(!history?.complete||!history.observedAt||now-new Date(history.observedAt)>5*60*1000||now<new Date(history.observedAt))reasons.push('history_stale');
 if(!campaign?.config?.segments?.includes(identity?.segment)||!campaign?.config?.territories?.includes(identity?.territory))reasons.push('cohort_mismatch');
 return {allowed:reasons.length===0,reasons:[...new Set(reasons)],evidenceRevision:identity?.revision||null};
}
export function checkLinkedinEligibility({identity,campaign,crm,controls,replies,history,account,now=new Date()}){const reasons=[...validateLinkedinCampaign(campaign).reasons];if(!identity||identity.companyId!==campaign?.companyId||identity.accountId!==campaign?.accountId||!identity.personId||!identity.organizationId||!identity.ownerId||!/^ACo/.test(identity.providerId||'')||identity.product!=='classic')reasons.push('identity_unverified');if(crm?.ownerId!==identity?.ownerId||crm?.customer!==false||crm?.apolloMembership!=='none')reasons.push('crm_or_membership_unverified');if(crm?.bidInvite!==false)reasons.push('bid_invite_contact');if(controls?.held!==false||replies?.inbound!==false||replies?.staffOutbound===true)reasons.push('conversation_or_hold');if(account?.status!=='healthy'||account?.product!=='classic')reasons.push('account_unhealthy');if(!history?.complete||!history.observedAt||now-new Date(history.observedAt)>5*60*1000||now<new Date(history.observedAt))reasons.push('history_stale');if(!campaign?.config?.segments?.includes(identity?.segment)||!campaign?.config?.territories?.includes(identity?.territory))reasons.push('cohort_mismatch');return {allowed:reasons.length===0,reasons,evidenceRevision:identity?.revision||null}}
