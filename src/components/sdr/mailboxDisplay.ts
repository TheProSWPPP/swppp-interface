import type {SdrMailbox} from '../../lib/sdrApi';

// Apollo's warmup flag stays "pending" on mailboxes that have been sending for weeks; staff read
// "pending" as "not sending". Label what the mailbox is actually doing.
export function mailboxStatus(m:Pick<SdrMailbox,'warmup_status'|'active'|'delivered_14d'>) {
  if(!m.active)return {label:'Turned off',tone:'slate' as const};
  if(m.warmup_status==='paused')return {label:'Paused',tone:'slate' as const};
  if(m.warmup_status==='ready')return {label:'Ready',tone:'emerald' as const};
  if(m.warmup_status==='warming')return {label:'Warming up',tone:'amber' as const};
  if((m.delivered_14d??0)>0)return {label:'Sending',tone:'emerald' as const};
  return {label:'Not sending yet',tone:'slate' as const};
}

// A score of 0.00 means Apollo never sent one, not a failing mailbox.
export function healthScoreText(m:Pick<SdrMailbox,'deliverability_score'|'last_health_check_at'>) {
  const score=m.deliverability_score==null?null:Number(m.deliverability_score);
  if(score==null||!Number.isFinite(score)||score<=0)return 'Not synced';
  const when=m.last_health_check_at?new Date(m.last_health_check_at).toLocaleDateString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric'}):null;
  return `${score.toFixed(1)}${when?` (as of ${when})`:''}`;
}
