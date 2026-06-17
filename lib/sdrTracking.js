// Self-hosted open/click tracking — gives per-lead opens + clicks WITHOUT Apollo's
// Professional webhook. We inject a 1x1 open-pixel + wrap links to redirect through
// our backend, keyed by draft id. Tracking hits feed /api/sdr/events/ingest (same
// dedup + side-effect pipeline as Apollo events).
//
// Deliverability note: for COLD email on warming mailboxes, a tracking domain can
// nick inboxing. Prefer a proswppp.co subdomain (PUBLIC_BASE_URL) over the raw
// railway.app host once volume ramps. Clicks are low-risk; the open pixel is the
// riskier bit (and Gmail proxies it anyway).

// 1x1 transparent GIF
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

/**
 * Inject open-pixel + wrap http(s) links so opens/clicks route through our backend.
 * Operates on the (HTML) email body. mailto: and already-wrapped links are left alone.
 * @param {string} htmlBody
 * @param {string} draftId - stable per-lead token
 * @param {string} base - public base URL (no trailing slash)
 */
export function injectTracking(htmlBody, draftId, base) {
  if (!htmlBody || !draftId || !base) return htmlBody;
  const trackBase = base.replace(/\/$/, "");
  // Wrap external http(s) links (skip ones already pointing at our tracker).
  let out = htmlBody.replace(/href="(https?:\/\/[^"]+)"/gi, (m, url) => {
    if (url.includes("/api/sdr/track/")) return m;
    return `href="${trackBase}/api/sdr/track/click/${draftId}?u=${encodeURIComponent(url)}"`;
  });
  // Append the open pixel.
  out += `<img src="${trackBase}/api/sdr/track/open/${draftId}" width="1" height="1" alt="" style="display:none;max-height:0;max-width:0;opacity:0">`;
  return out;
}

/**
 * Stable-ish dedupe key for a tracking hit. Opens bucket per hour (Gmail prefetches
 * the pixel repeatedly); clicks bucket per minute per destination.
 */
export function trackEventId(kind, draftId, url) {
  if (kind === "open") {
    const hour = Math.floor(Date.now() / 3_600_000);
    return `track:open:${draftId}:${hour}`;
  }
  const min = Math.floor(Date.now() / 60_000);
  const u = (url || "").slice(0, 80);
  return `track:click:${draftId}:${min}:${u}`;
}
