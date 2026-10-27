// System checks are read by non-technical staff: turn internal run scopes and error codes into words.
const PIPEDRIVE_FOLDERS:Record<string,string>={inbox:'inbox',sent:'sent mail',archive:'archived mail'};

export function jobScopeLabel(scope:string|null|undefined) {
  const value=String(scope||'');
  if(!value||value==='account'||value==='global')return null;
  const gmail=/^gmail:([^:]+):(recent-head|recent|history)$/.exec(value);
  if(gmail)return `${gmail[1]} · ${gmail[2]==='history'?'older mail':gmail[2]==='recent-head'?'newest mail, quick check':'newest mail'}`;
  const pipedrive=/^pipedrive:.*:(recent-head|recent|history):(inbox|sent|archive)$/.exec(value);
  if(pipedrive)return `Pipedrive ${PIPEDRIVE_FOLDERS[pipedrive[2]]} · ${pipedrive[1]==='history'?'older mail':pipedrive[1]==='recent-head'?'newest mail, quick check':'newest mail'}`;
  if(/^pipedrive:/.test(value))return 'Pipedrive mail';
  return value;
}

const ISSUES:Record<string,string>={
  permission:'Access was refused. The account may need to be reconnected.',
  authentication:'Sign-in to the provider failed. The account may need to be reconnected.',
  rate_limit:'The provider asked us to slow down. It retries on its own.',
  network:'Could not reach the provider. It retries on its own.',
  provider_error:'The provider had an error. It retries on its own.',
  timeout:'The check took too long. It retries on its own.',
  interrupted:'The run stopped part way (usually a restart). It retries on its own.',
  unavailable:'The source was unavailable. It retries on its own.',
  missing_schema:'A database update has not been applied yet.',
};

export function jobIssueLabel(category:string|null|undefined) {
  if(!category)return null;
  return ISSUES[category]||`Issue: ${category.replaceAll('_',' ')}.`;
}

// Outreach replenishment, admins only: how unconfirmed (catch-all / unknown) addresses fared in
// the last run. They are capped per day and held for a sequence that is bouncing.
export function softVerdictSummary(counts:Record<string,number>|undefined|null) {
  if(!counts||!['softEnrolled','softCapped','softPausedBounce'].some(key=>key in counts))return null;
  const n=(key:string)=>Number(counts[key])||0;
  const parts=[`${n('softEnrolled')} enrolled`];
  if(n('softCapped'))parts.push(`${n('softCapped')} held by the daily limit${n('softDailyCap')?` of ${n('softDailyCap')}`:''}`);
  if(n('softPausedBounce'))parts.push(`${n('softPausedBounce')} held because ${n('softBouncingSequences')===1?'a sequence is':'sequences are'} bouncing 4% or more`);
  return `Unconfirmed (catch-all) addresses, last run: ${parts.join(', ')}.${n('softGuardUnavailable')?' The bounce check could not be read, so none were sent.':''}`;
}
