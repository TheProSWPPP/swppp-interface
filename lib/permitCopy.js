// Which MSGP copy should go out right now, the pre-expiry pitch or the post-expiry one.
//
// TXR050000 expires 2026-08-13. What made this worth building: TCEQ opens the renewal
// applications (INOI-R / INEC-R) at 8:00 AM on that same day and closes them 90 days later,
// on 2026-11-12. So the date the campaign was pointed at is the start of the selling window
// rather than the end of it, and the outreach runs for another three months after it.
//
// The pre-expiry copy says the permit "is set to expire on August 13, 2026". Left alone it
// would still be saying that in October, reading like a notice about a deadline the operator
// already missed. After the 13th the true message is stronger and simpler: the authorization
// has lapsed, they have until November 12 to re-file, and until they do they are operating
// without coverage.
//
// The switch is a timestamp on the template row so it can be moved without a deploy, which
// matters because TCEQ's own page says August 14 while the industry write-ups and our
// facility records say August 13.

/** 2026-08-13 08:00 America/Chicago, when TCEQ's renewal forms go live. */
export const DEFAULT_EXPIRY_SWITCH_AT = "2026-08-13T13:00:00Z";

/**
 * @param tpl row from permit_msgp_template: {subject, body_html, expired_subject,
 *            expired_body_html, expiry_switch_at}
 * @param now injectable for tests
 * @returns {subject, body_html, variant} where variant is "pre" or "expired"
 */
export function choosePermitCopy(tpl, now = new Date()) {
  const pre = { subject: tpl?.subject || null, body_html: tpl?.body_html || null, variant: "pre" };
  if (!tpl) return pre;

  // No post-expiry copy written yet: keep sending the pre-expiry pitch rather than nothing.
  if (!tpl.expired_subject || !tpl.expired_body_html) return pre;

  const raw = tpl.expiry_switch_at || DEFAULT_EXPIRY_SWITCH_AT;
  const at = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  if (Number.isNaN(at)) return pre; // unparseable switch date: stay on the known-good copy

  if (now.getTime() < at) return pre;
  return { subject: tpl.expired_subject, body_html: tpl.expired_body_html, variant: "expired" };
}
