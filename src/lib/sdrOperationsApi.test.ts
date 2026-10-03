import {beforeEach,expect,it,vi} from 'vitest';
import {getRecentReplies,getRecentReplyPage,type ReplyContext} from './sdrOperationsApi';
import {sdrFetch} from './sdrApi';
vi.mock('./sdrApi',()=>({sdrFetch:vi.fn()}));
const context:ReplyContext={asOf:'2026-10-03T10:00:00.123456Z',from:'2026-09-26T10:00:00.123456Z',to:'2026-10-03T10:00:00.123456Z',mailbox:'rep-a@example.test',visibilitySnapshot:'9007199254740993:9007199254741000:9007199254740995'};
beforeEach(()=>{
 vi.clearAllMocks();vi.mocked(sdrFetch).mockResolvedValue({state:'available',context,total:0,items:[],nextCursor:null,coverage:{state:'partial',lastCollectedAt:null,note:'Partial'}});
});
it('pins the first browser load, retries and continuation to the exact returned visibility and clock',async()=>{
 const summary=await getRecentReplies({limit:3});
 for(const cursor of [undefined,undefined,'opaque-v2-cursor']) {
  await getRecentReplyPage(summary.context,cursor);
  const url=new URL(vi.mocked(sdrFetch).mock.lastCall![0],'https://local.test');
  expect(url.searchParams.get('visibilitySnapshot')).toBe(context.visibilitySnapshot);
  expect(url.searchParams.get('asOf')).toBe(context.asOf);
  expect(url.searchParams.get('mailbox')).toBe(context.mailbox);
  expect(url.searchParams.get('cursor')).toBe(cursor??null);
  expect(url.searchParams.get('limit')).toBe('20');
 }
});
it('omits a null snapshot on fresh capture requests',async()=>{
 await getRecentReplies({visibilitySnapshot:null,limit:3});
 const url=new URL(vi.mocked(sdrFetch).mock.lastCall![0],'https://local.test');
 expect(url.searchParams.has('visibilitySnapshot')).toBe(false);expect(url.searchParams.has('asOf')).toBe(false);expect(url.searchParams.get('limit')).toBe('3');
});
it('rejects an older response lacking visibility context instead of silently recapturing membership',async()=>{
 vi.mocked(sdrFetch).mockResolvedValue({state:'available',context:{asOf:context.asOf,from:context.from,to:context.to,mailbox:null},total:0,items:[],nextCursor:null,coverage:{state:'unknown',lastCollectedAt:null,note:'Unknown'}});
 await expect(getRecentReplies()).rejects.toThrow('unavailable');
});
