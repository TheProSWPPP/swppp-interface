import {linkedinHash} from './sdrLinkedinStore.js';
const missing=value=>value===null||value===undefined||value==='';
export function validateLinkedinCampaign(campaign){
 const reasons=[],c=campaign?.config||{};
 if(campaign?.status!=='approved'||!campaign.approvalDigest||!campaign.cohortDigest||!campaign.approvedBy||!campaign.approvedAt)reasons.push('approval_required');
 if(!campaign?.companyId||!campaign?.accountId||!Number.isInteger(campaign?.revision))reasons.push('identity_required');
 const window=c.sendWindow;let timezoneValid=false;try{new Intl.DateTimeFormat('en-US',{timeZone:c.timezone}).format();timezoneValid=true}catch{}
 if(!/^ACo[A-Za-z0-9_-]+$/.test(c.senderProviderId||'')||!timezoneValid||!window||window.weekdays?.join(',')!=='1,2,3,4,5'||window.start!=='08:00'||window.end!=='17:00'||!['hold','send_on_verified_observation'].includes(c.lateAcceptancePolicy)||!Array.isArray(c.followupDays)||c.followupDays.length!==2||c.followupDays.some((day,index)=>!Number.isInteger(day)||day<=0||day>365||index>0&&day<=c.followupDays[index-1])||!c.copy?.dm1||!c.copy?.followup1||!c.copy?.followup2||!Array.isArray(c.segments)||!c.segments.length||!Array.isArray(c.territories)||!c.territories.length||!Array.isArray(c.sources)||!c.sources.length||!Array.isArray(c.candidateSourceIds)||!c.candidateSourceIds.length||!Array.isArray(c.ownerIds)||!c.ownerIds.length||c.stopPolicy!=='any_inbound')reasons.push('config_incomplete');
 if(!Number.isInteger(c.budgets?.invite)||!Number.isInteger(c.budgets?.dm)||c.budgets.invite<0||c.budgets.dm<0)reasons.push('budget_unapproved');
 const expiry=campaign?.expiresAt?new Date(campaign.expiresAt):null;
 if(!expiry||!Number.isFinite(expiry.getTime())||expiry<=new Date())reasons.push('approval_expired');
 return {allowed:reasons.length===0,reasons,digest:linkedinHash({companyId:campaign?.companyId,accountId:campaign?.accountId,revision:campaign?.revision,config:c,cohort:campaign?.cohortDigest,expiresAt:expiry&&Number.isFinite(expiry.getTime())?expiry.toISOString():null})}
}
export function renderLinkedinStep({campaign,identity,facts={},step}){const copy=campaign?.config?.copy?.[step];if(!copy)throw Error('copy_unapproved');return copy.replace(/\{([a-zA-Z]+)\}/g,(_,field)=>{if(field==='firstName'&&identity.firstNameVerified&&identity.firstName)return identity.firstName;const fact=facts[field];if(!fact?.verified||missing(fact.value))throw Error('unverified_fact');return String(fact.value)})}
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
export function planLinkedinNextAction({candidate,campaign,observations={},now=new Date()}){if(!candidate||!campaign)return {step:null,held:true,reasons:['missing_context']};if(observations.inbound||observations.staffOutbound||candidate.state==='held'||candidate.state==='replied')return {step:null,held:true,reasons:['conversation_active']};if(observations.pendingInvite)return {step:null,held:true,reasons:['pending_invite']};if(observations.alreadyConnected&&!observations.relationReviewed)return {step:null,held:true,reasons:['existing_relation_review']};if(!observations.relationVerified)return {step:'invite',held:false,dueAt:nextLinkedinWindow(now,campaign.config)};if(!observations.dm1Confirmed){const unknown=observations.acceptanceDayUnknown||!observations.acceptanceAt;const late=observations.acceptanceAt&&localDay(new Date(observations.acceptanceAt),campaign.config.timezone)!==localDay(now,campaign.config.timezone);const held=campaign.config.lateAcceptancePolicy==='hold'&&(unknown||late);return {step:'dm1',held,reasons:held?['late_acceptance_review']:[],dueAt:new Date(observations.relationObservedAt||now)}}const step=observations.followup1Confirmed?'followup2':'followup1';if(observations.followup2Confirmed)return {step:null,held:true,reasons:['sequence_complete']};const days=step==='followup1'?campaign.config.followupDays[0]:campaign.config.followupDays[1];return {step,held:false,dueAt:nextLinkedinWindow(addBusinessDays(new Date(observations.dm1ConfirmedAt),days,campaign.config.timezone),campaign.config)}}
export function checkLinkedinEligibility({identity,campaign,crm,controls,replies,history,account,now=new Date()}){const reasons=[...validateLinkedinCampaign(campaign).reasons];if(!identity||identity.companyId!==campaign?.companyId||identity.accountId!==campaign?.accountId||!identity.personId||!identity.organizationId||!identity.ownerId||!/^ACo/.test(identity.providerId||'')||identity.product!=='classic')reasons.push('identity_unverified');if(crm?.ownerId!==identity?.ownerId||crm?.customer!==false||crm?.apolloMembership!=='none')reasons.push('crm_or_membership_unverified');if(crm?.bidInvite!==false)reasons.push('bid_invite_contact');if(controls?.held!==false||replies?.inbound!==false||replies?.staffOutbound===true)reasons.push('conversation_or_hold');if(account?.status!=='healthy'||account?.product!=='classic')reasons.push('account_unhealthy');if(!history?.complete||!history.observedAt||now-new Date(history.observedAt)>5*60*1000||now<new Date(history.observedAt))reasons.push('history_stale');if(!campaign?.config?.segments?.includes(identity?.segment)||!campaign?.config?.territories?.includes(identity?.territory))reasons.push('cohort_mismatch');return {allowed:reasons.length===0,reasons,evidenceRevision:identity?.revision||null}}
