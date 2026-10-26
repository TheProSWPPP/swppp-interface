import {expect,it} from 'vitest';
import {autoSendQueueNote} from './queueNotes';
it('explains why drafts wait while auto-send is on, in one sentence',()=>{
  const note=autoSendQueueNote({auto_outreach_enabled:true,auto_outreach_mode:'send'},235);
  expect(note).toBe('Auto-send is on, so new drafts go out on their own; these 235 drafts were not sent automatically (for example a check held the contact, Apollo did not accept it, or it was made before auto-send was on) and wait for someone to send or skip them.');
  expect(note?.split('. ').length).toBe(1);
  expect(autoSendQueueNote({auto_outreach_enabled:true,auto_outreach_mode:'send'},1)).toContain('this draft was not sent automatically');
  expect(autoSendQueueNote({auto_outreach_enabled:true,auto_outreach_mode:'queue'},4)).toMatch(/Draft to Queue/);
  expect(autoSendQueueNote({auto_outreach_enabled:false,auto_outreach_mode:'send'},4)).toBeNull();
  expect(autoSendQueueNote({auto_outreach_enabled:true,auto_outreach_mode:'send'},0)).toBeNull();
  expect(autoSendQueueNote(null,3)).toBeNull();
});
