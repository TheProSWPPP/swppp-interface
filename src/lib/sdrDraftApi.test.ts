import {it,expect,vi,afterEach} from 'vitest';
import {sdrApi} from './sdrApi';
const viewed={revision:'5',contextHash:'viewed-context'};
afterEach(()=>vi.unstubAllGlobals());
it.each(['approve','edit','reject','refresh'])('sends the viewed revision for %s even when another tab changes the draft',async action=>{
 vi.stubGlobal('localStorage',{getItem:()=>null});
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({draft:{revision:'6',contextHash:'new-context'}}),{status:200}));vi.stubGlobal('fetch',fetch);
 if(action==='approve')await sdrApi.approveAndSendDraft('draft',viewed);
 if(action==='edit')await sdrApi.patchDraft('draft',{body:'My edit'},viewed);
 if(action==='reject')await sdrApi.rejectDraft('draft','reason',viewed);
 if(action==='refresh')await sdrApi.refreshDraft('draft',viewed);
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({expectedRevision:'5',expectedContextHash:'viewed-context'});
});
