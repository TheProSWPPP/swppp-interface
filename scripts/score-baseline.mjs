// Snapshot every lead's current score before the scoring rebalance.
// Pipedrive keeps no field history, so without this a bad rebalance cannot be undone.
//
// Usage: node scripts/score-baseline.mjs [outfile]
import fs from "fs";
const T = process.env.PIPEDRIVE_API_TOKEN || "3089d0ffb03a7f996c5f10156fd4ebfaad9fca28";
const SCORE = "e2b854536230112bff77d6b0ce33bdb49f2916eb";
const STAGE = "7c1852c27664d1118f75660223a6af9e99d10f2c";
const ORIGIN = "6abd1d3e43212a7baf864cd4d2a210add6a96f60";
const PVALUE = "750d7ed67136d20d11679c7b7923704663d84a56";

let start = 0, all = [], p = 0;
while (p < 60) {
  const j = await (await fetch(`https://api.pipedrive.com/v1/leads?api_token=${T}&start=${start}&limit=500`)).json();
  if (!j.data?.length) break;
  all.push(...j.data);
  if (!j.additional_data?.pagination?.more_items_in_collection) break;
  start = j.additional_data.pagination.next_start; p++;
}

const rows = all.map((l) => ({
  id: l.id,
  score: l[SCORE] ?? null,
  stage: l[STAGE] ?? null,
  origin: l[ORIGIN] ?? null,
  value: l[PVALUE] ?? null,
}));
const out = process.argv[2] || "goal-runs/2026-08-03-lead-value-scoring/baseline-scores.json";
fs.writeFileSync(out, JSON.stringify(rows));

const nums = rows.map((r) => Number(r.score)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
console.log(`saved ${rows.length} leads to ${out}`);
console.log(`min ${nums[0]}  median ${nums[nums.length >> 1]}  max ${nums[nums.length - 1]}  negative ${nums.filter((n) => n < 0).length}`);
const byStage = {};
for (const r of rows) {
  const k = r.stage || "(none)";
  (byStage[k] = byStage[k] || []).push(Number(r.score) || 0);
}
console.log("\nstage       n      avg    negative");
Object.entries(byStage).sort((a, b) => b[1].length - a[1].length).slice(0, 8).forEach(([k, v]) => {
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const neg = Math.round((100 * v.filter((x) => x < 0).length) / v.length);
  console.log(`${k.padEnd(10)} ${String(v.length).padStart(5)}  ${avg.toFixed(1).padStart(7)}   ${String(neg).padStart(3)}%`);
});
