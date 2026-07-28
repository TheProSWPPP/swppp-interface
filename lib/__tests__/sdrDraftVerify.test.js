// lib/__tests__/sdrDraftVerify.test.js
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  sdrDraftVerifyEnabled, checkDraftEmail, SDR_DRAFT_VERIFY_MAX_PER_RUN, _resetLiveVerifyCountForTests,
} from "../sdrDraftVerify.js";

const KEYS = ["SDR_DRAFT_VERIFY", "MILLIONVERIFIER_API_KEY", "NEVERBOUNCE_API_KEY", "ZEROBOUNCE_API_KEY", "EMAIL_VERIFY_API_KEY", "EMAIL_VERIFY_PROVIDER"];
const saved = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetLiveVerifyCountForTests();
});
function clearAll() {
  for (const k of KEYS) delete process.env[k];
}

// ── Enable-check truth table across env permutations ───────────────────────────────────────
// SDR_DRAFT_VERIFY must be read at call time, and gating must be on the RESOLVED provider
// (activeProvider()), never on raw key presence.
describe("sdrDraftVerifyEnabled — truth table", () => {
  it("1. flag unset, no keys → false", () => {
    clearAll();
    expect(sdrDraftVerifyEnabled()).toBe(false);
  });

  it("2. flag unset, NeverBounce key SET → false (flag off wins even with a valid key)", () => {
    clearAll();
    process.env.NEVERBOUNCE_API_KEY = "nb-key";
    expect(sdrDraftVerifyEnabled()).toBe(false);
  });

  it("3. flag=true, no keys → false (flag on but no provider resolves)", () => {
    clearAll();
    process.env.SDR_DRAFT_VERIFY = "true";
    expect(sdrDraftVerifyEnabled()).toBe(false);
  });

  it("4. flag=true, NeverBounce key only → true", () => {
    clearAll();
    process.env.SDR_DRAFT_VERIFY = "true";
    process.env.NEVERBOUNCE_API_KEY = "nb-key";
    expect(sdrDraftVerifyEnabled()).toBe(true);
  });

  it("5. flag=true, MillionVerifier key only → true (works for a non-NeverBounce provider too)", () => {
    clearAll();
    process.env.SDR_DRAFT_VERIFY = "true";
    process.env.MILLIONVERIFIER_API_KEY = "mv-key";
    expect(sdrDraftVerifyEnabled()).toBe(true);
  });

  it("6. flag=true, ZeroBounce key only → true", () => {
    clearAll();
    process.env.SDR_DRAFT_VERIFY = "true";
    process.env.ZEROBOUNCE_API_KEY = "zb-key";
    expect(sdrDraftVerifyEnabled()).toBe(true);
  });

  it("7. TRAP CASE: flag=true, BOTH NeverBounce and MillionVerifier keys set → true (resolves millionverifier under the hood, but the gate is provider-agnostic so it still enables correctly)", () => {
    clearAll();
    process.env.SDR_DRAFT_VERIFY = "true";
    process.env.NEVERBOUNCE_API_KEY = "nb-key";
    process.env.MILLIONVERIFIER_API_KEY = "mv-key";
    expect(sdrDraftVerifyEnabled()).toBe(true);
  });

  it("8. flag explicitly 'false' (string), keys set → false", () => {
    clearAll();
    process.env.SDR_DRAFT_VERIFY = "false";
    process.env.NEVERBOUNCE_API_KEY = "nb-key";
    expect(sdrDraftVerifyEnabled()).toBe(false);
  });

  it("9. flag wrong-case 'TRUE', keys set → false (strict string compare, no case coercion)", () => {
    clearAll();
    process.env.SDR_DRAFT_VERIFY = "TRUE";
    process.env.NEVERBOUNCE_API_KEY = "nb-key";
    expect(sdrDraftVerifyEnabled()).toBe(false);
  });

  it("10. flag=true, PERMIT_NB_VERIFY-style unrelated env untouched → SDR flag is independent", () => {
    clearAll();
    process.env.SDR_DRAFT_VERIFY = "true";
    process.env.NEVERBOUNCE_API_KEY = "nb-key";
    // PERMIT_NB_VERIFY intentionally not set — SDR_DRAFT_VERIFY must not depend on it.
    expect(process.env.PERMIT_NB_VERIFY).toBeUndefined();
    expect(sdrDraftVerifyEnabled()).toBe(true);
  });
});

// ── checkDraftEmail — cache-then-live behavior ──────────────────────────────────────────────
function fakePoolRecording() {
  const calls = [];
  return { calls, query: async (text, params) => { calls.push({ text, params }); return { rows: [] }; } };
}

describe("checkDraftEmail", () => {
  it("blocks on a fresh cached hard_fail verdict, no live call made", async () => {
    let liveCalled = false;
    const pool = fakePoolRecording();
    const r = await checkDraftEmail(pool, { leadId: "1", email: "dead@acme.com" }, {
      readVerifyCache: async () => ({
        email_verify_status: "invalid", email_verified_value: "dead@acme.com", email_verified_at: new Date().toISOString(),
      }),
      verifyEmail: async () => { liveCalled = true; return { ok: true, status: "valid" }; },
    });
    expect(r.blocked).toEqual({ status: "invalid", sub_status: null, suggestion: null });
    expect(liveCalled).toBe(false);
  });

  it("does not block on a fresh cached soft/valid verdict", async () => {
    const pool = fakePoolRecording();
    const r = await checkDraftEmail(pool, { leadId: "1", email: "ok@acme.com" }, {
      readVerifyCache: async () => ({
        email_verify_status: "catchall", email_verified_value: "ok@acme.com", email_verified_at: new Date().toISOString(),
      }),
    });
    expect(r.blocked).toBe(null);
  });

  it("ignores a cache entry for a DIFFERENT email (verified_value mismatch) and goes live", async () => {
    let liveCalled = false;
    const pool = fakePoolRecording();
    const r = await checkDraftEmail(pool, { leadId: "1", email: "new@acme.com" }, {
      readVerifyCache: async () => ({
        email_verify_status: "invalid", email_verified_value: "old@acme.com", email_verified_at: new Date().toISOString(),
      }),
      verifyEmail: async () => { liveCalled = true; return { ok: true, status: "valid" }; },
      writeVerifyCache: async () => {},
    });
    expect(liveCalled).toBe(true);
    expect(r.blocked).toBe(null);
  });

  it("no cache → goes live, blocks on hard-fail, and writes the CANONICAL cache value (not the raw provider string)", async () => {
    let written = null;
    const pool = fakePoolRecording();
    const r = await checkDraftEmail(pool, { leadId: "2", email: "bad@acme.com" }, {
      readVerifyCache: async () => null,
      verifyEmail: async () => ({ ok: false, status: "invalid", sub_status: null, suggestion: "good@acme.com" }),
      writeVerifyCache: async (p, leadId, payload) => { written = { leadId, payload }; },
    });
    // The BLOCK decision still reports the raw provider status back to the caller (that's just
    // relayed from verifyEmail(), unrelated to what's persisted)...
    expect(r.blocked).toEqual({ status: "invalid", sub_status: null, suggestion: "good@acme.com" });
    expect(written.leadId).toBe("2");
    // ...but what's PERSISTED to sdr_lead_state.email_verify_status must be the canonical
    // verdict ("hard_fail"), not the raw provider string ("invalid" happens to be a NeverBounce/
    // MillionVerifier raw value that canonicalizes to "hard_fail" — see VERDICT_MAP).
    expect(written.payload.status).toBe("hard_fail");
  });

  it("raw and canonical genuinely diverge (ZeroBounce 'spamtrap') → the DB write is canonical, never the raw string", async () => {
    let written = null;
    const pool = fakePoolRecording();
    const r = await checkDraftEmail(pool, { leadId: "6", email: "trap@acme.com" }, {
      readVerifyCache: async () => null,
      verifyEmail: async () => ({ ok: false, status: "spamtrap", sub_status: null, suggestion: null }),
      writeVerifyCache: async (p, leadId, payload) => { written = { leadId, payload }; },
    });
    expect(r.blocked).toEqual({ status: "spamtrap", sub_status: null, suggestion: null });
    expect(written.payload.status).toBe("hard_fail");
    expect(written.payload.status).not.toBe("spamtrap");
  });

  it("raw and canonical genuinely diverge (MillionVerifier 'ok') → the DB write is canonical 'valid', never the raw 'ok'", async () => {
    let written = null;
    const pool = fakePoolRecording();
    const r = await checkDraftEmail(pool, { leadId: "7", email: "good@acme.com" }, {
      readVerifyCache: async () => null,
      verifyEmail: async () => ({ ok: true, status: "ok" }),
      writeVerifyCache: async (p, leadId, payload) => { written = { leadId, payload }; },
    });
    expect(r.blocked).toBe(null);
    expect(written.payload.status).toBe("valid");
    expect(written.payload.status).not.toBe("ok");
  });

  it("no cache → goes live, passes on valid, writes the cache, does not block", async () => {
    let written = null;
    const pool = fakePoolRecording();
    const r = await checkDraftEmail(pool, { leadId: "3", email: "good@acme.com" }, {
      readVerifyCache: async () => null,
      verifyEmail: async () => ({ ok: true, status: "valid" }),
      writeVerifyCache: async (p, leadId, payload) => { written = { leadId, payload }; },
    });
    expect(r.blocked).toBe(null);
    expect(written.payload.status).toBe("valid");
  });

  it("verifyEmail skipped (fail-open, e.g. no key/timeout) → does not block, does not write cache", async () => {
    let writeCalled = false;
    const pool = fakePoolRecording();
    const r = await checkDraftEmail(pool, { leadId: "4", email: "x@acme.com" }, {
      readVerifyCache: async () => null,
      verifyEmail: async () => ({ ok: true, skipped: true }),
      writeVerifyCache: async () => { writeCalled = true; },
    });
    expect(r.blocked).toBe(null);
    expect(writeCalled).toBe(false);
  });

  it("stale cache (older than STALE_MS) is treated as absent and goes live", async () => {
    let liveCalled = false;
    const pool = fakePoolRecording();
    const veryOld = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(); // 200 days
    const r = await checkDraftEmail(pool, { leadId: "5", email: "x@acme.com" }, {
      readVerifyCache: async () => ({ email_verify_status: "invalid", email_verified_value: "x@acme.com", email_verified_at: veryOld }),
      verifyEmail: async () => { liveCalled = true; return { ok: true, status: "valid" }; },
      writeVerifyCache: async () => {},
    });
    expect(liveCalled).toBe(true);
    expect(r.blocked).toBe(null);
  });
});

// ── Hard cap: SDR_DRAFT_VERIFY_MAX_PER_RUN ──────────────────────────────────────────────────
describe("checkDraftEmail — per-run cap", () => {
  it(`stops making live verify calls once ${SDR_DRAFT_VERIFY_MAX_PER_RUN} have been made, and fails open (does not block) past the cap`, async () => {
    const pool = fakePoolRecording();
    let liveCalls = 0;
    const deps = {
      readVerifyCache: async () => null, // always force the live path
      writeVerifyCache: async () => {},
      verifyEmail: async () => { liveCalls++; return { ok: false, status: "invalid" }; }, // would BLOCK if it ran
    };
    for (let i = 0; i < SDR_DRAFT_VERIFY_MAX_PER_RUN; i++) {
      await checkDraftEmail(pool, { leadId: `cap-${i}`, email: `cap-${i}@acme.com` }, deps);
    }
    expect(liveCalls).toBe(SDR_DRAFT_VERIFY_MAX_PER_RUN);

    // The (cap+1)th call must NOT invoke verifyEmail, and must fail OPEN (not block) rather
    // than block on an un-checked address.
    const r = await checkDraftEmail(pool, { leadId: "cap-over", email: "cap-over@acme.com" }, deps);
    expect(liveCalls).toBe(SDR_DRAFT_VERIFY_MAX_PER_RUN); // unchanged — no additional live call
    expect(r.blocked).toBe(null);
  });
});
