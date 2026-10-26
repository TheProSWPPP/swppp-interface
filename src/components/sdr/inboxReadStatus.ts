import type {InboxCoverage,InboxMailboxCoverage} from '../../lib/sdrApi';

export type InboxRead = {mailbox:string;status:'current'|'stale'|'error'|'not_checked'|string;checkedAt:string|null;issue:'google_limit'|'read_failed'|null|string;retryAt:string|null};

export const chicagoTime=(value:string|null|undefined)=>value?new Date(value).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'})+' CT':null;

// One plain sentence per mailbox that is not fully read. Staff should never see raw states.
export function mailboxReadNote(box:InboxMailboxCoverage) {
  const copyFrom=chicagoTime(box.checkedAt),retry=chicagoTime(box.retryAt);
  switch(box.status){
    case 'complete':return null;
    case 'limited':return `${box.mailbox}: showing its newest 100 conversations.`;
    case 'disconnected':return `${box.mailbox}: not connected.`;
    case 'stale':return box.issue==='google_limit'
      ?`${box.mailbox}: Google paused reading for a minute. Showing the copy from ${copyFrom||'earlier'}${retry?`; it updates again after ${retry}`:''}.`
      :`${box.mailbox}: could not be read just now. Showing the copy from ${copyFrom||'earlier'}.`;
    default:return box.issue==='google_limit'
      ?`${box.mailbox}: Google paused reading for a minute, so its conversations are not shown yet${retry?`. Trying again after ${retry}`:''}.`
      :`${box.mailbox}: could not be read. Press Refresh; if it keeps failing, reconnect this mailbox.`;
  }
}

export function inboxCoverageSummary(coverage:InboxCoverage|null|undefined) {
  if(!coverage||coverage.complete)return null;
  const notes=coverage.mailboxes.map(mailboxReadNote).filter((note):note is string=>Boolean(note));
  if(!notes.length)return null;
  const problem=coverage.mailboxes.some(box=>box.status==='stale'||box.status==='error');
  return {
    tone:problem?'warning' as const:'info' as const,
    headline:problem?'Some mailboxes could not be read just now. Needs-reply counts only cover the conversations shown.':'Older conversations are not loaded. Needs-reply counts only cover the conversations shown.',
    notes,
  };
}

// System checks: a background run can be fine while live reads are being rate-limited. Show the worse of the two.
export function liveReadIssue(mailbox:string,reads:InboxRead[]|undefined) {
  const read=reads?.find(entry=>entry.mailbox.toLowerCase()===mailbox.toLowerCase());
  return read&&(read.status==='stale'||read.status==='error')?read:null;
}

export function liveReadSentence(read:InboxRead) {
  const retry=chicagoTime(read.retryAt);
  return read.issue==='google_limit'
    ?`Inbox page: Google paused reading ${read.mailbox}${retry?` until about ${retry}`:''}. ${read.status==='stale'?`Showing the copy from ${chicagoTime(read.checkedAt)||'earlier'}.`:'Nothing is shown for it yet.'}`
    :`Inbox page: ${read.mailbox} could not be read on the last try.`;
}
