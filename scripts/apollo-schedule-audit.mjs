// READ ONLY: what sending schedule each Apollo sequence uses, and each sending mailbox's
// limits, before changing them in the Apollo UI (send 6:30-8:30 and 16:00-17:30 recipient
// local time). The repo never sets a schedule; this learns the real field names and values.
// Only search/GET calls: no sequence, schedule, contact or mailbox is changed.
//   APOLLO_API_KEY=... node scripts/apollo-schedule-audit.mjs [--json]
import { searchSequences, getSequenceDetail, listEmailAccounts } from '../lib/apolloClient.js';

if (!process.env.APOLLO_API_KEY) { console.error('APOLLO_API_KEY is required (read-only use).'); process.exit(1); }
const SEQUENCE_KEYS = /schedule|time.?zone|send.?window|mark_finished|business_hours|days_of_week/i;
const MAILBOX_KEYS = /limit|per_hour|hourly|gap|interval|delay|throttle|schedule|time.?zone|active|email$/i;

// Every key path (depth <= 3) whose name matches, with its value.
function matchingFields(value, pattern, prefix = '', depth = 0, out = {}) {
  if (!value || typeof value !== 'object' || depth > 3) return out;
  for (const [key, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (pattern.test(key) && (v === null || typeof v !== 'object' || Array.isArray(v))) out[path] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) matchingFields(v, pattern, path, depth + 1, out);
    else if (pattern.test(key)) out[path] = v;
  }
  return out;
}

const sequences = [];
for (let page = 1; page <= 20; page++) {
  const res = await searchSequences({ page, perPage: 50 });
  const rows = res?.emailer_campaigns || [];
  for (const row of rows) sequences.push(row);
  const total = res?.pagination?.total_pages;
  if ((Number.isInteger(total) && page >= total) || rows.length < 50) break;
}
const report = { read_at: new Date().toISOString(), sequences: [], mailboxes: [] };
for (const row of sequences) {
  let detail = null, error = null;
  try { detail = await getSequenceDetail(row.id); } catch (e) { error = e.status || 'read_failed'; }
  const campaign = detail?.emailer_campaign || detail || {};
  report.sequences.push({ id: row.id, name: row.name, active: row.active ?? null,
    fields: { ...matchingFields(row, SEQUENCE_KEYS), ...matchingFields(campaign, SEQUENCE_KEYS) },
    schedule_objects: Object.keys(detail || {}).filter(k => SEQUENCE_KEYS.test(k)), error });
}
for (const account of await listEmailAccounts()) {
  report.mailboxes.push({ id: account.id, email: account.email, fields: matchingFields(account, MAILBOX_KEYS) });
}
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Read ${report.sequences.length} sequences and ${report.mailboxes.length} mailboxes at ${report.read_at}. Nothing was changed.\n`);
  for (const s of report.sequences) {
    console.log(`${s.active ? 'ACTIVE  ' : 'inactive'} ${s.id}  ${s.name}${s.error ? `  (detail read failed: ${s.error})` : ''}`);
    for (const [k, v] of Object.entries(s.fields)) console.log(`           ${k}: ${JSON.stringify(v)}`);
    if (s.schedule_objects.length) console.log(`           detail objects: ${s.schedule_objects.join(', ')}`);
  }
  console.log('\nMailboxes:');
  for (const m of report.mailboxes) {
    console.log(`  ${m.email} (${m.id})`);
    for (const [k, v] of Object.entries(m.fields)) console.log(`           ${k}: ${JSON.stringify(v)}`);
  }
}
