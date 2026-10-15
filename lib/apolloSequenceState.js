import * as apolloClient from './apolloClient.js';

// Apollo can pause a sequence by itself (status_reason auto_pause_high_bounce). Contacts added
// to a paused sequence are held with "Sequence inactive" and get nothing, while the app recorded
// them as sent: 597 people sat that way from 2026-09-16 to 2026-10-15 (SWPPP - PB, then LBA).
// A short cache keeps this to one Apollo read per sequence every few minutes.
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

export async function sequencePaused(sequenceId, { getDetail = apolloClient.getSequenceDetail, now = Date.now() } = {}) {
  if (!sequenceId) return null;
  const hit = cache.get(sequenceId);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  let campaign;
  // An unreadable state keeps today's behavior: the send path's own guards still apply.
  try { campaign = (await getDetail(sequenceId))?.emailer_campaign; } catch { return null; }
  if (!campaign || typeof campaign.active !== 'boolean') return null;
  const value = campaign.active ? null : { reason: campaign.status_reason || 'inactive', pausedAt: campaign.auto_paused_at || null };
  cache.set(sequenceId, { at: now, value });
  return value;
}

export function clearSequenceStateCache() { cache.clear(); }
