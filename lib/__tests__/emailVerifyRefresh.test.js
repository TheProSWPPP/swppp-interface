// lib/__tests__/emailVerifyRefresh.test.js
import { describe, it, expect } from "vitest";
import {
  needsVerify, classifyVerifyResult, emailDomain, pickBestCandidate, STALE_MS,
} from "../emailVerifyRefresh.js";
import { readVerifyCache, writeVerifyCache, resolveContact } from "../emailVerifyRefresh.js";

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
