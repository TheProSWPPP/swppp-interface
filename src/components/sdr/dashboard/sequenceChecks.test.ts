import {describe,expect,it} from 'vitest';
import {sequenceChecks} from './sequenceStatusIssues';
import type {SdrSequence} from '../../../lib/sdrApi';
const sequence=(name:string,active:boolean|null,extra:Partial<SdrSequence>={}):SdrSequence=>({id:name,name,active,num_steps:1,steps:[],...extra});
describe('sequence status checks',()=>{
 it('flags paused sending and active test sequences separately',()=>{const result=sequenceChecks([sequence('PB',false),sequence('MSGP (TEST) do not activate',true),sequence('AGC',true)]);expect(result).toHaveLength(2);expect(result[0].text).toContain('Paused');expect(result[1].text).toContain('test sequence is active')});
 it('does not fabricate paused state for missing activation data',()=>{const [result]=sequenceChecks([sequence('Unknown',null)]);expect(result.text).toContain('could not be verified');expect(result.text).not.toContain('Paused')});
 it('preserves incomplete configuration evidence',()=>{expect(sequenceChecks([sequence('AGC',true,{coverage:'partial'})])[0].text).toContain('could not be verified')});
});
