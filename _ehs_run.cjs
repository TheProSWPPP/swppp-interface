const { Client } = require("pg");
const DBURL = "postgresql://postgres:EQBDBavxyARYZGeafCVguWQuhUsmMMGb@switchback.proxy.rlwy.net:12018/railway";
const APOLLO = "bl7X4VR27185B7UrFBBg_Q";
const TITLES = ["EHS Manager","EH&S Manager","Environmental Health and Safety","Environmental Manager",
  "Environmental Compliance","Environmental Specialist","Safety Manager","Safety Director",
  "HSE Manager","Director of Environmental Health and Safety","Compliance Manager","Environmental Coordinator"];
async function ap(path, body){
  const r=await fetch("https://api.apollo.io/v1"+path,{method:"POST",
    headers:{"X-Api-Key":APOLLO,"Content-Type":"application/json","Cache-Control":"no-cache"},body:JSON.stringify(body)});
  const t=await r.text();let d;try{d=JSON.parse(t)}catch{d={raw:t}}
  if(!r.ok){const e=new Error(`${path} ${r.status}: ${(d.error||d.message||t).toString().slice(0,120)}`);e.status=r.status;throw e;}
  return d;
}
const real=(e)=>e&&!/email_not_unlocked|domain\.com$/i.test(e)&&/@/.test(e);
const tokens=(s)=>(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").split(/\s+/).filter(w=>w.length>3&&!["inc","llc","corp","company","the","of","ltd","texas","city"].includes(w));
const orgMatch=(op,org)=>{const a=new Set(tokens(op)),b=tokens(org);return b.some(w=>a.has(w));};
const isQuota=(e)=>e.status===402||e.status===429||/credit|quota|exhaust|limit reached|insufficient/i.test(e.message);
const sleep=(ms)=>new Promise(z=>setTimeout(z,ms));

async function newPool(){const c=new Client({connectionString:DBURL,ssl:{rejectUnauthorized:false}});await c.connect();return c;}

(async()=>{
  let c=await newPool();
  await c.query(`ALTER TABLE permit_operator_email ADD COLUMN IF NOT EXISTS fallback_email text`);
  await c.query(`ALTER TABLE permit_operator_email ADD COLUMN IF NOT EXISTS ehs_checked_at timestamptz`);
  const tot=await c.query(`SELECT count(*)::int n FROM permit_operator_email WHERE domain<>'' AND ehs_checked_at IS NULL`);
  console.log(`[start] ${tot.rows[0].n} operators to probe`);
  let good=0,personNoEmail=0,noPerson=0,reject=0,err=0,done=0;
  const t0=Date.now();
  while(true){
    let batch;
    try{
      batch=await c.query(`
        SELECT em.operator_key,em.operator_name,em.domain,COALESCE(o.facility_count,0) fc
        FROM permit_operator_email em LEFT JOIN permit_operators o ON o.operator_key=em.operator_key
        WHERE em.domain<>'' AND em.ehs_checked_at IS NULL
        ORDER BY o.facility_count DESC NULLS LAST LIMIT 40`);
    }catch(e){console.log("[reconnect-select]",e.message);try{await c.end()}catch{}; c=await newPool(); continue;}
    if(!batch.rows.length)break;
    for(const op of batch.rows){
      let verdict="",email=null,name=null,title=null;
      try{
        const s=await ap("/mixed_people/search",{person_titles:TITLES,q_organization_domains:op.domain,page:1,per_page:5});
        const people=s.people||s.contacts||[];
        if(!people.length){verdict="no_person";}
        else{
          const p=people[0];
          const orgOk=orgMatch(op.operator_name,p.organization?.name)||(p.organization?.primary_domain||"").toLowerCase()===op.domain.toLowerCase();
          const usOk=!p.country||/united states|usa|^us$/i.test(p.country);
          if(!orgOk||!usOk){verdict="reject";}
          else{
            name=`${p.first_name||""} ${p.last_name||""}`.trim(); title=(p.title||"").slice(0,120);
            email=real(p.email)?p.email:null;
            if(!email){
              const m=await ap("/people/match",{first_name:p.first_name,last_name:p.last_name,domain:op.domain,organization_name:op.operator_name,reveal_personal_emails:false});
              if(real(m.person?.email))email=m.person.email;
            }
            verdict=email?"good":"person_no_email";
          }
        }
      }catch(e){
        if(isQuota(e)){console.log(`\n[ABORT] Apollo quota/limit hit: ${e.message}\nResuming later will continue from here.`);await c.end();
          console.log(`\n=== PARTIAL: good=${good} personNoEmail=${personNoEmail} noPerson=${noPerson} reject=${reject} err=${err} done=${done} ===`);process.exit(2);}
        err++; console.log("  err",op.operator_name.slice(0,30),e.message.slice(0,60)); await sleep(800); continue; // leave checked=NULL to retry
      }
      // persist
      try{
        if(verdict==="good"){
          await c.query(`UPDATE permit_operator_email
             SET fallback_email=CASE WHEN source<>'apollo_ehs' AND fallback_email IS NULL THEN email ELSE fallback_email END,
                 email=$2,contact_name=$3,title=$4,source='apollo_ehs',ehs_checked_at=now()
             WHERE operator_key=$1`,[op.operator_key,email,name,title]);
          good++;
        }else{
          await c.query(`UPDATE permit_operator_email SET ehs_checked_at=now() WHERE operator_key=$1`,[op.operator_key]);
          if(verdict==="person_no_email")personNoEmail++; else if(verdict==="no_person")noPerson++; else reject++;
        }
      }catch(e){console.log("[reconnect-write]",e.message);try{await c.end()}catch{}; c=await newPool();}
      done++;
      if(done%50===0){const el=((Date.now()-t0)/60000).toFixed(1);console.log(`[${done}] good=${good} noEmail=${personNoEmail} noPerson=${noPerson} reject=${reject} err=${err} (${el}m)`);}
      await sleep(300);
    }
  }
  await c.end();
  console.log(`\n=== DONE good=${good} personNoEmail=${personNoEmail} noPerson=${noPerson} reject=${reject} err=${err} done=${done} ===`);
})().catch(e=>{console.error("FATAL",e.message);process.exit(1);});
