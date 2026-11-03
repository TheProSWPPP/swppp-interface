// Sending-volume watch: one alert when a mailbox's daily sends fall below half its recent
// average, or when it has sent nothing by noon on a sending day (Derek, 2026-11-02 call:
// volume "dips then stops" and nobody notices for days).
//
// Count: emails Apollo reports as sent (sdr_message_facts out + completed, follow-ups
// included) per mailbox and Chicago day. If message facts are not being collected
// (SDR_REPORTING_INGEST_ENABLED off or empty) it falls back to new enrollments from
// sdr_sends and says so in the alert. Baseline: mean of the 7 previous sending days
// (weekdays unless SDR_VOLUME_INCLUDE_WEEKENDS=true). Read only; never changes sending.
import { canonicalMailbox } from './mailboxAliases.js';
import { dailyCap, rampDay, mailboxBounceHealth, RAMP_TARGET } from './sendRamp.js';

export const VOLUME_TZ = 'America/Chicago';
export const BASELINE_DAYS = 7;
export const MIN_BASELINE = 5;
export const DIP_RATIO = 0.5;
export const STALL_HOUR = 12;
export const RAMP_GRACE_DAYS = 7;
export const FACTS_STALE_MS = 6 * 3600 * 1000;

export const chicagoDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: VOLUME_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
const chicagoHour = date => Number(new Intl.DateTimeFormat('en-US', { timeZone: VOLUME_TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date(date)));
export const addDays = (day, n) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const isWeekend = day => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

export function parseSkipDates(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v));
}

const eligible = (day, { includeWeekends, skipDates }) => (includeWeekends || !isWeekend(day)) && !skipDates.includes(day);

// The `count` previous sending days strictly before `day`.
export function previousSendingDays(day, { includeWeekends = false, skipDates = [], count = BASELINE_DAYS } = {}) {
  const days = [];
  for (let d = addDays(day, -1), guard = 0; days.length < count && guard < 60; d = addDays(d, -1), guard++)
    if (eligible(d, { includeWeekends, skipDates })) days.push(d);
  return days;
}

// rows: one mailbox's [{day, sent, first_touches}]. Missing days count as zero.
export function baselineFor(rows, { day, includeWeekends = false, skipDates = [], key = 'sent' } = {}) {
  const days = previousSendingDays(day, { includeWeekends, skipDates });
  const byDay = new Map(rows.map(r => [r.day, Number(r[key]) || 0]));
  const total = days.reduce((sum, d) => sum + (byDay.get(d) || 0), 0);
  return { mean: days.length ? total / days.length : 0, days };
}

// Fold mailbox aliases (admin@ -> mf@) and sum per canonical mailbox and day.
export function foldRows(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const mailbox = canonicalMailbox(row.mailbox_email ?? row.mailbox);
    const key = `${mailbox}|${row.day}`;
    const cur = out.get(key) || { mailbox, day: row.day, sent: 0, first_touches: 0, followups: 0, last_sent_at: null };
    cur.sent += Number(row.sent) || 0;
    cur.first_touches += Number(row.first_touches) || 0;
    cur.followups += Number(row.followups) || 0;
    const last = row.last_sent_at ? new Date(row.last_sent_at) : null;
    if (last && (!cur.last_sent_at || last > cur.last_sent_at)) cur.last_sent_at = last;
    out.set(key, cur);
  }
  return [...out.values()];
}

// Pure. mailboxes: [{email, active, warmup_status, warmup_started_at, ...}]; capFor(mailbox) ->
// today's daily cap (or null); healthFor(mailbox) -> bounce health evidence.
export function evaluateVolume({ rows, mailboxes, now = new Date(), includeWeekends = false, skipDates = [], basis = 'facts',
  capFor = () => null, healthFor = () => null } = {}) {
  const today = chicagoDay(now);
  const options = { includeWeekends, skipDates };
  let evalDay = addDays(today, -1);
  for (let guard = 0; !eligible(evalDay, options) && guard < 30; guard++) evalDay = addDays(evalDay, -1);
  const folded = foldRows(rows);
  const alerts = [], seen = new Set();
  for (const mailbox of mailboxes || []) {
    const email = canonicalMailbox(mailbox.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (mailbox.active === false || ['paused', 'disabled'].includes(mailbox.warmup_status)) continue;
    // A mailbox in its first ramp week has no meaningful average yet.
    if (rampDay(mailbox.warmup_started_at, +now) <= RAMP_GRACE_DAYS) continue;
    const own = folded.filter(r => r.mailbox === email);
    const byDay = new Map(own.map(r => [r.day, r]));
    const lastSentAt = own.reduce((max, r) => (r.last_sent_at && (!max || r.last_sent_at > max) ? r.last_sent_at : max), null);
    const cap = capFor(mailbox);
    const check = (day, kind) => {
      const base = baselineFor(own, { day, ...options });
      const firstTouchBase = baselineFor(own, { day, ...options, key: 'first_touches' });
      const row = byDay.get(day);
      const sent = row?.sent || 0;
      // An intentional cap below half the usual first touches explains the drop (cap is counted at enrollment).
      const capLowered = Number.isFinite(cap) && cap < DIP_RATIO * firstTouchBase.mean;
      alerts.push({ mailbox: email, day, kind: capLowered ? 'cap_lowered' : kind, sent, baseline: Math.round(base.mean * 100) / 100,
        evidence: { basis, detected_as: kind, baseline_days: base.days, first_touches: row?.first_touches || 0, followups: row?.followups || 0,
          first_touch_baseline: Math.round(firstTouchBase.mean * 100) / 100, cap: Number.isFinite(cap) ? cap : null,
          bounce: healthFor(mailbox) || null, last_sent_at: lastSentAt ? lastSentAt.toISOString() : null } });
    };
    const dipBase = baselineFor(own, { day: evalDay, ...options }).mean;
    if (dipBase >= MIN_BASELINE && (byDay.get(evalDay)?.sent || 0) < DIP_RATIO * dipBase) check(evalDay, 'volume_dip');
    if (eligible(today, options) && chicagoHour(now) >= STALL_HOUR && !(byDay.get(today)?.sent)
      && baselineFor(own, { day: today, ...options }).mean >= MIN_BASELINE) check(today, 'stalled_today');
  }
  return alerts;
}

async function tableAvailable(db, name) {
  return Boolean((await db.query('SELECT to_regclass($1) AS name', [name])).rows[0]?.name);
}

// Per mailbox and Chicago day for the last `days` days. basis 'facts' (every email Apollo
// sent) when message facts are collected, else 'enrollments' (first touches only).
export async function dailySentByMailbox(db, { now = new Date(), days = 21, env = process.env } = {}) {
  const since = addDays(chicagoDay(now), -days);
  if (env.SDR_REPORTING_INGEST_ENABLED === 'true' && await tableAvailable(db, 'sdr_reporting_messages')) {
    const { rows } = await db.query(`SELECT mailbox_email, to_char(occurred_at AT TIME ZONE $2,'YYYY-MM-DD') AS day,
        count(*)::int AS sent, count(*) FILTER (WHERE sequence_step=1)::int AS first_touches,
        count(*) FILTER (WHERE sequence_step>1)::int AS followups, max(occurred_at) AS last_sent_at
      FROM sdr_reporting_messages WHERE direction='out' AND provider_status='completed' AND occurred_at IS NOT NULL
        AND occurred_at >= ($1::date::timestamp AT TIME ZONE $2) GROUP BY 1,2`, [since, VOLUME_TZ]);
    if (rows.length) return { basis: 'facts', rows };
  }
  const { rows } = await db.query(`SELECT mb.email AS mailbox_email, to_char(s.sent_at AT TIME ZONE $2,'YYYY-MM-DD') AS day,
      count(*)::int AS sent, count(*)::int AS first_touches, 0 AS followups, max(s.sent_at) AS last_sent_at
    FROM sdr_sends s JOIN sdr_mailboxes mb ON mb.id=s.mailbox_id
    WHERE s.status<>'failed' AND s.sent_at >= ($1::date::timestamp AT TIME ZONE $2) GROUP BY 1,2`, [since, VOLUME_TZ]);
  return { basis: 'enrollments', rows };
}

// The Apollo poll writes the facts. If it has run lately but not completed in 6 hours, a
// dip may be missing data, not missing email: report it and alert nothing.
export async function factsStale(db, { now = new Date() } = {}) {
  if (!await tableAvailable(db, 'sdr_job_runs')) return false;
  const row = (await db.query(`SELECT count(*)::int AS n, max(finished_at) FILTER (WHERE status='complete') AS last_complete
    FROM sdr_job_runs WHERE job='apollo_poll' AND started_at > $1::timestamptz - INTERVAL '2 days'`, [now])).rows[0];
  if (!row?.n) return false;
  return !row.last_complete || +now - +new Date(row.last_complete) > FACTS_STALE_MS;
}

const dayLabel = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const timeLabel = iso => iso ? new Date(iso).toLocaleString('en-US', { timeZone: VOLUME_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'none in the last 3 weeks';

// Plain-English notification text. The marker line lets anyone find the alert row.
export function volumeAlertText(alert) {
  const e = alert.evidence || {};
  const plural = n => `${n} email${n === 1 ? '' : 's'}`;
  const period = (e.baseline_days?.length || BASELINE_DAYS) === BASELINE_DAYS ? `previous ${BASELINE_DAYS} sending days` : 'previous sending days';
  const basis = e.basis === 'facts' ? 'Counted from emails Apollo reports as sent, follow-ups included.'
    : 'Counted from new sequence enrollments only, because the Apollo message sync is off.';
  const head = alert.kind === 'stalled_today'
    ? `${alert.mailbox} has sent no emails today (${dayLabel(alert.day)}) as of noon Chicago time. It usually sends about ${Number(alert.baseline).toFixed(1)} a day (average of the ${period}).`
    : `${alert.mailbox} sent ${plural(alert.sent)} on ${dayLabel(alert.day)}. The average over the ${period} was ${Number(alert.baseline).toFixed(1)} a day.`;
  const lines = [head, '',
    `Daily cap today: ${e.cap ?? 'unknown'}. First emails: ${e.first_touches ?? 0}. Follow-ups: ${e.followups ?? 0}.`,
    `Last send seen: ${timeLabel(e.last_sent_at)} (Chicago time).`,
    ...(e.bounce?.sent ? [`Bounces in the last 14 days: ${e.bounce.bounced} of ${e.bounce.sent} projects.`] : []),
    basis, '',
    'Please check this mailbox in Apollo: sending schedule, hourly limit, minimum gap between emails, and account health.',
    `[SDR volume alert ${alert.id}]`];
  return { subject: alert.kind === 'stalled_today' ? `No emails sent yet today: ${alert.mailbox}` : `Sending volume dropped: ${alert.mailbox}`, bodyText: lines.join('\n') };
}

// Sends from a connected mailbox that is not the one being reported on.
export function createVolumeAlertNotifier({ pool, gmail, getToken, to = [], notifyOwner = false }) {
  return async alert => {
    const recipients = new Set(to.map(v => String(v).trim().toLowerCase()).filter(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)));
    if (notifyOwner) {
      const route = (await pool.query('SELECT forward_to FROM sdr_reply_routes WHERE mailbox_email=$1 AND active AND verified_at IS NOT NULL', [alert.mailbox_email || alert.mailbox])).rows[0];
      if (route?.forward_to) recipients.add(String(route.forward_to).toLowerCase());
    }
    if (!recipients.size) throw Object.assign(new Error('volume_alert_recipients_missing'), { permanent: true });
    const mailbox = canonicalMailbox(alert.mailbox_email || alert.mailbox);
    const sender = (await pool.query(`SELECT mailbox_email FROM sdr_inbox_accounts WHERE refresh_token IS NOT NULL
      AND lower(mailbox_email)<>$1 ORDER BY mailbox_email LIMIT 1`, [mailbox])).rows[0]?.mailbox_email;
    if (!sender) throw Object.assign(new Error('volume_alert_sender_missing'), { permanent: true });
    const text = volumeAlertText({ ...alert, mailbox });
    const token = await getToken(sender);
    return gmail.sendMail(token, { from: sender, to: [...recipients], ...text, messageId: `<sdr-volume-${alert.id}@proswppp.co>` });
  };
}

export async function runVolumeWatch(pool, { now = new Date(), notify = null, env = process.env } = {}) {
  if (!await tableAvailable(pool, 'sdr_volume_alerts')) return { skipped: 'schema_missing' };
  const includeWeekends = env.SDR_VOLUME_INCLUDE_WEEKENDS === 'true';
  const skipDates = parseSkipDates(env.SDR_VOLUME_ALERT_SKIP_DATES);
  const { basis, rows } = await dailySentByMailbox(pool, { now, env });
  if (basis === 'facts' && await factsStale(pool, { now })) return { coverage: 'partial', counts: { facts_stale: 1 } };
  const mailboxes = (await pool.query('SELECT id, email, active, warmup_status, warmup_started_at, daily_send_limit FROM sdr_mailboxes')).rows;
  const health = await mailboxBounceHealth(pool);
  const alerts = evaluateVolume({ rows, mailboxes, now, includeWeekends, skipDates, basis,
    capFor: m => dailyCap(m.warmup_started_at, { target: m.daily_send_limit ?? RAMP_TARGET, now: +now, health: health.get(m.id) }),
    healthFor: m => health.get(m.id) || null });
  let created = 0;
  for (const a of alerts) {
    const r = await pool.query(`INSERT INTO sdr_volume_alerts(mailbox_email,day,kind,sent,baseline,evidence) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(mailbox_email,day,kind) DO NOTHING`, [a.mailbox, a.day, a.kind, a.sent, a.baseline, JSON.stringify(a.evidence)]);
    created += r.rowCount || 0;
  }
  // A mailbox that started sending after a "nothing yet today" alert closes it.
  const today = chicagoDay(now);
  const sendingToday = foldRows(rows).filter(r => r.day === today && r.sent > 0).map(r => r.mailbox);
  if (sendingToday.length) await pool.query(`UPDATE sdr_volume_alerts SET resolved_at=$1 WHERE kind='stalled_today' AND day=$2
    AND resolved_at IS NULL AND mailbox_email=ANY($3::text[])`, [now, today, sendingToday]);
  let notified = 0, failed = 0, unnotified = 0;
  const due = (await pool.query(`SELECT id, mailbox_email, day::text AS day, kind, sent, baseline, evidence FROM sdr_volume_alerts WHERE notified_at IS NULL AND resolved_at IS NULL
    AND kind IN ('volume_dip','stalled_today') AND created_at > $1::timestamptz - INTERVAL '2 days' ORDER BY created_at, id`, [now])).rows;
  for (const row of due) {
    if (!notify) { unnotified++; continue; }
    // Claim first so two runs never send the same alert twice; release on failure.
    const claimed = await pool.query('UPDATE sdr_volume_alerts SET notified_at=$2 WHERE id=$1 AND notified_at IS NULL RETURNING id', [row.id, now]);
    if (!claimed.rowCount) continue;
    try { await notify({ ...row, mailbox: row.mailbox_email, baseline: Number(row.baseline) }); notified++; }
    catch { failed++; await pool.query('UPDATE sdr_volume_alerts SET notified_at=NULL WHERE id=$1', [row.id]); }
  }
  return { coverage: failed ? 'partial' : 'complete', counts: { mailboxes: mailboxes.length, alerts: alerts.length, created, notified, failed, unnotified,
    suppressed: alerts.filter(a => a.kind === 'cap_lowered').length, enrollment_basis: basis === 'enrollments' ? 1 : 0 } };
}
