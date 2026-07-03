// scripts/_verify_pd_smoke.mjs — read-only-ish check of the new Pipedrive wrappers.
// Usage: PIPEDRIVE_API_TOKEN=... node scripts/_verify_pd_smoke.mjs <orgId>
import * as pd from "../lib/pipedriveClient.js";
const orgId = process.argv[2];
const persons = await pd.listOrgPersons(orgId);
console.log(`org ${orgId}: ${persons.length} persons`);
for (const p of persons.slice(0, 5)) {
  const primary = (p.email || []).find((e) => e.primary)?.value || (p.email?.[0]?.value ?? "—");
  console.log(`  #${p.id} ${p.name} <${primary}>`);
}
