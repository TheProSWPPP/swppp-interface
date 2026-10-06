import {moveRange,type DateSelection} from './dateRange';
const day=(date:string)=>Math.round(Date.parse(date+'T00:00:00Z')/86400000);
export default function DateRangeFilter({value,onChange,onApply,latest,earliest}:{value:DateSelection;onChange:(value:DateSelection)=>void;onApply:()=>void;latest:string;earliest?:string}) {
 const start=earliest||latest.slice(0,4)+'-01-01';
 const end=latest;
 const min=day(start),max=Math.max(min,day(end));
 const index=(date:string)=>Number.isFinite(day(date))?Math.max(min,Math.min(max,day(date))):min;
 const label=(date:string)=>new Date(date+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'America/Chicago'});
 const from=index(value.from),through=index(value.through),span=Math.max(1,max-min);
 return <div className="sales-date-range">
  <div className="sales-date-fields"><label>From<input type="date" min={earliest} max={latest} value={value.from} onChange={e=>onChange({...value,from:e.target.value})}/></label><label>Through<input type="date" min={earliest} max={latest} value={value.through} onChange={e=>onChange({...value,through:e.target.value})}/></label><button className="workspace-button" onClick={onApply}>Apply dates</button></div>
  <div className="sales-range-track"><div className="sales-range-selection" style={{left:`${(from-min)/span*100}%`,right:`${(max-through)/span*100}%`}}/>{(['from','through'] as const).map(edge=><input key={edge} type="range" aria-label={edge==='from'?'Range start date':'Range end date'} aria-valuetext={label(edge==='from'?value.from||start:value.through||end)} min={min} max={max} step={1} value={edge==='from'?from:through} onChange={e=>onChange(moveRange(value,edge,new Date(Number(e.target.value)*86400000).toISOString().slice(0,10)))}/>)}</div>
  <div className="sales-range-labels"><span>{label(start)}</span><span>{label(end)}</span></div>
 </div>;
}
