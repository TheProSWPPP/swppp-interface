// Per-mailbox daily send-cap ramp (cold-email warmup).
// "Gradual daily climb" curve chosen by Ivan 2026-06-22; team go-live = day 1.
// Protects the new proswppp.co inboxes (deliverability still warming) by capping
// how many sends each mailbox can do per day, climbing to the full target.

export const RAMP_TARGET = 40; // full per-mailbox daily cap once warmed
export const DEFAULT_WARMUP_START = "2026-06-22"; // team go-live (day 1)

// Day buckets → cap. day 1 = the warmup start date.
const RAMP_STEPS = [
  { throughDay: 3, cap: 5 },
  { throughDay: 6, cap: 10 },
  { throughDay: 9, cap: 15 },
  { throughDay: 12, cap: 20 },
  { throughDay: 15, cap: 28 },
  { throughDay: 18, cap: 35 },
];

// 1-based day index since warmup start (day 1 = start date).
export function rampDay(warmupStartedAt, now = Date.now()) {
  const start = new Date(warmupStartedAt || DEFAULT_WARMUP_START).getTime();
  if (Number.isNaN(start)) return 9999; // unknown → treat as fully warmed
  return Math.floor((now - start) / 86400000) + 1;
}

// Effective per-mailbox daily send cap for today.
export function dailyCap(warmupStartedAt, target = RAMP_TARGET, now = Date.now()) {
  const day = rampDay(warmupStartedAt, now);
  if (day < 1) return 0; // warmup hasn't started yet
  for (const s of RAMP_STEPS) if (day <= s.throughDay) return Math.min(s.cap, target);
  return target;
}
