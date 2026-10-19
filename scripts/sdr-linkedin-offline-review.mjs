#!/usr/bin/env node
// Private local review of dated evidence packets. This command cannot approve or send a campaign.
import fs from 'node:fs/promises';import pg from 'pg';
import {reviewLinkedinCandidate,previewLinkedinCampaign,assignLinkedinCampaign,previewLinkedinActions,recordLinkedinOutcomeAttribution} from '../lib/sdrLinkedinOfflineReview.js';
const [command,inputPath,outputPath]=process.argv.slice(2);
const allowed={intake:['source','identity','links','email'],campaign:['config','expiresAt','campaignId','expectedRevision'],assign:['candidateId','campaignId','expectedRevision'],preview:['campaignId','providerSnapshot'],attribution:['candidateId','dealId','leadId','occurredAt','evidenceRef','channelActionId']};
if(!allowed[command]||!inputPath||!outputPath||process.argv.length!==5)throw Error('usage: node scripts/sdr-linkedin-offline-review.mjs intake|campaign|assign|preview|attribution input.json private-output.json');
const url=process.env.SDR_TEST_DATABASE_URL,accountId=process.env.SDR_LINKEDIN_OFFLINE_ACCOUNT_ID,reviewer=process.env.SDR_LINKEDIN_OFFLINE_REVIEWER;
if(process.env.SDR_LINKEDIN_OFFLINE_REVIEW!=='1'||!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname)||!accountId||!reviewer)throw Error('local_offline_review_required');
const input=JSON.parse(await fs.readFile(inputPath,'utf8'));
if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed[command].includes(key)))throw Error('invalid_review_packet');
const output=await fs.open(outputPath,'wx',0o600);
const pool=new pg.Pool({connectionString:url});let complete=false;
try{
 const base={pool,companyId:'13105180',accountId,reviewer};let result;
 if(command==='intake'){const row=await reviewLinkedinCandidate({...base,packet:input});result={id:row.id,revision:row.revision,state:row.state,source:row.source,sourceObservedAt:row.source_observed_at,evidenceKind:'reviewed_offline_packet'}}
 if(command==='campaign'){const row=await previewLinkedinCampaign({...base,...input});result={id:row.id,revision:row.revision,status:row.status,approvalDigest:row.approval_digest,config:row.config,expiresAt:row.expires_at}}
 if(command==='assign'){const row=await assignLinkedinCampaign({...base,...input});result={id:row.id,revision:row.revision,campaignId:row.campaign_id,state:row.state}}
 if(command==='preview')result=await previewLinkedinActions({...base,...input});
 if(command==='attribution'){const row=await recordLinkedinOutcomeAttribution({...base,...input});result={id:row.id,sourceAt:row.source_at,kind:row.kind,evidenceKind:'reviewed_crm'}}
 await output.writeFile(JSON.stringify(result,null,2)+'\n');complete=true;
}finally{await pool.end();await output.close();if(!complete)await fs.unlink(outputPath).catch(()=>{})}
