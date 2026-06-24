// Unified inbox over the .co Workspace mailboxes (dc@/jg@/th@proswppp.co), via
// per-mailbox OAuth (refresh token stored in sdr_inbox_accounts). Both SDR and the
// TX05 permit outreach ship from these mailboxes, so one inbox covers both channels.
// Raw fetch against Google's OAuth + Gmail REST APIs — no SDK dependency.

const OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "openid",
  "email",
];

function cfg() {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect:
      process.env.GOOGLE_OAUTH_REDIRECT ||
      `${process.env.PUBLIC_BASE_URL || "https://swppp-interface-production.up.railway.app"}/api/sdr/inbox/oauth/callback`,
  };
}

export function isConfigured() {
  const c = cfg();
  return !!(c.clientId && c.clientSecret);
}

// Step 1: the consent URL. access_type=offline + prompt=consent so Google returns a
// refresh token; login_hint nudges the user toward the mailbox they're connecting.
export function buildAuthUrl({ state, loginHint }) {
  const c = cfg();
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirect,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `${OAUTH_AUTH}?${p.toString()}`;
}

function decodeJwtEmail(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString("utf8"));
    return (payload.email || "").toLowerCase() || null;
  } catch {
    return null;
  }
}

// Step 2: exchange the auth code for tokens. Returns the granted mailbox email so the
// caller can bind the refresh token to the right sdr_mailbox.
export async function exchangeCode(code) {
  const c = cfg();
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirect,
      grant_type: "authorization_code",
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`token exchange failed: ${j.error || res.status} ${j.error_description || ""}`);
  const email = decodeJwtEmail(j.id_token) || (await fetchEmail(j.access_token));
  return { refreshToken: j.refresh_token || null, accessToken: j.access_token, email, expiresIn: j.expires_in };
}

async function fetchEmail(accessToken) {
  try {
    const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const j = await r.json();
    return (j.email || "").toLowerCase() || null;
  } catch {
    return null;
  }
}

// Exchange a stored refresh token for a fresh access token (cached by the caller).
export async function refreshAccessToken(refreshToken) {
  const c = cfg();
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`token refresh failed: ${j.error || res.status} ${j.error_description || ""}`);
  return { accessToken: j.access_token, expiresIn: j.expires_in };
}

async function gmail(accessToken, path, { method = "GET", body } = {}) {
  const res = await fetch(`${GMAIL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Gmail ${method} ${path} → ${res.status}: ${j.error?.message || ""}`);
    err.status = res.status;
    throw err;
  }
  return j;
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || null;
}

// Walk a Gmail payload tree → best-effort plain-text body (falls back to stripped HTML).
function extractBody(payload) {
  if (!payload) return "";
  const decode = (data) => Buffer.from((data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  if (payload.mimeType === "text/plain" && payload.body?.data) return decode(payload.body.data);
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decode(plain.body.data);
    const html = payload.parts.find((p) => p.mimeType === "text/html");
    if (html?.body?.data) return decode(html.body.data).replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n");
    for (const p of payload.parts) {
      const nested = extractBody(p);
      if (nested) return nested;
    }
  }
  if (payload.body?.data) return decode(payload.body.data);
  return "";
}

// List inbox threads (received mail). Returns light metadata per thread for the list view.
export async function listThreads(accessToken, { q = "in:inbox", maxResults = 25 } = {}) {
  const list = await gmail(accessToken, `/threads?q=${encodeURIComponent(q)}&maxResults=${maxResults}`);
  const threads = list.threads || [];
  const out = [];
  for (const t of threads) {
    const full = await gmail(accessToken, `/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
    const msgs = full.messages || [];
    const last = msgs[msgs.length - 1];
    const h = last?.payload?.headers;
    // SENT label on the last message → the latest activity in this thread is outbound
    // (a send). The overview uses this to label sends vs replies and to match the
    // counterparty on the To address (sends) as well as the From (replies).
    const lastOutbound = (last?.labelIds || []).includes("SENT");
    out.push({
      id: t.id,
      subject: header(h, "Subject"),
      from: header(h, "From"),
      to: header(h, "To"),
      date: header(h, "Date"),
      snippet: last?.snippet || t.snippet || "",
      messageCount: msgs.length,
      unread: msgs.some((m) => (m.labelIds || []).includes("UNREAD")),
      lastOutbound,
    });
  }
  return out;
}

// Full thread → all messages with decoded bodies + the headers needed to reply in-thread.
export async function getThread(accessToken, threadId) {
  const full = await gmail(accessToken, `/threads/${threadId}?format=full`);
  const messages = (full.messages || []).map((m) => {
    const h = m.payload?.headers;
    return {
      id: m.id,
      from: header(h, "From"),
      to: header(h, "To"),
      subject: header(h, "Subject"),
      date: header(h, "Date"),
      messageId: header(h, "Message-ID"),
      references: header(h, "References"),
      unread: (m.labelIds || []).includes("UNREAD"),
      body: extractBody(m.payload),
    };
  });
  return { id: threadId, messages };
}

function base64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Reply within a thread. Threads via In-Reply-To/References so Gmail keeps the conversation.
export async function sendReply(accessToken, { threadId, from, to, subject, bodyText, inReplyTo, references }) {
  const subj = /^re:/i.test(subject || "") ? subject : `Re: ${subject || ""}`.trim();
  const refs = [references, inReplyTo].filter(Boolean).join(" ").trim();
  const raw = base64url(
    [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subj}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
      refs ? `References: ${refs}` : null,
      'Content-Type: text/plain; charset="UTF-8"',
      "MIME-Version: 1.0",
      "",
      bodyText || "",
    ]
      .filter((x) => x !== null)
      .join("\r\n"),
  );
  return gmail(accessToken, `/messages/send`, { method: "POST", body: { raw, threadId } });
}

export async function markThreadRead(accessToken, threadId) {
  return gmail(accessToken, `/threads/${threadId}/modify`, {
    method: "POST",
    body: { removeLabelIds: ["UNREAD"] },
  });
}
