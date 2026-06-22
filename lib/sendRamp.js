// Per-mailbox daily send-cap ramp (cold-email warmup).
// "Gradual daily climb" curve chosen by Ivan 2026-06-22. The ramp clock starts on
// each mailbox's FIRST send (not a calendar date), so volume only climbs once the
// team actually starts using it. Protects the warming proswppp.co inboxes.

export const RAMP_TARGET = 40; // full per-mailbox daily cap once warmed

// Day buckets → cap. day 1 = the day of the mailbox's first send.
const RAMP_STEPS = [
  { throughDay: 3, cap: 5 },
  { throughDay: 6, cap: 10 },
  { throughDay: 9, cap: 15 },
  { throughDay: 12, cap: 20 },
  { throughDay: 15, cap: 28 },
  { throughDay: 18, cap: 35 },
];

// 1-based day index since the mailbox started sending. Until first send
// (warmup_started_at IS NULL) it sits at day 1 (lowest cap) — the ramp begins
// the moment the mailbox sends its first email, set in approve-and-send.
export function rampDay(warmupStartedAt, now = Date.now()) {
  if (!warmupStartedAt) return 1; // not started yet → day 1
  const start = new Date(warmupStartedAt).getTime();
  if (Number.isNaN(start)) return 1;
  return Math.max(1, Math.floor((now - start) / 86400000) + 1);
}

// Effective per-mailbox daily send cap for today.
export function dailyCap(warmupStartedAt, target = RAMP_TARGET, now = Date.now()) {
  const day = rampDay(warmupStartedAt, now);
  for (const s of RAMP_STEPS) if (day <= s.throughDay) return Math.min(s.cap, target);
  return target;
}
