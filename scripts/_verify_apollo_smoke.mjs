// scripts/_verify_apollo_smoke.mjs — costs ~1 Apollo credit per run (a people search).
// Usage: APOLLO_API_KEY=... node scripts/_verify_apollo_smoke.mjs <domain>
import * as apollo from "../lib/apolloClient.js";
const domain = process.argv[2] || "apollo.io";
const people = await apollo.searchPeopleByDomain(domain, { perPage: 5 });
console.log(`${domain}: ${people.length} people`);
for (const p of people) console.log(`  ${p.name} | ${p.title} | ${p.email}`);
