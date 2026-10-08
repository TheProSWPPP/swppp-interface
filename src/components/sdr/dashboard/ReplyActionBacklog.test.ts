import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it,expect} from 'vitest';
import {ReplyActionBacklogView} from './ReplyActionBacklog';
const base={state:'available' as const,coverage:'partial' as const,checkedAt:'2026-10-08T20:00:00Z',total:0,failed:0,requiresReview:0,unverified:0,oldestCreatedAt:null,limit:50,groups:[],items:[]};
const render=(props:Record<string,unknown>)=>renderToStaticMarkup(createElement(ReplyActionBacklogView,{status:'ready',data:base,onRefresh:()=>{},...props}));
it('distinguishes loading, unavailable and empty without false zero claims',()=>{expect(render({status:'loading'})).toContain('role="status"');const error=render({status:'error'});expect(error).toContain('role="alert"');expect(error).not.toContain('No outstanding');expect(render({})).toContain('No outstanding actions');});
it('keeps technical review separate from retry timing and exposes no business actions',()=>{const html=render({data:{...base,total:1,requiresReview:1,failed:1,unverified:1,items:[{id:'local-id',kind:'forward',status:'failed',createdAt:'2020-01-01T00:00:00Z',updatedAt:null,retryAt:'2030-01-01T00:00:00Z',attempts:2,requiresReview:true,reason:'completion_uncertain',projectStatus:'unverified'}]}});expect(html).toContain('Technical review required');expect(html).toContain('Recorded retry time');expect(html).toContain('Project unverified');expect(html).not.toContain('href=');expect(html.match(/<button/g)).toHaveLength(1);});
it('shows current recorded classification separately from the historical action reason',()=>{
 const html=render({data:{...base,total:1,items:[{id:'a',kind:'match_lead',status:'pending',createdAt:'2020-01-01',updatedAt:null,retryAt:null,attempts:0,requiresReview:true,reason:'lead_unlinked',projectStatus:'unverified',currentStoredLink:'ambiguous',recordedReply:{kind:'auto',intent:'nurture',receivedAt:'2020-01-01',recordedAt:'2020-01-02'}}]}});
 expect(html).toContain('Recorded action reason');expect(html).toContain('Stored project link: ambiguous');expect(html).toContain('Stored reply classification: auto');expect(html).toContain('independent verification');expect(html).toContain('First recorded');expect(html).not.toContain('Classification recorded');
});
