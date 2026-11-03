// No-cookie Apify reads for LinkedIn research. Nothing here touches a client LinkedIn seat.
// An empty dataset from a query that should have results is an error (apify_empty_result),
// never "0 found": Apify can return an empty but SUCCEEDED run when a source is down.
const fail = (code, status) => Object.assign(new Error(code), { code, ...(status ? { status } : {}) });

// Pinned actors. Verify the ids and the input enum formats on the first real run (go-live step).
export const APIFY_ACTORS = Object.freeze({
  profileSearch: 'harvestapi~linkedin-profile-search',
  profileScraper: 'harvestapi~linkedin-profile-scraper',
  postSearch: 'harvestapi~linkedin-post-search',
});

export const apifyMaxItems = () => {
  const value = Number.parseInt(process.env.SDR_LINKEDIN_APIFY_MAX_ITEMS_PER_RUN || '100', 10);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 1000) : 100;
};

export function createApifyClient({ token = process.env.APIFY_TOKEN, transport = fetch, baseUrl = 'https://api.apify.com/v2' } = {}) {
  async function runActor({ actor, input, timeoutSecs = 240, allowEmpty = false }) {
    if (!token) throw fail('apify_unconfigured');
    if (!Object.values(APIFY_ACTORS).includes(actor)) throw fail('apify_actor_unpinned');
    const url = new URL(`${baseUrl}/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items`);
    url.searchParams.set('token', token);
    url.searchParams.set('timeout', String(timeoutSecs));
    let response;
    // Messages never carry the URL: it holds the token.
    try { response = await transport(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input || {}) }); }
    catch { throw fail('apify_unavailable'); }
    if (!response?.ok) throw fail(response?.status === 401 || response?.status === 403 ? 'apify_authentication' : response?.status === 402 ? 'apify_budget' : 'apify_rejected', response?.status);
    let items;
    try { items = await response.json(); } catch { throw fail('apify_invalid_result'); }
    if (!Array.isArray(items)) throw fail('apify_invalid_result');
    if (!items.length && !allowEmpty) throw fail('apify_empty_result');
    return items;
  }
  return { configured: Boolean(token), runActor };
}
