// lib/__tests__/emailVerifyRefresh.test.js
import { describe, it, expect } from "vitest";
import {
  needsVerify, classifyVerifyResult, emailDomain, pickBestCandidate, STALE_MS,
} from "../emailVerifyRefresh.js";
import { readVerifyCache, writeVerifyCache, resolveContact, verifyOneLead } from "../emailVerifyRefresh.js";

const NOW = Date.parse("2026-07-02T00:00:00Z");

describe("needsVerify", () => {
  const base = { status: "clear", triggerType: "agc", email: "a@b.com", verifiedValue: null, verifiedAt: null, now: NOW };
  it("verifies an eligible, never-verified lead", () => {
    expect(needsVerify(base)).toBe(true);
  });
  it("skips non-clear leads", () => {
    expect(needsVerify({ ...base, status: "contacted_recent" })).toBe(false);
  });
  it("skips leads with no trigger", () => {
    expect(needsVerify({ ...base, triggerType: null })).toBe(false);
  });
  it("skips leads with no email", () => {
    expect(needsVerify({ ...base, email: null })).toBe(false);
  });
  it("skips when verified recently and email unchanged", () => {
    expect(needsVerify({ ...base, verifiedValue: "a@b.com", verifiedAt: NOW - 1000 })).toBe(false);
  });
  it("re-verifies when the email changed", () => {
    expect(needsVerify({ ...base, verifiedValue: "old@b.com", verifiedAt: NOW - 1000 })).toBe(true);
  });
  it("re-verifies when the cache is older than 90 days", () => {
    expect(needsVerify({ ...base, verifiedValue: "a@b.com", verifiedAt: NOW - STALE_MS - 1000 })).toBe(true);
  });
});

describe("classifyVerifyResult", () => {
  it("maps skipped → skip", () => expect(classifyVerifyResult({ ok: true, skipped: true })).toBe("skip"));
  it("maps ok:false → hard_fail", () => expect(classifyVerifyResult({ ok: false, status: "invalid" })).toBe("hard_fail"));
  it("maps ok pass → pass", () => expect(classifyVerifyResult({ ok: true, status: "valid" })).toBe("pass"));
  it("maps soft (catchall) → pass", () => expect(classifyVerifyResult({ ok: true, status: "catchall", soft: "catchall" })).toBe("pass"));
});

describe("emailDomain", () => {
  it("extracts + lowercases", () => expect(emailDomain("Bob@Acme.COM")).toBe("acme.com"));
  it("returns null on garbage", () => expect(emailDomain("nope")).toBe(null));
});

describe("pickBestCandidate", () => {
  const pri = ["owner", "estimator"];
  it("prefers the higher-priority title", () => {
    const c = pickBestCandidate([{ email: "e@x.com", title: "Estimator" }, { email: "o@x.com", title: "Owner" }], pri);
    expect(c.email).toBe("o@x.com");
  });
  it("drops locked/emailless candidates", () => {
    const c = pickBestCandidate([{ email: "email_not_unlocked@domain.com", title: "Owner" }, { email: "real@x.com", title: "Clerk" }], pri);
    expect(c.email).toBe("real@x.com");
  });
  it("returns null when nothing usable", () => {
    expect(pickBestCandidate([{ email: null, title: "Owner" }], pri)).toBe(null);
  });
});

function fakePool(rows = []) {
  const calls = [];
  return { calls, query: async (text, params) => { calls.push({ text, params }); return { rows }; } };
}

describe("readVerifyCache", () => {
  it("returns the row", async () => {
    const pool = fakePool([{ email_verify_status: "valid", email_flag: null }]);
    const r = await readVerifyCache(pool, "123");
    expect(r.email_verify_status).toBe("valid");
    expect(pool.calls[0].params).toEqual(["123"]);
  });
  it("returns null when absent", async () => {
    expect(await readVerifyCache(fakePool([]), "x")).toBe(null);
  });
});

describe("writeVerifyCache", () => {
  it("writes status + value and clears flag when flag:null", async () => {
    const pool = fakePool();
    await writeVerifyCache(pool, "123", { status: "valid", verifiedValue: "a@b.com", flag: null });
    const { text, params } = pool.calls[0];
    expect(text).toMatch(/UPDATE sdr_lead_state/);
    expect(params).toContain("valid");
    expect(params).toContain("a@b.com");
    expect(params).toContain("123");
  });
});

const lead ={ leadId: "1", personId: "9", orgId: "5", email: "dead@acme.com" };
const pass = { ok: true, status: "valid" };
const fail = { ok: false, status: "invalid" };
function deps(over = {}) {
  return {
    verify: async () => pass,
    listOrgPersons: async () => [],
    searchPeopleByDomain: async () => [],
    setPrimaryEmail: async () => ({}),
    addNote: async () => ({}),
    canUseApollo: () => true,
    ...over,
  };
}

describe("resolveContact", () => {
  it("passes a good primary through untouched", async () => {
    const r = await resolveContact(lead, deps());
    expect(r).toEqual({ outcome: "ok", email: "dead@acme.com" });
  });
  it("recovers from a Pipedrive org contact (free branch, no Apollo call)", async () => {
    let apolloCalled = false;
    const r = await resolveContact(lead, deps({
      verify: async (e) => (e === "dead@acme.com" ? fail : pass),
      listOrgPersons: async () => [{ email: [{ value: "owner@acme.com", primary: true }], name: "O", title: "Owner" }],
      searchPeopleByDomain: async () => { apolloCalled = true; return []; },
    }));
    expect(r.outcome).toBe("recovered");
    expect(r.email).toBe("owner@acme.com");
    expect(r.source).toBe("pd_org");
    expect(apolloCalled).toBe(false);
  });
  it("falls back to Apollo when the org has nothing usable", async () => {
    const r = await resolveContact(lead, deps({
      verify: async (e) => (e === "found@acme.com" ? pass : fail),
      searchPeopleByDomain: async () => [{ email: "found@acme.com", title: "Estimator" }],
    }));
    expect(r.outcome).toBe("recovered");
    expect(r.source).toBe("apollo");
  });
  it("does NOT call Apollo when the cap is exhausted", async () => {
    let apolloCalled = false;
    const r = await resolveContact(lead, deps({
      verify: async () => fail,
      canUseApollo: () => false,
      searchPeopleByDomain: async () => { apolloCalled = true; return []; },
    }));
    expect(r.outcome).toBe("flagged");
    expect(apolloCalled).toBe(false);
  });
  it("flags when every avenue fails", async () => {
    const r = await resolveContact(lead, deps({
      verify: async () => fail,
      listOrgPersons: async () => [{ email: [{ value: "x@acme.com", primary: true }], title: "Clerk" }],
      searchPeopleByDomain: async () => [{ email: "y@acme.com", title: "Clerk" }],
    }));
    expect(r.outcome).toBe("flagged");
  });
  it("adopts the best-title candidate first even when it is not first in the array (regression: correct sort comparator)", async () => {
    // orgPersons has Clerk first (lower priority) and Owner second (higher priority).
    // Both pass verification; the fix must ensure Owner is tried first and adopted.
    const r = await resolveContact(lead, deps({
      verify: async (e) => (e === "dead@acme.com" ? fail : pass),
      listOrgPersons: async () => [
        { email: [{ value: "clerk@acme.com", primary: true }], title: "Clerk" },
        { email: [{ value: "owner@acme.com", primary: true }], title: "Owner" },
      ],
    }));
    expect(r.email).toBe("owner@acme.com");
    expect(r.source).toBe("pd_org");
  });
});

// ── verifyOneLead ─────────────────────────────────────────────────────────────

function fakePoolWithRowCount(rows = []) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  };
}

describe("verifyOneLead", () => {
  const goodLead = { leadId: "42", personId: "9", orgId: "5", email: "good@acme.com" };
  const badLead = { leadId: "99", personId: "9", orgId: "5", email: "dead@acme.com" };

  it("returns outcome:ok and writes valid status for a good email", async () => {
    const pool = fakePoolWithRowCount();
    const fakeVerify = async () => ({ ok: true, status: "valid" });
    const r = await verifyOneLead(pool, goodLead, {
      verify: fakeVerify,
      canUseApollo: () => false,
    });
    expect(r.outcome).toBe("ok");
    expect(r.status).toBe("valid");
    expect(r.email_flag).toBeNull();
    // writeVerifyCache was called — at least one pool.query with UPDATE sdr_lead_state
    expect(pool.calls.some((c) => c.text.includes("UPDATE sdr_lead_state"))).toBe(true);
  });

  it("returns outcome:flagged and writes email_bad when primary hard-fails and no alternate exists", async () => {
    const pool = fakePoolWithRowCount([]);
    const fakeVerify = async () => ({ ok: false, status: "invalid" });
    const r = await verifyOneLead(pool, badLead, {
      verify: fakeVerify,
      canUseApollo: () => false,
      listOrgPersons: async () => [],
      searchPeopleByDomain: async () => [],
      setPrimaryEmail: async () => ({}),
      addNote: async () => ({}),
    });
    expect(r.outcome).toBe("flagged");
    expect(r.email_flag).toBe("email_bad");
    // writeVerifyCache was called with invalid status
    const updateCall = pool.calls.find((c) => c.text.includes("UPDATE sdr_lead_state") && (c.params || []).includes("invalid"));
    expect(updateCall).toBeTruthy();
  });

  it("returns outcome:recovered and writes invalid+resolvedEmail when an alternate is found", async () => {
    const pool = fakePoolWithRowCount([]);
    // Primary fails, alternate passes
    const fakeVerify = async (e) =>
      e === "dead@acme.com" ? { ok: false, status: "invalid" } : { ok: true, status: "valid" };
    const setPrimaryEmailCalls = [];
    const addNoteCalls = [];
    const r = await verifyOneLead(pool, badLead, {
      verify: fakeVerify,
      canUseApollo: () => false,
      listOrgPersons: async () => [
        { email: [{ value: "owner@acme.com", primary: true }], title: "Owner" },
      ],
      setPrimaryEmail: async (...a) => { setPrimaryEmailCalls.push(a); return {}; },
      addNote: async (...a) => { addNoteCalls.push(a); return {}; },
    });
    expect(r.outcome).toBe("recovered");
    expect(r.resolved_email).toBe("owner@acme.com");
    // cache written with resolved email
    const updateCall = pool.calls.find((c) => c.text.includes("UPDATE sdr_lead_state"));
    expect(updateCall).toBeTruthy();
  });

  // Regression: lib/emailVerifyRefresh.js:183 used to write the provider's RAW status string
  // (e.g. MillionVerifier's "catch_all", ZeroBounce's "catch-all") straight into
  // email_verify_status. Harmless only by coincidence while NeverBounce resolves in prod. Now
  // it must go through canonicalVerdict() so the column holds the same closed vocabulary no
  // matter which provider is active.
  it("writes the CANONICAL verdict, not the provider's raw string, for a soft (catch-all) pass", async () => {
    const pool = fakePoolWithRowCount();
    // Simulate MillionVerifier's raw vocabulary — "catch_all", not NeverBounce's "catchall".
    const fakeVerify = async () => ({ ok: true, status: "catch_all", soft: "catch_all" });
    const r = await verifyOneLead(pool, goodLead, { verify: fakeVerify, canUseApollo: () => false });
    expect(r.outcome).toBe("ok");
    expect(r.status).toBe("soft"); // canonical bucket, not raw "catch_all"
    const updateCall = pool.calls.find((c) => c.text.includes("UPDATE sdr_lead_state") && (c.params || []).includes("soft"));
    expect(updateCall).toBeTruthy();
  });

  it("writes the CANONICAL 'valid' verdict for MillionVerifier's raw 'ok'", async () => {
    const pool = fakePoolWithRowCount();
    const fakeVerify = async () => ({ ok: true, status: "ok" });
    const r = await verifyOneLead(pool, goodLead, { verify: fakeVerify, canUseApollo: () => false });
    expect(r.status).toBe("valid");
  });
});
