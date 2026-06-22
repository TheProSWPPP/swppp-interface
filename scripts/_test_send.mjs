// One-off: send ONE test render of the permit email to Ivan via Brevo transactional.
// Fills sample merge values so we see the real blue-Georgia + Derek-sig rendering.
// BREVO_API_KEY + TO from env.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
let html = readFileSync(join(__dir, "_msgp_body.html"), "utf8").trim();

const sample = { first_name: "Sam", operator: "Lone Star Concrete Co", permit: "TXR0512345", expires: "August 13, 2026" };
html = html.replace(/\{\{(\w+)\}\}/g, (_, k) => sample[k] ?? `{{${k}}}`);

const to = process.env.TO;
const key = process.env.BREVO_API_KEY;
if (!to || !key) { console.error("need TO + BREVO_API_KEY"); process.exit(1); }

const payload = {
  sender: { name: "Pro SWPPP, LLC", email: "dc@ProSWPPP.com" },
  to: [{ email: to }],
  subject: "[TEST] Action needed: your TXR050000 stormwater permit expires Aug 13",
  htmlContent: `<!DOCTYPE html><html><body>${html}</body></html>`,
};

const res = await fetch("https://api.brevo.com/v3/smtp/email", {
  method: "POST",
  headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(payload),
});
const text = await res.text();
console.log("status", res.status, text);
if (!res.ok) process.exit(1);
