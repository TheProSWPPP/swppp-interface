import {describe,it,expect} from 'vitest';
import {LANE_COPY,laneCampaignDefaults} from '../sdrLinkedinLaneCopy.js';
import {renderLinkedinStep,renderLinkedinText,linkedinSequenceValid} from '../sdrLinkedinPolicy.js';

const v=value=>({value,verified:true});
const identity={firstName:'Randy',firstNameVerified:true};
const facts={company:v('Crossland Construction'),newCompany:v('Crossland Construction'),oldCompany:v('Flintco'),state:v('Oklahoma'),lastProject:v('Tulsa Med Center'),topic:v('the new EPA permit'),reaction:v('good breakdown of the NOI changes')};
const campaign=lane=>({config:{lane,...laneCampaignDefaults(lane)}});
const render=(lane,step,f=facts)=>renderLinkedinStep({campaign:campaign(lane),identity,facts:f,step});

// Expected text is the client page (ProSWPPP-Bid-Invites-and-LinkedIn.html, Part 2) with the sample facts filled in.
describe('Derek lane copy, word for word from the page',()=>{
 it('renders every lane line byte for byte',()=>{
  expect(render('A','dm1')).toBe("Hey Randy, appreciate the connection. Congrats on the new role at Crossland Construction. Who's handling the SWPPPs over there these days?");
  expect(render('A','followup1')).toBe('Hey Randy, first few months in a new seat usually means rebuilding the sub list. Worth having a SWPPP guy on it who actually picks up the phone?');
  expect(render('A','followup2')).toBe("Hey Randy, I'll stop sliding into your DMs about stormwater after this one 😄 If a SWPPP ever lands on your desk, send it my way.");
  expect(render('B','dm1')).toBe("Hey Randy, saw you made the move to Crossland Construction. Congrats man. We miss doing your SWPPPs from the Flintco days. Who's handling stormwater over there?");
  expect(render('B','followup1')).toBe("Hey Randy, if y'all have anything coming up at Crossland Construction that needs a SWPPP, send it over and we'll take care of you like old times.");
  expect(render('C','dm1')).toBe("Hey Randy, appreciate the connection. We've done the SWPPPs for Crossland Construction for a while, most recently Tulsa Med Center. Wanted to say hi since you're the new go-to for precon.");
  expect(render('C','followup1')).toBe('Hey Randy, anything coming up at Crossland Construction that needs a SWPPP? Happy to bid it.');
  expect(render('D','dm1')).toBe('Hey Randy, appreciate the connection. Saw your post about the new EPA permit, good breakdown of the NOI changes. We write SWPPPs for GCs in Oklahoma, so that one hit home.');
  expect(render('D','followup1')).toBe(render('A','followup1'));expect(render('D','followup2')).toBe(render('A','followup2'));
  for(const lane of ['A','B'])expect(JSON.parse(render(lane,'inmail'))).toEqual({subject:'SWPPPs at Crossland Construction',body:"Hey Randy, congrats on the new role. I'm Derek, I run ProSWPPP. We write the SWPPPs for GCs in Oklahoma. If you're putting your sub list together, I'd love to be on it. Worth a 10 minute call?"});
 });
 it('uses the page timing and InMail lanes, and every default campaign is a valid sequence',()=>{
  expect(laneCampaignDefaults('A')).toMatchObject({followupDays:[3,7],inmail:true});
  expect(laneCampaignDefaults('B')).toMatchObject({followupDays:[4],inmail:true});
  expect(laneCampaignDefaults('C')).toMatchObject({followupDays:[4],inmail:false});
  expect(laneCampaignDefaults('D')).toMatchObject({followupDays:[3,7],inmail:false});
  expect(laneCampaignDefaults('B').copy.followup2).toBeUndefined();
  for(const lane of ['A','B','C','D'])expect(linkedinSequenceValid(campaign(lane).config),lane).toBe(true);
  expect(JSON.stringify(LANE_COPY)).not.toMatch(/[—–]/);
 });
 it('drops lane C last project clause when no order verifies it',()=>{
  const {lastProject,...rest}=facts;void lastProject;
  expect(render('C','dm1',rest)).toBe("Hey Randy, appreciate the connection. We've done the SWPPPs for Crossland Construction for a while. Wanted to say hi since you're the new go-to for precon.");
  expect(render('C','dm1',{...rest,lastProject:{value:'Guess',verified:false}})).toContain('for a while. Wanted');
 });
 it('holds lane D when the post line is not approved, and any lane when a required fact is unverified',()=>{
  expect(()=>render('D','dm1',{...facts,reaction:{value:'draft line',verified:false,draft:true}})).toThrow('unverified_fact');
  expect(()=>render('A','dm1',{...facts,company:undefined})).toThrow('unverified_fact');
  expect(()=>renderLinkedinStep({campaign:campaign('A'),identity:{firstName:'Randy',firstNameVerified:false},facts,step:'dm1'})).toThrow('unverified_fact');
  expect(()=>render('A','inmail',{...facts,state:undefined})).toThrow('unverified_fact');
  expect(renderLinkedinText('A[[ {x}]] B {company}',{facts})).toBe('A B Crossland Construction');
 });
});
describe('whole-sequence copy check before an invite (QA 9)',()=>{
 it('lists every fact the lane will need, InMail included, and leaves lane D post lines to approval',async()=>{
  const {sequenceMissingFacts,sameNamedPerson,nameTokens}=await import('../sdrLinkedinProspect.js');
  const identity={firstName:'Randy',firstNameVerified:true};
  expect(sequenceMissingFacts({lane:'A',facts,identity})).toEqual([]);
  expect(sequenceMissingFacts({lane:'A',facts:{company:facts.company},identity})).toEqual(['state']);
  expect(sequenceMissingFacts({lane:'B',facts:{newCompany:facts.newCompany,state:facts.state},identity}).sort()).toEqual(['company','oldCompany']);
  expect(sequenceMissingFacts({lane:'C',facts:{company:facts.company},identity})).toEqual([]);
  expect(sequenceMissingFacts({lane:'D',facts:{state:facts.state},identity})).toEqual([]);
  expect(sequenceMissingFacts({lane:'A',facts,identity:{firstName:'Randy',firstNameVerified:false}})).toEqual(['firstName']);
  expect(sameNamedPerson('Mike Smith, P.E.','Michael J. Smith')).toBe(true);expect(sameNamedPerson('Dan Brown','Daniel Brownstein')).toBe(false);
  expect(nameTokens("Steve O'Brien, LEED AP")).toEqual({first:'steve',last:'obrien'});
 });
});
