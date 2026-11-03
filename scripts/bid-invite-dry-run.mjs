// Bid invite follow-ups: dry run. Renders the emails that would go out and writes them to an HTML
// page for Derek. Sends nothing, writes nothing to Pipedrive, Gmail or the database.
//
//   node scripts/bid-invite-dry-run.mjs --csv BC.csv CC.csv            (before import, no database)
//   PIPEDRIVE_API_TOKEN=... node scripts/bid-invite-dry-run.mjs --csv BC.csv   (adds the customer check, Pipedrive reads only)
//   DATABASE_URL=... PIPEDRIVE_API_TOKEN=... SDR_CRM_COMPANY_ID=... node scripts/bid-invite-dry-run.mjs   (imported leads, read-only transaction)
//
// Options: --out=bid-invite-samples.html (refuses to overwrite unless --force), --limit=10,
//          --min-bid-date=2026-09-01, --signature-file=sig.txt (CSV mode; default: Derek's .co signature).
// Samples using wording that is not on the page Derek saw (Email 2/3 naming several projects,
// the signature block) are flagged in the output and on the page.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { planFromCsv, SAMPLE_SIGNATURE } from "../lib/bidInviteCsvPreview.js";
import { renderPreviewHtml, runBidInviteSequence, bidInviteConfig } from "../lib/bidInviteEngine.js";

export function parseArgs(argv) {
  const opts = { csv: [], out: "bid-invite-samples.html", limit: 10, force: false, minBidDate: null, signatureFile: null };
  let inCsv = false;
  for (const arg of argv) {
    if (arg === "--csv") { inCsv = true; continue; }
    if (arg.startsWith("--")) {
      inCsv = false;
      const [k, v] = arg.slice(2).split("=");
      if (k === "out") opts.out = v;
      else if (k === "limit") opts.limit = Math.max(1, Number(v) || 10);
      else if (k === "force") opts.force = true;
      else if (k === "min-bid-date") opts.minBidDate = v;
      else if (k === "signature-file") opts.signatureFile = v;
      else throw new Error(`unknown option --${k}`);
      continue;
    }
    if (inCsv) opts.csv.push(arg);
    else throw new Error(`unexpected argument ${arg}`);
  }
  return opts;
}

// One client, BEGIN READ ONLY, for the whole run: a dry run cannot write even by mistake.
async function readOnlyPool(connectionString) {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString, max: 1, ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  await client.query("BEGIN READ ONLY");
  const db = {
    query: (...a) => client.query(...a),
    connect: async () => ({ query: (...a) => client.query(...a), release() {} }),
    end: async () => { await client.query("ROLLBACK").catch(() => {}); client.release(); await pool.end(); },
  };
  return db;
}

export function printCounts(result) {
  const flagged = result.samples.filter((s) => s.flags.some((f) => /_not_on_page$/.test(f)));
  console.log(JSON.stringify({ counts: result.counts, holds: result.holds, samples: result.samples.length, errors: result.errors.length }, null, 2));
  for (const [i, s] of result.samples.entries()) {
    const off = s.flags.filter((f) => /_not_on_page$/.test(f));
    console.log(`${i + 1}. Email ${s.step.slice(1)} to ${s.to} (${s.customer ? "customer" : "non-customer"}) at ${s.sendAt}: ${s.subject}${off.length ? `  FLAG: ${off.join(", ")}` : ""}`);
  }
  if (flagged.length) console.log(`\n${flagged.length} sample(s) use wording not on the page Derek saw. Get his OK before going live.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = bidInviteConfig();
  const minBidDate = opts.minBidDate || cfg.minBidDate;
  const out = path.resolve(opts.out);
  if (fs.existsSync(out) && !opts.force) throw new Error(`${out} already exists; pass --force to overwrite or --out=<new file>`);
  let result;
  if (opts.csv.length) {
    const files = opts.csv.map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, "utf8") }));
    let isCustomerCompany = null;
    if (process.env.PIPEDRIVE_API_TOKEN) isCustomerCompany = (await import("../lib/customerSuppression.js")).isCustomerCompany;
    const signature = opts.signatureFile ? fs.readFileSync(opts.signatureFile, "utf8") : SAMPLE_SIGNATURE;
    result = await planFromCsv(files, { minBidDate, isCustomerCompany, signature, limit: opts.limit });
  } else {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required without --csv");
    const db = await readOnlyPool(process.env.DATABASE_URL);
    try {
      const pd = process.env.PIPEDRIVE_API_TOKEN ? await import("../lib/pipedriveClient.js") : null;
      const { isCustomerLead } = await import("../lib/customerSuppression.js");
      result = await runBidInviteSequence(db, {
        mode: "dry_run", preview: true, limit: opts.limit, maxNewBatches: opts.limit, pd, isCustomerLead: pd ? isCustomerLead : async () => null,
        onlyLeads: cfg.onlyLeads, minBidDate, companyId: cfg.companyId,
      });
    } finally { await db.end(); }
  }
  fs.writeFileSync(out, renderPreviewHtml(result));
  printCounts(result);
  console.log(`\nWrote ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
