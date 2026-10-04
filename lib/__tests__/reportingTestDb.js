import pg from 'pg';
// Integration tests own a separate schema per file/process and refuse remote databases.
export function reportingTestDb(name) {
  const connectionString=process.env.SDR_TEST_DATABASE_URL;
  if(!connectionString) return null;
  const url=new URL(connectionString);
  const host=url.searchParams.get('host')||url.hostname;
  if(!['localhost','127.0.0.1','::1'].includes(host) && !host.startsWith('/tmp/')) throw new Error('SDR_TEST_DATABASE_URL must target an isolated local database');
  const schema=`sdr_test_${name}_${process.pid}`;
  const pool=new pg.Pool({connectionString,options:`-c search_path=${schema}`});
  return {pool,async setup() {await pool.query(`CREATE SCHEMA ${schema}`);},async close() {await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();}};
}
