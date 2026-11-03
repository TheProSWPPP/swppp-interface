// Sending-volume watch: one alert when a mailbox's daily sends fall below half its recent
// average, or when it has sent nothing by noon on a sending day (Derek, 2026-11-02 call:
// volume "dips then stops" and nobody notices for days).
//
// Count: emails Apollo reports as sent (sdr_message_facts out + completed, follow-ups
// included) per mailbox and Chicago day. If message facts are not being collected
// (SDR_REPORTING_INGEST_ENABLED off or empty) it falls back to new enrollments from
// sdr_sends and says so in the alert. Baseline: mean of the 7 previous sending days
// (weekdays unless SDR_VOLUME_INCLUDE_WEEKENDS=true). Read only; never changes sending.
import { createHash } from 'node:crypto';
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

// n-th (or last, n=-1) weekday of a month; weekday 0=Sunday.
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    return new Date(Date.UTC(year, month - 1, 1 + ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7)).toISOString().slice(0, 10);
  }
  const last = new Date(Date.UTC(year, month, 0));
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7))).toISOString().slice(0, 10);
}
const observedDay = day => { const w = new Date(`${day}T12:00:00Z`).getUTCDay(); return w === 6 ? addDays(day, -1) : w === 0 ? addDays(day, 1) : day; };

// Days US construction offices usually do not work. Not alerted on and left out of baselines.
export function usHolidays(year) {
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  return [observedDay(`${year}-01-01`), nthWeekday(year, 5, 1, -1), observedDay(`${year}-07-04`), nthWeekday(year, 9, 1, 1),
    thanksgiving, addDays(thanksgiving, 1), `${year}-12-24`, observedDay(`${year}-12-25`), `${year}-12-31`];
}

// SDR_VOLUME_ALERT_SKIP_DATES plus the built-in holidays (SDR_VOLUME_HOLIDAYS=off drops them).
export function volumeSkipDates(env = process.env, now = new Date()) {
  const year = Number(chicagoDay(now).slice(0, 4));
  const holidays = env.SDR_VOLUME_HOLIDAYS === 'off' ? [] : [year - 1, year, year + 1].flatMap(usHolidays);
  return [...new Set([...parseSkipDates(env.SDR_VOLUME_ALERT_SKIP_DATES), ...holidays])].sort();
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

// Freshness of the message facts. Judged by the newest outbound fact the poll has written or
// re-observed (observed_at), or by any finished poll run (complete or partial: resumable
// sweeps rarely finish 'complete'). Only when the poll has receipts and neither shows life
// in 6 hours is the data stale. With no receipts at all it cannot tell, so it does not mute.
export async function factsFreshness(db, { now = new Date() } = {}) {
  let lastObservedAt = null;
  if (await tableAvailable(db, 'sdr_reporting_messages')) {
    const at = (await db.query(`SELECT max(observed_at) AS at FROM sdr_reporting_messages WHERE direction='out'`)).rows[0]?.at;
    lastObservedAt = at ? new Date(at) : null;
  }
  if (lastObservedAt && +now - +lastObservedAt <= FACTS_STALE_MS) return { stale: false, lastObservedAt };
  if (!await tableAvailable(db, 'sdr_job_runs')) return { stale: false, lastObservedAt };
  const row = (await db.query(`SELECT count(*)::int AS n, max(finished_at) FILTER (WHERE status IN ('complete','partial')) AS last_done
    FROM sdr_job_runs WHERE job='apollo_poll' AND started_at > $1::timestamptz - INTERVAL '2 days'`, [now])).rows[0];
  if (!row?.n) return { stale: false, lastObservedAt };
  return { stale: !row.last_done || +now - +new Date(row.last_done) > FACTS_STALE_MS, lastObservedAt };
}
export async function factsStale(db, options) { return (await factsFreshness(db, options)).stale; }

const dayLabel = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const timeLabel = iso => iso ? new Date(iso).toLocaleString('en-US', { timeZone: VOLUME_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'none in the last 3 weeks';

// Plain-English text for one alert. The marker line lets anyone find the alert row.
export function volumeAlertText(alert) {
  const e = alert.evidence || {};
  const plural = n => `${n} email${n === 1 ? '' : 's'}`;
  const period = (e.baseline_days?.length || BASELINE_DAYS) === BASELINE_DAYS ? `previous ${BASELINE_DAYS} sending days` : 'previous sending days';
  const basis = e.basis === 'facts' ? 'Counted from emails Apollo reports as sent, follow-ups and bid invites included.'
    : 'Counted from new sequence enrollments only, because the Apollo message sync is off.';
  const head = alert.kind === 'stalled_today'
    ? `${alert.mailbox} has sent no emails today (${dayLabel(alert.day)}) as of noon Chicago time. It usually sends about ${Number(alert.baseline).toFixed(1)} a day (average of the ${period}).`
    : `${alert.mailbox} sent ${plural(alert.sent)} on ${dayLabel(alert.day)}. The average over the ${period} was ${Number(alert.baseline).toFixed(1)} a day.`;
  const lines = [head, '',
    `Daily cap today: ${e.cap ?? 'unknown'}. First emails: ${e.first_touches ?? 0}. Follow-ups: ${e.followups ?? 0}.`,
    `Last send seen: ${timeLabel(e.last_sent_at)} (Chicago time).`,
    ...(e.bounce?.sent ? [`Bounces in the last 14 days: ${e.bounce.bounced} of ${e.bounce.sent} projects.`] : []),
    ...(e.facts_observed_at ? [`Apollo message data last updated: ${timeLabel(e.facts_observed_at)} (Chicago time).`] : []),
    basis, '',
    'Please check this mailbox in Apollo: sending schedule, hourly limit, minimum gap between emails, and account health.',
    `[SDR volume alert ${alert.id}]`];
  return { subject: alert.kind === 'stalled_today' ? `No emails sent yet today: ${alert.mailbox}` : `Sending volume dropped: ${alert.mailbox}`, bodyText: lines.join('\n') };
}

// One email for every alert due in a run.
export function volumeDigestText(alerts) {
  if (alerts.length === 1) return volumeAlertText(alerts[0]);
  const mailboxes = new Set(alerts.map(a => a.mailbox));
  return { subject: `Sending volume alerts: ${mailboxes.size} mailbox${mailboxes.size === 1 ? '' : 'es'}`,
    bodyText: [`${alerts.length} sending volume alerts for ${[...mailboxes].join(', ')}.`, '', ...alerts.map(a => volumeAlertText(a).bodyText)].join('\n\n') };
}

const definiteRejection = error => {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || error?.code);
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408;
};

// Sends one digest from a connected mailbox that is none of the reported ones, falling back
// to the next one when a sender is unusable or Gmail rejected the message outright. If a send
// may have gone out (timeout, 5xx), it stops and returns 'uncertain' instead of trying another
// sender, so a digest is never sent twice; check() later settles it from the Sent folder.
export function createVolumeAlertNotifier({ pool, gmail, getToken, to = [], notifyOwner = false }) {
  const notify = async (alerts, { messageId }) => {
    const recipients = new Set(to.map(v => String(v).trim().toLowerCase()).filter(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)));
    const reported = [...new Set(alerts.map(a => canonicalMailbox(a.mailbox_email || a.mailbox)))];
    if (notifyOwner) {
      const routes = (await pool.query('SELECT forward_to FROM sdr_reply_routes WHERE mailbox_email=ANY($1::text[]) AND active AND verified_at IS NOT NULL', [reported])).rows;
      for (const route of routes) if (route?.forward_to) recipients.add(String(route.forward_to).toLowerCase());
    }
    if (!recipients.size) throw Object.assign(new Error('volume_alert_recipients_missing'), { permanent: true });
    const senders = (await pool.query(`SELECT mailbox_email FROM sdr_inbox_accounts WHERE refresh_token IS NOT NULL
      AND NOT (lower(mailbox_email)=ANY($1::text[])) ORDER BY mailbox_email`, [reported])).rows.map(r => r.mailbox_email);
    const text = volumeDigestText(alerts.map(a => ({ ...a, mailbox: canonicalMailbox(a.mailbox_email || a.mailbox) })));
    for (const sender of senders) {
      let token;
      try { token = await getToken(sender); } catch { continue; }
      try {
        const sent = await gmail.sendMail(token, { from: sender, to: [...recipients], ...text, messageId });
        return { state: 'sent', sender, providerId: sent?.id || null };
      } catch (error) {
        if (definiteRejection(error)) continue;
        return { state: 'uncertain', sender };
      }
    }
    throw Object.assign(new Error('volume_alert_sender_unavailable'), { definite: true });
  };
  // true: found in the sender's Sent folder; false: definitely absent; null: cannot tell.
  notify.check = async ({ sender, messageId }) => {
    try {
      const page = await gmail.listThreadPage(await getToken(sender), { query: `in:sent rfc822msgid:${messageId}`, maxResults: 5 });
      return Array.isArray(page?.threads) ? page.threads.length > 0 : null;
    } catch { return null; }
  };
  return notify;
}

// An uncertain digest is checked again after this long before it may be sent again.
export const UNCERTAIN_RECHECK_MS = 30 * 60 * 1000;

export async function runVolumeWatch(pool, { now = new Date(), notify = null, env = process.env } = {}) {
  if (!await tableAvailable(pool, 'sdr_volume_alerts')) return { skipped: 'schema_missing' };
  const includeWeekends = env.SDR_VOLUME_INCLUDE_WEEKENDS === 'true';
  const skipDates = volumeSkipDates(env, now);
  const { basis, rows } = await dailySentByMailbox(pool, { now, env });
  const freshness = basis === 'facts' ? await factsFreshness(pool, { now }) : { stale: false, lastObservedAt: null };
  if (freshness.stale) return { coverage: 'partial', counts: { facts_stale: 1 } };
  const mailboxes = (await pool.query('SELECT id, email, active, warmup_status, warmup_started_at, daily_send_limit FROM sdr_mailboxes')).rows;
  const health = await mailboxBounceHealth(pool);
  const alerts = evaluateVolume({ rows, mailboxes, now, includeWeekends, skipDates, basis,
    capFor: m => dailyCap(m.warmup_started_at, { target: m.daily_send_limit ?? RAMP_TARGET, now: +now, health: health.get(m.id) }),
    healthFor: m => health.get(m.id) || null });
  let created = 0;
  for (const a of alerts) {
    const evidence = { ...a.evidence, ...(freshness.lastObservedAt ? { facts_observed_at: freshness.lastObservedAt.toISOString() } : {}) };
    const r = await pool.query(`INSERT INTO sdr_volume_alerts(mailbox_email,day,kind,sent,baseline,evidence) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(mailbox_email,day,kind) DO NOTHING`, [a.mailbox, a.day, a.kind, a.sent, a.baseline, JSON.stringify(evidence)]);
    created += r.rowCount || 0;
  }
  // A mailbox that started sending after a "nothing yet today" alert closes it.
  const today = chicagoDay(now);
  const sendingToday = foldRows(rows).filter(r => r.day === today && r.sent > 0).map(r => r.mailbox);
  if (sendingToday.length) await pool.query(`UPDATE sdr_volume_alerts SET resolved_at=$1 WHERE kind='stalled_today' AND day=$2
    AND resolved_at IS NULL AND mailbox_email=ANY($3::text[])`, [now, today, sendingToday]);
  const counts = { mailboxes: mailboxes.length, alerts: alerts.length, created, notified: 0, digests: 0, failed: 0, uncertain: 0, unnotified: 0,
    suppressed: alerts.filter(a => a.kind === 'cap_lowered').length, enrollment_basis: basis === 'enrollments' ? 1 : 0 };
  // Settle digests whose send outcome was uncertain: found in Sent -> sent; still absent after
  // the recheck delay -> released for the next digest; otherwise left alone (never resent blind).
  const uncertain = (await pool.query(`SELECT DISTINCT notify_receipt FROM sdr_volume_alerts WHERE notify_receipt->>'state'='uncertain'`)).rows.map(r => r.notify_receipt);
  for (const receipt of uncertain) {
    const found = typeof notify?.check === 'function' ? await notify.check(receipt) : null;
    if (found === true) await pool.query(`UPDATE sdr_volume_alerts SET notify_receipt=notify_receipt||'{"state":"sent","settled":"sent_folder"}'::jsonb WHERE notify_receipt->>'messageId'=$1`, [receipt.messageId]);
    else if (found === false && +now - Date.parse(receipt.at) > UNCERTAIN_RECHECK_MS)
      await pool.query(`UPDATE sdr_volume_alerts SET notified_at=NULL,notify_receipt=NULL WHERE notify_receipt->>'messageId'=$1`, [receipt.messageId]);
    else counts.uncertain++;
  }
  const due = (await pool.query(`SELECT id FROM sdr_volume_alerts WHERE notified_at IS NULL AND resolved_at IS NULL
    AND kind IN ('volume_dip','stalled_today') AND created_at > $1::timestamptz - INTERVAL '2 days' ORDER BY created_at, id`, [now])).rows;
  if (!due.length) return { coverage: 'complete', counts };
  if (!notify) { counts.unnotified = due.length; return { coverage: 'complete', counts }; }
  // Claim every due alert first so two runs never send them twice; release on a definite failure.
  const claimed = (await pool.query(`UPDATE sdr_volume_alerts SET notified_at=$2 WHERE id=ANY($1::uuid[]) AND notified_at IS NULL
    RETURNING id, mailbox_email, day::text AS day, kind, sent, baseline, evidence`, [due.map(r => r.id), now])).rows
    .sort((a, b) => a.mailbox_email.localeCompare(b.mailbox_email) || a.kind.localeCompare(b.kind));
  if (!claimed.length) return { coverage: 'complete', counts };
  const ids = claimed.map(r => r.id);
  const messageId = `<sdr-volume-${createHash('sha1').update(`${[...ids].sort().join(',')}|${now.toISOString()}`).digest('hex').slice(0, 24)}@proswppp.co>`;
  try {
    const result = await notify(claimed.map(r => ({ ...r, mailbox: r.mailbox_email, baseline: Number(r.baseline) })), { messageId });
    const state = result?.state === 'uncertain' ? 'uncertain' : 'sent';
    await pool.query('UPDATE sdr_volume_alerts SET notify_receipt=$2 WHERE id=ANY($1::uuid[])',
      [ids, JSON.stringify({ state, messageId, sender: result?.sender || null, at: now.toISOString() })]);
    if (state === 'sent') { counts.notified = claimed.length; counts.digests = 1; } else counts.uncertain++;
  } catch {
    counts.failed = claimed.length;
    await pool.query('UPDATE sdr_volume_alerts SET notified_at=NULL WHERE id=ANY($1::uuid[])', [ids]);
  }
  return { coverage: counts.failed ? 'partial' : 'complete', counts };
}
