import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect,it } from 'vitest';
import SdrWorkspace from './SdrWorkspace';
import OutreachHealth from './OutreachHealth';
const user={id:'u',username:'admin',display_name:'Admin User',email:'rep-a@example.test',role:'admin' as const};
const base={user,lane:'cold' as const,active:'dashboard',onLaneChange:()=>{},onNavigate:()=>{},onSignOut:()=>{},children:'Workspace content'};
it('preserves every cold workspace destination and makes the active route accessible',()=>{
 const html=renderToStaticMarkup(createElement(SdrWorkspace,base));
 for(const label of ['Dashboard','Leads','Queue','Priority','Inbox','Mailboxes','Templates','Permits','Team','Switch user','Open navigation']) expect(html).toContain(label);
 expect(html).toContain('aria-current="page"');
});
it('retains the admin gate in navigation and all nurture destinations',()=>{
 const rep=renderToStaticMarkup(createElement(SdrWorkspace,{...base,user:{...user,role:'sdr'}}));
 expect(rep).not.toContain('>Team<');
 const nurture=renderToStaticMarkup(createElement(SdrWorkspace,{...base,lane:'nurture',active:'campaigns'}));
 for(const label of ['Campaigns','Lists','Contacts','Automations']) expect(nurture).toContain(label);
});
it('does not present unknown runtime health as healthy before the request completes',()=>{
 const html=renderToStaticMarkup(createElement(OutreachHealth));
 expect(html).toContain('Checking the latest runs');
 expect(html).not.toContain('Up to date');
});
