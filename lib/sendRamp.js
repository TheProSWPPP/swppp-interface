// Per-mailbox daily send-cap ramp (cold-email warmup).
// "Gradual daily climb" curve chosen by Ivan 2026-06-22. The ramp clock starts on
// each mailbox's FIRST send (not a calendar date), so volume only climbs once the
// team actually starts using it. Protects the warming proswppp.co inboxes.
//
// The ladder is a CEILING, not a schedule. Two things pull the cap back down:
//   1. the mailbox's own `daily_send_limit` (what Derek set in the interface), and
//   2. its recent bounce rate — a mailbox that is burning addresses stops climbing.

export const RAMP_TARGET = 40; // full per-mailbox daily cap once warmed

// Rungs of the ladder. `throughDay` is the last day-since-first-send at that cap; the final
// rung has no upper day. A mailbox's index into this array is its "step", which is the
// thing the bounce penalty moves.
const RAMP_STEPS = [
  { throughDay: 3, cap: 5 },
  { throughDay: 6, cap: 10 },
  { throughDay: 9, cap: 15 },
  { throughDay: 12, cap: 20 },
  { throughDay: 15, cap: 28 },
  { throughDay: 18, cap: 35 },
  { throughDay: Infinity, cap: RAMP_TARGET },
];

// Bounce thresholds. Google and Microsoft start throttling a sender well below the
// double-digit rates a scraped list produces; 4% is the "stop climbing" line and 8% the
// "come back down" line. Measured 2026-08-06 over the first two full-volume days: dc@ 6.3%,
// th@ 5.2%, pm@ 23.1% (on 13 sends), against jg@ 2.5% and mh@ 1.6% on the same copy and the
// same lead pool — the spread is per-mailbox, which is why the gate is too.
export const BOUNCE_WARN_RATE = 0.04;
export const BOUNCE_HIGH_RATE = 0.08;
// Below this many sends in the window a single bad address reads as a 20% bounce rate. A new
// mailbox sits on rung 0 regardless, so waiting for ten sends costs no volume.
export const BOUNCE_MIN_SENDS = 10;
// Long enough that a throttled mailbox keeps a real denominator while it sends 5/day, which
// is what stops the cap oscillating rung to rung.
export const BOUNCE_WINDOW_DAYS = 14;

// 1-based day index since the mailbox started sending. Until first send
// (warmup_started_at IS NULL) it sits at day 1 (lowest cap) — the ramp begins
// the moment the mailbox sends its first email, set in approve-and-send.
export function rampDay(warmupStartedAt, now = Date.now()) {
  if (!warmupStartedAt) return 1; // not started yet → day 1
  const start = new Date(warmupStartedAt).getTime();
  if (Number.isNaN(start)) return 1;
  return Math.max(1, Math.floor((now - start) / 86400000) + 1);
}

// Which rung of the ladder a mailbox's age alone entitles it to.
export function rampStep(day) {
  const i = RAMP_STEPS.findIndex((s) => day <= s.throughDay);
  return i === -1 ? RAMP_STEPS.length - 1 : i;
}

/**
 * How many rungs to hold a mailbox back for its recent bounce rate.
 *
 * A step penalty rather than a multiplier, deliberately: it self-recovers (clean sends age
 * the bad ones out of the window, the penalty lifts, the cap climbs back on its own) and it
 * can never invent a cap that isn't on the ladder.
 *
 * @param health {sent, bounced} over BOUNCE_WINDOW_DAYS. pg returns these as strings.
 */
export function bounceStepPenalty(health) {
  const sent = Number(health?.sent) || 0;
  const bounced = Number(health?.bounced) || 0;
  if (sent < BOUNCE_MIN_SENDS) return 0; // not enough evidence to act on
  const rate = bounced / sent;
  if (rate >= BOUNCE_HIGH_RATE) return 2;
  if (rate >= BOUNCE_WARN_RATE) return 1;
  return 0;
}

/**
 * Effective per-mailbox daily send cap for today.
 *
 * Manual throttle: set SDR_DAILY_CAP to a number to pin every mailbox's daily cap (e.g. "5"
 * while sender reputation recovers). Unset to resume the warmup ramp. Applies to BOTH manual
 * approve-and-send and the auto-outreach engine.
 *
 * @param target the mailbox's own daily_send_limit. Omit for the ramp target.
 * @param health {sent, bounced} from mailboxBounceHealth. Omit to skip the bounce gate.
 */
export function dailyCap(warmupStartedAt, { target = RAMP_TARGET, now = Date.now(), health } = {}) {
  const override = Number(process.env.SDR_DAILY_CAP);
  if (Number.isFinite(override) && override > 0) return override;
  const step = Math.max(0, rampStep(rampDay(warmupStartedAt, now)) - bounceStepPenalty(health));
  return Math.min(RAMP_STEPS[step].cap, target);
}

/**
 * Trailing per-mailbox bounce counts, keyed by mailbox id.
 *
 * Attribution goes through `sdr_sends.pipedrive_lead_id`, NOT
 * `sdr_engagement_events.mailbox_email` — the Apollo-sourced events leave that column null
 * (25 of the 46 bounce events in the 14 days to 2026-08-06). Joining on the lead resolved
 * 100% of them.
 *
 * Counts distinct LEADS rather than events: one dead address bounces on every step of a
 * sequence and would otherwise read as several separate failures.
 *
 * @returns Map<mailbox_id, {sent, bounced}>
 */
export async function mailboxBounceHealth(pool, { days = BOUNCE_WINDOW_DAYS, mailboxId } = {}) {
  const params = [days];
  let scope = "";
  if (mailboxId) {
    params.push(mailboxId);
    scope = ` AND s.mailbox_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT s.mailbox_id,
            count(DISTINCT s.pipedrive_lead_id) AS sent,
            count(DISTINCT s.pipedrive_lead_id) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM sdr_engagement_events e
                 WHERE e.pipedrive_lead_id = s.pipedrive_lead_id
                   AND e.event_type = 'email_bounced'
                   AND e.occurred_at >= s.sent_at
              )
            ) AS bounced
       FROM sdr_sends s
      WHERE s.mailbox_id IS NOT NULL
        AND s.sent_at > NOW() - make_interval(days => $1::int)${scope}
      GROUP BY s.mailbox_id`,
    params,
  );
  return new Map(rows.map((r) => [r.mailbox_id, { sent: Number(r.sent), bounced: Number(r.bounced) }]));
}
