// Draft staleness gate.
//
// Found 2026-07-30: 94 drafts sat `pending`, 93 of them older than 14 days, and 51 were
// written on a single day three weeks earlier. Every one was still approvable with one click.
// Nothing stopped them: `pruneStaleQueuedDrafts` only prunes drafts whose contact was emailed
// in Pipedrive since drafting, the contact cooldown is consulted against SEND history rather
// than draft age, and the auto-switch guard has no bearing on a manual approval.
//
// A three-week-old draft is written against a lead state that has moved on. Its stage may have
// changed, its contact may have left, the bid may be long decided. Sending it is worse than
// not sending it.
//
// This gate governs whether WE send, which is why an age check is safe here in a way the
// vetoed engagement age-guard was not. That one tried to infer meaning from how old an
// INBOUND reply was, where age tells you nothing (Apollo does not expose reply-arrival time
// at all). This one asks how old OUR OWN draft is, which we recorded ourselves.

export const DEFAULT_MAX_DRAFT_AGE_DAYS = 14; // matches the contact cooldown already in use

export function maxDraftAgeDays() {
  const raw = process.env.SDR_DRAFT_MAX_AGE_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MAX_DRAFT_AGE_DAYS;
  if (String(raw).trim().toLowerCase() === "off") return null; // explicit kill switch
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DRAFT_AGE_DAYS;
}

/**
 * @param draft {created_at}
 * @param opts.now Date, injectable for tests
 * @param opts.maxAgeDays overrides the env setting
 * @returns null when the draft may be sent, else {ageDays, maxAgeDays} describing the block
 */
export function staleDraftBlock(draft, { now = new Date(), maxAgeDays = maxDraftAgeDays() } = {}) {
  if (maxAgeDays === null) return null; // gate disabled
  const created = draft?.created_at;
  if (!created) return null; // unknown age: fail open rather than block a legitimate send
  const ms = created instanceof Date ? created.getTime() : new Date(created).getTime();
  if (Number.isNaN(ms)) return null;
  const ageDays = Math.floor((now.getTime() - ms) / 86400000);
  if (ageDays <= maxAgeDays) return null;
  return { ageDays, maxAgeDays };
}
