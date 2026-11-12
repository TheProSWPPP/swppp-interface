// Former addresses of a .co mailbox that now lives under another address.
//
// 2026-10-27: Daniela's mailbox admin@proswppp.co was handed to Michael Forster and the Google
// Workspace user renamed to mf@proswppp.co. 2026-11-12: Michael left and Derek asked for the
// mailbox back as admin@proswppp.co, so the app's rows moved back and the map now points the
// other way. Gmail keeps stamping mf@ on what this account sends until the Google user is
// renamed back, and pending work written in between can still carry it. Every place that turns
// an address into a mailbox (the Gmail token, reply routing, message facts, the outbox view)
// resolves it through here first.
export const MAILBOX_ALIASES = Object.freeze({
  'mf@proswppp.co': 'admin@proswppp.co',
});

export function canonicalMailbox(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return MAILBOX_ALIASES[email] || email;
}
