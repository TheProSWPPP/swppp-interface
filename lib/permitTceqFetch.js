// Fetch a single TCEQ wq_dpa detail page. Returns rendered HTML/text, or null.
// Primary: plain HTTPS fetch (page is server-rendered HTML). Fallback: Browserless
// residential proxy, used only when BROWSERLESS_TOKEN is set (TCEQ blocked the host IP).

const TCEQ_URL = (permit) =>
  `https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.validate_permit&permit_number=${encodeURIComponent(permit)}`;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const isAuth = (html) => !!html && /Summary of Authorization|Water Quality General Permits/i.test(html);

async function plainFetch(permit) {
  const r = await fetch(TCEQ_URL(permit), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) return null;
  const html = await r.text();
  return isAuth(html) ? html : null;
}

async function browserlessFetch(permit, token) {
  const endpoint = `https://chrome.browserless.io/content?token=${token}&proxy=residential&blockConsentModals=true`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: TCEQ_URL(permit) }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) return null;
  const html = await r.text();
  return isAuth(html) ? html : null;
}

export async function fetchTceqDetail(permit, { token = process.env.BROWSERLESS_TOKEN } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const html = token ? await browserlessFetch(permit, token) : await plainFetch(permit);
      if (html) return html;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 1500 * attempt));
  }
  return null;
}
