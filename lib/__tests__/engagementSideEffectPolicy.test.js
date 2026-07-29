import { describe, it, expect } from "vitest";
import { resolveEventPolicy, shouldCloseBackfillWindow } from "../engagementSideEffectPolicy.js";

// These tests exist because an earlier revision guarded Pipedrive side effects on MESSAGE
// AGE (7 days, keyed on completed_at). That was wrong twice: Apollo carries no reply-arrival
// timestamp on this endpoint (reply and send share one value, measured 15/15), and 34% of
// real replies arrive >7 days after first touch. Nothing here may take a timestamp.

describe("resolveEventPolicy — no age input, ever", () => {
  it("takes no timestamp: identical verdict for a 1-minute-old and a 400-day-old message", () => {
    // The signature has no timestamp parameter at all, so this is structural, not incidental.
    const a = resolveEventPolicy({ eventId: "poll:m1:replied", sendMatch: "message_id", backfillDone: true });
    const b = resolveEventPolicy({ eventId: "poll:m1:replied", sendMatch: "message_id", backfillDone: true });
    expect(a).toEqual(b);
    expect(a.recordOnly).toBe(false);
    expect(a.mayMutateSend).toBe(true);
  });

  it("REGRESSION: a reply on a lead whose last outbound is months old still fires side effects", () => {
    // The exact case the old age guard broke — 682 of 718 live send rows are in this state.
    const p = resolveEventPolicy({ eventId: "poll:old-msg:replied", sendMatch: "message_id", backfillDone: true });
    expect(p.recordOnly).toBe(false); // reaches the Pipedrive branch
    expect(p.processStatus).toBe("pending");
  });
});

describe("resolveEventPolicy — mutations require an exact message-id match", () => {
  it("allows mutation only on an exact apollo_emailer_message_id hit", () => {
    expect(resolveEventPolicy({ eventId: "poll:m:replied", sendMatch: "message_id" }).mayMutateSend).toBe(true);
  });

  it.each(["sequence_email", "email", null])(
    "VETO REGRESSION: refuses to mutate when the send row resolved by %s",
    (sendMatch) => {
      // These are ORDER BY sent_at DESC LIMIT 1 fallbacks that land on the contact's CURRENT
      // live row. Mutating off one flips a running send to 'replied' and ejects a
      // mid-sequence contact from a live Apollo campaign — unretryable.
      const p = resolveEventPolicy({ eventId: "poll:m:replied", sendMatch, backfillDone: true });
      expect(p.mayMutateSend).toBe(false);
      expect(p.recordOnly).toBe(false); // still records, and still notes Pipedrive
    },
  );
});

describe("resolveEventPolicy — backfill watermark", () => {
  it("records only, and marks 'backfilled', while the sweep is outstanding", () => {
    const p = resolveEventPolicy({ eventId: "poll:m:replied", sendMatch: "message_id", backfillDone: false });
    expect(p.recordOnly).toBe(true);
    expect(p.processStatus).toBe("backfilled");
  });

  it("fires normally once the watermark is set, however old the message", () => {
    const p = resolveEventPolicy({ eventId: "poll:m:replied", sendMatch: "message_id", backfillDone: true });
    expect(p.recordOnly).toBe(false);
    expect(p.processStatus).toBe("pending");
  });

  it("an explicit caller backfill flag always wins", () => {
    const p = resolveEventPolicy({ eventId: "poll:m:replied", backfillFlag: true, backfillDone: true });
    expect(p.recordOnly).toBe(true);
  });

  it("does NOT suppress non-poll events (webhook / inbox watch) during the sweep", () => {
    // A live Apollo webhook must not be silenced by a backfill that has nothing to do with it.
    const p = resolveEventPolicy({ eventId: "evt_apollo_webhook_123", sendMatch: "message_id", backfillDone: false });
    expect(p.isPollSourced).toBe(false);
    expect(p.recordOnly).toBe(false);
  });

  it("defaults are safe when called with nothing", () => {
    const p = resolveEventPolicy();
    expect(p.mayMutateSend).toBe(false);
    expect(p.recordOnly).toBe(false);
  });
});

// ── The 2026-07-28 back-blast ──
// resolveEventPolicy did its job perfectly that day. The watermark lied to it: the sweep
// recorded ZERO rows (every insert hit the process_status CHECK, which did not list
// 'backfilled'), the failures were swallowed, the window closed anyway, and the next full
// scan replayed 35 events aged 5-20 days through the live Pipedrive path.
describe("shouldCloseBackfillWindow — a sweep that persisted nothing has swept nothing", () => {
  it("REGRESSION 2026-07-28: refuses to close when every emit failed", () => {
    // The real shape of the incident: the sweep read everything and wrote nothing.
    expect(shouldCloseBackfillWindow({ backfillMode: true, emitFailures: 35 })).toBe(false);
  });

  it("refuses to close on a single failure — one unrecorded event is one future back-blast", () => {
    expect(shouldCloseBackfillWindow({ backfillMode: true, emitFailures: 1 })).toBe(false);
  });

  it("closes on a clean sweep", () => {
    expect(shouldCloseBackfillWindow({ backfillMode: true, emitFailures: 0 })).toBe(true);
  });

  it("does not withhold the watermark on an ordinary full scan, whatever happened", () => {
    // Only the one-time sweep owns engagement_backfill_done_at. A routine 3h scan with a
    // flaky emit must not be able to re-open a window that is already correctly closed.
    expect(shouldCloseBackfillWindow({ backfillMode: false, emitFailures: 99 })).toBe(true);
  });

  it("defaults are safe: no arguments means not a sweep, nothing to withhold", () => {
    expect(shouldCloseBackfillWindow()).toBe(true);
    expect(shouldCloseBackfillWindow({ backfillMode: true })).toBe(true);
  });

  it("takes no timestamp either — same rule as resolveEventPolicy", () => {
    expect(shouldCloseBackfillWindow.length).toBeLessThanOrEqual(1);
    const src = shouldCloseBackfillWindow.toString();
    expect(src).not.toMatch(/Date|occurred|age|hours|days/i);
  });
});

describe("processStatus 'backfilled' must be a legal column value", () => {
  it("emits exactly the string the sdr_engagement_events CHECK constraint must allow", () => {
    // This value goes straight into an INSERT. When the CHECK did not list it, Postgres
    // raised 23514 on every row and the sweep silently recorded nothing. If anyone renames
    // this, server.js's CHECK has to move with it.
    const p = resolveEventPolicy({ eventId: "poll:x:replied", backfillDone: false });
    expect(p.processStatus).toBe("backfilled");
    expect(["pending", "processed", "skipped", "error", "backfilled"]).toContain(p.processStatus);
  });
});
