import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import CrmFollowUps from './CrmFollowUps';
import CrmLeadHistory from './CrmLeadHistory';
import {crmPlainText,crmReadableEvidence,crmFollowupUnavailableMessage} from './crmViewState';
import type {CrmObservations} from '../../lib/sdrCrmApi';
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
