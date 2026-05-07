# cmd-scraper

Playwright service for scraping CMD Insight bidder + contacts pages.
Replaces Browserless calls in n8n. Browserless stays as fallback in n8n IF nodes.

## Endpoints

All POST endpoints require `x-api-key: $SCRAPER_API_KEY` header (or omit auth in dev when env var is unset).

### `GET /health`
```json
{ "ok": true, "browser_connected": true, "login_age_seconds": 1240, "queue_depth": 0, "busy": false }
```

### `POST /cmd/scrape-bidder`
```json
// request
{ "project_url": "https://insight.cmdgroup.com/Project/Home/ProjectInformation/1007823561/1/72024461" }

// response
{
  "ok": true,
  "bidder": {
    "company": "Highland Paving Inc",
    "address": "...", "phone": "...", "email": "...",
    "companyId": "12345", "companyUrl": "https://insight.cmdgroup.com/Company/Home/CompanyInformation/12345",
    "bidRank": "1", "biddingRole": "Apparent Low"
  },
  "military": { "matched": null },
  "page_url": "...",
  "login_age_seconds": 12
}
```

### `POST /cmd/scrape-contacts`
```json
// request
{ "company_url": "https://insight.cmdgroup.com/Company/Home/CompanyInformation/12345" }

// response
{ "ok": true, "contacts": [{ "name": "...", "email": "...", ... }], "source": "extjs", "login_age_seconds": 24 }
```

### `POST /cmd/relogin`
Force a fresh login. Use after CMD password rotation or if the session goes weird.

## Environment variables

| var | required | default | notes |
|---|---|---|---|
| `SCRAPER_API_KEY` | recommended | (none) | shared with n8n; if unset, no auth |
| `CMD_USER` | yes | `dchinners@XpressSW3P.com` | CMD login email |
| `CMD_PASS` | yes | (default for backup) | CMD password — rotate via env, not code |
| `PORT` | no | `3000` | Railway sets this automatically |
| `LOGIN_TTL_MS` | no | `3600000` (1h) | re-login if older than this |
| `NAV_TIMEOUT_MS` | no | `60000` | page nav timeout |

## Deploy

Railway auto-detects the Dockerfile. Set the env vars above in the Railway service.
The Playwright official Docker image (`mcr.microsoft.com/playwright:v1.49.1-noble`) ships all browser deps.

## How n8n calls it

CMD Per-Lead Processor and CMD Insight Daily Update workflows have an HTTP node hitting this service first; on error or timeout, an IF branch falls back to Browserless.
