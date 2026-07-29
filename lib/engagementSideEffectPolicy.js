// The two decisions /api/sdr/events/ingest makes before it is allowed to touch anything
// outside `sdr_engagement_events`. Pulled out of the route so they can be unit-tested —
// the first version of this logic shipped with an age guard that was wrong in two ways and
// nothing in the suite could have caught it, because it was inline in a 6000-line file.
//
// NOTE WHAT IS NOT A PARAMETER: there is no timestamp. Nothing about a Pipedrive side
// effect may depend on how old the message is.
//
//   Apollo does not expose a reply-arrival time on /emailer_messages/search. The reply
//   event and the send event carry the SAME value — measured 15/15 for replies, 2/2 for
//   bounces, `occurred_at` byte-identical. So "message age" can only ever mean "how long
//   ago WE sent", and gating on it silences real replies: measured from Gmail (where true
//   arrival times exist) 15 of 44 replies — 34% — arrive more than 7 days after first
//   touch, max 14.98 days, and step 3 alone lands a median 10.08 days after enrollment.
//   682 of 718 live send rows already have their newest outbound older than 7 days.
//
// Back-blast is contained by first-observation instead (`backfillDone`), which is a
// property of OUR history with the message, not of the message's age.

/**
 * @param {object}  a
 * @param {string}  a.eventId       apollo_event_id; `poll:` prefix = emitted by the cron
 * @param {string?} a.sendMatch     how the sdr_sends row resolved:
 *                                  "message_id" (exact) | "sequence_email" | "email" | null
 * @param {boolean} a.backfillFlag  caller asserted this is backfill (poll sets it)
 * @param {boolean} a.backfillDone  watermark: has the one-time sweep completed?
 * @returns {{isPollSourced:boolean, recordOnly:boolean, mayMutateSend:boolean, processStatus:string}}
 */
export function resolveEventPolicy({
  eventId,
  sendMatch = null,
  backfillFlag = false,
  backfillDone = true,
} = {}) {
  const isPollSourced = String(eventId || "").startsWith("poll:");

  // Record-only while the one-time sweep is outstanding. Scoped to poll-sourced events so a
  // live Apollo webhook or the Gmail inbox watch is never suppressed by a sweep that has
  // nothing to do with it. An explicit caller flag always wins.
  const recordOnly = backfillFlag === true || (isPollSourced && !backfillDone);

  // Only an exact apollo_emailer_message_id hit identifies the send that actually produced
  // this message. The other two resolutions are `ORDER BY sent_at DESC LIMIT 1` best-guesses
  // that land on the contact's CURRENT live row — and `sdr_sends` stores only the FIRST
  // message id per send, so every follow-up-step message falls through to them. On this book
  // 52 addresses have a live row plus an earlier row for the same address and 164 rows are
  // 'switched', so a fallback-driven mutation would flip a running send to 'replied' and
  // eject a mid-sequence contact from their live campaign, off a months-old message.
  // `removeContactsFromSequence` is idempotent against an already-removed contact, NOT
  // against one who has since been re-added — so this is unretryable damage, not a no-op.
  const mayMutateSend = sendMatch === "message_id";

  return {
    isPollSourced,
    recordOnly,
    mayMutateSend,
    processStatus: recordOnly ? "backfilled" : "pending",
  };
}

/**
 * May the one-time backfill sweep close its window?
 *
 * Lives here, next to the policy it protects, because getting it wrong is how the containment
 * above gets bypassed entirely. On 2026-07-28 the sweep walked every sequence, had all of its
 * inserts rejected by a CHECK constraint that did not list 'backfilled', dropped the failures
 * silently, and stamped the watermark anyway. `backfillDone` then flipped true, the next full
 * scan re-ingested 35 events aged 5-20 days through the LIVE side-effect path, and the client's
 * Pipedrive took ~35 duplicate notes. `resolveEventPolicy` behaved perfectly throughout; the
 * watermark lied to it.
 *
 * Read-side truncation (rate limit, budget ceiling) is handled by the caller. This covers the
 * write side: a sweep that persisted nothing has swept nothing.
 *
 * @param {object}  a
 * @param {boolean} a.backfillMode   is this cycle the one-time sweep?
 * @param {number}  a.emitFailures   events the ingest endpoint refused or never answered
 * @returns {boolean} true = safe to stamp engagement_backfill_done_at
 */
export function shouldCloseBackfillWindow({ backfillMode = false, emitFailures = 0 } = {}) {
  if (!backfillMode) return true; // a normal full scan does not own this watermark
  return Number(emitFailures) === 0;
}
