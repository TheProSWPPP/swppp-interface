// Interface link to one project's conversation. thread + mailbox pin the exact thread when the
// caller knows it, so a buyer on several projects never lands on another project's thread.
export function leadInboxLink(base, leadId, where = null) {
  const pin = where?.threadId && where?.mailbox ? `&thread=${encodeURIComponent(where.threadId)}&mailbox=${encodeURIComponent(where.mailbox)}` : "";
  return `${base}/#/sdr?inboxLead=${encodeURIComponent(leadId)}${pin}`;
}
