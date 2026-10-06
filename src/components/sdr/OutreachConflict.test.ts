import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it,expect} from 'vitest';
import {OutreachConflictPanel} from './OutreachConflict';
const data={controls:[{id:'hold',version:3,scope_kind:'lead',scope_id:'lead',reason:'Wrong contact',owner_id:'rep',provider_stop_status:'unresolved',context_hash:'current'}],applicationActionsBlocked:true,providerStopStatus:'unresolved',context:{contextHash:'current',personId:'person',recipientEmail:'buyer@example.test',organizationId:'org',complete:false}};
const props={data,userId:'rep',isAdmin:false,evidence:'',onEvidence:()=>{},onDecision:()=>{},busy:false};
it('distinguishes an application hold from unconfirmed provider mail',()=>{
 const html=renderToStaticMarkup(createElement(OutreachConflictPanel,props));
 expect(html).toContain('Application actions held');expect(html).toContain('Provider stop unresolved');expect(html).not.toContain('follow-ups stopped');expect(html).toContain('buyer@example.test');
});
it('limits resolution controls to the owner/admin and shows independent scope',()=>{
 const html=renderToStaticMarkup(createElement(OutreachConflictPanel,{...props,userId:'other'}));
 expect(html).not.toContain('Release this hold');expect(html).toContain('Owner: rep');expect(html).toContain('lead');
});
it('does not turn an unknown provider state or missing source into permission',()=>{
 const html=renderToStaticMarkup(createElement(OutreachConflictPanel,{...props,data:{...data,controls:[],applicationActionsBlocked:false,providerStopStatus:'unverified'}}));
 expect(html).toContain('Provider status unverified');expect(html).toContain('Source context needs review');expect(html).not.toContain('Safe to send');
});
it('escapes source evidence and keeps keeping a contact distinct from sending',()=>{
 const html=renderToStaticMarkup(createElement(OutreachConflictPanel,{...props,data:{...data,controls:[{...data.controls[0],reason:'<script>alert(1)</script>'}]}}));
 expect(html).not.toContain('<script>');expect(html).toContain('does not approve copy, send, or restart');
});
