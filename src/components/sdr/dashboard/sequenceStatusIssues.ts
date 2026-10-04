import type {SdrSequence} from '../../../lib/sdrApi';
export function sequenceChecks(sequences:SdrSequence[]) {
 return sequences.flatMap(sequence=>{
  const issues:string[]=[];
  if(sequence.active===false) issues.push('Paused in Apollo. New enrollments do not prove emails were sent.');
  if(sequence.active===true && /test|do not activate/i.test(sequence.name)) issues.push('This test sequence is active. Review its recipients and intended use.');
  if(sequence.active===null || sequence.coverage==='partial') issues.push('Some configuration details could not be verified.');
  return issues.map(text=>({id:sequence.id,name:sequence.name,text}));
 });
}
