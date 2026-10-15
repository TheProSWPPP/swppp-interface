import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {ReplyDetail} from './RecentRepliesInbox';
import {OutreachTodaySnapshot} from './OutreachToday';
import {snapshotLabel} from './metricDisplay';
import {getRecentReplies,type RecentReply} from '../../../lib/sdrOperationsApi';
import {sdrFetch} from '../../../lib/sdrApi';
vi.mock('../../../lib/sdrApi',()=>({sdrFetch:vi.fn()}));
const reply:RecentReply={id:'r1',receivedAt:'2026-10-03T10:00:00Z',mailbox:'rep-a@example.test',source:'gmail',sourceMessageId:'message',threadId:'thread',prospectEmail:'prospect@example.test',project:{status:'ambiguous',id:null,title:null,basis:null},owner:{status:'unassigned',pipedriveUserId:null,label:null},response:{status:'unknown',at:null,source:null,coverage:'partial'},intent:'interested',actions:[{kind:'forward',status:'success',requiresReview:false,receiptAt:'2026-10-03T11:00:00Z'}]};
it('keeps successful receipts separate from response status, with closed evidence and no invented project',()=>{
 const html=renderToStaticMarkup(createElement(ReplyDetail,{reply,onOpenThread:()=>{},onOpenProject:()=>{},onBackToList:()=>{}}));
 expect(html).toContain('No staff reply logged');expect(html).toContain('Owner unassigned');expect(html).not.toContain('Deadline');expect(html).toContain('Open conversation');expect(html).not.toContain('Open project');expect(html).toContain('<details');expect(html).not.toMatch(/<details[^>]*open/);expect(html).toContain('success');
});
it('shows who replied, when, project and a short status without caveat text',()=>{
 const html=renderToStaticMarkup(createElement(OutreachTodaySnapshot,{data:{state:'available',context:{asOf:'2026-10-03T12:00:00Z',from:'2026-09-26T12:00:00Z',to:'2026-10-03T12:00:00Z',mailbox:null,visibilitySnapshot:null},total:1,items:[reply],nextCursor:null,coverage:{state:'partial',lastCollectedAt:null,note:'Partial'}},onOpenReplies:()=>{}}));
 expect(html).toContain('prospect@example.test');expect(html).toContain('Project link ambiguous');expect(html).toContain('1 reply');expect(html).toContain('Last 7 days');expect(html).toContain('No staff reply logged');expect(html).toContain('View recent replies');
 expect(html).not.toMatch(/Unanswered|Deadline|Live bid status|Partial inbox coverage|Next: review/);
 const answered=renderToStaticMarkup(createElement(OutreachTodaySnapshot,{data:{state:'available',context:{asOf:'2026-10-03T12:00:00Z',from:'2026-09-26T12:00:00Z',to:'2026-10-03T12:00:00Z',mailbox:null,visibilitySnapshot:null},total:1,items:[{...reply,response:{status:'recorded',at:'2026-10-03T11:00:00Z',source:'Connected inbox observation',coverage:'partial'}}],nextCursor:null,coverage:{state:'partial',lastCollectedAt:null,note:'Partial'}}}));
 expect(answered).toContain('Staff replied Oct 3, 2026');
});
it('pins retained snapshot identity to its loaded query',()=>{
 expect(snapshotLabel({from:'2026-09-01',to:'2026-10-01',mailbox:'rep-a@example.test',source:'cmd'})).toContain('rep-a@example.test');expect(snapshotLabel({from:'2026-09-01',to:'2026-10-01',mailbox:'rep-a@example.test',source:'cmd'})).toContain('2026-09-30');
});
it('rejects SPA fallback HTML and malformed objects instead of inventing a zero',async()=>{
 vi.mocked(sdrFetch).mockResolvedValue({raw:'<!doctype html>'});await expect(getRecentReplies()).rejects.toThrow('unavailable');
 vi.mocked(sdrFetch).mockResolvedValue({state:'available',items:[]});await expect(getRecentReplies()).rejects.toThrow('unavailable');
});
it('carries microsecond context and cursor without date roundtrip',async()=>{
 vi.mocked(sdrFetch).mockResolvedValue({state:'unavailable',context:{asOf:'2026-10-03T12:00:00.000123Z',from:'2026-09-26T12:00:00.000123Z',to:'2026-10-03T12:00:00.000123Z',mailbox:null,visibilitySnapshot:null},total:null,items:[],nextCursor:null,coverage:{state:'unknown',lastCollectedAt:null,note:'Unknown'}});
 await getRecentReplies({asOf:'2026-10-03T12:00:00.000123Z',cursor:'exact_cursor'});expect(vi.mocked(sdrFetch).mock.lastCall?.[0]).toContain('000123Z');expect(vi.mocked(sdrFetch).mock.lastCall?.[0]).toContain('cursor=exact_cursor');
});

it('offers a nearby keyboard button that calls the return-to-list action',()=>{
 const onBackToList=vi.fn();
 const detail=ReplyDetail({reply,onOpenThread:()=>{},onOpenProject:()=>{},onBackToList});
 const returnButton=detail.props.children[0];
 expect(returnButton.type).toBe('button');expect(returnButton.props.className).toContain('sdr-reply-button');
 returnButton.props.onClick();expect(onBackToList).toHaveBeenCalledOnce();
 const html=renderToStaticMarkup(detail);expect(html).toContain('Back to reply list');
});
