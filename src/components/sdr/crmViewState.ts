import {displayTitle} from '../../lib/displayText';
import type {CrmObservations} from '../../lib/sdrCrmApi';

export const crmPlainText=(value:unknown)=>displayTitle(String(value??'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();

export function crmFollowupUnavailableMessage(reason:string|null|undefined) {
  if(!reason)return null;
  return reason==='permission_denied'
    ?'Pipedrive access is restricted. Follow-ups are hidden until access is restored.'
    :'CRM follow-ups are unavailable. Check source access and sync coverage before relying on this view.';
}

export function crmReadableEvidence(history:CrmObservations|null) {
  const stored=history?.unavailable?[]:history?.items||[];
  return {
    notes:stored.filter(item=>item.entity==='note').map(item=>item.data||{}),
    activities:stored.filter(item=>item.entity==='activity').map(item=>item.data||{}),
    revisions:history?.unavailable?[]:history?.revisions||[],
  };
}

// Presentation grouping only: retain every original record, timestamp and ID.
export function groupCrmNotes(notes:Record<string,unknown>[]) {
  const groups:Array<{content:unknown;originals:Record<string,unknown>[]}> = [];
  const byContent=new Map<string,number>();
  for(const note of notes) {
    const key=String(note.content??'');
    const existing=key?byContent.get(key):undefined;
    if(existing!==undefined)groups[existing].originals.push(note);
    else {if(key)byContent.set(key,groups.length);groups.push({content:note.content,originals:[note]});}
  }
  return groups;
}

// Retry the first page once when the server answers "busy" (503); later pages keep their own retry button.
export function shouldRetryFollowupRead(cursor:string|null,status:number|undefined,retried:boolean) {
  return cursor===null&&!retried&&status===503;
}

// Plain words for the Pipedrive task sync state shown above the follow-up list.
export function activitySyncLabel(status:string|null|undefined,loading=false) {
  switch(status){
    case 'complete':return 'up to date';
    case 'partial':return 'partly synced, some tasks may be missing';
    case 'error':return 'sync failed, check Pipedrive';
    case 'running':return 'updating';
    default:return loading?'checking…':'not checked yet';
  }
}

export function replyCoverageLabel(status:string|null|undefined) {
  return status==='partial'?'partly checked':'not checked yet';
}
