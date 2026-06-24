const {Client}=require("pg");
const CONN="postgresql://postgres:EQBDBavxyARYZGeafCVguWQuhUsmMMGb@switchback.proxy.rlwy.net:12018/railway";
(async()=>{
  const deadline=Date.now()+2.7*60*60*1000;
  while(Date.now()<deadline){
    try{
      const c=new Client({connectionString:CONN,ssl:{rejectUnauthorized:false}});await c.connect();
      const r=await c.query(`SELECT count(*) FILTER (WHERE status='emailed')::int emailed, count(*) FILTER (WHERE status='skipped')::int skipped FROM permit_outreach WHERE created_at > now() - interval '3 hours'`);
      const ps=await c.query(`SELECT count(*)::int n FROM permit_sends WHERE sent_at > now() - interval '3 hours'`);
      await c.end();
      if(r.rows[0].emailed>0 || ps.rows[0].n>0){
        console.log(`FIRST BATCH SENT: ${r.rows[0].emailed} emailed, ${r.rows[0].skipped} skipped (bad match), ${ps.rows[0].n} enrolled in Apollo`);
        process.exit(0);
      }
    }catch(e){}
    await new Promise(r=>setTimeout(r,180000));
  }
  console.log("no sends after 2.7h - check scheduler/Apollo");
})();
