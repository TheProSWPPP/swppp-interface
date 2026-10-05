import {expect,it} from 'vitest';
import {monthlySales,monthWindow} from './salesMonths';
it('groups calendar months and calculates the USD weighted average without dividing by unknown or non-USD sales',()=>{
 const rows=monthlySales([
  {date:'2026-07-01',company_won_deals:2,company_won_booked_value:1000,company_valued_wins:1},
  {date:'2026-07-02',company_won_deals:1,company_won_booked_value:3000,company_valued_wins:1},
  {date:'2026-08-01',company_won_deals:1,company_won_booked_value:6000,company_valued_wins:1}
 ],{from:'2026-07-01',to:'2026-09-01'});
 expect(rows).toMatchObject([{month:'2026-07',sales:3,revenue:4000,average:2000,partialMonth:false},{month:'2026-08',sales:1,revenue:6000,average:6000,partialMonth:false}]);
});
it('marks clipped months and preserves missing totals rather than inventing zero',()=>{
 expect(monthlySales([{date:'2026-09-10',company_won_deals:null,company_won_booked_value:null,company_valued_wins:null}],{from:'2026-09-10',to:'2026-09-12'})).toMatchObject([{sales:null,revenue:null,average:null,partialMonth:true}]);
});
it('selects whole complete months across year boundaries',()=>{
 expect(monthWindow('2026-02-05',3)).toEqual({from:'2025-11-01',to:'2026-02-01'});
});
