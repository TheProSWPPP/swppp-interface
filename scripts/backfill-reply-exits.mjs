// One-time, after SDR_REPLY_EXIT_MODE=live: queue the exit_person action for human replies
// recorded before the exit was on (see backfillReplyExits in lib/replyExit.js), one per
// sender address. Default --dry-run prints the plan inside a READ ONLY transaction and
// writes nothing. --apply queues the actions; the running reply-action drain then exits each
// person. Exits seen during a dry-run window are re-run automatically and need no backfill.
//   DATABASE_URL=... node scripts/backfill-reply-exits.mjs [--dry-run|--apply] [--days=30]
import pg from 'pg';
import { backfillReplyExits } from '../lib/replyExit.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
if (apply && args.includes('--dry-run')) throw new Error('choose --dry-run or --apply');
const days = Number((args.find(a => a.startsWith('--days=')) || '--days=30').slice(7));
if (!Number.isInteger(days) || days < 1 || days > 180) throw new Error('--days must be 1..180');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const client = await pool.connect();
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    const result = await backfillReplyExits(client, { days, dryRun: !apply });
    await client.query('COMMIT');
    if (result.skipped) console.log(`Nothing done: ${result.skipped} (apply migrations/2026-11-03-sdr-reply-exit.sql first).`);
    console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${result.count} sender address${result.count === 1 ? '' : 'es'} with a human reply in the last ${days} days and no exit yet`);
    for (const p of result.planned) console.log([new Date(p.receivedAt).toISOString().slice(0, 16), p.mailbox, p.fromEmail, p.leadId ? `lead ${p.leadId}` : 'no single project', apply ? (p.inserted ? 'queued' : 'already queued') : ''].join('  '));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
} finally { await pool.end(); }
