import {it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OrderCandidatesView as Orders} from './OrderCandidates';
import {DeliveryEvidenceView as Delivery} from './dashboard/DeliveryEvidence';
import type {OrderCandidatesData,DeliveryEvidenceData} from '../../lib/sdrPreparationEvidenceApi';
const ordersBase:OrderCandidatesData={leadId:'A',checkedAt:'2020-01-02T00:00:00Z',total:0,offset:0,limit:20,query:'',items:[],coverage:{partial:true,source:'dedicated_app_inventory',linkStatus:'unverified',matching:'exact_title_email_company',orderStatus:'unknown',wordpressCompleteness:'unknown',currentTrello:'unavailable'}};
const deliveryBase:DeliveryEvidenceData={checkedAt:'2020-01-02T00:00:00Z',total:0,limit:50,items:[],safetyChecks:{total:0,limit:50,items:[]},coverage:{partial:true,visibleMailboxes:1,receiptMatching:'unique_direct_message_id',historicalRefusals:'unavailable',providerHistory:'collected_records_only'}};
it('renders order candidates as unverified inventory, safe references and unknown completeness',()=>{expect(Orders).toBeTypeOf('function');const html=renderToStaticMarkup(createElement(Orders,{data:{...ordersBase,total:1,offset:0,limit:20,query:'',items:[{projectId:'p',projectName:'Example',companyName:'Builder',contactName:'Buyer',contactEmail:'b@example.test',intakeDate:'10/08/26',documentStatus:'Complete',safeTrelloReference:'https://trello.com/c/AbCd1234',matchReasons:['project_title'],testStatus:'unknown'}]}}));expect(html).toContain('Candidate');expect(html).toContain('unverified');expect(html).toContain('10/08/26');expect(html).toContain('WordPress');expect(html).not.toContain('Confirm order');expect(html).not.toContain('Link order');});
it('never treats missing receipt as unsent or enrollment time as sendtime',()=>{expect(Delivery).toBeTypeOf('function');const html=renderToStaticMarkup(createElement(Delivery,{data:{...deliveryBase,total:1,limit:50,items:[{sendId:'s',leadId:'A',projectTitle:'Example',mailbox:'rep@example.test',historicalRecipient:'buyer@example.test',localEnrollmentAt:'2020-01-01',storedStatus:'enrolled',receipt:null,operations:[],operationTotal:0}],safetyChecks:{total:0,limit:50,items:[]},coverage:deliveryBase.coverage}}));expect(html).toContain('No exact message receipt recorded');expect(html).toContain('Local enrollment');expect(html).not.toContain('not sent');expect(html).toContain('partial');});
it('links each expanded delivery and safety record to its encoded fixed-host CRM parent',()=>{
 const html=renderToStaticMarkup(createElement(Delivery,{data:{...deliveryBase,total:1,limit:50,items:[{sendId:'s',leadId:'lead/one?next=https://evil.example',projectTitle:'Example',mailbox:'rep@example.test',historicalRecipient:'buyer@example.test',localEnrollmentAt:'2020-01-01',storedStatus:'enrolled',receipt:null,operations:[],operationTotal:0}],safetyChecks:{total:1,limit:50,items:[{decisionId:'decision',leadId:'lead#two',projectTitle:'Second project',draftId:'d',draftRevision:'1',mailbox:'rep@example.test',firstRecordedAt:'2020-01-02',outcome:'hold',reasons:['outreach_held']}]},coverage:deliveryBase.coverage}}));
 expect(html).toContain('href="https://proswpppllc.pipedrive.com/leads/inbox/lead%2Fone%3Fnext%3Dhttps%3A%2F%2Fevil.example"');
 expect(html).toContain('href="https://proswpppllc.pipedrive.com/leads/inbox/lead%23two"');
 expect(html.match(/Open project in Pipedrive/g)).toHaveLength(2);
 expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
 expect(html).not.toContain('href="https://evil.example');
});
