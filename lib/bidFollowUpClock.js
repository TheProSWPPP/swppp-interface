// The old bid follow-up clock (before-bid "make sure it came through" tasks, BID_FOLLOWUP_ENABLED)
// was removed on 2026-11-03: Derek asked for nothing before the bid date. Bid follow-ups are now
// sent by lib/bidInviteEngine.js (BID_INVITE_SEQUENCE). The bid_followup_marks table it wrote
// stays, because lib/followupOutcomeReadout.js still reads it.
//
// The business-day helpers moved to lib/businessDays.js and are re-exported here for the
// modules that import them from this path (lib/quietConversationClock.js).
export { addBusinessDays, chicagoNow } from "./businessDays.js";
