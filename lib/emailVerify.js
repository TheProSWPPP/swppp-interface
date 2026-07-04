// Pre-send email verification — checks an address is deliverable BEFORE we enroll a lead in a
// sequence, so we stop burning sends (and sender reputation) on dead mailboxes and typo domains.
//
// Provider-pluggable: MillionVerifier, ZeroBounce, or NeverBounce (pick whichever account).
//   MillionVerifier: GET /api/v3/?api=KEY&email=ADDR
//                    result ∈ ok | catch_all | unknown | disposable | invalid | error
//   ZeroBounce:      GET /v2/validate?api_key=KEY&email=ADDR
//                    status ∈ valid | invalid | catch-all | unknown | spamtrap | abuse | do_not_mail
//   NeverBounce:     GET /v4/single/check?key=KEY&email=ADDR
//                    result ∈ valid | invalid | disposable | catchall | unknown
//
// FAIL-OPEN by design: if no API key is set, or the API errors / times out, we DO NOT block the
// send (verifier downtime must never halt outreach). A lead is only blocked on a confident
// "this address is bad" verdict (the "red" results). catch-all / unknown pass through as soft
// flags (blocking them would drop a large share of legitimate B2B addresses).
//
// Activate by setting ONE of:
//   MILLIONVERIFIER_API_KEY → MillionVerifier
//   ZEROBOUNCE_API_KEY      → ZeroBounce
//   NEVERBOUNCE_API_KEY     → NeverBounce
//   EMAIL_VERIFY_API_KEY (+ optional EMAIL_VERIFY_PROVIDER=millionverifier|zerobounce|neverbounce)

const ZB_BASE = "https://api.zerobounce.net/v2";
const NB_BASE = "https://api.neverbounce.com/v4";
const MV_BASE = "https://api.millionverifier.com/api/v3";

// Resolve which provider + key to use. Explicit EMAIL_VERIFY_PROVIDER wins; otherwise we infer
// from whichever provider-specific key is present.
function resolveProvider() {
  const explicit = (process.env.EMAIL_VERIFY_PROVIDER || "").toLowerCase();
  const generic = process.env.EMAIL_VERIFY_API_KEY || null;
  const mvKey = process.env.MILLIONVERIFIER_API_KEY || null;
  const zbKey = process.env.ZEROBOUNCE_API_KEY || null;
  const nbKey = process.env.NEVERBOUNCE_API_KEY || null;
  if (explicit === "millionverifier") return { provider: "millionverifier", key: mvKey || generic };
  if (explicit === "neverbounce") return { provider: "neverbounce", key: nbKey || generic };
  if (explicit === "zerobounce") return { provider: "zerobounce", key: zbKey || generic };
  if (mvKey) return { provider: "millionverifier", key: mvKey };
  if (nbKey) return { provider: "neverbounce", key: nbKey };
  if (zbKey) return { provider: "zerobounce", key: zbKey };
  if (generic) return { provider: "zerobounce", key: generic }; // default provider
  return { provider: null, key: null };
}

export function verifyEnabled() {
  return !!resolveProvider().key;
}

// Diagnostic summary: which provider actually resolves live + which keys are present. Returns NO
// secret values — booleans + the resolved provider name only — so a status endpoint can confirm
// exactly one verifier is firing (and which), catching a stale EMAIL_VERIFY_PROVIDER override.
export function activeProvider() {
  const { provider, key } = resolveProvider();
  return {
    provider,
    hasKey: !!key,
    explicitOverride: (process.env.EMAIL_VERIFY_PROVIDER || "").toLowerCase() || null,
    keysPresent: {
      millionverifier: !!process.env.MILLIONVERIFIER_API_KEY,
      neverbounce: !!process.env.NEVERBOUNCE_API_KEY,
      zerobounce: !!process.env.ZEROBOUNCE_API_KEY,
      generic: !!process.env.EMAIL_VERIFY_API_KEY,
    },
  };
}

// Confident-bad ("red") verdicts → block the enroll. catch-all / unknown are deliberately
// ALLOWED as soft flags so the caller can note them without stopping the send.
const ZB_HARD_FAIL = new Set(["invalid", "spamtrap", "abuse", "do_not_mail"]);
const ZB_SOFT = new Set(["catch-all", "unknown"]);
const NB_HARD_FAIL = new Set(["invalid", "disposable"]);
const NB_SOFT = new Set(["catchall", "unknown"]);
const MV_HARD_FAIL = new Set(["invalid", "disposable"]);
const MV_SOFT = new Set(["catch_all", "unknown"]);

async function fetchJson(url, { timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json();
    return { ok: res.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a single email address (provider-agnostic result).
 * Returns:
 *   { ok: true,  skipped: true }              → no key / error (fail-open, treat as sendable)
 *   { ok: true,  status, soft?: status }      → deliverable (soft set when catch-all/unknown)
 *   { ok: false, status, sub_status, suggestion } → confident bad address, block the enroll
 */
export async function verifyEmail(email, { timeoutMs = 8000 } = {}) {
  const { provider, key } = resolveProvider();
  if (!provider || !key || !email || !/.+@.+\..+/.test(email)) return { ok: true, skipped: true };

  try {
    if (provider === "millionverifier") {
      const url = new URL(`${MV_BASE}/`);
      url.searchParams.set("api", key);
      url.searchParams.set("email", email);
      const { ok, data } = await fetchJson(url, { timeoutMs });
      const result = String(data?.result || "").toLowerCase();
      if (!ok || !result || result === "error") return { ok: true, skipped: true };
      if (MV_HARD_FAIL.has(result)) return { ok: false, status: result, sub_status: data?.subresult || null, suggestion: data?.didyoumean || null };
      return { ok: true, status: result, soft: MV_SOFT.has(result) ? result : undefined, suggestion: data?.didyoumean || null };
    }
    if (provider === "neverbounce") {
      const url = new URL(`${NB_BASE}/single/check`);
      url.searchParams.set("key", key);
      url.searchParams.set("email", email);
      const { ok, data } = await fetchJson(url, { timeoutMs });
      const result = String(data?.result || "").toLowerCase();
      if (!ok || data?.status !== "success" || !result) return { ok: true, skipped: true };
      if (NB_HARD_FAIL.has(result)) return { ok: false, status: result, sub_status: null, suggestion: data?.suggested_correction || null };
      return { ok: true, status: result, soft: NB_SOFT.has(result) ? result : undefined, suggestion: data?.suggested_correction || null };
    }
    // default: ZeroBounce
    const url = new URL(`${ZB_BASE}/validate`);
    url.searchParams.set("api_key", key);
    url.searchParams.set("email", email);
    const { ok, data } = await fetchJson(url, { timeoutMs });
    const status = String(data?.status || "").toLowerCase();
    if (!ok || !status) return { ok: true, skipped: true };
    if (ZB_HARD_FAIL.has(status)) return { ok: false, status, sub_status: data?.sub_status || null, suggestion: data?.did_you_mean || null };
    return { ok: true, status, soft: ZB_SOFT.has(status) ? status : undefined, suggestion: data?.did_you_mean || null };
  } catch {
    return { ok: true, skipped: true }; // timeout / network → fail-open
  }
}

// Remaining verification credits (for a health/status surface). null if no key or on error.
export async function remainingCredits() {
  const { provider, key } = resolveProvider();
  if (!provider || !key) return null;
  try {
    if (provider === "millionverifier") {
      const { data } = await fetchJson(`${MV_BASE}/credits?api=${encodeURIComponent(key)}`, { timeoutMs: 8000 });
      const n = Number(data?.credits);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    if (provider === "neverbounce") {
      const { data } = await fetchJson(`${NB_BASE}/account/info?key=${encodeURIComponent(key)}`, { timeoutMs: 8000 });
      const n = Number(data?.credits_info?.paid_credits_remaining);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    const { data } = await fetchJson(`${ZB_BASE}/getcredits?api_key=${encodeURIComponent(key)}`, { timeoutMs: 8000 });
    const n = Number(data?.Credits);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
