// One-time relink of stored Apollo outbound history to the project (Pipedrive lead) and
// source of OUR enrollment that sent it. Until the poll passed its match through, every
// polled message was stored unmatched / source 'unknown', so no won deal could ever be
// attributed. Runner: tools/backfill-apollo-attribution.mjs (dry run by default).
//
// Reads only our own tables. A message is linked only when exactly one of our sends fits:
// same sequence + same recipient address (the approved draft's snapshot) + either Apollo's
// message id on the send, or the latest enrollment at/before the message (ties = skip),
// with the sending mailbox agreeing. Ambiguous rows and rows already verified to another
// project are never touched, nothing is ever unlinked, and re-running changes nothing.
import { sourceKeyForSend } from './apolloAttribution.js';
import { dealOutreachSource } from './pipedriveSalesHistory.js';

const FACTS_SQL = `SELECT provider_message_id, campaign_id, prospect_email, lower(mailbox_email) AS mailbox_email,
    occurred_at, provider_status, link_status, pipedrive_lead_id, source_key, outreach_classification
  FROM sdr_message_facts
  WHERE provider='apollo' AND direction='out' AND NOT is_test AND campaign_id IS NOT NULL
    AND (link_status='unmatched' OR (link_status='verified' AND source_key='unknown'))`;
const SENDS_SQL = `SELECT s.id, s.pipedrive_lead_id, s.apollo_sequence_id, s.apollo_emailer_message_id, s.sent_at,
    s.enrolled_trigger, d.trigger_type AS draft_trigger_type,
    lower(btrim(d.contact_email_snapshot)) AS recipient_email, lower(mb.email) AS mailbox_email
  FROM sdr_sends s LEFT JOIN sdr_drafts d ON d.id=s.draft_id LEFT JOIN sdr_mailboxes mb ON mb.id=s.mailbox_id
  WHERE s.apollo_sequence_id = ANY($1::text[])`;

const chicagoMonth = (at) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).format(new Date(at));

/** Pure: which of our sends produced this stored message? */
export function matchFactToSend(fact, sends) {
  const email = String(fact.prospect_email || '').trim().toLowerCase();
  const candidates = sends.filter((s) => String(s.apollo_sequence_id) === String(fact.campaign_id)
    && s.recipient_email && s.recipient_email === email);
  if (!candidates.length) return { status: 'unmatched' };
  const receipts = candidates.filter((s) => s.apollo_emailer_message_id && s.apollo_emailer_message_id === fact.provider_message_id);
  if (receipts.length > 1) return { status: 'ambiguous', reason: 'duplicate_receipt' };
  let send = receipts[0];
  let kind = 'provider_receipt';
  if (!send) {
    const at = Date.parse(fact.occurred_at);
    if (!Number.isFinite(at)) return { status: 'skipped', reason: 'not_sent' };
    const eligible = candidates.filter((s) => Date.parse(s.sent_at) <= at);
    if (!eligible.length) return { status: 'ambiguous', reason: 'before_enrollment' };
    const latest = Math.max(...eligible.map((s) => Date.parse(s.sent_at)));
    const matches = eligible.filter((s) => Date.parse(s.sent_at) === latest);
    if (matches.length !== 1) return { status: 'ambiguous', reason: 'simultaneous_enrollments' };
    [send] = matches;
    kind = 'campaign_recipient_mailbox_time';
  }
  if (send.mailbox_email && fact.mailbox_email && send.mailbox_email !== fact.mailbox_email) return { status: 'ambiguous', reason: 'mailbox_mismatch' };
  if (!send.pipedrive_lead_id) return { status: 'ambiguous', reason: 'send_without_project' };
  return { status: 'verified', send, evidence: `send:${send.id}:${kind}` };
}

/** Read-only: what the backfill would change. Safe inside BEGIN READ ONLY. */
export async function planAttributionBackfill(db, { env = process.env } = {}) {
  const { rows: facts } = await db.query(FACTS_SQL);
  const campaigns = [...new Set(facts.map((f) => f.campaign_id))];
  const { rows: sends } = campaigns.length ? await db.query(SENDS_SQL, [campaigns]) : { rows: [] };
  const links = [], sources = [], skipped = {};
  const skip = (key) => { skipped[key] = (skipped[key] || 0) + 1; };
  for (const fact of facts) {
    const match = matchFactToSend(fact, sends);
    if (match.status !== 'verified') { skip(`${fact.link_status}:${match.reason || match.status}`); continue; }
    const change = {
      id: fact.provider_message_id, campaignId: fact.campaign_id, leadId: String(match.send.pipedrive_lead_id),
      evidence: match.evidence, sourceKey: sourceKeyForSend(match.send, fact.campaign_id, env),
      classificationEvidence: `sdr_send:${match.send.id}:apollo_sequence:${fact.campaign_id}`,
      occurredAt: fact.occurred_at, completed: fact.provider_status === 'completed',
      // unknown becomes sales_outreach; an existing classification is kept as it is.
      classificationAfter: fact.outreach_classification === 'unknown' ? 'sales_outreach' : fact.outreach_classification,
    };
    if (fact.link_status === 'unmatched') links.push(change);
    else if (fact.pipedrive_lead_id === change.leadId) {
      if (change.sourceKey === 'unknown') { skip('verified:no_known_source'); continue; }
      sources.push(change);
    } else skip('verified:different_project_kept');
  }
  return { factsRead: facts.length, sendsRead: sends.length, links, sources, skipped };
}

/** Writes the plan. Every UPDATE re-checks its guard, so a re-run is a no-op. */
export async function applyAttributionBackfill(db, plan) {
  const col = (rows, key) => rows.map((r) => r[key]);
  const linked = plan.links.length ? await db.query(`UPDATE sdr_message_facts f SET pipedrive_lead_id=c.lead, link_status='verified',
      link_evidence=c.evidence, source_key=c.source,
      outreach_classification=CASE WHEN f.outreach_classification='unknown' THEN 'sales_outreach' ELSE f.outreach_classification END,
      classification_evidence=CASE WHEN f.outreach_classification='unknown' THEN c.cls ELSE f.classification_evidence END
    FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[]) AS c(id,lead,evidence,source,cls)
    WHERE f.provider='apollo' AND f.direction='out' AND f.provider_message_id=c.id AND f.link_status='unmatched'`,
  [col(plan.links, 'id'), col(plan.links, 'leadId'), col(plan.links, 'evidence'), col(plan.links, 'sourceKey'), col(plan.links, 'classificationEvidence')]) : { rowCount: 0 };
  const sourced = plan.sources.length ? await db.query(`UPDATE sdr_message_facts f SET source_key=c.source,
      outreach_classification=CASE WHEN f.outreach_classification='unknown' THEN 'sales_outreach' ELSE f.outreach_classification END,
      classification_evidence=CASE WHEN f.outreach_classification='unknown' THEN c.cls ELSE f.classification_evidence END
    FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) AS c(id,lead,source,cls)
    WHERE f.provider='apollo' AND f.direction='out' AND f.provider_message_id=c.id AND f.link_status='verified'
      AND f.pipedrive_lead_id=c.lead AND f.source_key='unknown'`,
  [col(plan.sources, 'id'), col(plan.sources, 'leadId'), col(plan.sources, 'sourceKey'), col(plan.sources, 'classificationEvidence')]) : { rowCount: 0 };
  return { linked: linked.rowCount, sourced: sourced.rowCount };
}

/** Counts per sequence and Chicago month of messages that would be linked. */
export function summarizePlan(plan) {
  const bySequenceMonth = {};
  for (const change of plan.links) {
    const key = `${change.campaignId} (${change.sourceKey})`;
    const month = change.occurredAt ? chicagoMonth(change.occurredAt) : 'no date';
    bySequenceMonth[key] ||= {};
    bySequenceMonth[key][month] = (bySequenceMonth[key][month] || 0) + 1;
  }
  const bySource = {};
  for (const change of [...plan.links, ...plan.sources]) bySource[change.sourceKey] = (bySource[change.sourceKey] || 0) + 1;
  return { factsRead: plan.factsRead, wouldLink: plan.links.length, wouldFillSource: plan.sources.length,
    projectsLinked: new Set(plan.links.map((c) => c.leadId)).size, bySequenceMonth, bySource, skipped: plan.skipped };
}

/**
 * Read-only projection: which won deals the next CRM sales sync would attribute, using
 * the exact rule the sync applies (dealOutreachSource) before and after the plan.
 */
export async function projectDealAttribution(db, plan, { now = new Date() } = {}) {
  const { rows: deals } = await db.query(`SELECT d.pipedrive_deal_id, d.pipedrive_lead_id, d.status, d.source, d.won_at, d.value, d.currency,
      l.lead_title FROM sdr_reporting_deals d LEFT JOIN sdr_lead_state l ON l.pipedrive_lead_id=d.pipedrive_lead_id
    WHERE d.status IN ('won','open') AND d.link_status='verified' AND d.pipedrive_lead_id IS NOT NULL ORDER BY d.won_at NULLS LAST, d.pipedrive_deal_id`);
  const leadIds = [...new Set(deals.map((d) => d.pipedrive_lead_id))];
  const { rows: before } = leadIds.length ? await db.query(`SELECT pipedrive_lead_id,source_key,MIN(occurred_at) AS first_at
    FROM sdr_reporting_messages WHERE pipedrive_lead_id=ANY($1::text[]) AND link_status='verified'
      AND direction='out' AND provider_status='completed' AND source_key<>'unknown'
      AND outreach_classification='sales_outreach' AND classification_evidence IS NOT NULL
    GROUP BY pipedrive_lead_id,source_key`, [leadIds]) : { rows: [] };
  const { rows: runs } = await db.query(`SELECT counts FROM sdr_job_runs WHERE job='pipedrive_deals' AND status='complete'
    ORDER BY finished_at DESC LIMIT 1`);
  const counts = runs[0]?.counts || {};
  const after = new Map(before.map((r) => [`${r.pipedrive_lead_id}|${r.source_key}`, { ...r }]));
  const wanted = new Set(leadIds);
  for (const change of [...plan.links, ...plan.sources]) {
    if (!wanted.has(change.leadId) || !change.completed || change.sourceKey === 'unknown' || !change.occurredAt
      || change.classificationAfter !== 'sales_outreach') continue;
    const key = `${change.leadId}|${change.sourceKey}`;
    const prior = after.get(key);
    if (!prior || +new Date(change.occurredAt) < +new Date(prior.first_at)) after.set(key, { pipedrive_lead_id: change.leadId, source_key: change.sourceKey, first_at: change.occurredAt });
  }
  // sdr_deal_facts keeps the sale time, not Pipedrive's raw won_time string; match held /
  // reconstructed dates by deal id.
  const byId = (rows) => (rows || []).map((r) => ({ ...r }));
  const reviews = new Set(byId(counts.date_reviews).map((r) => String(r.id)));
  const adjustments = new Map(byId(counts.date_adjustments).map((r) => [String(r.id), r]));
  const projected = deals.map((deal) => {
    // Open deals: what they would get if won now.
    const wonTime = new Date(deal.won_at || now).toISOString();
    const dealCounts = {
      date_reviews: reviews.has(deal.pipedrive_deal_id) ? [{ id: deal.pipedrive_deal_id, provider_won_at: wonTime }] : [],
      date_adjustments: adjustments.has(deal.pipedrive_deal_id) ? [{ ...adjustments.get(deal.pipedrive_deal_id), provider_won_at: wonTime }] : [],
    };
    const input = { id: deal.pipedrive_deal_id, won_time: wonTime };
    const multi = (touches) => touches.filter((r) => r.pipedrive_lead_id === deal.pipedrive_lead_id && +new Date(r.first_at) <= +new Date(wonTime)).length;
    return {
      dealId: deal.pipedrive_deal_id, leadId: deal.pipedrive_lead_id, title: deal.lead_title || null, status: deal.status,
      wonAt: deal.won_at ? wonTime : null, value: deal.value == null ? null : Number(deal.value), currency: deal.currency,
      storedSource: deal.source || 'unknown',
      sourceBefore: dealOutreachSource(input, deal.pipedrive_lead_id, before, dealCounts),
      sourceAfter: dealOutreachSource(input, deal.pipedrive_lead_id, [...after.values()], dealCounts),
      knownSourcesBeforeSaleAfter: multi([...after.values()]),
      heldDate: dealCounts.date_reviews.length > 0,
    };
  });
  const won = projected.filter((d) => d.status === 'won');
  return {
    wonDealsWithProjectLink: won.length,
    attributedBefore: won.filter((d) => d.sourceBefore !== 'unknown').length,
    attributedAfter: won.filter((d) => d.sourceAfter !== 'unknown').length,
    deals: won,
    openDealsWithProjectLink: projected.length - won.length,
    openDealsWithSourceIfWonNow: projected.filter((d) => d.status === 'open' && d.sourceAfter !== 'unknown'),
  };
}
