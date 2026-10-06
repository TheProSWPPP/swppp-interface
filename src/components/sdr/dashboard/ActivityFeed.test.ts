import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it,expect} from 'vitest';
import {ActivityRows} from './ActivityFeed';
import type {ActivityEvent} from '../../../lib/sdrActivityApi';
const event:ActivityEvent={id:'message',kind:'reply',occurredAt:'2026-10-06T15:22:00Z',mailbox:'rep@example.test',contact:'<script>buyer</script>',projectId:null,projectTitle:null,threadId:null};
it('escapes untrusted contact text, retains event time and avoids inventing a project link',()=>{
 const html=renderToStaticMarkup(createElement(ActivityRows,{items:[event]}));
 expect(html).toContain('&lt;script&gt;buyer&lt;/script&gt;');expect(html).not.toContain('<script>');
 expect(html).toContain('Oct 6, 10:22 AM');expect(html).toContain('dateTime="2026-10-06T15:22:00Z"');
 expect(html).not.toContain('href=');expect(html).not.toContain('is-new');
});
it('marks only newly observed rows for animation and links an available project',()=>{
 const html=renderToStaticMarkup(createElement(ActivityRows,{items:[{...event,contact:'buyer@example.test',projectId:'verified-project'}],newIds:['message']}));
 expect(html).toContain('is-new');expect(html).toContain('https://proswpppllc.pipedrive.com/leads/inbox/verified-project');expect(html).toContain('noopener noreferrer');
});
