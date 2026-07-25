const fs=require('fs');const {Client}=require('pg');
(async()=>{
  const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:false});
  await c.connect();
  // columns of permit_sends
  const cols=await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='permit_sends' ORDER BY ordinal_position`);
  console.log('permit_sends cols:', cols.rows.map(r=>r.column_name).join(', '));
  // recent activity
  const q=await c.query(`SELECT to_char(created_at,'YYYY-MM-DD') d, COUNT(*) n FROM permit_sends GROUP BY 1 ORDER BY 1 DESC LIMIT 12`).catch(e=>({rows:[],err:e.message}));
  console.log('\npermit_sends by day (recent):'); q.rows.forEach(r=>console.log(' ',r.d,r.n)); if(q.err)console.log('  ERR',q.err);
  const tot=await c.query(`SELECT COUNT(*) n, MIN(created_at) f, MAX(created_at) l FROM permit_sends`).catch(e=>({rows:[{}]}));
  console.log('\npermit_sends total:',tot.rows[0].n,'| first:',tot.rows[0].f,'| last:',tot.rows[0].l);
  // permit_outreach: interface-origin (non-brevo notes) recent
  const io=await c.query(`SELECT to_char(created_at,'YYYY-MM-DD') d, COUNT(*) n FROM permit_outreach WHERE note NOT ILIKE 'brevo%' OR note IS NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 10`).catch(e=>({rows:[],err:e.message}));
  console.log('\npermit_outreach NON-brevo rows by day:'); io.rows.forEach(r=>console.log(' ',r.d,r.n)); if(io.err)console.log('  ERR',io.err);
  await c.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
