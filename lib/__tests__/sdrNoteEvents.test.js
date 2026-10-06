import {it,expect} from 'vitest';
import {renderOutreachEvent} from '../sdrNoteEvents.js';
const base={recipient:'buyer@example.test',eventAt:'2026-10-07T10:00:00Z',source:{kind:'apollo',eventId:'event-one'},nextAction:'Review with the owner'};
it('does not label an enrollment as a completed message',()=>{
 const event=renderOutreachEvent({...base,type:'queued',result:{status:'enrolled',receipt:{id:'enrollment'}}});
 expect(event.title).toBe('Outreach queued');expect(event.html).not.toMatch(/email sent|message sent/i);
});
it('requires a completed-message receipt before showing sent',()=>{
 expect(renderOutreachEvent({...base,type:'sent',result:{status:'enrolled'}}).title).toBe('Send confirmation needed');
 expect(renderOutreachEvent({...base,type:'sent',result:{status:'completed',receipt:{messageId:'message-one'}}}).title).toBe('Email sent');
});
it('does not report unresolved or unverified-generation stop as confirmed',()=>{
 expect(renderOutreachEvent({...base,type:'stop_confirmed',result:{status:'unresolved'}}).title).toBe('Provider stop needs attention');
 expect(renderOutreachEvent({...base,type:'stop_confirmed',result:{status:'confirmed',receipt:{id:'receipt'}}}).title).toBe('Provider stop needs attention');
 expect(renderOutreachEvent({...base,type:'stop_confirmed',result:{status:'confirmed',generationMatched:true,receipt:{id:'receipt'}}}).title).toBe('Provider stop confirmed');
});
it('deduplicates by source event identity, keeping identical distinct replies separate',()=>{
 const one=renderOutreachEvent({...base,type:'reply',result:{summary:'Thanks'}});
 const replay=renderOutreachEvent({...base,type:'reply',result:{summary:'Thanks'}});
 const two=renderOutreachEvent({...base,type:'reply',source:{kind:'apollo',eventId:'event-two'},result:{summary:'Thanks'}});
 expect(one.eventKey).toBe(replay.eventKey);expect(two.eventKey).not.toBe(one.eventKey);
 expect(renderOutreachEvent({...base,source:'unknown',type:'reply'}).eventKey).toBeNull();
});
it('escapes source text and omits a copied signature only from the summary',()=>{
 const source={kind:'mail',messageId:'message',raw:'Original source remains'};
 const result={summary:'<script>alert(1)</script>\nPlease call.\n-- \nFull signature'};
 const rendered=renderOutreachEvent({...base,source,type:'reply',result});
 expect(rendered.html).toContain('&lt;script&gt;');expect(rendered.html).not.toContain('<script>');expect(rendered.html).not.toContain('Full signature');expect(result.summary).toContain('Full signature');expect(source.raw).toBe('Original source remains');
});
it('never infers interest from an open',()=>{
 const event=renderOutreachEvent({...base,type:'opened',result:{count:12}});
 expect(event.title).toBe('Email opened');expect(event.html).not.toMatch(/interest|hot lead|engaged buyer/i);
});
it('does not turn a requested queue action or missing reply source into a receipt',()=>{
 expect(renderOutreachEvent({...base,type:'queued',result:{status:'requested'}}).title).toBe('Enrollment confirmation needed');
 expect(renderOutreachEvent({...base,type:'reply',source:null}).title).toBe('Reply confirmation needed');
});
