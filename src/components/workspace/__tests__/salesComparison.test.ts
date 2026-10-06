import {expect,it} from 'vitest';
import {comparisonWindow,changeText} from '../../../lib/salesComparison';
it('compares calendar months without rolling day offsets',()=>{
 expect(comparisonWindow({from:'2026-09-01',to:'2026-10-01'})).toEqual({from:'2026-08-01',to:'2026-09-01'});
 expect(comparisonWindow({from:'2024-02-01',to:'2024-03-01'})).toEqual({from:'2024-01-01',to:'2024-02-01'});
 expect(comparisonWindow({from:'2026-01-01',to:'2027-01-01'})).toEqual({from:'2025-01-01',to:'2026-01-01'});
 expect(comparisonWindow({from:'2026-09-02',to:'2026-09-10'})).toEqual({from:'2026-08-25',to:'2026-09-02'});
});
it('uses percentage change only for complete, nonzero baselines',()=>{
 expect(changeText({value:21,state:'available'},{value:23,state:'available'})).toBe('−2 (−8.7%)');
 expect(changeText({value:5,state:'available'},{value:0,state:'available'})).toBe('+5 (previously zero)');
 expect(changeText({value:21,state:'partial'},{value:23,state:'available'})).toBe('Comparison unavailable: incomplete history');
 expect(changeText({value:null,state:'unavailable'},{value:23,state:'available'})).toBe('Comparison unavailable: incomplete history');
});

it('explains a missing average in a zero-sales month without claiming incomplete history',()=>{expect(changeText({value:null,state:'unavailable',reason:'no_valued_wins'},{value:2000,state:'available'},true)).toBe('No valued sales to compare');});
