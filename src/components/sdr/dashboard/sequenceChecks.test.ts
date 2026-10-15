import {describe,expect,it} from 'vitest';
import {sequenceChecks} from './sequenceStatusIssues';
import type {SdrSequence} from '../../../lib/sdrApi';
const sequence=(name:string,active:boolean|null,extra:Partial<SdrSequence>={}):SdrSequence=>({id:name,name,active,num_steps:1,steps:[],...extra});
describe('sequence status checks',()=>{
 it('flags paused sending and active test sequences separately, in one short line each',()=>{const result=sequenceChecks([sequence('PB',false),sequence('MSGP (TEST) do not activate',true),sequence('AGC',true)]);expect(result.map(issue=>issue.text)).toEqual(['paused in Apollo','test sequence is active'])});
 it('names a high-bounce auto pause',()=>{expect(sequenceChecks([sequence('SWPPP - PB',false,{pause_reason:'auto_pause_high_bounce'})])[0].text).toBe('paused in Apollo (high bounce)')});
 it('does not fabricate paused state for missing activation data',()=>{const [result]=sequenceChecks([sequence('Unknown',null)]);expect(result.text).toContain('could not be checked');expect(result.text).not.toContain('paused')});
 it('preserves incomplete configuration evidence',()=>{expect(sequenceChecks([sequence('AGC',true,{coverage:'partial'})])[0].text).toContain('could not be checked')});
});
