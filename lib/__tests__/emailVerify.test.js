// lib/__tests__/emailVerify.test.js
import { describe, it, expect, afterEach } from "vitest";
import { canonicalVerdict, activeProvider, verifyEnabled } from "../emailVerify.js";

// canonicalVerdict() must handle every raw string every one of the three providers can emit
// (enumerated straight from the file header of lib/emailVerify.js, not from memory), plus its
// own already-canonical output (idempotency), plus garbage.
describe("canonicalVerdict — full provider vocabulary", () => {
  // MillionVerifier: ok | catch_all | unknown | disposable | invalid | error
  it.each([
    ["ok", "valid"],
    ["catch_all", "soft"],
    ["unknown", "soft"],
    ["disposable", "hard_fail"],
    ["invalid", "hard_fail"],
    ["error", "skipped"],
  ])("MillionVerifier %s → %s", (raw, expected) => {
    expect(canonicalVerdict(raw)).toBe(expected);
  });

  // ZeroBounce: valid | invalid | catch-all | unknown | spamtrap | abuse | do_not_mail
  it.each([
    ["valid", "valid"],
    ["invalid", "hard_fail"],
    ["catch-all", "soft"],
    ["unknown", "soft"],
    ["spamtrap", "hard_fail"],
    ["abuse", "hard_fail"],
    ["do_not_mail", "hard_fail"],
  ])("ZeroBounce %s → %s", (raw, expected) => {
    expect(canonicalVerdict(raw)).toBe(expected);
  });

  // NeverBounce: valid | invalid | disposable | catchall | unknown
  it.each([
    ["valid", "valid"],
    ["invalid", "hard_fail"],
    ["disposable", "hard_fail"],
    ["catchall", "soft"],
    ["unknown", "soft"],
  ])("NeverBounce %s → %s", (raw, expected) => {
    expect(canonicalVerdict(raw)).toBe(expected);
  });

  it("is idempotent on its own canonical outputs", () => {
    expect(canonicalVerdict("valid")).toBe("valid");
    expect(canonicalVerdict("soft")).toBe("soft");
    expect(canonicalVerdict("hard_fail")).toBe("hard_fail");
    expect(canonicalVerdict("skipped")).toBe("skipped");
  });

  it("is case/whitespace insensitive", () => {
    expect(canonicalVerdict("  INVALID  ")).toBe("hard_fail");
    expect(canonicalVerdict("Catch-All")).toBe("soft");
  });

  it("falls open (skipped) on null/undefined/empty/unrecognized — never guesses a block", () => {
    expect(canonicalVerdict(null)).toBe("skipped");
    expect(canonicalVerdict(undefined)).toBe("skipped");
    expect(canonicalVerdict("")).toBe("skipped");
    expect(canonicalVerdict("some_new_provider_status_nobody_mapped_yet")).toBe("skipped");
  });

  it("no raw string from any of the three providers falls into an unintended bucket", () => {
    const ALL_HARD_FAIL_RAW = ["invalid", "disposable", "spamtrap", "abuse", "do_not_mail"];
    const ALL_SOFT_RAW = ["catch_all", "catch-all", "catchall", "unknown"];
    const ALL_VALID_RAW = ["ok", "valid"];
    for (const s of ALL_HARD_FAIL_RAW) expect(canonicalVerdict(s)).toBe("hard_fail");
    for (const s of ALL_SOFT_RAW) expect(canonicalVerdict(s)).toBe("soft");
    for (const s of ALL_VALID_RAW) expect(canonicalVerdict(s)).toBe("valid");
    expect(canonicalVerdict("error")).toBe("skipped");
  });
});

// activeProvider()/verifyEnabled() env-permutation truth table — the trap case (both a
// NeverBounce and a MillionVerifier key set) must resolve to MillionVerifier (resolveProvider()'s
// documented preference order), and any downstream gate reading activeProvider() (never key
// presence) must reflect that, not silently assume NeverBounce.
describe("activeProvider() — resolution across key permutations", () => {
  const KEYS = ["MILLIONVERIFIER_API_KEY", "NEVERBOUNCE_API_KEY", "ZEROBOUNCE_API_KEY", "EMAIL_VERIFY_API_KEY", "EMAIL_VERIFY_PROVIDER"];
  const saved = {};
  const clearAll = () => { for (const k of KEYS) delete process.env[k]; };

  afterEach(() => {
    clearAll();
    for (const k of KEYS) if (saved[k] !== undefined) process.env[k] = saved[k];
  });

  it("no keys → no provider, disabled", () => {
    clearAll();
    const a = activeProvider();
    expect(a.provider).toBe(null);
    expect(a.hasKey).toBe(false);
    expect(verifyEnabled()).toBe(false);
  });

  it("NeverBounce key only → resolves neverbounce", () => {
    clearAll();
    process.env.NEVERBOUNCE_API_KEY = "nb-key";
    const a = activeProvider();
    expect(a.provider).toBe("neverbounce");
    expect(a.hasKey).toBe(true);
  });

  it("MillionVerifier key only → resolves millionverifier", () => {
    clearAll();
    process.env.MILLIONVERIFIER_API_KEY = "mv-key";
    expect(activeProvider().provider).toBe("millionverifier");
  });

  it("ZeroBounce key only → resolves zerobounce", () => {
    clearAll();
    process.env.ZEROBOUNCE_API_KEY = "zb-key";
    expect(activeProvider().provider).toBe("zerobounce");
  });

  it("TRAP CASE: both NeverBounce and MillionVerifier keys set → resolves millionverifier, NOT neverbounce", () => {
    clearAll();
    process.env.NEVERBOUNCE_API_KEY = "nb-key";
    process.env.MILLIONVERIFIER_API_KEY = "mv-key";
    const a = activeProvider();
    expect(a.provider).toBe("millionverifier");
    expect(a.keysPresent.neverbounce).toBe(true);
    expect(a.keysPresent.millionverifier).toBe(true);
  });

  it("explicit EMAIL_VERIFY_PROVIDER override wins over key-presence order", () => {
    clearAll();
    process.env.NEVERBOUNCE_API_KEY = "nb-key";
    process.env.MILLIONVERIFIER_API_KEY = "mv-key";
    process.env.EMAIL_VERIFY_PROVIDER = "zerobounce";
    process.env.ZEROBOUNCE_API_KEY = "zb-key";
    expect(activeProvider().provider).toBe("zerobounce");
  });
});
