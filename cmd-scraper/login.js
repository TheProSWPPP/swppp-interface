function isDashboard(url) {
  return url.protocol === "https:" && url.hostname === "insight.cmdgroup.com" && /^\/dashboard\/home(?:\/index)?\/?$/i.test(url.pathname);
}

export async function loginCmdPage(page, { username, password, loginUrl, timeoutMs }) {
  await page.goto(loginUrl, { waitUntil: "networkidle" });
  // A valid SSO cookie redirects the login URL straight back into INSIGHT.
  if (isDashboard(new URL(page.url()))) return;
  const destination = new URL(page.url());
  if (destination.protocol !== "https:" || !["insight.cmdgroup.com", "login.cmdgroup.com"].includes(destination.hostname)) {
    throw new Error("CMD unexpected login destination");
  }
  await page.fill('input#Username, input[name="Username"], input[name="username"], input#Email, input[name="Email"], input[type="email"]', username);
  await page.fill('input#Password, input[name="Password"], input[name="password"], input[type="password"]', password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: timeoutMs }).catch(() => null),
    page.evaluate(() => {
      const form = document.querySelector('form:has(input[type="password"])');
      if (!form) return "no form";
      const btn = form.querySelector('button[type=submit], input[type=submit]');
      if (btn) { btn.click(); return "clicked"; }
      form.submit();
      return "submitted";
    }),
  ]);
  await page.waitForURL(isDashboard, { waitUntil: "domcontentloaded", timeout: timeoutMs })
    .catch(() => { throw new Error("CMD login did not reach the authenticated dashboard"); });
}
