import {hashDecisionContext} from './sdrChangeJournal.js';
export const outreachContextHash=hashDecisionContext;
export function evaluateOutreachInvariants({context={},controls=[],providerState={},now=new Date()}={}) {
 const contextHash=hashDecisionContext(context),reasons=[];
 if(controls.length)reasons.push('outreach_held');
 if(['paused','removed','unknown','unresolved'].includes(providerState.status))reasons.push('provider_state_requires_review');
 if(context.scheduledFor&&(!Number.isFinite(+new Date(context.scheduledFor))||new Date(context.scheduledFor)>now))reasons.push('scheduled_for_future');
 if(!(context.technicalComplete??context.complete)||!context.trigger||!context.personId||!context.organizationId||!context.recipientEmail)reasons.push('source_context_incomplete');
 // A recorded award-only restriction is global, even when its review is stale.
 if(context.cadence==='award_only'&&context.sequenceCadence!=='award_only')reasons.push('award_only_requires_matching_sequence');
 return {outcome:reasons.length?'hold':'allow',reasonCodes:reasons,contextHash,proposedCrmPatch:null};
}
export function evaluateOutreach({context={},viewedContextHash,controls=[],affiliationEvidence={},providerState={},now=new Date()}={}) {
 const invariant=evaluateOutreachInvariants({context,controls,providerState,now});
 if(invariant.outcome!=='allow')return invariant;
 const contextHash=invariant.contextHash,reasons=[];
 if(viewedContextHash&&viewedContextHash!==contextHash)reasons.push('reviewed_context_changed');
 if(context.businessReviewed===false||affiliationEvidence.status!=='reviewed'||affiliationEvidence.contextHash!==contextHash)reasons.push('project_role_unverified');
 if(!['standard','award_only'].includes(context.cadence))reasons.push('cadence_unverified');
 return {outcome:reasons.length?'review':'allow',reasonCodes:reasons,contextHash,proposedCrmPatch:null};
}
export function evaluateTransition({oldContext={},newContext={},affiliationEvidence={},providerState={},controls=[]}={}) {
 const changed=hashDecisionContext(oldContext)!==hashDecisionContext(newContext);
 if(!changed&&!controls.length)return {sourceDisposition:'keep',targetDisposition:'none'};
 const ownedObsolete=affiliationEvidence.status==='confirmed_obsolete_recipient'&&providerState.ownership==='verified_own'&&providerState.status==='active';
 // A request to stop still goes through the conditional-generation executor.
 return {sourceDisposition:ownedObsolete?'stop_owned':'review',targetDisposition:'review'};
}
