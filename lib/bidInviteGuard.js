// Bid-tracker contacts (Pipedrive Lead Origin "Bid Invite" / "Bid Invite: <platform>") come from
// the estimator's bid sheet. Derek: "mostly customers or really warm leads", so the automatic cold
// drip never enrolls them. Staff can still email them by hand.
export const isBidInviteOrigin = value => /^\s*bid invite/i.test(String(value ?? ""));
