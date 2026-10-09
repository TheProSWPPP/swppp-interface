import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import type {HandoffState} from './followupHandoffState';
import {HandoffView as View} from './FollowupHandoff';
const state:HandoffState={phase:'preview',attempted:false,error:'',receipt:null,preview:{noteHtml:'Prepared note<br>Proposed subject:<br>&lt;script&gt;bad()&lt;/script&gt;<br>Proposed message:<br>First<br>&lt;img src=x onerror=bad()&gt;<br>Last<br>Tasks: unchanged',previewToken:'p',revision:2,leadId:'lead',content:{subject:'<script>bad()</script>',body:'First\n<img src=x onerror=bad()>\nLast'},owner:{id:'7',name:'Alex'},contact:{id:'8',name:'Sam',email:'sam@example.test'},checkedAt:'2026-10-10T12:00:00Z',replyCoverage:'unverified',requiresLatestConversationReview:true,publication:null}};
const render=(value:HandoffState,reviewed=false)=>{expect(View).toBeTypeOf('function');return renderToStaticMarkup(createElement(View,{state:value,currentRevision:2,onNewPreview:()=>{},reviewed,onReviewed:()=>{},onPublish:()=>{},onCheck:()=>{},onRetry:()=>{}}));};
it('renders the complete note as text and requires review before confirmation',()=>{
 const html=render(state);expect(html).not.toContain('<script>');expect(html).not.toContain('<img');expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');expect(html).toContain('Last');expect(html).toMatch(/disabled=""[^>]*>Add draft to Pipedrive/);expect(html).toContain('Visible to people with access to this lead');
 expect(render(state,true)).not.toMatch(/disabled=""[^>]*>Add draft to Pipedrive/);
});
it('offers only status recovery for uncertainty and requires readback to claim success',()=>{
 const receipt={id:'1',status:'confirmed' as const,noteId:'2',readbackVerified:false,projectUrl:'https://proswpppllc.pipedrive.com/leads/inbox/lead',checkedAt:'2026-10-10T12:00:00Z',revision:2};
 const html=render({...state,phase:'receipt',attempted:true,receipt});expect(html).toContain('Check status');expect(html).not.toContain('Add draft to Pipedrive');expect(html).not.toContain('Note added to Pipedrive');
 expect(render({...state,phase:'receipt',attempted:true,receipt:{...receipt,readbackVerified:true}})).toContain('Note added to Pipedrive');
});

it('decodes one layer of server escaping without interpreting message markup',async()=>{
 const {notePreviewText}=await import('./followupHandoffState');expect(notePreviewText('A &amp; B<br>&amp;lt;literal&amp;gt;<br>&quot;quote&quot; &#39;single&#39;')).toBe("A & B\n&lt;literal&gt;\n\"quote\" 'single'");
});

it('shows definite no-publication receipts without an uncertainty action',()=>{
 const receipt={id:'1',status:'not_attempted' as const,reason:'preview_expired',noteId:null,readbackVerified:false,projectUrl:'https://proswpppllc.pipedrive.com/leads/inbox/lead',checkedAt:'2026-10-10T12:00:00Z',revision:2};
 const html=render({...state,phase:'receipt',attempted:true,receipt});expect(html).toContain('Note was not added');expect(html).not.toContain('Check status');expect(html).not.toContain('Publication unconfirmed');
});

it('identifies an older receipt without implying the current saved revision was shared',()=>{
 const receipt={id:'1',status:'confirmed' as const,noteId:'2',readbackVerified:true,projectUrl:'https://proswpppllc.pipedrive.com/leads/inbox/lead',checkedAt:'2026-10-10T12:00:00Z',revision:1};
 const html=render({...state,phase:'receipt',attempted:true,receipt});expect(html).toContain('Earlier revision published');expect(html).toContain('Current revision 2 remains private');expect(html).toContain('Preview current revision');expect(html).not.toContain('Note added to Pipedrive');
});
