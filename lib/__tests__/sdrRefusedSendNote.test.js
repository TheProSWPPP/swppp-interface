import {it,expect,vi} from 'vitest';
import {reportRefusedSend} from '../sdrRefusedSendNote.js';
import {renderOutreachEvent} from '../sdrNoteEvents.js';

const pool=email=>({query:vi.fn(async()=>({rows:email?[{contact_email_snapshot:email}]:[]}))});
it('writes one not-sent note for the refused send, with the recipient',async()=>{
 const publish=vi.fn(async()=>({status:'confirmed'}));
 const result=await reportRefusedSend(pool('buyer@example.test'),{send:{id:'send-1',draft_id:'draft-1',pipedrive_lead_id:'lead-1'}},{publish});
 expect(result).toEqual({status:'confirmed'});
 const {leadId,event}=publish.mock.calls[0][1];
 expect(leadId).toBe('lead-1');expect(event.recipient).toBe('buyer@example.test');
 const rendered=renderOutreachEvent(event);
 expect(rendered.title).toBe('Email not sent');expect(rendered.html).toContain('No email went out to this contact.');
 expect(rendered.eventKey).toBe(renderOutreachEvent({...event,recipient:null}).eventKey);
 expect(rendered.eventKey).not.toBe(renderOutreachEvent({...event,source:{kind:'apollo',eventId:'refused:send-2'}}).eventKey);
});
it('skips a send with no project',async()=>{
 const publish=vi.fn();
 expect(await reportRefusedSend(pool(null),{send:{id:'send-1'}},{publish})).toEqual({status:'skipped'});
 expect(publish).not.toHaveBeenCalled();
});
// The by-hand task follows the note once. A note already on the lead means the refusal was
// already handled, so nothing is raised a second time.
it('asks for the by-hand task once, with the first note',async()=>{
 const send={id:'send-1',draft_id:'draft-1',pipedrive_lead_id:'lead-1'};
 const raiseTask=vi.fn(async()=>'raised');
 expect(await reportRefusedSend(pool('buyer@example.test'),{send},{publish:async()=>({status:'confirmed'}),raiseTask})).toEqual({status:'confirmed',task:'raised'});
 expect(raiseTask).toHaveBeenCalledWith({send});
 raiseTask.mockClear();
 expect(await reportRefusedSend(pool('buyer@example.test'),{send},{publish:async()=>({status:'already_recorded'}),raiseTask})).toEqual({status:'already_recorded'});
 expect(raiseTask).not.toHaveBeenCalled();
});
it('keeps the note when the task cannot be raised',async()=>{
 const send={id:'send-1',draft_id:'draft-1',pipedrive_lead_id:'lead-1'};
 expect(await reportRefusedSend(pool('buyer@example.test'),{send},{publish:async()=>({status:'confirmed'}),raiseTask:async()=>{throw new Error('apollo 429');}})).toEqual({status:'confirmed',task:'failed'});
});
