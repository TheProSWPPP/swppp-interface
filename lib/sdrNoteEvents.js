import {createHash} from 'node:crypto';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const summarize=value=>String(value??'').split(/\n(?:--\s*\n|(?:Best regards|Kind regards|Regards|Sincerely),?\s*\n|Sent from my )/i)[0].trim().slice(0,1500);

/** Receipt semantics only. No provider mutations or inferred business intent.
 * eventKey supports a unique source-event ledger; it must never dedupe on text.
 */
export function renderOutreachEvent({type,recipient,eventAt,source,result={},nextAction}={}) {
 const sourceObject=source&&typeof source==='object'?source:{};
 const sourceId=sourceObject.eventId||sourceObject.messageId||sourceObject.actionId||null;
 const sourceKind=sourceObject.kind||sourceObject.provider||null;
 const eventKey=sourceId&&sourceKind?createHash('sha256').update(JSON.stringify([String(sourceKind),String(sourceId),String(type)])).digest('hex'):null;
 let title;
 switch(type) {
  case 'queued':title=['enrolled','queued','confirmed'].includes(result.status)&&result.receipt?'Outreach queued':'Enrollment confirmation needed';break;
  case 'sent':title=result.status==='completed'&&result.receipt?.messageId?'Email sent':'Send confirmation needed';break;
  case 'reply':title=sourceId?'Reply received':'Reply confirmation needed';break;
  case 'stop_requested':title='Provider stop requested';break;
  case 'stop_confirmed':title=result.status==='confirmed'&&result.generationMatched===true&&result.receipt?'Provider stop confirmed':'Provider stop needs attention';break;
  case 'opened':title='Email opened';break;
  case 'clicked':title='Email link clicked';break;
  default:title='Outreach review needed';
 }
 const summary=summarize(result.summary);
 const when=eventAt&&Number.isFinite(new Date(eventAt).getTime())?new Date(eventAt).toISOString():null;
 const parts=[`<b>${escape(title)}</b>`];
 if(recipient)parts.push(`Recipient: ${escape(recipient)}`);
 if(when)parts.push(`Event time: ${escape(when)}`);
 if(sourceKind)parts.push(`Source: ${escape(sourceKind)}`);
 if(summary)parts.push(escape(summary).replace(/\n/g,'<br>'));
 if(title==='Outreach queued')parts.push('Enrollment accepted; message completion is not yet confirmed.');
 if(type==='stop_requested'||title==='Provider stop needs attention')parts.push('Application hold and provider cancellation are separate. Scheduled provider mail may still run.');
 if(nextAction)parts.push(`Next action: ${escape(nextAction)}`);
 return {title,html:parts.join('<br>'),eventKey,evidence:{type,sourceKind,sourceId,eventAt:when,status:result.status??null,receipt:result.receipt??null,generationMatched:result.generationMatched===true}};
}
