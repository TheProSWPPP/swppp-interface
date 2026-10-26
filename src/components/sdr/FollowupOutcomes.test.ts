import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {FollowupOutcomesView} from './FollowupOutcomes';
it('shows unavailable figures as unavailable, never as zero',()=>{
 const html=renderToStaticMarkup(createElement(FollowupOutcomesView,{data:{since:'2026-10-12T05:00:00Z',weeks:2,salesCheckedAt:null,activitiesCheckedAt:null,orders:'unavailable',
  rows:[{kind:'bid',week:'2026-10-19',created:3,done:null,open:null,statusUnknown:null,emailedAfter:0,replyAfter:1,quoteAfter:null,wonAfter:null}]}}));
 expect(html).toContain('Bid follow-up');expect(html).toContain('<td>3</td><td>unavailable</td><td>0</td><td>1</td><td>unavailable</td><td>unavailable</td><td>unavailable</td>');
 expect(html).toContain('deals checked never');
});
it('says when no tasks were created',()=>{
 expect(renderToStaticMarkup(createElement(FollowupOutcomesView,{data:{since:'x',weeks:8,salesCheckedAt:null,activitiesCheckedAt:null,orders:'unavailable',rows:[]}}))).toContain('No quiet-conversation or bid follow-up tasks created in the last 8 weeks.');
});
