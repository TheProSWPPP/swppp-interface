import { useEffect,useRef,useState,type ReactNode } from 'react';
import { BarChart3,Target,Inbox,Flame,Mail,ListChecks,FileSearch,Users,Send,Layers,Contact,RefreshCw,Menu,X,LogOut,ShieldCheck,CalendarClock } from 'lucide-react';
import type { SdrUser } from '../../../lib/sdrApi';
import './dashboard.css';
const coldItems=[{id:'dashboard',label:'Dashboard',icon:BarChart3},{id:'leads',label:'Leads',icon:Target},{id:'queue',label:'Queue',icon:Send},{id:'engaged',label:'Priority',icon:Flame},{id:'inbox',label:'Inbox',icon:Inbox},{id:'followups',label:'Follow-ups',icon:CalendarClock},{id:'mailboxes',label:'Mailboxes',icon:Mail},{id:'templates',label:'Templates',icon:ListChecks},{id:'permits',label:'Permits',icon:FileSearch},{id:'team',label:'Team',icon:Users}];
const nurtureItems=[{id:'campaigns',label:'Campaigns',icon:Send},{id:'lists',label:'Lists',icon:Layers},{id:'contacts',label:'Contacts',icon:Contact},{id:'automations',label:'Automations',icon:RefreshCw}];
export default function SdrWorkspace({user,lane,active,onLaneChange,onNavigate,onSignOut,notifications,badges={},children}:{user:SdrUser;lane:'cold'|'nurture';active:string;onLaneChange:(lane:'cold'|'nurture')=>void;onNavigate:(tab:string)=>void;onSignOut:()=>void;notifications?:ReactNode;badges?:Record<string,number>;children:ReactNode}) {
  const [menuOpen,setMenuOpen]=useState(false);
  const openButton=useRef<HTMLButtonElement>(null);
  const closeButton=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(menuOpen) closeButton.current?.focus();},[menuOpen]);
  const closeMenu=()=>{setMenuOpen(false);requestAnimationFrame(()=>openButton.current?.focus());};
  const items=(lane==='cold'?coldItems:nurtureItems).filter(item=>!['team','followups'].includes(item.id)||user.role==='admin');
  const activeLabel=items.find(item=>item.id===active)?.label||'Templates';
  return <div className="sdr-workspace">
    <aside className={`sdr-sidebar ${menuOpen?'is-open':''}`} aria-label="Outreach workspace" onKeyDown={event=>{if(menuOpen&&event.key==='Escape'){event.preventDefault();closeMenu();}if(menuOpen&&event.key==='Tab'){const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));const first=buttons[0];const last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}}>
      <div className="sdr-workspace-brand"><span className="sdr-brand-mark" aria-hidden="true"><ShieldCheck size={23}/></span><div><strong>Pro SWPPP</strong></div><button ref={closeButton} className="sdr-menu-close" aria-label="Close navigation" onClick={closeMenu}><X size={20}/></button></div>
      <div className="sdr-lane-switch" role="group" aria-label="Outreach lane">{(['cold','nurture'] as const).map(value=><button key={value} aria-pressed={lane===value} onClick={()=>onLaneChange(value)}>{value==='cold'?'Cold outreach':'Nurture'}</button>)}</div>
      <nav aria-label={lane==='cold'?'Cold outreach':'Nurture'}>{items.map(({id:tab,label,icon:Icon},index)=><div key={tab} className={lane==='cold'&&index===5?'sdr-nav-separated':undefined}><button className="sdr-nav-item" aria-current={active===tab?'page':undefined} onClick={()=>{onNavigate(tab);if(menuOpen) closeMenu();}}>
        {active===tab&&<span className="sdr-nav-highlight"/>}<Icon size={18} aria-hidden="true"/><span>{label}</span>{Boolean(badges[tab])&&<span className="sdr-nav-badge">{badges[tab]}</span>}
      </button></div>)}</nav>
      <div className="sdr-sidebar-footer"><span>{lane==='cold'?'Cold outreach · Apollo':'Nurture · Brevo'}</span><div><ShieldCheck size={15} aria-hidden="true"/>Pro SWPPP sales team</div></div>
    </aside>
    <div className="sdr-workspace-body" inert={menuOpen||undefined}><header className="sdr-workspace-topbar"><div className="sdr-breadcrumb"><button ref={openButton} aria-label="Open navigation" aria-expanded={menuOpen} className="sdr-menu-open" onClick={()=>setMenuOpen(true)}><Menu size={21}/></button><span>Outreach</span><span aria-hidden="true">/</span><strong>{activeLabel}</strong></div><div className="sdr-workspace-account">{notifications}<div className="sdr-account-name"><strong>{user.display_name}</strong><span>{user.role==='admin'?'Administrator':'Sales representative'}</span></div><button className="sdr-switch-user" onClick={onSignOut} title="Switch user" aria-label="Switch user"><LogOut size={17} aria-hidden="true"/><span>Switch user</span></button></div></header>
      <div className="sdr-workspace-content">{children}</div>
    </div>
  </div>;
}
