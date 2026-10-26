// Relink stored Apollo outbound history to the project + source of our enrollment.
//
//   DATABASE_URL=... node tools/backfill-apollo-attribution.mjs --dry-run [--json]
//   DATABASE_URL=... node tools/backfill-apollo-attribution.mjs --apply
//
// --dry-run runs inside BEGIN READ ONLY and writes nothing. --apply writes in one
// transaction; re-running it changes nothing. Neither mode calls Apollo or Pipedrive.
// Won deals pick up their source at the next scheduled CRM sales sync (pipedrive_deals).
import pg from 'pg';
import { planAttributionBackfill, applyAttributionBackfill, summarizePlan, projectDealAttribution } from '../lib/apolloAttributionBackfill.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run'), apply = args.has('--apply');
if (dryRun === apply || !process.env.DATABASE_URL) {
  console.error('usage: DATABASE_URL=... node tools/backfill-apollo-attribution.mjs (--dry-run [--json] | --apply)');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query(dryRun ? 'BEGIN READ ONLY' : 'BEGIN');
  if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtext('apollo_attribution_backfill'))");
  const plan = await planAttributionBackfill(client);
  const summary = summarizePlan(plan);
  const deals = await projectDealAttribution(client, plan);
  let applied = null;
  if (apply) { applied = await applyAttributionBackfill(client, plan); await client.query('COMMIT'); }
  else await client.query('ROLLBACK');
  const report = { mode: dryRun ? 'dry-run (read only, nothing written)' : 'apply', ...summary, ...(applied ? { applied } : {}), deals };
  if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally { client.release(); await pool.end(); }

function printReport(r) {
  console.log(`Mode: ${r.mode}`);
  console.log(`Apollo outbound rows checked: ${r.factsRead}`);
  console.log(`Would link to a project: ${r.wouldLink} messages across ${r.projectsLinked} projects`);
  console.log(`Already linked, would gain a source: ${r.wouldFillSource}`);
  if (r.applied) console.log(`Applied: linked ${r.applied.linked}, source filled ${r.applied.sourced}`);
  console.log('\nMessages that would be linked, per sequence (source) and month (Chicago):');
  for (const [sequence, months] of Object.entries(r.bySequenceMonth).sort()) {
    console.log(`  ${sequence}: ${Object.entries(months).sort().map(([m, n]) => `${m} ${n}`).join(', ')}  (total ${Object.values(months).reduce((a, b) => a + b, 0)})`);
  }
  console.log('\nLinked or source-filled per source:', Object.entries(r.bySource).map(([k, n]) => `${k} ${n}`).join(', ') || 'none');
  console.log('Left as they are:', Object.entries(r.skipped).sort().map(([k, n]) => `${k} ${n}`).join(', ') || 'none');
  const d = r.deals;
  console.log(`\nWon deals with a CRM project link: ${d.wonDealsWithProjectLink}; attributed now: ${d.attributedBefore}; attributed after the next sales sync: ${d.attributedAfter}`);
  for (const deal of d.deals) {
    const change = deal.sourceBefore === deal.sourceAfter ? `stays ${deal.sourceAfter}` : `${deal.sourceBefore} -> ${deal.sourceAfter}`;
    const why = deal.sourceAfter !== 'unknown' ? '' : deal.heldDate ? ' (sale date under review)' : deal.knownSourcesBeforeSaleAfter > 1 ? ' (several sources before the sale)' : ' (no matched outreach before the sale)';
    console.log(`  deal ${deal.dealId} won ${deal.wonAt.slice(0, 10)} ${deal.value ?? '?'} ${deal.currency} "${deal.title || deal.leadId}": ${change}${why}`);
  }
  console.log(`\nOpen deals with a CRM project link: ${d.openDealsWithProjectLink}; would carry a source if won: ${d.openDealsWithSourceIfWonNow.length}`);
  for (const deal of d.openDealsWithSourceIfWonNow) console.log(`  open deal ${deal.dealId} ${deal.value ?? '?'} ${deal.currency} "${deal.title || deal.leadId}": ${deal.sourceAfter}`);
}
