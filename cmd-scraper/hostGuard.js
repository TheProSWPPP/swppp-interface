// Only CMD Insight links may be opened by this service, which holds a logged-in CMD session.
// A BuildingConnected, ConstructConnect or iSqFt link (a bid invite) must never be scraped
// here: the n8n CMD Per-Lead Processor only guards on status and "is it http(s)", and a bid
// invite's Quick Link passes that.

/** true for https://insight.cmdgroup.com/... and any other *.cmdgroup.com host. */
export function isCmdUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  return host === "cmdgroup.com" || host.endsWith(".cmdgroup.com");
}

/** null when the link is a CMD link, else the 400 the route must answer with. */
export function refuseNonCmdUrl(raw, field) {
  if (isCmdUrl(raw)) return null;
  return { status: 400, body: { ok: false, error: "not_a_cmd_url", message: `${field} must be a cmdgroup.com link` } };
}
