import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it,expect} from 'vitest';
import {FollowupProjectCard} from './CrmFollowUps';
import {ReviewProjectCard} from './FollowupReview';
it('offers the same independent context read in open-task and review views while preserving private drafting',()=>{
 const task=renderToStaticMarkup(createElement(FollowupProjectCard,{leadId:'A',project:{id:'task',leadId:'A',subject:'Call',note:null,ownerId:null,dueDate:null,dueTime:null,done:false,sourceUpdatedAt:null,observedAt:null,sourceUrl:null},tasks:[],today:'2026-10-09',ownerName:()=>'',onOpenLead:()=>{}}));
 const review=renderToStaticMarkup(createElement(ReviewProjectCard,{project:{leadId:'A',title:'A',ownerId:null,ownerName:null,sourceUrl:null,latestAt:'2026-10-08',evidence:[]},onOpenLead:()=>{}}));
 for(const html of [task,review]){expect(html).toContain('Load project context');expect(html).toContain('Write private draft');expect(html).not.toContain('Loading project context');}
});
