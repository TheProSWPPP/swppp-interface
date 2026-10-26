// One-time: queue the missing "Reply received" tasks for human replies that never got one
// (see backfillMissingReplyTasks in lib/sdrReplyActions.js). Default is --dry-run: it prints
// the plan and writes nothing. Pass --apply to queue the tasks; the running reply-action
// drain then creates them in Pipedrive after re-checking each live thread. Safe to rerun.
//   DATABASE_URL=... node scripts/backfill-reply-tasks.mjs [--dry-run|--apply] [--days=14]
import pg from 'pg';
import { backfillMissingReplyTasks } from '../lib/sdrReplyActions.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
if (apply && args.includes('--dry-run')) throw new Error('choose --dry-run or --apply');
const days = Number((args.find(a => a.startsWith('--days=')) || '--days=14').slice(7));
if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('--days must be 1..60');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const client = await pool.connect();
  try {
    // A dry run cannot write even by mistake.
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    const result = await backfillMissingReplyTasks(client, { days, dryRun: !apply });
    await client.query('COMMIT');
    console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${result.count} human repl${result.count === 1 ? 'y' : 'ies'} without a task in the last ${days} days`);
    for (const p of result.planned) {
      console.log([new Date(p.receivedAt).toISOString().slice(0, 16), p.mailbox, p.leadId ? `"${p.project || '?'}" (lead ${p.leadId})` : `no single project (${p.linkStatus}${p.candidates ? `: ${p.candidates}` : ''})`,
        `intent ${p.intent}`, `task target ${p.target}`, p.assignee ? `assignee ${p.assignee}` : `held: ${p.review}`, apply ? `queued ${p.inserted}` : 'would queue'].join(' | '));
    }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
} finally { await pool.end(); }
