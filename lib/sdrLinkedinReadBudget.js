const fail=code=>Object.assign(new Error(code),{code});
const dayInZone=(date,zone)=>{const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);const value=type=>parts.find(part=>part.type===type)?.value;return `${value('year')}-${value('month')}-${value('day')}`};
export async function chargeLinkedinRead({pool,companyId,accountId,now=new Date()}){
 if(!pool||!companyId||!accountId)throw fail('read_identity_unverified');
 const db=await pool.connect();
 try{await db.query('BEGIN');const account=(await db.query('SELECT read_budget,read_timezone,coverage FROM sdr_linkedin_accounts WHERE company_id=$1 AND account_id=$2 FOR UPDATE',[companyId,accountId])).rows[0];
  if(!account?.read_timezone)throw fail('read_identity_unverified');
  let day;try{day=dayInZone(new Date(now),account.read_timezone)}catch{throw fail('read_identity_unverified')}
  const used=account.coverage?.readBudgetDay===day?Number(account.coverage?.readUsed||0):0;
  if(!Number.isInteger(used)||used<0||!Number.isInteger(account.read_budget)||account.read_budget<=used)throw fail('read_budget_exhausted');
  await db.query(`UPDATE sdr_linkedin_accounts SET coverage=coverage||$3::jsonb WHERE company_id=$1 AND account_id=$2`,[companyId,accountId,JSON.stringify({readBudgetDay:day,readUsed:used+1})]);
  await db.query('COMMIT');return {day,used:used+1,remaining:account.read_budget-used-1};
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}finally{db.release()}
}
