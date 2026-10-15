import type {SdrSequence} from '../../../lib/sdrApi';
export function sequenceChecks(sequences:SdrSequence[]) {
 return sequences.flatMap(sequence=>{
  const issues:string[]=[];
  if(sequence.active===false) issues.push(`paused in Apollo${/bounce/i.test(sequence.pause_reason||'')?' (high bounce)':''}`);
  if(sequence.active===true && /test|do not activate/i.test(sequence.name)) issues.push('test sequence is active');
  if(sequence.active===null || sequence.coverage==='partial') issues.push('settings could not be checked');
  return issues.map(text=>({id:sequence.id,name:sequence.name,text}));
 });
}
