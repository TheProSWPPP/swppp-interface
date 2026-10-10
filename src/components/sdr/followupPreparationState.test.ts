import {describe,it,expect} from 'vitest';
import {canApplyProposal} from './followupPreparationState';

const request={leadId:'A',session:'token-1',editorVersion:4,revision:2,contextToken:'context-1',handoffUnresolved:false};
describe('private proposal application guard',()=>{
 it('allows only the exact unchanged editor request',()=>{
  expect(canApplyProposal(request,request)).toBe(true);
 });
 it('rejects late response after changed-and-changed-back text, lead, session, revision or context changes',()=>{
  for(const patch of [{editorVersion:6},{leadId:'B'},{session:'token-2'},{revision:3},{contextToken:'context-2'},{handoffUnresolved:true}])expect(canApplyProposal(request,{...request,...patch})).toBe(false);
 });
});
