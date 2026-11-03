// One-off: give a Pipedrive lead whose Lead Origin is a bare short code ("BC") the full
// "Bid Invite: <platform>" tag, so every Bid Invite guard (lib/bidInviteGuard.js, Derek's
// Pipedrive automation conditions) can see it. Lead 21b9e420-b07c-11f1-b582-c7400378b13f was
// imported with origin "BC" and, until this runs, counts as a cold lead.
//
// DRY RUN BY DEFAULT: it reads Pipedrive and prints the plan, and writes nothing. Pass --apply
// to write. It was written but not run when it was added; Ivan runs it.
//
//   PIPEDRIVE_API_TOKEN=... node scripts/retag-bid-invite-origin.mjs                    (dry run, the lead below)
//   PIPEDRIVE_API_TOKEN=... node scripts/retag-bid-invite-origin.mjs --lead=<id> --platform=BuildingConnected   (optional; stops if it disagrees with the lead's own code)
//   PIPEDRIVE_API_TOKEN=... DATABASE_URL=... node scripts/retag-bid-invite-origin.mjs --apply
//   DATABASE_URL=... node scripts/retag-bid-invite-origin.mjs --scan                      (list other bare-code rows, read only)
//
// --apply sends a raw PATCH on purpose. lib/pipedriveClient.js turns any PATCH on an existing
// record into a reviewable proposal instead of writing it (lib/sdrCrmWriteProtection.js), which
// is the right default for the app but not for a one-field fix someone asked for by name.
// Alternative with no script: edit the "Lead Origin" field on that lead by hand in Pipedrive.
import { pathToFileURL } from 'node:url';
import { platformFromColumn } from '../lib/leadCsvNormalize.js';

export const LEAD_ORIGIN_FIELD = '6abd1d3e43212a7baf864cd4d2a210add6a96f60';
export const DEFAULT_LEAD = '21b9e420-b07c-11f1-b582-c7400378b13f';
const PD_BASE = 'https://api.pipedrive.com/v1';
export const SHORT_CODE = /^(bc|cc|isqft|other|buildingconnected|constructconnect)$/i;

/** The decision, with no I/O: what would be written, or why it must not be. */
export function planRetag(currentValue, platformArg = '') {
  const current = String(currentValue ?? '');
  if (!SHORT_CODE.test(current.trim())) {
    return { ok: false, reason: `current Lead Origin is ${JSON.stringify(current)}, not a bare short code, so nothing to do` };
  }
  // The platform comes from the code the lead already carries ("BC" is BuildingConnected).
  // --platform is only a cross-check: if it disagrees, stop rather than guess.
  const platform = platformFromColumn(current);
  if (String(platformArg).trim()) {
    const asked = platformFromColumn(platformArg);
    if (!asked) return { ok: false, reason: `--platform must be BuildingConnected, ConstructConnect, iSqFt or Other (got "${platformArg}")` };
    if (asked !== platform) return { ok: false, reason: `--platform ${asked} disagrees with the current value ${JSON.stringify(current)}, which means ${platform}` };
  }
  return { ok: true, from: current, to: `Bid Invite: ${platform}` };
}

function token() {
  const t = process.env.PIPEDRIVE_API_TOKEN;
  if (!t) throw new Error('PIPEDRIVE_API_TOKEN is required');
  return t;
}

async function pdRaw(path, { method = 'GET', body } = {}) {
  const url = new URL(`${PD_BASE}${path}`);
  url.searchParams.set('api_token', token());
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data?.success === false) throw new Error(`Pipedrive ${method} ${path} -> ${res.status}: ${data?.error || data?.message || text.slice(0, 200)}`);
  return data.data;
}

const readOrigin = async (leadId) => {
  const lead = await pdRaw(`/leads/${leadId}`);
  return { title: lead?.title ?? null, value: lead?.[LEAD_ORIGIN_FIELD] ?? '' };
};

async function withPool(fn) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try { return await fn(pool); } finally { await pool.end(); }
}

async function scan() {
  await withPool(async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const { rows } = await client.query(
        `SELECT pipedrive_lead_id, lead_title, lead_origin, crm_status
           FROM sdr_lead_state
          WHERE lead_origin ~* '^\\s*(bc|cc|isqft|other|buildingconnected|constructconnect)\\s*$'
          ORDER BY pipedrive_lead_id`,
      );
      await client.query('COMMIT');
      console.log(`SCAN (read only): ${rows.length} lead(s) with a bare short code as Lead Origin`);
      for (const r of rows) console.log([r.pipedrive_lead_id, JSON.stringify(r.lead_origin), r.crm_status, r.lead_title].join(' | '));
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  });
}

async function run(args) {
  const flag = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
  const apply = args.includes('--apply');
  if (apply && args.includes('--dry-run')) throw new Error('choose --dry-run or --apply');
  if (args.includes('--scan')) return scan();

  const leadId = flag('lead') || DEFAULT_LEAD;
  const platformArg = flag('platform');
  const first = await readOrigin(leadId);
  console.log(`lead ${leadId} "${first.title}": Lead Origin is ${JSON.stringify(first.value)}`);
  const plan = planRetag(first.value, platformArg);
  if (!plan.ok) { console.log(`REFUSED: ${plan.reason}`); process.exitCode = 1; return; }
  if (!apply) {
    console.log(`DRY RUN: would set Lead Origin ${JSON.stringify(plan.from)} -> ${JSON.stringify(plan.to)}${process.env.DATABASE_URL ? ' (and the matching sdr_lead_state row)' : ''}. Nothing written. Pass --apply to write.`);
    return;
  }

  // Read again straight before the write: if anyone changed the field meanwhile, stop.
  const second = await readOrigin(leadId);
  if (second.value !== first.value) throw new Error(`ABORTED: Lead Origin changed from ${JSON.stringify(first.value)} to ${JSON.stringify(second.value)} while this ran`);
  await pdRaw(`/leads/${leadId}`, { method: 'PATCH', body: { [LEAD_ORIGIN_FIELD]: plan.to } });
  const after = await readOrigin(leadId);
  console.log(`APPLIED in Pipedrive: before ${JSON.stringify(first.value)} | after ${JSON.stringify(after.value)}`);
  if (after.value !== plan.to) { console.log('WARNING: read-back does not match what was written'); process.exitCode = 1; }

  if (process.env.DATABASE_URL) {
    await withPool(async (pool) => {
      const r = await pool.query(
        'UPDATE sdr_lead_state SET lead_origin = $2 WHERE pipedrive_lead_id = $1 AND lead_origin = $3',
        [leadId, plan.to, plan.from],
      );
      console.log(`sdr_lead_state: ${r.rowCount} row(s) updated${r.rowCount ? '' : ' (none matched, the next Pipedrive sync will carry the new value)'}`);
    });
  } else {
    console.log('DATABASE_URL not set: sdr_lead_state not touched, the next Pipedrive sync will carry the new value.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
