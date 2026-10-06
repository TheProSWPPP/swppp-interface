import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Archive,BookOpen,ChartNoAxesCombined,ChevronDown,FileCode,Files,LayoutDashboard,ListChecks,Menu,Newspaper,Send,Settings,Upload,X,type LucideIcon} from 'lucide-react';
import type {SdrUser} from '../../lib/sdrApi';
import type {WorkspaceView} from './navigation';
const items:{id:WorkspaceView;label:string;icon:LucideIcon;primary?:boolean}[]=[
  {id:'overview',label:'Overview',icon:LayoutDashboard,primary:true},
  {id:'sales',label:'Sales',icon:ChartNoAxesCombined,primary:true},
  {id:'dashboard',label:'Documents',icon:Files,primary:true},
  {id:'sdr',label:'SDR',icon:Send,primary:true},
  {id:'leads',label:'Lead Import',icon:Upload,primary:true},
  {id:'ai-content',label:'AI Content',icon:Newspaper,primary:true},
  {id:'archive',label:'Archive',icon:Archive},
  {id:'roadmap',label:'Roadmap',icon:ListChecks},
  {id:'methodology',label:'Methodology',icon:BookOpen},
  {id:'system-docs',label:'System Docs',icon:FileCode},
  {id:'settings',label:'Settings',icon:Settings},
  ...(import.meta.env.DEV?[{id:'interface-review' as const,label:'Interface review',icon:ListChecks}]:[]),
];
export default function WorkspaceChrome({view,user,onNavigate,children}:{view:WorkspaceView;user:SdrUser|null;onNavigate:(view:WorkspaceView)=>void;children:ReactNode}){
  const [open,setOpen]=useState(false);
  const [more,setMore]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null);
  const drawer=useRef<HTMLDivElement>(null);
  const moreRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!open)return;
    const previous=(document.activeElement as HTMLElement|null)||trigger.current;
    drawer.current?.querySelector<HTMLElement>('button')?.focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();setOpen(false);}
      if(event.key==='Tab'){
        const controls=Array.from(drawer.current?.querySelectorAll<HTMLElement>('button,a[href]')||[]);
        const first=controls[0],last=controls.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',key);
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    return()=>{document.removeEventListener('keydown',key);document.body.style.overflow=overflow;previous?.focus();};
  },[open]);
  useEffect(()=>{
    if(!more)return;
    const close=(event:MouseEvent)=>{if(!moreRef.current?.contains(event.target as Node))setMore(false);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMore(false);moreRef.current?.querySelector('button')?.focus();}};
    document.addEventListener('mousedown',close);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',key);};
  },[more]);
  const navigate=(target:WorkspaceView)=>{setOpen(false);setMore(false);onNavigate(target);};
  const navButton=(item:typeof items[number])=><button key={item.id} type="button" onClick={()=>navigate(item.id)} className="workspace-nav-item" aria-current={view===item.id?'page':undefined}><item.icon size={17} aria-hidden="true"/>{item.label}</button>;
  return <div className={`workspace-shell ${view==='sdr'?'workspace-shell-sdr':''}`}>
    <a className="workspace-skip" href="#workspace-main" onClick={event=>{event.preventDefault();document.getElementById('workspace-main')?.focus();}}>Skip to content</a>
    <div inert={open?true:undefined}>
      <header className="workspace-header">
        <div className="workspace-brand-row"><button className="workspace-brand" aria-label="Pro SWPPP overview" onClick={()=>navigate('overview')}><img src="/logo.webp" alt="Pro SWPPP"/><span>Pro SWPPP</span></button>
          <div className="workspace-header-right">{import.meta.env.DEV&&<a className="workspace-review-link" href="#/interface-review" onClick={event=>{event.preventDefault();navigate('interface-review');}}>Local design review</a>}<span className="workspace-identity">{user?user.display_name:'Team workspace'}</span><button ref={trigger} className="workspace-mobile-trigger" aria-label="Open workspace navigation" aria-expanded={open} aria-controls="workspace-drawer" onClick={()=>setOpen(true)}><Menu size={21}/>{view==='sdr'&&<span>Workspace</span>}</button></div>
        </div>
        <nav className="workspace-nav" aria-label="Primary workspace navigation">{items.filter(item=>item.primary).map(navButton)}<div className="workspace-more" ref={moreRef}><button className="workspace-nav-item" aria-expanded={more} aria-controls="workspace-tools" onClick={()=>setMore(!more)}>Tools<ChevronDown size={16}/></button>{more&&<div id="workspace-tools" className="workspace-tools">{items.filter(item=>!item.primary).map(navButton)}</div>}</div></nav>
      </header>
      <main id="workspace-main" tabIndex={-1} className={`workspace-main ${view==='sdr'?'workspace-main-sdr':''}`}>
        {view!=='sdr'&&<div className="workspace-location"><span>Workspace</span><span aria-hidden="true">/</span><strong>{items.find(item=>item.id===view)?.label||'Overview'}</strong></div>}<div className={`workspace-area workspace-area-${view} ${!['sdr','overview','sales','interface-review'].includes(view)?'workspace-legacy':''}`}>{children}</div>
      </main>
    </div>
    {open&&<div className="workspace-drawer-layer"><button className="workspace-drawer-backdrop" aria-label="Close workspace navigation" tabIndex={-1} onClick={()=>setOpen(false)}/><div id="workspace-drawer" ref={drawer} className="workspace-drawer" role="dialog" aria-modal="true" aria-labelledby="workspace-drawer-title"><div className="workspace-drawer-heading"><strong id="workspace-drawer-title">Workspace navigation</strong><button aria-label="Close workspace navigation" onClick={()=>setOpen(false)}><X size={21}/></button></div><nav aria-label="Mobile workspace navigation">{items.map(navButton)}</nav></div></div>}
  </div>;
}
