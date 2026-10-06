import {createHash} from 'node:crypto';
import {hashDecisionContext,hashContextDependencies} from './sdrChangeJournal.js';
import {evaluateOutreach,evaluateOutreachInvariants} from './sdrOutreachPolicy.js';
export const OUTREACH_POLICY_VERSION='role-affiliation-cadence-v1';
const blocked=code=>Object.assign(new Error(code),{code,status:409,preserveDraft:true});
function validateConfig(config,companyId) {
 if(!config||String(config.companyId)!==String(companyId)||!['observe','enforce'].includes(config.mode)||!Number.isInteger(config.version)||config.version<1)
  throw blocked('policy_rollout_unconfigured');
 if(config.cohort&&(!Number.isInteger(config.cohort.version)||typeof config.cohort.active!=='boolean'||!config.cohort.dependencyHash||!config.cohort.contextHash))throw blocked('policy_cohort_unverified');
 return config;
}
export async function getPolicyRollout(db,{companyId,leadId}) {
 if(!companyId||!leadId)throw blocked('policy_rollout_unconfigured');
 const row=(await db.query(`SELECT r.*,to_jsonb(c) AS cohort FROM
  (SELECT * FROM sdr_policy_rollouts WHERE company_id=$1 ORDER BY version DESC LIMIT 1) r
  LEFT JOIN LATERAL (SELECT * FROM sdr_policy_cohorts WHERE company_id=$1 AND lead_id=$2 ORDER BY version DESC LIMIT 1) c ON true`,[String(companyId),String(leadId)])).rows[0];
 return validateConfig(row?{companyId:row.company_id,version:row.version,mode:row.mode,cohort:row.cohort?{
  version:row.cohort.version,active:row.cohort.active,dependencyHash:row.cohort.dependency_hash,contextHash:row.cohort.context_hash}:null}:null,companyId);
}
export function policyRequiresReview(config,context) {
 validateConfig(config,context.companyId);
 return config.mode==='enforce'||config.cohort?.active===true;
}
// This observer only appends a decision. It has no provider, hold, note or draft writer.
export async function observeOutreachPolicy(db,{context,config,actionKey,phase='preflight',invariantDecision,affiliationEvidence=context.reviewEvidence,reviewedDraftContextHash,recordDecision=recordPolicyDecision}) {
 const enforced=policyRequiresReview(config,context);
 if(!actionKey)throw blocked('policy_action_identity_required');
 const contextHash=hashDecisionContext(context),dependencyHash=hashContextDependencies(context);
 const invariant=invariantDecision||evaluateOutreachInvariants({context});
 const proposed=evaluateOutreach({context,affiliationEvidence});
 if(proposed.outcome==='allow'&&phase!=='observation'&&reviewedDraftContextHash!==contextHash){proposed.outcome='review';proposed.reasonCodes.push('draft_review_context_changed');}
 const cohortChanged=config.cohort?.active&&(config.cohort.dependencyHash!==dependencyHash||config.cohort.contextHash!==contextHash);
 if(cohortChanged){proposed.outcome='hold';proposed.reasonCodes=[...new Set(['cohort_context_changed',...proposed.reasonCodes])];}
 const actual=invariant.outcome!=='allow'?invariant:enforced?proposed:{outcome:'allow',reasonCodes:[]};
 const evidence={companyId:String(context.companyId),leadId:String(context.leadId),policyVersion:OUTREACH_POLICY_VERSION,mode:config.mode,
  rolloutVersion:config.version,cohortVersion:config.cohort?.version??null,enforced,actionKey:String(actionKey),phase,
  contextHash,dependencyHash,sourceHash:context.sourceRevision||'unverified',proposedOutcome:proposed.outcome,reasonCodes:proposed.reasonCodes,
  invariantOutcome:invariant.outcome,invariantReasons:invariant.reasonCodes,actualOutcome:actual.outcome,actualReasons:actual.reasonCodes};
 await recordDecision(db,evidence);
 return {...actual,contextHash,enforced};
}
export async function recordPolicyDecision(db,evidence) {
 const key=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
 await db.query(`INSERT INTO sdr_policy_decisions
  (decision_key,company_id,lead_id,policy_version,mode,rollout_version,cohort_version,enforced,action_key,phase,context_hash,dependency_hash,source_hash,proposed_outcome,reason_codes,invariant_outcome,invariant_reasons,actual_outcome,actual_reasons)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18,$19::jsonb) ON CONFLICT(decision_key) DO NOTHING`,
 [key,evidence.companyId,evidence.leadId,evidence.policyVersion,evidence.mode,evidence.rolloutVersion,evidence.cohortVersion,evidence.enforced,evidence.actionKey,evidence.phase,evidence.contextHash,evidence.dependencyHash,evidence.sourceHash,evidence.proposedOutcome,JSON.stringify(evidence.reasonCodes),evidence.invariantOutcome,JSON.stringify(evidence.invariantReasons),evidence.actualOutcome,JSON.stringify(evidence.actualReasons)]);
 return {decisionKey:key};
}
