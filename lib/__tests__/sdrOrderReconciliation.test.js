import {it,expect,describe,beforeAll,afterAll} from 'vitest';
import {resolveProjectCard,invoicePaidState,reconcileOrderProjects,readOrderReconciliation,PAID_FIELD_ID} from '../sdrOrderReconciliation.js';
import {reportingTestDb} from './reportingTestDb.js';

const card={id:'123456789012345678901234',shortLink:'AbCdEf12',name:'Same title',idList:'follow-up',customFieldItems:[]};
const project=(id,trelloLink,status='Ready')=>({id,status,data:{id,projectName:'Same title',trelloLink,status}});
const retainedDeals={kind:'retained_deals',observedAt:'2026-10-03T20:00:00Z'};

it('matches a full card ID despite a different provider display URL',()=>{
 expect(resolveProjectCard(project('p1',`https://trello.com/c/${card.id}`),[card]))
  .toEqual({state:'verified',cardId:card.id});
});
it('matches an exact provider shortLink but never a shared title or foreign host',()=>{
 expect(resolveProjectCard(project('p1','https://trello.com/c/AbCdEf12'),[card])).toEqual({state:'verified',cardId:card.id});
 expect(resolveProjectCard(project('p2','https://evil.test/c/AbCdEf12'),[card])).toEqual({state:'unmatched',cardId:null});
 expect(resolveProjectCard(project('p3',''),[card,{...card,id:'abcdefabcdefabcdefabcdef',shortLink:'ZyXwVu12'}])).toEqual({state:'unmatched',cardId:null});
});
it('treats duplicate provider references as ambiguous',()=>{
 expect(resolveProjectCard(project('p1','https://trello.com/c/AbCdEf12'),[card,{...card,id:'abcdefabcdefabcdefabcdef'}]))
  .toEqual({state:'ambiguous',cardId:null});
});
it('missing Paid is unknown; explicit Y/N uses idCustomField',()=>{
 expect(invoicePaidState([],{})).toBe('unknown');
 const item={idCustomField:PAID_FIELD_ID,idValue:'yes-option'};
 expect(invoicePaidState([item],{'yes-option':'Y'})).toBe('paid');
 expect(invoicePaidState([item],{'yes-option':'N'})).toBe('unpaid');
 expect(invoicePaidState([{id:PAID_FIELD_ID,idValue:'yes-option'}],{'yes-option':'Y'})).toBe('unknown');
});
it('marks retained one-list cards as stale partial evidence, never current completion or sale',()=>{
 const result=reconcileOrderProjects([project('p1',`https://trello.com/c/${card.id}`)],{
  cards:[card],cardCoverage:{kind:'retained_one_list',observedAt:'2026-10-03T17:00:53.112Z',listId:'follow-up'},
  paidOptions:{},deals:[{id:'deal-a',title:'Same title',status:'won'}],dealCoverage:retainedDeals,now:'2026-10-03T21:00:00Z'
 });
 expect(result.coverage.cards).toMatchObject({kind:'retained_one_list',complete:false,stale:true});
 expect(result.items[0]).toMatchObject({cardLinkState:'verified',cardId:card.id,trelloListId:'follow-up',jobCompleted:null,invoicePaid:'unknown',crmStatus:null,dealLinkState:'unmatched'});
 expect(result.items[0].observedAt.trello).toBe('2026-10-03T17:00:53.112Z');
});
it('keeps document Ready, completion, payment and CRM win separate with reviewed exact links',()=>{
 const result=reconcileOrderProjects([project('p1',`https://trello.com/c/${card.id}`)],{
  cards:[{...card,idList:'completed',customFieldItems:[{idCustomField:PAID_FIELD_ID,idValue:'no'}]}],
  cardCoverage:{kind:'current_board',complete:true,observedAt:'2026-10-03T20:00:00Z'},completedListId:'completed',paidOptions:{no:'N'},
  deals:[{id:'deal-a',title:'Same title',status:'won',observedAt:'2026-10-03T20:00:00Z'}],
  dealCoverage:{kind:'current_deals',complete:true,observedAt:'2026-10-03T20:00:00Z'},
  dealLinks:[{projectId:'p1',dealId:'deal-a',reviewed:true,evidence:{type:'exact_project_id',value:'p1'}}]
 });
 expect(result.items[0]).toMatchObject({documentStatus:'Ready',jobCompleted:true,invoicePaid:'unpaid',crmStatus:'won',dealLinkState:'verified'});
});
it('leaves repeated moves and unreviewed same-title deals unresolved',()=>{
 const result=reconcileOrderProjects([project('p1',`https://trello.com/c/${card.id}`)],{
  cards:[{...card,idList:'operations',actions:[{idList:'completed'},{idList:'operations'}]}],
  cardCoverage:{kind:'current_board',complete:true,observedAt:'2026-10-03T20:00:00Z'},completedListId:'completed',
  deals:[{id:'deal-a',title:'Same title',status:'won'},{id:'deal-b',title:'Same title',status:'open'}],
  dealCoverage:retainedDeals,
  dealLinks:[{projectId:'p1',dealId:'deal-a',reviewed:false,evidence:'title match'}]
 });
 expect(result.items[0]).toMatchObject({jobCompleted:false,crmStatus:null,dealLinkState:'unmatched'});
});
it('does not infer company/contact identity from missing fields',()=>{
 const result=reconcileOrderProjects([project('p1',`https://trello.com/c/${card.id}`)],{cards:[card],cardCoverage:{kind:'current_board',complete:true}});
 expect(result.items[0]).toMatchObject({companyName:null,contactName:null,crmStatus:null});
});
it('reports complete deal coverage only for an explicit current-deal read',()=>{
 const result=reconcileOrderProjects([project('p1','')],{
  deals:[],dealCoverage:{kind:'current_deals',complete:true,observedAt:'2026-10-03T20:00:00Z'}
 });
 expect(result.coverage.deals).toMatchObject({kind:'current_deals',complete:true,stale:false});
});
it('pages read-only project exceptions without treating absent card source as missing orders',async()=>{
 const queries=[];const pool={query:async(sql)=>{queries.push(sql);return {rows:[project('p2',''),project('p1',`https://trello.com/c/${card.id}`)]};}};
 const result=await readOrderReconciliation(pool,{limit:1,offset:1});
 expect(queries).toHaveLength(1);expect(queries[0]).toMatch(/^SELECT /);expect(result).toMatchObject({total:2,limit:1,offset:1});
 expect(result.items[0]).toMatchObject({projectId:'p1',cardLinkState:'unobserved',jobCompleted:null,invoicePaid:'unknown'});
 expect(result.items[0].exceptionReasons).toContain('card_source_unavailable');
});
it.each(['$1,797.00','1.797,00'])('does not convert invoice text %s into a CRM sale',invoiceTotal=>{
 const result=reconcileOrderProjects([project('p1',`https://trello.com/c/${card.id}`)],{
  cards:[{...card,invoiceTotal}],cardCoverage:{kind:'retained_one_list',observedAt:'2026-10-03T17:00:53.112Z'},
  deals:[{id:'deal-a',title:'Same title',status:'won'}],dealCoverage:retainedDeals
 });
 expect(result.items[0]).toMatchObject({crmStatus:null,dealLinkState:'unmatched',jobCompleted:null});
});
it('keeps document exceptions visible when external read sources fail',async()=>{
 const pool={query:async()=>({rows:[project('p1',`https://trello.com/c/${card.id}`)]})};
 const result=await readOrderReconciliation(pool,{readCards:async()=>{throw new Error('private Trello token');},
  readDeals:async()=>{throw new Error('private CRM token');}});
 expect(result).toMatchObject({state:'available',total:1,sourceFailures:['cards','deals']});
 expect(result.items[0]).toMatchObject({cardLinkState:'unobserved',jobCompleted:null,invoicePaid:'unknown',crmStatus:null,dealLinkState:'unobserved'});
 expect(JSON.stringify(result)).not.toContain('private');
});
it('requires the card source kind, rows, and observation time before claiming current completion',()=>{
 const source={cards:[{...card,idList:'completed',customFieldItems:[{idCustomField:PAID_FIELD_ID,idValue:'yes'}]}],
  cardCoverage:{kind:'current_board',complete:true,observedAt:'2026-10-03T20:00:00Z'},completedListId:'completed',paidOptions:{yes:'Y'}};
 for(const change of [
  {cardCoverage:{...source.cardCoverage,kind:'current_deals'}},
  {cardCoverage:{...source.cardCoverage,observedAt:null}},
  {cardCoverage:{...source.cardCoverage,observedAt:'2026-02-31T20:00:00Z'}},
  {cards:undefined}
 ]){
  const result=reconcileOrderProjects([project('p1',`https://trello.com/c/${card.id}`)],{...source,...change});
  expect(result.coverage.cards.complete).toBe(false);
  expect(result.items[0]).toMatchObject({cardLinkState:'unobserved',jobCompleted:null,invoicePaid:'unknown',trelloListId:null});
 }
});
it('requires the deal source kind, rows, and observation time before exposing CRM status',()=>{
 const source={deals:[{id:'deal-a',status:'won'}],dealCoverage:{kind:'current_deals',complete:true,observedAt:'2026-10-03T20:00:00Z'},
  dealLinks:[{projectId:'p1',dealId:'deal-a',reviewed:true,evidence:{type:'exact_project_id',value:'p1'}}]};
 for(const change of [
  {dealCoverage:{...source.dealCoverage,kind:'current_board'}},
  {dealCoverage:{...source.dealCoverage,observedAt:'not a time'}},
  {deals:undefined}
 ]){
  const result=reconcileOrderProjects([project('p1','')],{...source,...change});
  expect(result.coverage.deals.complete).toBe(false);
  expect(result.items[0]).toMatchObject({dealLinkState:'unobserved',crmStatus:null});
 }
});
it('keeps reviewed title-only overlap as a candidate, while accepting typed exact evidence',()=>{
 const base={deals:[{id:'deal-a',title:'Same title',status:'won'}],dealCoverage:{kind:'current_deals',complete:true,observedAt:'2026-10-03T20:00:00Z'}};
 const title=reconcileOrderProjects([project('p1','')],{...base,dealLinks:[{projectId:'p1',dealId:'deal-a',reviewed:true,evidence:'title match'}]});
 expect(title.items[0]).toMatchObject({dealLinkState:'unmatched',crmStatus:null});
 const exact=reconcileOrderProjects([project('p1','')],{...base,dealLinks:[{projectId:'p1',dealId:'deal-a',reviewed:true,evidence:{type:'exact_project_id',value:'p1'}}]});
 expect(exact.items[0]).toMatchObject({dealLinkState:'verified',crmStatus:'won'});
 const falseClaim=reconcileOrderProjects([project('p1','')],{...base,dealLinks:[{projectId:'p1',dealId:'deal-a',reviewed:true,evidence:{type:'exact_project_id',value:'other-project'}}]});
 expect(falseClaim.items[0]).toMatchObject({dealLinkState:'unmatched',crmStatus:null});
 const typedTitle=reconcileOrderProjects([project('p1','')],{...base,dealLinks:[{projectId:'p1',dealId:'deal-a',reviewed:true,evidence:{type:'documented_review',referenceType:'title',referenceId:'same',reviewRecordId:'review-1'}}]});
 expect(typedTitle.items[0]).toMatchObject({dealLinkState:'unmatched',crmStatus:null});
});

const orderDb=reportingTestDb('order_reconciliation');
describe.skipIf(!orderDb)('order reconciliation SQL integration',()=>{
 beforeAll(async()=>{
  await orderDb.setup();
  await orderDb.pool.query('CREATE TABLE projects(id text PRIMARY KEY,name text,status text,data jsonb NOT NULL,archived boolean DEFAULT false)');
  await orderDb.pool.query(`INSERT INTO projects(id,name,status,data,archived) VALUES
   ('current','Current','Ready','{"id":"current","trelloLink":"https://trello.com/c/123456789012345678901234"}',false),
   ('archived','Archived','Ready','{"id":"archived"}',true)`);
 });
 afterAll(async()=>{await orderDb.close();});
 it('reads only active project rows and returns unknown source states',async()=>{
  const result=await readOrderReconciliation(orderDb.pool,{limit:10,offset:0});
  expect(result).toMatchObject({total:1,items:[{projectId:'current',documentStatus:'Ready',cardLinkState:'unobserved',jobCompleted:null,invoicePaid:'unknown',crmStatus:null}]});
 });
});
