import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { loginCmdPage } from "./login.js";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const home = "https://insight.cmdgroup.com/DashBoard/Home/Index";
const loginUrl = "https://insight.cmdgroup.com/Account/Login";
const form = '<form method="post" action="/submit"><input name="username"><input name="password" type="password"><button type="submit">Sign In</button></form>';

async function scenario({ signedIn = false, accepted = true, formUrl = "https://login.cmdgroup.com/Account/Form" }, run) {
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  let submits = 0;
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    const navigate = target => ({ contentType: "text/html", body: `<script>location.replace(${JSON.stringify(target)})</script>` });
    if (url.pathname === "/Account/Login") return route.fulfill(navigate(signedIn ? home : formUrl));
    if (url.pathname === "/Account/Form") return route.fulfill({ contentType: "text/html", body: form });
    if (url.pathname === "/submit") {
      submits++;
      return route.fulfill(accepted ? navigate(home) : { contentType: "text/html", body: form + "Invalid login" });
    }
    if (req.url() === home) return route.fulfill({ contentType: "text/html", body: "<h1>INSIGHT dashboard</h1>" });
    return route.abort();
  });
  try { await run(page, () => submits); } finally { await page.close(); }
}
const options = { username: "fixture-user", password: "fixture-password", loginUrl, timeoutMs: 2000 };

test("an existing SSO session returns successfully without waiting for absent login inputs", async () => {
  await scenario({ signedIn: true }, async (page, submits) => {
    await loginCmdPage(page, options);
    assert.equal(page.url(), home);
    assert.equal(submits(), 0);
  });
});

test("an expired session submits the login and reaches the authenticated dashboard", async () => {
  await scenario({}, async (page, submits) => {
    await loginCmdPage(page, options);
    assert.equal(page.url(), home);
    assert.equal(submits(), 1);
  });
});

test("a rejected login cannot be recorded as a successful session", async () => {
  await scenario({ accepted: false }, async page => {
    await assert.rejects(loginCmdPage(page, options), /authenticated dashboard/i);
  });
});

test("an unexpected login redirect cannot receive the configured credentials", async () => {
  await scenario({ formUrl: "https://unexpected.example/Account/Form" }, async (page, submits) => {
    await assert.rejects(loginCmdPage(page, options), /unexpected login destination/i);
    assert.equal(submits(), 0);
  });
});
