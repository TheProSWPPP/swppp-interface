// CMD Insight scraper — Playwright on Railway, persistent login, JSON API.
// Endpoints:
//   POST /cmd/scrape-bidder   { project_url } → { ok, bidder, military_hint, login_age_seconds }
//   POST /cmd/scrape-contacts { company_url } → { ok, contacts, source }
//   GET  /health              { ok, login_age_seconds, browser_ok }
//
// Auth: header `x-api-key: ${SCRAPER_API_KEY}`.
// Login is held in memory across requests; re-login is automatic if session expires
// or any nav redirects back to the login page.

import express from "express";
import { chromium } from "playwright";

const PORT = parseInt(process.env.PORT || "3000", 10);
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || "";
const CMD_USER = process.env.CMD_USER || "dchinners@XpressSW3P.com";
const CMD_PASS = process.env.CMD_PASS || "$$WWppp2025";
const LOGIN_URL = "https://insight.cmdgroup.com/Account/Login";
const LOGIN_TTL_MS = parseInt(process.env.LOGIN_TTL_MS || "3600000", 10); // 1h
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || "60000", 10);

const app = express();
app.use(express.json({ limit: "1mb" }));

// === Browser pool — single browser, single context; serialize requests via mutex ===
let browser = null;
let context = null;
let page = null;
let loginAt = 0;
const queue = [];
let busy = false;

async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  console.log("Launching Chromium...");
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/Chicago",
  });
  // Light stealth: hide webdriver, fix navigator.plugins length
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  loginAt = 0;
  console.log("Chromium launched.");
}

async function login() {
  await ensureBrowser();
  console.log("Logging into CMD...");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle" });
  await page.fill(
    'input#Username, input[name="Username"], input[name="username"], input#Email, input[name="Email"], input[type="email"]',
    CMD_USER
  );
  await page.fill(
    'input#Password, input[name="Password"], input[name="password"], input[type="password"]',
    CMD_PASS
  );
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS }).catch(() => null),
    page.evaluate(() => {
      const form = document.querySelector('form:has(input[type="password"])');
      if (!form) return "no form";
      const btn = form.querySelector('button[type=submit], input[type=submit]');
      if (btn) { btn.click(); return "clicked"; }
      form.submit();
      return "submitted";
    }),
  ]);
  loginAt = Date.now();
  console.log("Login complete.");
}

async function ensureLoggedIn() {
  await ensureBrowser();
  const stale = !loginAt || Date.now() - loginAt > LOGIN_TTL_MS;
  if (stale) {
    await login();
    return;
  }
  // Light probe — if last nav redirected to login page, force re-login
  const url = page.url();
  if (url.includes("/Account/Login") || url.includes("ReturnUrl")) {
    await login();
  }
}

// === Mutex queue (one scrape at a time per browser) ===
// QUEUE_TIMEOUT_MS: max time a request may wait in queue before being rejected.
// Once drain() picks up the request, the timer is cancelled — the scrape itself
// runs until NAV_TIMEOUT_MS, not this limit.
const QUEUE_TIMEOUT_MS = parseInt(process.env.QUEUE_TIMEOUT_MS || "75000", 10);
function withLock(fn) {
  return new Promise((resolve, reject) => {
    let queueTimer = setTimeout(() => {
      const idx = queue.findIndex((q) => q.cancelTimer === cancelTimer);
      if (idx !== -1) queue.splice(idx, 1);
      reject(Object.assign(new Error("Queue wait timeout — scraper busy"), { queueTimeout: true }));
    }, QUEUE_TIMEOUT_MS);
    const cancelTimer = () => { clearTimeout(queueTimer); queueTimer = null; };
    queue.push({ fn, resolve, reject, cancelTimer });
    drain();
  });
}
async function drain() {
  if (busy) return;
  const next = queue.shift();
  if (!next) return;
  busy = true;
  next.cancelTimer(); // stop queue-wait timer — we're processing now
  try {
    const result = await next.fn();
    next.resolve(result);
  } catch (e) {
    next.reject(e);
  } finally {
    busy = false;
    drain();
  }
}

// Mirrors mapProjectStage in bids-processor/index.js — keep in sync.
// Handles both FTP format ("Low Bids Announced") and CMD DOM format
// ("Post Bid - Low Bids Announced") by exact match first, then keyword fallback.
function mapProjectStage(stage) {
  if (!stage) return stage;
  if (['Pre-Bid', 'Bid Date Set', 'Biddate Set', 'Schematic Design', 'Design Development'].includes(stage)) return 'Pre-Bid';
  if (['Open Bid', 'SUBBIDS: ASAP'].includes(stage)) return 'OB';
  if (['Low Bid Apparent', 'Low Bid / Apparent', 'Low Bids Announced'].includes(stage)) return 'LBA';
  if (['Post-Bid - General Contractor Award', 'Post Bid - General Contractor Award', 'Architectural General Contracting', 'General Contractor Award'].includes(stage)) return 'AGC';
  if (stage === 'Post Bid') return 'PB';
  if (['General Contract', 'Construction Underway'].includes(stage)) return 'GC';
  if (stage === 'Construction Manager') return 'CM';
  if (['Construction Documents', 'Pre-Design'].includes(stage)) return 'CD';
  const s = stage.toLowerCase();
  if (s.includes('general contractor award') || s.includes('gc award')) return 'AGC';
  if (s.includes('low bid') || s.includes('low bids announced')) return 'LBA';
  if (s.includes('construction underway') || s.includes('general contract')) return 'GC';
  if (s.includes('construction manager')) return 'CM';
  if (s.includes('construction documents') || s.includes('pre-design')) return 'CD';
  if (s.includes('open bid') || s.includes('subbids')) return 'OB';
  if (s.startsWith('pre-bid') || s.includes('bid date set') || s.includes('biddate set') || s.includes('schematic design') || s.includes('design development')) return 'Pre-Bid';
  if (s === 'post bid' || s.startsWith('post bid') || s.startsWith('post-bid')) return 'PB';
  return stage;
}

// === Scrape: project page → bidder grid + military hint ===
async function scrapeBidder(projectUrl) {
  await ensureLoggedIn();
  try {
    await page.goto(projectUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
  } catch {
    await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(3000);
  }
  // If we landed on login, our session expired — re-login and retry once
  if (page.url().includes("/Account/Login")) {
    await login();
    try {
      await page.goto(projectUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
    } catch {
      await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(3000);
    }
  }

  // Extract stage FIRST — the snapshot panel loads before the bidder grid, so we
  // can still return useful stage data for pre-bid projects that lack div#bv.
  // Saves wasted Browserless fallbacks downstream when CMD genuinely has no grid yet.
  const rawStageEarly = await page.evaluate(() => {
    const stageLabel = Array.from(document.querySelectorAll("span.snapshot-label-small"))
      .find(el => el.textContent.trim() === "Stage");
    return stageLabel ? (stageLabel.nextElementSibling?.textContent?.trim() || "") : "";
  });

  let bidderGridVisible = true;
  try {
    await page.waitForSelector("div#bv", { timeout: 15000 });
  } catch {
    bidderGridVisible = false;
  }

  if (!bidderGridVisible) {
    // Page loaded successfully but no bidder grid (pre-bid or no rank yet).
    // Return stage data so downstream can update Pipedrive without falling back to BL.
    return {
      bidder: null,
      military: { matched: null },
      stage: mapProjectStage(rawStageEarly),
      raw_stage: rawStageEarly,
      page_url: page.url(),
      note: "no_bidder_grid",
    };
  }

  // Click "show more" bidders if present
  await page.evaluate(() => {
    const lnk = document.querySelector("#lnkBidder");
    if (lnk && lnk.offsetParent !== null) lnk.click();
  });
  await page.waitForTimeout(3000);

  const bidder = await page.evaluate(() => {
    const grid = document.querySelector("div#bv");
    if (!grid) return { error: "Grid not found" };
    const tables = grid.querySelectorAll('table[role="presentation"]');
    for (const table of tables) {
      const cells = table.querySelectorAll("td.x-grid-cell");
      const cellTexts = Array.from(cells).map((cell) => {
        const div = cell.querySelector("div.x-grid-cell-inner");
        return div ? div.textContent.trim() : "";
      });
      const bidRank = cellTexts[8] || "";
      const biddingRole = cellTexts[7] || "";
      if (
        bidRank === "1" ||
        biddingRole.includes("Apparent Low") ||
        biddingRole.includes("Awarded")
      ) {
        const companyCell = cells[0];
        const link = companyCell ? companyCell.querySelector("a") : null;
        let companyId = "";
        let companyUrl = "";
        if (link) {
          const onclickAttr = link.getAttribute("onclick");
          const hrefAttr = link.getAttribute("href");
          if (onclickAttr) {
            const m = onclickAttr.match(/navigateToDetailsPage\('([^']+)','([^']+)','([^']+)'\)/);
            if (m) companyId = m[1];
          }
          if (!companyId && hrefAttr) {
            const m = hrefAttr.match(/CompanyInformation\/(\d+)/);
            if (m) companyId = m[1];
          }
          if (companyId) {
            const numericId = companyId.replace(/\|.*$/, "");
            companyUrl =
              "https://insight.cmdgroup.com/Company/Home/CompanyInformation/" + numericId;
          }
        }
        return {
          company: cellTexts[0] || "",
          address: cellTexts[4] || "",
          phone: cellTexts[5] || "",
          email: cellTexts[6] || "",
          companyId,
          companyUrl,
          bidRank,
          biddingRole,
        };
      }
    }
    const debug = [];
    for (let i = 0; i < Math.min(3, tables.length); i++) {
      const cells = tables[i].querySelectorAll("td.x-grid-cell");
      debug.push(
        Array.from(cells).map((c) => {
          const d = c.querySelector("div.x-grid-cell-inner");
          return d ? d.textContent.trim() : "";
        })
      );
    }
    return { error: "Bid Rank 1 not found", totalBidders: tables.length, firstBidders: debug };
  });

  const military = await page.evaluate(() => {
    const text = (document.body.innerText || "").toLowerCase();
    const KW = [
      "us navy",
      "navfac",
      "naval facilities",
      "usace",
      "us army corps",
      "army corps of engineers",
      "us army",
      "u.s. army",
      "air force",
      "marine corps",
      "national guard",
      "department of defense",
      "dod",
      "department of the navy",
      "department of the army",
      "department of the air force",
    ];
    for (const k of KW) if (text.includes(k)) return { matched: k };
    return { matched: null };
  });

  const stage = mapProjectStage(rawStageEarly);

  return { bidder, military, stage, raw_stage: rawStageEarly, page_url: page.url() };
}

// === Scrape: company page → all contacts ===
async function scrapeContacts(companyUrl) {
  await ensureLoggedIn();
  try {
    await page.goto(companyUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
  } catch {
    // networkidle timeout — try domcontentloaded instead
    await page.goto(companyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(5000);
  }
  if (page.url().includes("/Account/Login")) {
    await login();
    try {
      await page.goto(companyUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
    } catch {
      await page.goto(companyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(5000);
    }
  }
  await page.waitForTimeout(5000);

  await page.evaluate(() => {
    const lnk = document.querySelector("#lnkContact");
    if (lnk && lnk.offsetParent !== null) lnk.click();
  });
  await page.waitForTimeout(3000);

  return await page.evaluate(() => {
    const grid = document.querySelector("#grdCompanyContact");
    if (grid) {
      const tables = grid.querySelectorAll('table[role="presentation"]');
      const contacts = [];
      const seen = new Set();
      for (const t of tables) {
        const cells = t.querySelectorAll("td.x-grid-cell");
        const ct = Array.from(cells).map((c) => {
          const d = c.querySelector("div.x-grid-cell-inner");
          return d ? d.textContent.trim() : "";
        });
        if (ct.length >= 6) {
          const name = ct[0] || "";
          const email = ct[6] || "";
          const key = name + "|" + email;
          if (name && !seen.has(key)) {
            seen.add(key);
            contacts.push({
              name,
              address: ct[1] || "",
              city: ct[2] || "",
              state: ct[3] || "",
              zip: ct[4] || "",
              phone: ct[5] || "",
              email,
              fax: ct[7] || "",
              status: ct[8] || "",
            });
          }
        }
      }
      if (contacts.length > 0) return { contacts, source: "extjs" };
    }
    // Fallback: parse generic HTML tables
    const allTables = document.querySelectorAll("table");
    for (const t of allTables) {
      const headers = Array.from(t.querySelectorAll("th")).map((th) =>
        th.textContent.trim().toLowerCase()
      );
      const headerText = headers.join(" ");
      if (headerText.includes("name") && (headerText.includes("email") || headerText.includes("phone"))) {
        const nameIdx = headers.findIndex((h) => h.includes("name") && !h.includes("company"));
        const emailIdx = headers.findIndex((h) => h.includes("email"));
        const phoneIdx = headers.findIndex((h) => h.includes("phone"));
        const rows = t.querySelectorAll("tbody tr, tr");
        const contacts = [];
        const seen = new Set();
        for (const row of rows) {
          const cells = row.querySelectorAll("td");
          if (cells.length < 2) continue;
          const name = nameIdx >= 0 ? (cells[nameIdx]?.textContent.trim() || "") : "";
          const email = emailIdx >= 0 ? (cells[emailIdx]?.textContent.trim() || "") : "";
          const key = name + "|" + email;
          if (name && !seen.has(key)) {
            seen.add(key);
            contacts.push({
              name,
              email,
              phone: phoneIdx >= 0 ? (cells[phoneIdx]?.textContent.trim() || "") : "",
            });
          }
        }
        if (contacts.length > 0) return { contacts, source: "html" };
      }
    }
    return { error: "No contacts found", pageUrl: window.location.href };
  });
}

// === Auth middleware ===
function requireKey(req, res, next) {
  if (!SCRAPER_API_KEY) return next(); // dev mode — no auth set
  const k = req.headers["x-api-key"] || req.query.api_key;
  if (k !== SCRAPER_API_KEY) return res.status(401).json({ ok: false, error: "Invalid api key" });
  next();
}

// === Routes ===
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    browser_connected: !!browser && browser.isConnected(),
    login_age_seconds: loginAt ? Math.floor((Date.now() - loginAt) / 1000) : null,
    queue_depth: queue.length,
    busy,
  });
});

app.post("/cmd/scrape-bidder", requireKey, async (req, res) => {
  const url = (req.body && req.body.project_url) || "";
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "project_url required (must be http(s) URL)" });
  }
  try {
    const result = await withLock(() => scrapeBidder(url));
    if (result.error) {
      return res.json({ ok: false, ...result, login_age_seconds: Math.floor((Date.now() - loginAt) / 1000) });
    }
    res.json({ ok: true, ...result, login_age_seconds: Math.floor((Date.now() - loginAt) / 1000) });
  } catch (err) {
    console.error("scrapeBidder error:", err);
    const status = err.queueTimeout ? 503 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

app.post("/cmd/scrape-contacts", requireKey, async (req, res) => {
  const url = (req.body && req.body.company_url) || "";
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "company_url required (must be http(s) URL)" });
  }
  try {
    const result = await withLock(() => scrapeContacts(url));
    res.json({ ok: true, ...result, login_age_seconds: Math.floor((Date.now() - loginAt) / 1000) });
  } catch (err) {
    console.error("scrapeContacts error:", err);
    const status = err.queueTimeout ? 503 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

app.post("/cmd/relogin", requireKey, async (req, res) => {
  try {
    await withLock(async () => {
      await login();
    });
    res.json({ ok: true, login_age_seconds: 0 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`cmd-scraper listening on :${PORT}`);
  console.log(`  CMD_USER=${CMD_USER}, login TTL=${LOGIN_TTL_MS}ms`);
  console.log(`  auth: ${SCRAPER_API_KEY ? "on" : "off (dev mode)"}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM, closing browser...");
  try { await browser?.close(); } catch {}
  process.exit(0);
});
