// Existing-customer suppression for cold .co outreach.
//
// Derek, 2026-07-29: "Can you check on the drips and see if you can stop out the ones that
// are already existing customers? I don't need them getting a drip from a different email
// it may just be confusing to them."
//
// THE SIGNAL ALREADY EXISTS. It is a Pipedrive label, on both leads and organizations,
// maintained weekly by the n8n workflow `te0dP1zV1XduMS6B` ("Customer Tag Auto-Assigner"),
// which reads Derek's Dropbox `/Working Customer SWPPP` folders and tags the matching orgs.
// 414 leads and 1,031 org records carried it on 2026-07-30. Nothing in the sending path had
// ever read it: `grep -rn "label_ids|label_id" server.js lib/*.js` returned zero hits.
//
// Measured before this shipped: 63 sends to 55 leads at 43 tagged customer companies had
// already gone out, 59 of them in July, most recent 2026-07-28. A further 657 tagged leads
// sat in the book never sent to, with 3 drafts approvable that day.
//
// WHY MATCHING ON organization_id IS NOT ENOUGH — this is the whole subtlety.
// Pipedrive holds ~15,791 org records for ~13,086 distinct company names; 1,687 names have
// more than one record (one company has 68). Crossland Construction has 34 org records and
// exactly 3 carry the Customer tag, so its cold sends went to leads hanging off untagged
// copies. An org_id lookup catches only 31 of the 63 real cases. We therefore resolve the
// tag across every org record sharing a NORMALIZED COMPANY NAME, reusing the same
// `companyKey` normalizer the permit engine already dedupes operators with.
//
// This is deliberately a read plus a boolean, never a written `skipped` row. The 2026-07-27
// attempt (`11d7fce`) was reverted (`2fb19d6`) partly for being irreversible: 74 permanent
// `skipped` rows exist elsewhere in the system with no delete path. Suppression here is
// recomputed from live CRM state every time, so untagging a company in Pipedrive un-suppresses
// it with no migration and no cleanup.

import * as pipedriveClient from "./pipedriveClient.js";
import { companyKey } from "./permitMatch.js";

// Pipedrive `Customer` label ids, read from the live CRM 2026-07-30.
export const CUSTOMER_LEAD_LABEL_ID = "60f8db60-9db4-11ee-98c4-8b14e7552970";
export const CUSTOMER_ORG_LABEL_ID = 1;

const REFRESH_MS = 6 * 60 * 60 * 1000; // 6h; the upstream tagger runs weekly

/**
 * Normalized keys a company name should match on. Returns 1-2 keys.
 *
 * The plain `companyKey` normalizer is not enough here, because Derek's duplicate org records
 * are largely BRANCH records: "Crossland Construction - Tulsa", "Crossland Construction -
 * Columbus (HQ)", "Crossland Construction - OKC", "Crossland Construction - Rogers". The dash
 * becomes a space in `companyKey`, so "crossland construction tulsa" is a different key from
 * the tagged "crossland construction" and the branch escapes suppression.
 *
 * So we also key the segment BEFORE the first dash. Only when that base still has 2+ tokens,
 * which stops a name like "Smith - Partners" collapsing to the over-broad key "smith" and
 * suppressing every unrelated Smith in the book. Deliberately does NOT do prefix or substring
 * matching: "Crossland Heavy Contractors" must stay distinct from "Crossland Construction",
 * and both really exist.
 */
export function companyKeyVariants(name) {
  const out = new Set();
  const raw = String(name || "").trim();
  if (!raw) return out;
  const full = companyKey(raw);
  if (full) out.add(full);
  const dash = raw.split(/\s[-–—]\s/)[0];
  if (dash && dash !== raw) {
    const base = companyKey(dash);
    if (base && base.split(" ").length >= 2) out.add(base);
  }
  return out;
}

// { keys: Set<normalizedCompanyName>, orgIds: Set<string>, at: number, orgRecords: number }
let _index = null;
let _refreshing = null;

export function customerSuppressionEnabled() {
  return process.env.SDR_SUPPRESS_CUSTOMERS !== "off"; // on unless explicitly killed
}

/**
 * Build the customer index from Pipedrive orgs. Two sets come out of it:
 *   orgIds — org records that literally carry the tag
 *   keys   — normalized company names of those records, which is what catches duplicates
 */
export async function refreshCustomerIndex({ force = false } = {}) {
  if (!force && _index && Date.now() - _index.at < REFRESH_MS) return _index;
  if (_refreshing) return _refreshing; // collapse concurrent callers onto one fetch
  _refreshing = (async () => {
    const orgIds = new Set();
    const keys = new Set();
    let orgRecords = 0;
    let start = 0;
    // Bounded: ~32 pages at 500/page for the current book. The cap stops a runaway loop if
    // Pipedrive ever stops reporting pagination correctly.
    for (let page = 0; page < 200; page++) {
      const { data, pagination } = await pipedriveClient.listOrganizations({ start, limit: 500 });
      for (const o of data) {
        orgRecords++;
        if (String(o.label) === String(CUSTOMER_ORG_LABEL_ID)) {
          orgIds.add(String(o.id));
          for (const k of companyKeyVariants(o.name)) keys.add(k);
        }
      }
      if (!pagination?.more_items_in_collection) break;
      const next = pagination.next_start;
      if (next === undefined || next === null || next === start) break;
      start = next;
    }
    _index = { orgIds, keys, orgRecords, at: Date.now() };
    console.log(
      `[customer-suppression] index refreshed: ${orgIds.size} tagged org records, ` +
        `${keys.size} distinct company names, from ${orgRecords} orgs`,
    );
    return _index;
  })();
  try {
    return await _refreshing;
  } finally {
    _refreshing = null;
  }
}

export function customerIndexStats() {
  if (!_index) return { loaded: false };
  return {
    loaded: true,
    tagged_org_records: _index.orgIds.size,
    tagged_company_names: _index.keys.size,
    orgs_scanned: _index.orgRecords,
    refreshed_at: new Date(_index.at).toISOString(),
    enabled: customerSuppressionEnabled(),
  };
}

/**
 * Pure decision, so it is testable without Pipedrive.
 *
 * @param lead.label_ids   the lead's Pipedrive label ids
 * @param lead.org_id      the lead's organization id
 * @param lead.org_name    that organization's name
 * @param index.orgIds     Set of org ids carrying the Customer tag
 * @param index.keys       Set of normalized company names carrying it on ANY record
 * @returns null when the lead is not a known customer, else {reason, matchedOn}
 */
export function customerMatch(lead, index) {
  if (!lead || !index) return null;
  const labels = Array.isArray(lead.label_ids) ? lead.label_ids.map(String) : [];
  if (labels.includes(CUSTOMER_LEAD_LABEL_ID)) {
    return { reason: "lead carries the Pipedrive Customer label", matchedOn: "lead_label" };
  }
  if (lead.org_id != null && index.orgIds?.has(String(lead.org_id))) {
    return { reason: "the lead's organization carries the Customer label", matchedOn: "org_label" };
  }
  // The duplicate-record case, which is over half of the real exposure.
  for (const key of companyKeyVariants(lead.org_name)) {
    if (index.keys?.has(key)) {
      return {
        reason: `another Pipedrive record for "${lead.org_name}" carries the Customer label`,
        matchedOn: "company_name",
      };
    }
  }
  return null;
}

/**
 * Live check for one lead. Fetches the lead + its org from Pipedrive, so it sees a tag added
 * seconds ago rather than whatever the 6-hourly mirror last saw.
 *
 * FAIL-OPEN on any error. A Pipedrive outage must not silently stop all outreach; it degrades
 * to today's behaviour instead. Every fail-open path logs.
 *
 * @returns null when the send may proceed, else {reason, matchedOn, orgName}
 */
export async function isCustomerLead(pipedriveLeadId, { leadRecord = null } = {}) {
  if (!customerSuppressionEnabled()) return null;
  if (!process.env.PIPEDRIVE_API_TOKEN) return null;
  if (!pipedriveLeadId) return null;
  try {
    const index = await refreshCustomerIndex();
    const lead = leadRecord || (await pipedriveClient.getLead(pipedriveLeadId));
    if (!lead) return null;
    const orgId = lead.organization_id ?? lead.org_id ?? null;
    let orgName = lead.organization?.name || null;
    // The tag may sit on a SIBLING record, so we need the name even when this org is untagged.
    if (!orgName && orgId != null && !index.orgIds.has(String(orgId))) {
      try {
        const org = await pipedriveClient.getOrganization(orgId);
        orgName = org?.name || null;
      } catch (e) {
        console.warn(`[customer-suppression] org lookup failed for ${orgId} (allowing):`, e.message);
      }
    }
    return customerMatch({ label_ids: lead.label_ids, org_id: orgId, org_name: orgName }, index);
  } catch (e) {
    console.warn(`[customer-suppression] check failed for lead ${pipedriveLeadId} (allowing send):`, e.message);
    return null;
  }
}
