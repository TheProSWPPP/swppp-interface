// Former addresses of a .co mailbox that now lives under another address.
//
// 2026-10-27: Daniela's mailbox admin@proswppp.co was handed to Michael Forster and the Google
// Workspace user renamed to mf@proswppp.co (Google keeps admin@ as an alias, the OAuth refresh
// token stays valid). The app's rows were moved to mf@proswppp.co, but Apollo can keep reporting
// the old address on messages, events and scheduled steps for people already in a sequence, and
// pending work can still carry it. Every place that turns an address into a mailbox (the Gmail
// token, reply routing, message facts, the outbox view) resolves it through here first.
export const MAILBOX_ALIASES = Object.freeze({
  'admin@proswppp.co': 'mf@proswppp.co',
});

export function canonicalMailbox(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return MAILBOX_ALIASES[email] || email;
}
