import { describe, it, expect, afterEach } from "vitest";
import {
  RAMP_TARGET,
  BOUNCE_WARN_RATE,
  BOUNCE_HIGH_RATE,
  BOUNCE_MIN_SENDS,
  rampDay,
  rampStep,
  bounceStepPenalty,
  dailyCap,
} from "../sendRamp.js";

const DAY = 86400000;
const at = (day, now = Date.UTC(2026, 7, 6)) => now - (day - 1) * DAY;

afterEach(() => {
  delete process.env.SDR_DAILY_CAP;
});

describe("rampDay", () => {
  it("treats a mailbox that has never sent as day 1", () => {
    expect(rampDay(null)).toBe(1);
    expect(rampDay(undefined)).toBe(1);
  });

  it("treats an unparseable timestamp as day 1 rather than throwing", () => {
    expect(rampDay("not a date")).toBe(1);
  });

  it("counts the first send day as day 1", () => {
    const now = Date.UTC(2026, 7, 6);
    expect(rampDay(new Date(now).toISOString(), now)).toBe(1);
    expect(rampDay(new Date(at(19, now)).toISOString(), now)).toBe(19);
  });
});

describe("rampStep", () => {
  it("climbs one rung per bucket and tops out", () => {
    expect(rampStep(1)).toBe(0);
    expect(rampStep(4)).toBe(1);
    expect(rampStep(19)).toBe(6);
    expect(rampStep(400)).toBe(6);
  });
});

describe("bounceStepPenalty", () => {
  it("does not penalise a mailbox with no health data", () => {
    expect(bounceStepPenalty(undefined)).toBe(0);
    expect(bounceStepPenalty({ sent: 0, bounced: 0 })).toBe(0);
  });

  it("does not penalise below the minimum sample size", () => {
    // 2 of 9 is 22%, but nine sends is not evidence of anything.
    expect(bounceStepPenalty({ sent: BOUNCE_MIN_SENDS - 1, bounced: 2 })).toBe(0);
  });

  it("penalises once at the warn rate and twice at the high rate", () => {
    expect(bounceStepPenalty({ sent: 100, bounced: 3 })).toBe(0);
    expect(bounceStepPenalty({ sent: 100, bounced: Math.ceil(BOUNCE_WARN_RATE * 100) })).toBe(1);
    expect(bounceStepPenalty({ sent: 100, bounced: Math.ceil(BOUNCE_HIGH_RATE * 100) })).toBe(2);
    expect(bounceStepPenalty({ sent: 100, bounced: 50 })).toBe(2);
  });

  it("reads string counts from pg without mis-scoring them", () => {
    // node-postgres returns bigint aggregates as strings; "8"/"100" must not compare as text.
    expect(bounceStepPenalty({ sent: "100", bounced: "8" })).toBe(2);
    expect(bounceStepPenalty({ sent: "100", bounced: "1" })).toBe(0);
  });
});

describe("dailyCap", () => {
  const now = Date.UTC(2026, 7, 6);

  it("follows the warmup ladder for a healthy mailbox", () => {
    expect(dailyCap(null, { now })).toBe(5);
    expect(dailyCap(new Date(at(4, now)).toISOString(), { now })).toBe(10);
    expect(dailyCap(new Date(at(19, now)).toISOString(), { now })).toBe(RAMP_TARGET);
  });

  it("holds a warmed mailbox one rung back while bounces sit at the warn rate", () => {
    const warmed = new Date(at(19, now)).toISOString();
    expect(dailyCap(warmed, { now, health: { sent: 100, bounced: 5 } })).toBe(35);
  });

  it("drops a warmed mailbox two rungs when bounces are high", () => {
    const warmed = new Date(at(19, now)).toISOString();
    expect(dailyCap(warmed, { now, health: { sent: 100, bounced: 10 } })).toBe(28);
  });

  it("never drops below the first rung", () => {
    // A brand-new mailbox bouncing badly is already on rung 0; the penalty cannot go negative.
    expect(dailyCap(null, { now, health: { sent: 20, bounced: 10 } })).toBe(5);
  });

  it("lets volume climb back on its own once bounces fall", () => {
    const warmed = new Date(at(19, now)).toISOString();
    const throttled = dailyCap(warmed, { now, health: { sent: 100, bounced: 12 } });
    const recovered = dailyCap(warmed, { now, health: { sent: 100, bounced: 1 } });
    expect(throttled).toBeLessThan(recovered);
    expect(recovered).toBe(RAMP_TARGET);
  });

  it("honours the per-mailbox daily_send_limit as a ceiling", () => {
    const warmed = new Date(at(19, now)).toISOString();
    expect(dailyCap(warmed, { now, target: 25 })).toBe(25);
    // The ramp still wins while it is the lower of the two.
    expect(dailyCap(null, { now, target: 25 })).toBe(5);
  });

  it("applies the bounce penalty underneath the mailbox ceiling", () => {
    const warmed = new Date(at(19, now)).toISOString();
    // Ceiling 25, ladder says 40, high bounces knock the ladder to 28 → 25 still wins.
    expect(dailyCap(warmed, { now, target: 25, health: { sent: 100, bounced: 10 } })).toBe(25);
    // Knock it further and the penalty becomes the binding constraint.
    expect(dailyCap(warmed, { now, target: 25, health: { sent: 100, bounced: 10 } })).toBeLessThanOrEqual(25);
  });

  it("treats a zero mailbox limit as a full stop", () => {
    expect(dailyCap(new Date(at(19, now)).toISOString(), { now, target: 0 })).toBe(0);
  });

  it("lets SDR_DAILY_CAP pin every mailbox regardless of ramp or health", () => {
    process.env.SDR_DAILY_CAP = "3";
    expect(dailyCap(new Date(at(19, now)).toISOString(), { now, health: { sent: 100, bounced: 40 } })).toBe(3);
  });
});
