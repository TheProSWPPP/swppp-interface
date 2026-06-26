// Pre-send email verification — checks an address is deliverable BEFORE we enroll a lead in a
// sequence, so we stop burning sends (and sender reputation) on dead mailboxes and typo domains.
//
// Provider: ZeroBounce (https://www.zerobounce.net/docs/email-validation-api-quickstart/).
//   GET /v2/validate?api_key=KEY&email=ADDR → { status, sub_status, did_you_mean, ... }
//   status ∈ valid | invalid | catch-all | unknown | spamtrap | abuse | do_not_mail
//
// FAIL-OPEN by design: if no API key is set, or the API errors / times out, we DO NOT block the
// send (verifier downtime must never halt outreach). A lead is only blocked on a confident
// "this address is bad" verdict.
//
// Activate by setting EMAIL_VERIFY_API_KEY (ZeroBounce key) in the environment.

const ZB_BASE = "https://api.zerobounce.net/v2";

// Confident-bad verdicts → block the enroll. catch-all / unknown are deliberately ALLOWED
// (blocking catch-all domains would drop a large share of legitimate B2B addresses); they come
// back as soft flags so the caller can note them without stopping the send.
const HARD_FAIL = new Set(["invalid", "spamtrap", "abuse", "do_not_mail"]);
const SOFT_FLAG = new Set(["catch-all", "unknown"]);

function apiKey() {
  return process.env.EMAIL_VERIFY_API_KEY || process.env.ZEROBOUNCE_API_KEY || null;
}

export function verifyEnabled() {
  return !!apiKey();
}

/**
 * Verify a single email address.
 * Returns:
 *   { ok: true,  skipped: true }              → no key / error (fail-open, treat as sendable)
 *   { ok: true,  status, soft?: status }      → deliverable (soft set when catch-all/unknown)
 *   { ok: false, status, sub_status, suggestion } → confident bad address, block the enroll
 */
export async function verifyEmail(email, { timeoutMs = 8000 } = {}) {
  const key = apiKey();
  if (!key || !email || !/.+@.+\..+/.test(email)) return { ok: true, skipped: true };

  const url = new URL(`${ZB_BASE}/validate`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("email", email);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json();
    const status = String(data?.status || "").toLowerCase();
    if (!res.ok || !status) return { ok: true, skipped: true }; // API hiccup → fail-open
    if (HARD_FAIL.has(status)) {
      return {
        ok: false,
        status,
        sub_status: data?.sub_status || null,
        suggestion: data?.did_you_mean || null, // ZeroBounce typo fix (gmai→gmail)
      };
    }
    return { ok: true, status, soft: SOFT_FLAG.has(status) ? status : undefined, suggestion: data?.did_you_mean || null };
  } catch {
    return { ok: true, skipped: true }; // timeout / network → fail-open
  } finally {
    clearTimeout(timer);
  }
}

// Remaining ZeroBounce credits (for a health/status surface). null if no key or on error.
export async function remainingCredits() {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch(`${ZB_BASE}/getcredits?api_key=${encodeURIComponent(key)}`);
    const data = await res.json();
    const n = Number(data?.Credits);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
