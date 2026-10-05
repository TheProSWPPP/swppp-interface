export type SalesDay={date:string;company_won_deals:number|null;company_won_booked_value:number|null;company_valued_wins?:number|null};
export type SalesMonth={month:string;from:string;to:string;sales:number|null;revenue:number|null;valuedWins:number|null;average:number|null;partialMonth:boolean};
export function monthWindow(today:string,months:number):{from:string;to:string} {
  const to=today.slice(0,8)+'01';
  const date=new Date(`${to}T12:00:00Z`);date.setUTCMonth(date.getUTCMonth()-months);
  return {from:date.toISOString().slice(0,10),to};
}
export function monthlySales(days:SalesDay[],window:{from:string;to:string}):SalesMonth[] {
  const months=new Map<string,SalesMonth>();
  for(const day of days) {
    const month=day.date.slice(0,7),start=month+'-01';
    const next=new Date(`${start}T12:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);
    const end=next.toISOString().slice(0,10);
    let row=months.get(month);
    if(!row){row={month,from:start<window.from?window.from:start,to:end>window.to?window.to:end,sales:0,revenue:0,valuedWins:0,average:null,partialMonth:start<window.from||end>window.to};months.set(month,row);}
    row.sales=row.sales===null||day.company_won_deals===null?null:row.sales+day.company_won_deals;
    row.revenue=row.revenue===null||day.company_won_booked_value===null?null:row.revenue+day.company_won_booked_value;
    row.valuedWins=row.valuedWins===null||day.company_valued_wins==null?null:row.valuedWins+day.company_valued_wins;
    row.average=row.revenue!==null&&row.valuedWins?row.revenue/row.valuedWins:null;
  }
  return [...months.values()].sort((a,b)=>a.month.localeCompare(b.month));
}
