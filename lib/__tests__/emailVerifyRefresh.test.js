// lib/__tests__/emailVerifyRefresh.test.js
import { describe, it, expect } from "vitest";
import {
  needsVerify, classifyVerifyResult, emailDomain, pickBestCandidate, STALE_MS,
} from "../emailVerifyRefresh.js";
import { readVerifyCache, writeVerifyCache, resolveContact, verifyOneLead, cancelInFlightOutreach } from "../emailVerifyRefresh.js";

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
      listOrgPersons: async () => [{ id: "9", email: [{ value: "owner@acme.com", primary: true }], name: "O", title: "Owner" }],
      searchPeopleByDomain: async () => { apolloCalled = true; return []; },
    }));
    expect(r.outcome).toBe("recovered");
    expect(r.email).toBe("owner@acme.com");
    expect(r.source).toBe("pd_org");
    expect(apolloCalled).toBe(false);
  });
  it("returns an Apollo person as a review candidate without replacing the lead person", async () => {
    let replaced = false;
    const r = await resolveContact(lead, deps({
      verify: async (e) => (e === "found@acme.com" ? pass : fail),
      searchPeopleByDomain: async () => [{ id: "apollo-other", email: "found@acme.com", title: "Estimator" }],
      setPrimaryEmail: async () => { replaced = true; },
    }));
    expect(r).toMatchObject({ outcome: "review", candidate: { email: "found@acme.com", source: "apollo" } });
    expect(replaced).toBe(false);
  });
  it("returns another Pipedrive person's address for review without mutating the original", async () => {
    let replaced = false;
    const r = await resolveContact(lead, deps({
      verify: async e => e === lead.email ? fail : pass,
      listOrgPersons: async () => [{ id: "different-person", email: [{ value: "owner@acme.com", primary: true }], title: "Owner" }],
      setPrimaryEmail: async () => { replaced = true; },
    }));
    expect(r).toMatchObject({ outcome: "review", candidate: { email: "owner@acme.com", source: "pd_org", personId: "different-person" } });
    expect(replaced).toBe(false);
  });
  it("promotes a verified secondary address on the original person", async () => {
    let promoted;
    const r = await resolveContact(lead, deps({
      verify: async e => e === lead.email ? fail : pass,
      listOrgPersons: async () => [{ id: "9", email: [
        { value: lead.email, primary: true, label: "office" },
        { value: "working@acme.com", primary: false, label: "home" },
      ], title: "Estimator" }],
      setPrimaryEmail: async (...args) => { promoted = args; },
    }));
    expect(r).toMatchObject({ outcome: "recovered", email: "working@acme.com" });
    expect(promoted).toEqual(["9", "working@acme.com", { keepOld: lead.email }]);
  });
  it("returns a stale same-person address for review when the fresh person read rejects it", async () => {
    const r = await resolveContact(lead, deps({
      verify: async e => e === lead.email ? fail : pass,
      listOrgPersons: async () => [{ id: "9", email: [{ value: "removed@acme.com", primary: false }] }],
      setPrimaryEmail: async () => { throw Object.assign(new Error("stale candidate"), { code: "email_identity_changed" }); },
    }));
    expect(r).toMatchObject({ outcome: "review", candidate: { email: "removed@acme.com", source: "pd_org", personId: "9" } });
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
        { id: "different", email: [{ value: "clerk@acme.com", primary: true }], title: "Clerk" },
        { id: "9", email: [{ value: "owner@acme.com", primary: true }], title: "Owner" },
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
        { id: "9", email: [{ value: "owner@acme.com", primary: true }], title: "Owner" },
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

  it("flags a different-person candidate for review without storing it as resolved email", async () => {
    const pool = fakePoolWithRowCount([]);
    const r = await verifyOneLead(pool, badLead, {
      verify: async e => e === badLead.email ? fail : pass,
      canUseApollo: () => false,
      listOrgPersons: async () => [{ id: "other", email: [{ value: "other@acme.com", primary: true }], title: "Owner" }],
      addNote: async () => ({}),
      cancelInFlightOutreach: async () => ({ cancelledDrafts: 0, removedEnrollments: 0 }),
    });
    expect(r).toMatchObject({ outcome: "review", email_flag: "email_bad", resolved_email: null, candidate: { email: "other@acme.com" } });
    expect(pool.calls.find(c => c.text.includes("UPDATE sdr_lead_state")).params).toContain(null);
  });

});

describe("cancelInFlightOutreach", () => {
  it.each([
    ["wrong contact", async () => ({ id: "someone-else", contact_campaign_statuses: [] })],
    ["missing memberships", async () => ({ id: "contact" })],
    ["malformed memberships", async () => ({ id: "contact", contact_campaign_statuses: [{}] })],
    ["membership timeout", async () => { throw new Error("timeout"); }],
  ])("does not mark stopped or clear the CRM marker after %s", async (_name, getContact) => {
    const pool = fakePoolWithRowCount([{ id: "send-1", apollo_sequence_id: "seq", apollo_contact_id: "contact" }]);
    let markerClears = 0;
    const result = await cancelInFlightOutreach(pool, lead, {
      removeContactsFromSequence: async () => ({ entity_progress_job: { id: "job", progress: 0 } }),
      getContact,
      updateLead: async () => { markerClears++; },
    });
    expect(result).toMatchObject({ removedEnrollments: 0, unresolvedRemovals: 1 });
    expect(markerClears).toBe(0);
    expect(pool.calls.some(c => c.text.includes("SET status = 'failed'"))).toBe(false);
    expect(pool.calls.some(c => c.text.includes("INSERT INTO sdr_engagement_events"))).toBe(true);
  });

  it("records a confirmed stop only after reading the exact contact without that sequence", async () => {
    const pool = fakePoolWithRowCount([{ id: "send-1", apollo_sequence_id: "seq", apollo_contact_id: "contact" }]);
    const operations = [];
    const result = await cancelInFlightOutreach(pool, lead, {
      removeContactsFromSequence: async (seq, contacts, action) => { operations.push([seq, contacts, action]); },
      getContact: async id => { operations.push(["read", id]); return { id: "contact", contact_campaign_statuses: [{ emailer_campaign_id: "unrelated" }] }; },
      updateLead: async id => { operations.push(["clear", id]); },
    });
    expect(result).toMatchObject({ removedEnrollments: 1, unresolvedRemovals: 0 });
    expect(operations).toEqual([["seq", ["contact"], "remove"], ["read", "contact"], ["clear", "1"]]);
    expect(pool.calls.some(c => c.text.includes("SET status = 'failed'"))).toBe(true);
  });

  it("keeps an enrollment retryable when Apollo removal has no confirmed receipt", async () => {
    const pool = fakePoolWithRowCount([{ id: "send-1", apollo_sequence_id: "seq", apollo_contact_id: "contact" }]);
    const r = await cancelInFlightOutreach(pool, lead, {
      removeContactsFromSequence: async () => ({ entity_progress_job: { id: "job", progress: 0 } }),
      getContact: async () => ({ id: "contact", contact_campaign_statuses: [{ emailer_campaign_id: "seq", status: "active" }] }),
      updateLead: async () => { throw new Error("must not clear marker"); },
    });
    expect(r).toMatchObject({ removedEnrollments: 0, unresolvedRemovals: 1 });
    expect(pool.calls.some(c => c.text.includes("SET status = 'failed'"))).toBe(false);
  });
});
