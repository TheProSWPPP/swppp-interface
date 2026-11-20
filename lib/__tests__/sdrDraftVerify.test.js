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

describe("checkDraftEmail", () => {
  it("blocks a cached or live hard-fail, including the suggested correction", async () => {
    const result = { ok:false, status:"spamtrap", sub_status:null, suggestion:"other@example.test" };
    const checkSdrAddress = async (_pool, target) => {
      expect(target).toEqual({ leadId:"1", email:"a@example.test" });
      return result;
    };
    const {blocked} = await checkDraftEmail({}, { leadId:"1", email:"a@example.test" }, {checkSdrAddress});
    expect(blocked).toEqual({ status:"spamtrap", sub_status:null, suggestion:"other@example.test" });
  });

  it.each(["valid","soft","skipped"])("permits %s through the draft checkpoint", async status => {
    const checkSdrAddress = async () => ({ok:true,status,skipped:status==="skipped"});
    expect((await checkDraftEmail({}, {leadId:"1",email:"a@example.test"}, {checkSdrAddress})).blocked).toBeNull();
  });
});

// ── Hard cap: SDR_DRAFT_VERIFY_MAX_PER_RUN ──────────────────────────────────────────────────
describe("checkDraftEmail — per-run cap", () => {
  it(`stops making live verify calls once ${SDR_DRAFT_VERIFY_MAX_PER_RUN} have been made, and fails open (does not block) past the cap`, async () => {
    const pool = {};
    let liveCalls = 0;
    const deps = {
      checkSdrAddress: (_pool, { email }, { verifyEmail }) => verifyEmail(email),
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
