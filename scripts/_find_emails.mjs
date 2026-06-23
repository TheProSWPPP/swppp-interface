// Find emails for the promoted permit operators via Apollo (company search ->
// domain -> people search -> reveal best contact). Stores to permit_operator_email.
// Only reveals (1 credit) for operators with a domain; skips already-probed.
// Env: APOLLO_API_KEY, DBURL (captured at launch so a Railway re-link can't break it).
import pg from "pg";
const KEY = process.env.APOLLO_API_KEY;
async function apollo(path, body) {
  const r = await fetch("https://api.apollo.io/v1" + path, { method: "POST",
    headers: { "X-Api-Key": KEY, "Content-Type": "application/json", "Cache-Control": "no-cache" }, body: JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; } return { status: r.status, j };
}
const real = (e) => e && !/not_unlocked|@domain\.com$/i.test(e) && /@/.test(e);

const pool = new pg.Pool({ connectionString: process.env.DBURL, ssl: { rejectUnauthorized: false } });
await pool.query(`CREATE TABLE IF NOT EXISTS permit_operator_email (
  operator_key TEXT PRIMARY KEY,
  operator_name TEXT,
  email TEXT,
  contact_name TEXT,
  title TEXT,
  domain TEXT,
  apollo_org_id TEXT,
  source TEXT DEFAULT 'apollo',
  probed_at TIMESTAMPTZ DEFAULT NOW()
)`);

const { rows } = await pool.query(`
  SELECT DISTINCT ON (f.operator_key) f.operator_key, f.operator_name
    FROM permit_facilities f
   WHERE f.status IN ('promoted','enriched') AND f.operator_name IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM permit_operator_email e WHERE e.operator_key = f.operator_key)
   ORDER BY f.operator_key, f.score DESC`);
console.log(`Probing ${rows.length} promoted operators for email...`);

let domains = 0, emails = 0;
for (let i = 0; i < rows.length; i++) {
  const op = rows[i];
  let domain = null, orgId = null, email = null, name = null, title = null;
  try {
    const co = await apollo("/mixed_companies/search", { q_organization_name: op.operator_name, page: 1, per_page: 1 });
    const org = (co.j.organizations || co.j.accounts || [])[0];
    domain = org?.primary_domain || null; orgId = org?.id || null;
    if (domain && orgId) {
      domains++;
      const ppl = await apollo("/mixed_people/search", { organization_ids: [orgId], page: 1, per_page: 10 });
      const people = ppl.j.people || [];
      const pick = people.find(p => /owner|president|principal|founder|manager|director|operations|environment|safety|compliance/i.test(p.title || "")) || people[0];
      if (pick) {
        const m = await apollo("/people/match", { first_name: pick.first_name, last_name: pick.last_name, domain, organization_name: op.operator_name, reveal_personal_emails: true });
        const e = m.j.person?.email;
        if (real(e)) { email = e; name = `${pick.first_name || ""} ${pick.last_name || ""}`.trim(); title = pick.title || null; emails++; }
      }
    }
  } catch (err) { /* skip on error */ }
  await pool.query(
    `INSERT INTO permit_operator_email (operator_key, operator_name, email, contact_name, title, domain, apollo_org_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (operator_key) DO UPDATE SET email=EXCLUDED.email, contact_name=EXCLUDED.contact_name,
       title=EXCLUDED.title, domain=EXCLUDED.domain, apollo_org_id=EXCLUDED.apollo_org_id, probed_at=NOW()`,
    [op.operator_key, op.operator_name, email, name, title, domain, orgId]);
  if ((i + 1) % 25 === 0 || i === rows.length - 1) console.log(`  ${i + 1}/${rows.length}  domains=${domains} emails=${emails}`);
  await new Promise(r => setTimeout(r, 350));
}
console.log(`DONE: ${rows.length} probed, ${domains} domains, ${emails} real emails stored.`);
await pool.end();
