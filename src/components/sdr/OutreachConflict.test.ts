import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it,expect} from 'vitest';
import {OutreachConflictPanel} from './OutreachConflict';
const data={controls:[{id:'hold',version:3,scope_kind:'lead',scope_id:'lead',reason:'Wrong contact',owner_id:'rep',provider_stop_status:'unresolved',context_hash:'current',canResolveOnProject:true}],applicationActionsBlocked:true,providerStopStatus:'unresolved',context:{contextHash:'current',personId:'person',recipientEmail:'buyer@example.test',organizationId:'org',complete:false}};
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
it('requires explicit current-context acknowledgement before resolving a changed hold',()=>{
 const html=renderToStaticMarkup(createElement(OutreachConflictPanel,{...props,evidence:'New context reviewed',data:{...data,context:{...data.context,contextHash:'new-context'}}}));
 expect(html).toContain('I reviewed the current contact and context');expect(html).toMatch(/disabled=""[^>]*>Release this hold/);
});
it('keeps protected CRM proposals visible separately from selected data',()=>{
 const html=renderToStaticMarkup(createElement(OutreachConflictPanel,{...props,data:{...data,proposals:[{id:'proposal',entity:'lead',entity_id:'lead',proposed_fields:{organization_id:'proposed-org'},reason:'Review contractor'}]}}));
 expect(html).toContain('Proposed CRM changes');expect(html).toContain('proposed-org');expect(html).toContain('Selected company');
});

it.each([false,true])('shows a recipient restriction read-only for owner and admin (admin=%s)',isAdmin=>{
 const recipient={...data.controls[0],id:'recipient-hold',scope_kind:'recipient',scope_id:'buyer@example.test',reason:'Recipient requested no further contact',canResolveOnProject:false};
 const html=renderToStaticMarkup(createElement(OutreachConflictPanel,{...props,isAdmin,evidence:'Reviewed',data:{...data,controls:[recipient]}}));
 expect(html).toContain('Recipient requested no further contact');expect(html).toContain('recipient');expect(html).toContain('buyer@example.test');
 expect(html).toContain('Read-only here');expect(html).not.toContain('Release this hold');expect(html).not.toContain('Keep verified contact');expect(html).not.toContain('Review replacement');expect(html).not.toContain('Decision evidence');
});
it('retains project decisions alongside a broader restriction without granting broader release',()=>{
 const recipient={...data.controls[0],id:'recipient-hold',scope_kind:'recipient',scope_id:'buyer@example.test',reason:'Recipient requested no further contact',canResolveOnProject:false};
 const html=renderToStaticMarkup(createElement(OutreachConflictPanel,{...props,isAdmin:true,evidence:'Reviewed',data:{...data,controls:[data.controls[0],recipient]}}));
 expect(html.match(/>Release this hold</g)).toHaveLength(1);expect(html).toContain('Decision evidence');expect(html).toContain('Wrong contact');expect(html).toContain('Recipient requested no further contact');
});
