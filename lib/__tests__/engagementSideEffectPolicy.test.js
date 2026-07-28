import { describe, it, expect } from "vitest";
import { resolveEventPolicy } from "../engagementSideEffectPolicy.js";

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
