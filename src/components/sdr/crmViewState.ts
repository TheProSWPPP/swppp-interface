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
