import {describe,it,expect,vi} from 'vitest';
import {createGeminiSalesLoopGenerator} from '../sdrSalesLoopGenerator.js';

const request={sourceText:'Buyer asks for the bid form by October 21.',source:{kind:'crm_note',id:'n-1'},project:{title:'Library'},missingFacts:['quote amount'],envelope:{companyId:'42',leadId:'A'}};
describe('staged sales loop Gemini adapter',()=>{
 it('requires explicit authorized model configuration and returns only bounded private proposal fields',async()=>{
  const transport=vi.fn(async payload=>({text:JSON.stringify({subject:'Bid form',body:'I can send the form.',missingFacts:['quote amount']})}));
  const generate=createGeminiSalesLoopGenerator({apiKey:'synthetic-key',model:'explicit-model',transport});
  const result=await generate(request);
  expect(result).toEqual({subject:'Bid form',body:'I can send the form.',missingFacts:['quote amount']});
  const payload=transport.mock.calls[0][0];expect(payload.model).toBe('explicit-model');expect(payload.sourceText).toBe(request.sourceText);expect(payload.tools).toBeUndefined();
 });
 it('rejects missing model, malformed output and provider failure without canned substitute',async()=>{
  expect(()=>createGeminiSalesLoopGenerator({apiKey:'synthetic-key',transport:vi.fn()})).toThrow('generator_configuration');
  const malformed=createGeminiSalesLoopGenerator({apiKey:'synthetic-key',model:'explicit-model',transport:async()=>({text:'not json'})});
  await expect(malformed(request)).rejects.toMatchObject({code:'generator_unavailable'});
  const failing=createGeminiSalesLoopGenerator({apiKey:'synthetic-key',model:'explicit-model',transport:async()=>{throw Error('provider down');}});
  await expect(failing(request)).rejects.toMatchObject({code:'generator_unavailable'});
 });
});
