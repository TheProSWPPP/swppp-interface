// A failed app send from weeks ago next to "Contact emailed · today" reads as a contradiction.
// When the contact has been emailed since the failure, the failure is history, not the current state.
export function failureSupersededByLaterEmail(lead:{send_status:string|null;send_sent_at:string|null;outreach_sent_at?:string|null;last_outgoing_mail_time?:string|null}) {
  if(lead.send_status!=='failed')return false;
  const failedAt=Date.parse(lead.send_sent_at||'');
  if(!Number.isFinite(failedAt))return false;
  return [lead.outreach_sent_at,lead.last_outgoing_mail_time].some(value=>{const at=Date.parse(value||'');return Number.isFinite(at)&&at>failedAt;});
}
