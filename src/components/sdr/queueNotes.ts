import type {SdrSettings} from '../../lib/sdrApi';

// "235 awaiting review" next to "Auto-send is on" reads like a contradiction. Say why in one sentence.
export function autoSendQueueNote(settings:Pick<SdrSettings,'auto_outreach_enabled'|'auto_outreach_mode'>|null|undefined,awaiting:number) {
  if(!settings||awaiting<=0)return null;
  const drafts=awaiting===1?'This draft was':`These ${awaiting} drafts were`;
  if(settings.auto_outreach_enabled&&settings.auto_outreach_mode==='send')
    return `Auto-send is on, so new drafts go out on their own; ${drafts.charAt(0).toLowerCase()+drafts.slice(1)} not sent automatically (for example a check held the contact, Apollo did not accept it, or it was made before auto-send was on) and ${awaiting===1?'waits':'wait'} for someone to send or skip ${awaiting===1?'it':'them'}.`;
  if(settings.auto_outreach_enabled)
    return `Auto-outreach is set to "Draft to Queue", so new drafts wait here until someone sends or skips them.`;
  return null;
}
