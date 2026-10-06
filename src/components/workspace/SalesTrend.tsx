import {useEffect,useId,useRef,useState} from 'react';
import {ArrowUpRight,BarChart3,ChartNoAxesCombined} from 'lucide-react';
import type {MetricsResponse} from '../../lib/sdrMetricsApi';
import {changeText} from '../../lib/salesComparison';
import {monthlySales} from '../sdr/dashboard/salesMonths';
import {salesAmount,changeTone,comparable,monthMetric,type SalesMeasure} from './salesChartData';

const monthLabel=(month:string)=>new Date(month+'-15T12:00:00Z').toLocaleDateString('en-US',{month:'short',year:'numeric',timeZone:'America/Chicago'});
const measures:{id:SalesMeasure;label:string}[]=[{id:'sales',label:'Sales won'},{id:'revenue',label:'Revenue'},{id:'average',label:'Average sale'}];

export default function SalesTrend({data,previous,monthBaseline,comparisonLabel,comparisonLoading,onOpenMonth}:{data:MetricsResponse;previous?:MetricsResponse;monthBaseline?:MetricsResponse;comparisonLabel:string;comparisonLoading:boolean;onOpenMonth:(from:string,to:string)=>void}) {
  const id=useId();
  const [measure,setMeasure]=useState<SalesMeasure>('sales');
  const [style,setStyle]=useState<'bars'|'line'>('bars');
  const [compare,setCompare]=useState(false);
  const [selected,setSelected]=useState<string|null>(null);
  const [hovered,setHovered]=useState<string|null>(null);
  const scrollRef=useRef<HTMLDivElement>(null);
  const [chartWidth,setChartWidth]=useState(680);
  useEffect(()=>{
    const element=scrollRef.current;
    if(!element)return;
    const observer=new ResizeObserver(()=>setChartWidth(element.clientWidth-24));
    observer.observe(element);
    return()=>observer.disconnect();
  },[]);
  const rows=monthlySales(data.activity,data.window);
  const priorRows=previous?monthlySales(previous.activity,previous.window):[];
  const currentMetrics=rows.map(row=>monthMetric(data,row,measure));
  const priorMetrics=rows.map((_,index)=>monthMetric(previous,priorRows[index],measure));
  const values=rows.map((row,index)=>currentMetrics[index].state==='unavailable'?null:row[measure]);
  const priorValues=rows.map((_,index)=>comparable(currentMetrics[index],priorMetrics[index])?priorMetrics[index].value:null);
  const highest=Math.max(1,...values.map(value=>value||0),...(compare?priorValues.map(value=>value||0):[]));
  const magnitude=10**Math.floor(Math.log10(highest/4));
  const tickStep=Math.max(measure==='sales'?1:0,Math.ceil(highest/4/magnitude)*magnitude);
  const max=tickStep*4;
  const min=Math.min(0,...values.map(value=>value||0),...(compare?priorValues.map(value=>value||0):[]));
  const width=Math.max(300,chartWidth,rows.length*65+64),height=248,left=58,right=18,top=20,bottom=206;
  const step=(width-left-right)/Math.max(1,rows.length);
  const x=(index:number)=>left+step*(index+.5);
  const y=(value:number)=>bottom-((value-min)/(max-min))*(bottom-top);
  const line=(series:(number|null)[])=>series.map((value,index)=>value===null?'':`${index>0&&series[index-1]!==null?'L':'M'}${x(index)},${y(value)}`).join(' ');
  const activeMonth=hovered||selected||rows.at(-1)?.month;
  const activeIndex=Math.max(0,rows.findIndex(row=>row.month===activeMonth));
  const active=rows[activeIndex];
  const activePrior=priorRows[activeIndex];
  const warnings=data.company_sales?.date_warnings||[];
  const inspect=(month:string)=>{setSelected(month);setHovered(null);};
  const tick=(value:number)=>new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1,...(measure==='sales'?{}:{style:'currency',currency:'USD'})}).format(value);
  const delta=(index:number,key:SalesMeasure)=>changeText(monthMetric(data,rows[index],key),monthMetric(previous,priorRows[index],key),key!=='sales');

  return <>
    <section className="sales-trend" aria-labelledby={`${id}-title`} data-measure={measure}>
      <div className="sales-trend-heading"><div><h2 id={`${id}-title`}>Monthly performance</h2><p>Dated Pipedrive wins</p></div>
        <div className="sales-segments" role="group" aria-label="Chart metric">{measures.map(item=><button key={item.id} aria-pressed={measure===item.id} onClick={()=>setMeasure(item.id)}>{item.label}</button>)}</div>
      </div>
      <div className="sales-chart-toolbar"><div className="sales-chart-legend"><span><i/>{measures.find(item=>item.id===measure)?.label}</span>{compare&&<span><i className="is-previous"/>{comparisonLabel}</span>}{warnings.length>0&&<span className="sales-review-key"><i/>Date review</span>}</div>
        <div className="sales-chart-actions"><label className="sales-compare-toggle"><input type="checkbox" checked={compare} onChange={event=>setCompare(event.target.checked)}/>Compare</label><div className="sales-chart-style" role="group" aria-label="Chart style"><button aria-label="Bar chart" aria-pressed={style==='bars'} onClick={()=>setStyle('bars')}><BarChart3 size={18}/></button><button aria-label="Line chart" aria-pressed={style==='line'} onClick={()=>setStyle('line')}><ChartNoAxesCombined size={18}/></button></div></div>
      </div>
      {compare&&<p className="sales-chart-comparison-note">{comparisonLoading?'Loading comparison…':!previous?'Comparison unavailable. Retry from the summary above.':priorValues.every(value=>value===null)?'Comparison withheld: these periods have incomplete data or sale dates needing review.':`Compared with ${monthLabel(previous.window.from.slice(0,7))} through ${monthLabel(priorRows.at(-1)?.month||previous.window.from.slice(0,7))}. Months needing date review are omitted from the comparison.`}</p>}
      {!rows.length?<div className="sales-chart-empty">No monthly records are available for these dates. Choose another period or refresh sales.</div>:<div ref={scrollRef} className="sales-chart-scroll" role="region" aria-label="Sales chart, scroll horizontally for more months" tabIndex={0}>
        <div className="sales-chart-canvas" style={{minWidth:width}} onMouseLeave={()=>setHovered(null)}>
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
            {[0,.25,.5,.75,1].map(ratio=>{const value=min+(max-min)*ratio;return <g key={ratio}><line x1={left} x2={width-right} y1={y(value)} y2={y(value)} className="sales-grid-line"/><text x={left-10} y={y(value)+4} textAnchor="end" className="sales-axis">{tick(value)}</text></g>;})}
            {rows.map((row,index)=><rect key={row.month} x={x(index)-step/2+2} y={top-8} width={step-4} height={bottom-top+8} rx={4} className={`sales-chart-highlight ${row.month===activeMonth?'is-active':''}`}/>)}
            {style==='line'&&<>{compare&&<path d={line(priorValues)} className="sales-previous-line"/>}<path d={line(values)} className="sales-current-line"/></>}
            {rows.map((row,index)=>{
              const value=values[index],prior=priorValues[index],warn=warnings.some(w=>w.month===row.month),barWidth=Math.min(30,step*(compare?.28:.5));
              return <g key={row.month}>
                {style==='bars'&&compare&&prior!==null&&<rect x={x(index)+2} y={Math.min(y(prior),y(0))} width={barWidth} height={Math.max(2,Math.abs(y(0)-y(prior)))} rx={3} className="sales-previous-bar"/>}
                {style==='line'&&compare&&prior!==null&&<circle cx={x(index)} cy={y(prior)} r={4} className="sales-previous-dot"/>}
                {value!==null?(style==='bars'?<rect x={x(index)-(compare?barWidth+2:barWidth/2)} y={Math.min(y(value),y(0))} width={barWidth} height={Math.max(2,Math.abs(y(0)-y(value)))} rx={3} className={`sales-current-bar ${warn?'needs-review':''}`}/>:<circle cx={x(index)} cy={y(value)} r={row.month===activeMonth?5:3.5} className={`sales-current-dot ${warn?'needs-review':''}`}/>):<text x={x(index)} y={bottom-8} textAnchor="middle" className="sales-axis">N/A</text>}
                <text x={x(index)} y={230} textAnchor="middle" className="sales-axis sales-axis-month">{monthLabel(row.month).split(' ')[0]}</text>
                {(index===0||row.month.endsWith('-01'))&&<text x={x(index)} y={245} textAnchor="middle" className="sales-axis">{row.month.slice(0,4)}</text>}
              </g>;
            })}
          </svg>
          <div className="sales-chart-hitareas" style={{left:`${left/width*100}%`,right:`${right/width*100}%`,gridTemplateColumns:`repeat(${rows.length},minmax(0,1fr))`}}>{rows.map((row,index)=><button key={row.month} aria-label={`${monthLabel(row.month)}: ${salesAmount(values[index],measure!=='sales')}${measure==='sales'?' sales':''}${warnings.some(w=>w.month===row.month)?', dates need review':''}`} aria-pressed={selected===row.month} onMouseEnter={()=>setHovered(row.month)} onFocus={()=>setHovered(row.month)} onBlur={()=>setHovered(null)} onClick={()=>inspect(row.month)}/>)}</div>
          {(hovered||selected)&&active&&<div className="sales-chart-tooltip" style={{left:`${Math.min(75,Math.max(3,x(activeIndex)/width*100-8))}%`}} aria-hidden="true"><strong>{monthLabel(active.month)}</strong><span>{salesAmount(values[activeIndex],measure!=='sales')}{measure==='sales'?' sales':''}</span>{warnings.some(w=>w.month===active.month)&&<small>Dates need review</small>}{compare&&activePrior&&<small>{monthLabel(activePrior.month)}: {salesAmount(priorValues[activeIndex],measure!=='sales')}</small>}</div>}
        </div>
      </div>}
      {active&&<div className="sales-month-inspector" aria-label="Selected month details"><div className="sales-month-title"><strong>{monthLabel(active.month)}</strong>{active.partialMonth&&<span>Partial month</span>}{warnings.some(w=>w.month===active.month)&&<span className="sales-review-label">Dates need review</span>}<button className="sales-month-open" onClick={()=>onOpenMonth(active.from,active.to)}>View month<ArrowUpRight size={16}/></button></div><dl>{measures.map(item=><div key={item.id}><dt>{item.label}</dt><dd>{salesAmount(monthMetric(data,active,item.id).state==='unavailable'?null:active[item.id],item.id!=='sales')}</dd>{compare&&<small className={`sales-change is-${changeTone(monthMetric(data,active,item.id),monthMetric(previous,activePrior,item.id))}`}>{delta(activeIndex,item.id)}</small>}</div>)}</dl></div>}
    </section>
    <section className="sales-breakdown" aria-labelledby={`${id}-breakdown`}><div className="sales-breakdown-heading"><h2 id={`${id}-breakdown`}>Month by month</h2><span>Changes vs. the previous month</span></div>
      <div className="sales-table-scroll" role="region" aria-label="Monthly sales breakdown" tabIndex={0}><table><thead><tr><th scope="col">Month</th><th scope="col">Sales won</th><th scope="col">Revenue</th><th scope="col">Average sale</th><th scope="col">Sales change</th><th scope="col">Revenue change</th></tr></thead><tbody>{rows.map((row,index)=>{
        const baselineRows=monthBaseline?monthlySales(monthBaseline.activity,monthBaseline.window):priorRows;
        const prior=rows[index-1]||baselineRows.find(item=>item.to===row.from),source=index>0?data:monthBaseline||previous;
        const adjacent=prior?.to===row.from;
        return <tr key={row.month}><th scope="row"><button onClick={()=>onOpenMonth(row.from,row.to)}>{monthLabel(row.month)}<ArrowUpRight size={14}/></button>{row.partialMonth&&<small>Partial month</small>}{warnings.some(w=>w.month===row.month)&&<small className="sales-review-label">Dates need review</small>}</th><td>{salesAmount(monthMetric(data,row,'sales').state==='unavailable'?null:row.sales)}</td><td>{salesAmount(monthMetric(data,row,'revenue').state==='unavailable'?null:row.revenue,true)}</td><td>{salesAmount(monthMetric(data,row,'average').state==='unavailable'?null:row.average,true)}</td>{(['sales','revenue'] as const).map(key=>{
          const current=monthMetric(data,row,key),previousMetric=monthMetric(source,adjacent?prior:undefined,key);
          const text=changeText(current,previousMetric,key==='revenue');
          return <td key={key}><span className={`sales-change is-${changeTone(current,previousMetric)}`} title={text}>{comparable(current,previousMetric)?text:current.reason==='crm_sales_dates_need_review'||previousMetric.reason==='crm_sales_dates_need_review'?'Date review':!adjacent?'Unavailable':'Incomplete data'}</span></td>;
        })}</tr>;
      })}</tbody></table></div>
    </section>
  </>;
}
