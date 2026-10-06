import pg from 'pg';
import {fetchSalesHistory,storeSalesHistory} from '../lib/pipedriveSalesHistory.js';
// Explicit environment selects the reporting database. No provider writes occur.
if(!process.env.DATABASE_URL||!process.env.PIPEDRIVE_API_TOKEN)throw Error('DATABASE_URL and PIPEDRIVE_API_TOKEN are required');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{const result=await storeSalesHistory(pool,await fetchSalesHistory({apiToken:process.env.PIPEDRIVE_API_TOKEN}));const {date_adjustments,...summary}=result;console.log(JSON.stringify({...summary,reconstructed_dates:date_adjustments.length}));}finally{await pool.end();}
