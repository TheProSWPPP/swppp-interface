import {expect,it} from 'vitest';
import {leadInboxHref,parentCrmUrl} from './followupNavigation';

it('accepts only parent records on the configured HTTPS CRM tenant',()=>{
 for(const path of ['/leads/inbox/123','/deal/123','/person/123','/organization/123']){
  const url=`https://proswpppllc.pipedrive.com${path}`;
  expect(parentCrmUrl(url)).toBe(url);
 }
 for(const value of [null,'javascript:alert(1)','http://proswpppllc.pipedrive.com/deal/1','https://other.pipedrive.com/leads/inbox/123','https://user@proswpppllc.pipedrive.com/deal/1','https://proswpppllc.pipedrive.com/deal/1/activities/2'])expect(parentCrmUrl(value)).toBeNull();
});

it('encodes an observed lead ID in a same-origin inbox hash',()=>{
 expect(leadInboxHref('lead A/B')).toBe('#/sdr?inboxLead=lead%20A%2FB');
});
