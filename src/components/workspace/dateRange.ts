import {shiftDate} from '../sdr/dashboard/metricDisplay';
export type DateSelection={from:string;through:string};
const day=(date:string)=>Math.round(Date.parse(date+'T00:00:00Z')/86400000);
export function moveRange(value:DateSelection,edge:'from'|'through',date:string):DateSelection {
 if(edge==='from')return {from:date,through:value.through<date?date:day(value.through)-day(date)>365?shiftDate(date,365):value.through};
 return {from:value.from>date?date:day(date)-day(value.from)>365?shiftDate(date,-365):value.from,through:date};
}
