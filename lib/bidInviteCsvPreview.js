// Bid invite dry run from Derek's CSVs, before they are imported: the same normalizer as the
// upload button, the same grouping, short names, timing and copy as the engine. No database.
// The customer check is optional (isCustomerCompany: Pipedrive reads only).
// Differences from the real run, shown as flags: the import shortens long titles first (n8n Clean
// Phase), the time zone comes from the Pipedrive organization (Central is used here), and the
// sending mailbox is picked at send time.
import { normalizeLeadCsv, parseCsv } from "./leadCsvNormalize.js";
import { projectShortName } from "./bidProjectShortName.js";
import { firstName, renderBidEmail } from "./bidInviteCopy.js";
import { buildBatches, e1DueAt, e2DueAt, e3DueAt, nextWindowSlot, normalRecipient, DEFAULT_TZ } from "./bidInvitePlan.js";
import { looksLikeEmail } from "./emailVerify.js";

export const SAMPLE_SIGNATURE = "Regards,\nDerek E. Chinners - Founder\nPro SWPPP, LLC\nwww.ProSWPPP.com";
const DAY_MS = 24 * 60 * 60 * 1000;

export async function planFromCsv(files, { now = new Date(), minBidDate = "2026-09-01", isCustomerCompany = null, signature = SAMPLE_SIGNATURE, limit = 10 } = {}) {
  const counts = { files: files.length, rows: 0, platforms: {}, customers_matched: 0, customer_check: isCustomerCompany ? "pipedrive" : "skipped", batches: 0, grouped_batches: 0 };
  const holds = {};
  const hold = (k) => { holds[k] = (holds[k] || 0) + 1; };
  const leads = [];
  for (const { name, text } of files) {
    const n = normalizeLeadCsv(text, { kind: "bid_sheet", minBidDate });
    if (n.source !== "bid-aggregator") { hold(`file_not_a_bid_sheet:${name}`); continue; }
    for (const [k, v] of Object.entries(n.platforms || {})) counts.platforms[k] = (counts.platforms[k] || 0) + v;
    if (n.platformErrors?.length) hold(`platform_errors:${name}`);
    const rows = parseCsv(n.csv);
    const head = rows[0];
    const col = (r, c) => String(r[head.indexOf(c)] ?? "").trim();
    rows.slice(1).forEach((r, i) => {
      counts.rows++;
      const email = normalRecipient(col(r, "Email"));
      const bidDate = col(r, "Bid Date");
      const shortName = projectShortName(col(r, "Project Title"));
      if (!looksLikeEmail(email)) return hold("no_email");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bidDate)) return hold("no_bid_date");
      if (bidDate < minBidDate) return hold("before_min_bid_date");
      if (!shortName) return hold("short_name_unusable");
      leads.push({ leadId: `${name}#${i + 2}`, email, bidDate, shortName, title: col(r, "Project Title"), company: col(r, "Winning Bidder"),
        personName: col(r, "Name"), origin: col(r, "Lead Origin"), e1: e1DueAt({ bidDate, firstSeenAt: now }) });
    });
  }
  // Same chaining as the engine: one batch per contact for leads whose Email 1 falls within a day.
  const byEmail = new Map();
  for (const l of leads) { if (!byEmail.has(l.email)) byEmail.set(l.email, []); byEmail.get(l.email).push(l); }
  const groups = [];
  for (const list of byEmail.values()) {
    list.sort((a, b) => +a.e1 - +b.e1);
    let cur = [];
    for (const l of list) { if (cur.length && +l.e1 > +cur[0].e1 + DAY_MS) { groups.push(cur); cur = []; } cur.push(l); }
    if (cur.length) groups.push(cur);
  }
  groups.sort((a, b) => +a[0].e1 - +b[0].e1);
  const batches = [];
  const companyCache = new Map();
  for (const group of groups) {
    for (const l of group) {
      if (!isCustomerCompany || !l.company) continue;
      if (!companyCache.has(l.company)) companyCache.set(l.company, await isCustomerCompany(l.company).catch(() => "unavailable"));
      const match = companyCache.get(l.company);
      l.customer = Boolean(match) && match !== "unavailable";
      l.customerUnavailable = match === "unavailable";
    }
    const [b] = buildBatches(group);
    b.e1 = group.reduce((a, l) => (+l.e1 < +a ? l.e1 : a), group[0].e1);
    if (b.customer) counts.customers_matched++;
    if (b.leadIds.length > 1) counts.grouped_batches++;
    batches.push(b);
  }
  counts.batches = batches.length;
  const sample = (b, step, at) => {
    const named = b.leads.filter((l) => b.namedLeadIds.includes(String(l.leadId)));
    const r = renderBidEmail({ step, firstName: firstName(named[0]?.personName), names: b.names, signature });
    const flags = [...r.flags, "time_zone_assumed_central", "sender_picked_at_send_time"];
    if (b.customer) flags.push("customer_owner_task_after_email_1");
    if (b.leads.some((l) => l.customerUnavailable)) flags.push("customer_check_unavailable");
    if (b.leads.some((l) => l.title.length > 40)) flags.push("title_shortened_at_import_first");
    return {
      batchId: null, step, from: null, senderReason: b.customer ? "customer_owner" : "rotation", to: b.email,
      subject: step === "e1" ? r.subject : `Re: ${renderBidEmail({ step: "e1", names: b.names }).subject}`, bodyText: r.bodyText,
      sendAt: nextWindowSlot(+at < +now ? now : at, DEFAULT_TZ, { jitterKey: b.email }).toISOString(), timezone: DEFAULT_TZ, customer: b.customer,
      leads: b.leads.map((l) => ({ id: l.leadId, title: l.title, shortName: l.shortName, bidDate: l.bidDate, named: b.namedLeadIds.includes(String(l.leadId)) })),
      flags, holds: [],
    };
  };
  const samples = batches.slice(0, limit).map((b) => sample(b, "e1", b.e1));
  // Show Email 2 and 3 too (projected from Email 1), for one single-project and one grouped
  // non-customer batch, so the follow-up wording can be checked before anything is sent.
  for (const pick of [batches.find((b) => !b.customer && b.leadIds.length === 1), batches.find((b) => !b.customer && b.names.length > 1)]) {
    if (!pick) continue;
    const e1At = nextWindowSlot(+pick.e1 < +now ? now : pick.e1, DEFAULT_TZ, { jitterKey: pick.email });
    const e2At = e2DueAt({ anchor: pick.anchor, e1SentAt: e1At });
    samples.push(sample(pick, "e2", e2At), sample(pick, "e3", e3DueAt({ anchor: pick.anchor, e2SentAt: nextWindowSlot(e2At) })));
  }
  return { mode: "dry_run", counts, holds, samples, errors: [] };
}
