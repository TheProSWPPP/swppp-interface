import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import CrmFollowUps,{FollowupProjectCard} from './CrmFollowUps';
import {ReviewProjectCard} from './FollowupReview';
import CrmLeadHistory from './CrmLeadHistory';
import {crmPlainText,crmReadableEvidence,crmFollowupUnavailableMessage} from './crmViewState';
import type {CrmObservations} from '../../lib/sdrCrmApi';
import type {CrmFollowUp,FollowupReviewProject} from '../../lib/sdrCrmApi';
it('shows loading and explains observation coverage without claiming an outreach gate',()=>{
 expect(renderToStaticMarkup(createElement(CrmFollowUps,{onOpenLead:()=>{}}))).toContain('Loading follow-ups');
 const html=renderToStaticMarkup(createElement(CrmLeadHistory,{leadId:'lead-1'}));
 expect(html).toContain('Loading CRM source history');
 expect(html).not.toMatch(/outreach blocked|acknowledge|hold outreach/i);
});
it('hides cached content when observations are unavailable or permission is denied',()=>{
 const history={items:[{entity:'note',data:{content:'private'}}],revisions:[{data:{content:'private'}}]} as unknown as CrmObservations;
 expect(crmReadableEvidence(history).notes).toEqual([{content:'private'}]);
 expect(crmReadableEvidence({...history,unavailable:'permission_denied'})).toEqual({notes:[],activities:[],revisions:[]});
 expect(crmReadableEvidence({...history,unavailable:'incomplete'}).notes).toEqual([]);
});
it('renders notes as plain text and distinguishes unavailable data from empty history',()=>{
 expect(crmPlainText('<p>Call&nbsp;Derek &amp; team</p>')).toBe('Call Derek & team');
 expect(crmFollowupUnavailableMessage('permission_denied')).toContain('Pipedrive access is restricted');
 expect(crmFollowupUnavailableMessage(null)).toBeNull();
});
import * as viewState from './crmViewState';
it('groups repeated note text for display while retaining every original identity',()=>{
 const notes=[{id:1,content:'Classification unchanged',add_time:'first'},{id:2,content:'Classification unchanged',add_time:'second'},{id:3,content:'Call only'}];
 const groups=viewState.groupCrmNotes(notes);
 expect(groups).toHaveLength(2);expect(groups[0].originals.map(note=>note.id)).toEqual([1,2]);expect(groups[1].originals[0].content).toBe('Call only');
});
it('renders a task with parent source and same-origin candidate conversation while preserving identity',()=>{
 const task={id:'task-1',leadId:'lead-1',leadTitle:'Project',subject:'Call buyer',type:'call',note:'Talked',ownerId:'staff-1',ownerName:'Staff One',dueDate:'2026-10-08',dueTime:null,done:false,sourceUpdatedAt:null,observedAt:'2026-10-08T12:00:00Z',sourceUrl:'https://proswpppllc.pipedrive.com/leads/inbox/123'} as CrmFollowUp;
 const html=renderToStaticMarkup(createElement(FollowupProjectCard,{leadId:'lead-1',project:task,tasks:[task],today:'2026-10-08',ownerName:(_id:string|null|undefined,name:string|null|undefined)=>name||'Unassigned',onOpenLead:()=>{}}));
 expect(html).toContain('task-1');expect(html).toContain('2026-10-08');expect(html).toContain('Staff One');
 expect(html).toMatch(/href="#\/sdr\?inboxLead=lead-1"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
 expect(html).toContain('Find a conversation for this project');expect(html).toContain('Open parent CRM record');
 expect(html).not.toMatch(/task email|note permalink/i);
});
it('keeps every review evidence identity and its own valid parent source in order',()=>{
 const evidence=Array.from({length:5},(_,index)=>({id:`note-${index+1}`,entity:'note',text:'Same text',subject:null,sourceUpdatedAt:'2026-10-08T12:00:00Z',observedAt:'2026-10-08T12:00:00Z',sourceUrl:index===4?'https://other.pipedrive.com/deal/1':`https://proswpppllc.pipedrive.com/deal/${index+1}`}));
 const project={leadId:'lead-2',title:'Review project',ownerId:null,ownerName:null,sourceUrl:'https://proswpppllc.pipedrive.com/leads/inbox/2',latestAt:'2026-10-08',evidence} as FollowupReviewProject;
 const html=renderToStaticMarkup(createElement(ReviewProjectCard,{project,onOpenLead:()=>{}}));
 for(let index=1;index<=5;index++)expect(html).toContain(`note-${index}`);
 expect((html.match(/Open parent CRM record for note/g)||[])).toHaveLength(4);
 expect(html.indexOf('note-1')).toBeLessThan(html.indexOf('note-2'));
 expect(html).toContain('Open project in Pipedrive');expect(html).toContain('Find a conversation for this project');
 expect(html).not.toContain('other.pipedrive.com');
});
it('renders bounded recent CRM record evidence without inferring manual calls or email',()=>{
 const task={id:'task-2',leadId:'lead-2',leadTitle:'Project',subject:'Call buyer',type:'call',note:null,ownerId:'7',dueDate:'2026-10-08',dueTime:null,done:false,sourceUpdatedAt:null,observedAt:null,sourceUrl:null,
  recentRecords:{status:'available',reason:null,note:{id:'note-2',entity:'note',sourceUrl:'https://proswpppllc.pipedrive.com/leads/inbox/lead-2',linkEvidence:[],eventAt:'2026-04-01T09:00:00Z',sourceUpdatedAt:'2026-10-07T10:00:00Z',sourceUpdatedField:'update_time',observedAt:'2026-10-08T11:00:00Z',sourceReadStartedAt:null,originStatus:'unknown',text:'Older CRM note',textTruncated:false,subject:null,subjectTruncated:false},completedCall:{id:'call-2',entity:'activity',sourceUrl:null,linkEvidence:[],eventAt:null,sourceUpdatedAt:'2026-10-07T10:30:00Z',sourceUpdatedField:'update_time',observedAt:'2026-10-08T11:30:00Z',sourceReadStartedAt:null,originStatus:'unknown',text:'',textTruncated:false,subject:'Call',subjectTruncated:false},email:{status:'unavailable',reason:'no_verified_project_mail_source'},coverage:{notes:{status:'partial',checkedAt:'2026-10-08T11:00:00Z',errorCategory:null},activities:{status:'complete',checkedAt:'2026-10-08T11:00:00Z',errorCategory:null},checkedAt:'2026-10-08T12:00:00Z',partial:true},asOf:'2026-10-08T12:00:00Z'}} as CrmFollowUp;
 const html=renderToStaticMarkup(createElement(FollowupProjectCard,{leadId:'lead-2',project:task,tasks:[task],today:'2026-10-08',ownerName:(_id:string|null|undefined,name:string|null|undefined)=>name||'Unknown',onOpenLead:()=>{}}));
 expect(html).toContain('Recent CRM records');
 expect(html).toContain('CRM note');expect(html).toContain('origin unverified');
 expect(html).toContain('CRM call marked complete');expect(html).toContain('Completion time not established');
 expect(html).toContain('2026');expect(html).toContain('Project-linked email context unavailable');
 expect(html).toContain('note-2');expect(html).toContain('call-2');
 expect(html).not.toContain('update_time');
 expect(html).not.toMatch(/manual call|called at|quote sent/i);
});
