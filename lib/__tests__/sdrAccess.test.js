import { describe, it, expect } from "vitest";
import { ownerScope, leadVisibilityScope, leadVisibleTo } from "../sdrAccess.js";

// Context: on 2026-07-28 a live audit found GET /api/sdr/leads returning a byte-identical
// payload to an admin and to an SDR who owned nothing. `sdr_lead_state` has no per-user
// column, so `ownerScope` had nothing to bind to and was simply never applied.

const ADMIN = { role: "admin", sub: "7b7930f3-1439-4c1e-830b-5cf6483d1458" };
const MICHAEL = { role: "sdr", sub: "a9f295bf-2f4c-4025-b4ee-bae3b065fe1d" };
const CAMERON = { role: "sdr", sub: "0ad762cd-e8b8-465a-b177-01555cb6440a" };

describe("leadVisibilityScope", () => {
  it("admin gets no clause at all", () => {
    const s = leadVisibilityScope(ADMIN);
    expect(s.requires).toBe(false);
    expect(s.value).toBeNull();
    expect(s.sql("$1")).toBe("TRUE");
  });

  it("an SDR gets a clause bound to their own id, never to another's", () => {
    expect(leadVisibilityScope(MICHAEL).value).toBe(MICHAEL.sub);
    expect(leadVisibilityScope(CAMERON).value).toBe(CAMERON.sub);
    expect(leadVisibilityScope(MICHAEL).value).not.toBe(CAMERON.sub);
  });

  it("no user falls back to the nil UUID, which is a VALID uuid no row can carry", () => {
    // Not ownerScope's '__no_user__'. That string raises Postgres 22P02 against a uuid column
    // rather than evaluating false, so it denies by 500 instead of by returning nothing.
    const s = leadVisibilityScope(undefined);
    expect(s.requires).toBe(true);
    expect(s.value).toBe("00000000-0000-0000-0000-000000000000");
    expect(s.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("encodes BOTH halves of the locked rule: shared pool OR my own draft", () => {
    const sql = leadVisibilityScope(MICHAEL).sql("$1");
    // half one: a lead with no draft at all is visible to everyone
    expect(sql).toMatch(/NOT EXISTS[\s\S]*sdr_drafts/);
    // half two: a lead with a draft is visible to that draft's assignee
    expect(sql).toMatch(/OR EXISTS[\s\S]*assigned_user_id = \$1/);
  });

  it("uses EXISTS, never a JOIN — a JOIN fans out one row per draft", () => {
    // Measured on the live book: LEFT JOIN returned 8,075 rows for 8,010 distinct leads, which
    // corrupts COUNT(*) OVER() and silently breaks paging.
    const sql = leadVisibilityScope(MICHAEL).sql("$1");
    expect(sql).not.toMatch(/\bJOIN\b/i);
  });

  it("honours the caller's table alias so it can be reused across the list, facet and filter queries", () => {
    expect(leadVisibilityScope(MICHAEL, "x").sql("$1")).toMatch(/x\.pipedrive_lead_id/);
    expect(leadVisibilityScope(MICHAEL, "x").sql("$1")).not.toMatch(/\bs\.pipedrive_lead_id/);
  });

  it("uses a subquery alias that cannot collide with the outer query's `d`", () => {
    // The list query already LEFT JOIN LATERALs sdr_drafts as `d`. Reusing `d` inside these
    // EXISTS would silently correlate against the wrong relation.
    const sql = leadVisibilityScope(MICHAEL).sql("$1");
    expect(sql).toMatch(/sdr_drafts vd/);
    expect(sql).not.toMatch(/sdr_drafts d\b/);
  });
});

describe("leadVisibleTo — the by-id guard", () => {
  // GET /api/sdr/leads/:leadId/detail returned every draft's subject, body and assignee for
  // any lead to any SDR, which completely defeated the correctly-scoped GET /api/sdr/drafts/:id.
  const fakePool = (rows) => ({ query: async () => ({ rows }) });

  it("short-circuits for admin without touching the database", async () => {
    let called = false;
    const pool = { query: async () => { called = true; return { rows: [] }; } };
    expect(await leadVisibleTo(pool, ADMIN, "any-lead")).toBe(true);
    expect(called).toBe(false);
  });

  it("true when the scoped lookup finds the lead", async () => {
    expect(await leadVisibleTo(fakePool([{ "?column?": 1 }]), MICHAEL, "lead-1")).toBe(true);
  });

  it("false when it does not — a lead someone else has drafted", async () => {
    expect(await leadVisibleTo(fakePool([]), CAMERON, "lead-1")).toBe(false);
  });

  it("false on a missing lead id rather than falling through to a query", async () => {
    let called = false;
    const pool = { query: async () => { called = true; return { rows: [{}] }; } };
    expect(await leadVisibleTo(pool, MICHAEL, null)).toBe(false);
    expect(called).toBe(false);
  });

  it("binds the lead id and the user id as parameters, never as string-interpolated SQL", async () => {
    let seen = null;
    const pool = { query: async (sql, params) => { seen = { sql, params }; return { rows: [] }; } };
    await leadVisibleTo(pool, MICHAEL, "'; DROP TABLE sdr_leads; --");
    expect(seen.params).toEqual(["'; DROP TABLE sdr_leads; --", MICHAEL.sub]);
    expect(seen.sql).not.toMatch(/DROP TABLE/);
  });
});

describe("ownerScope is unchanged by all of the above", () => {
  it("still deny-alls with no user and still bypasses for admin", () => {
    expect(ownerScope(undefined).value).toBe("__no_user__");
    expect(ownerScope(ADMIN).requires).toBe(false);
    expect(ownerScope(MICHAEL, "assigned_user_id")).toEqual({
      requires: true, column: "assigned_user_id", value: MICHAEL.sub,
    });
  });
});

// Refutations from the Phase 3 skeptics, each now a test so it cannot come back.
describe("leadVisibilityScope — what a draft has to be to privatise a lead", () => {
  const sql = () => leadVisibilityScope(MICHAEL).sql("$1");

  it("a dead draft does not privatise: failed/rejected/cancelled are excluded", () => {
    // 141 leads were hidden forever by a draft that never resulted in contact, while the
    // engine would re-offer the same lead to a different rep 30 days later.
    expect(sql()).toMatch(/status IN \('pending','approved','edited','sent'\)/);
    expect(sql()).not.toMatch(/'rejected'|'cancelled'|'failed'/);
  });

  it("matches the status set the auto-outreach engine calls 'already drafted'", () => {
    // lib/autoOutreach.js:73-77 uses exactly this set. If the two ever disagree, a lead can be
    // re-offered by the engine while still sitting privately in someone else's list.
    const ENGINE_SET = "('pending','approved','edited','sent')";
    expect(sql()).toContain(`status IN ${ENGINE_SET}`);
  });

  it("an unassigned draft cannot hide a lead from every SDR at once", () => {
    // Five such drafts exist on one lead. Without the NULL check that lead satisfies neither
    // half of the predicate and disappears for all six SDRs while staying visible to admin.
    expect(sql()).toMatch(/assigned_user_id IS NOT NULL/);
  });
});
