// Finished / inactive Apollo sequences do not need a message read every 15 minutes.
//
// The message endpoint (/emailer_messages/search) is capped per day and shared by every
// caller. Re-reading a sequence that sends nothing new burns that cap: the permit
// sequence alone (1,049 messages, 11 pages) cost ~1,050 calls/day and on 2026-10-25 the
// shared ceiling was hit at 19:44Z, leaving reply/bounce polling blind until midnight.
//
// A sequence is dormant when Apollo says it is archived or inactive, or when nothing is
// scheduled and nobody has been added for DORMANT_AFTER_DAYS. Late replies can still flip
// flags on old messages, so dormant sequences are still read, just not every cycle.
// Detail reads use a different Apollo endpoint and are cached for an hour.
import * as apollo from './apolloClient.js';

export const DORMANT_AFTER_DAYS = 14;
const DETAIL_CACHE_MS = 60 * 60 * 1000;
const cache = new Map();

/** Pure: classify one /emailer_campaigns/:id response. Unknown shapes are NOT dormant. */
export function sequenceDormancy(detail, now = Date.now()) {
  const campaign = detail?.emailer_campaign;
  if (!campaign || typeof campaign !== 'object') return { dormant: false, reason: 'detail_unavailable' };
  if (campaign.archived === true) return { dormant: true, reason: 'archived' };
  if (campaign.active === false) return { dormant: true, reason: 'inactive' };
  const lastUsed = Date.parse(campaign.last_used_at);
  if (campaign.unique_scheduled === 0 && Number.isFinite(lastUsed)
    && now - lastUsed >= DORMANT_AFTER_DAYS * 86_400_000) return { dormant: true, reason: 'finished' };
  return { dormant: false, reason: 'active' };
}

/** Cached detail read. A failed read never marks a sequence dormant. */
export async function readSequenceDormancy(sequenceId, { now = Date.now(), read = apollo.getSequenceDetail } = {}) {
  const hit = cache.get(sequenceId);
  if (hit && now - hit.at < DETAIL_CACHE_MS) return hit.value;
  try {
    const value = sequenceDormancy(await read(sequenceId), now);
    cache.set(sequenceId, { at: now, value });
    return value;
  } catch {
    return hit?.value || { dormant: false, reason: 'detail_unavailable' };
  }
}

/** Seed from a detail response the caller already fetched (no extra request). */
export function rememberSequenceDetail(sequenceId, detail, now = Date.now()) {
  const value = sequenceDormancy(detail, now);
  if (value.reason !== 'detail_unavailable') cache.set(sequenceId, { at: now, value });
  return value;
}

export function _resetSequenceDormancy() { cache.clear(); }
