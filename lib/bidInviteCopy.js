// Bid invite follow-up email copy. Pure.
//
// The wording is exactly what Derek was shown on the client page (ProSWPPP-Bid-Invites-and-
// LinkedIn.html, Part 1, "The emails"). Change it only after Derek changes it there.
// Two things are NOT on that page and are flagged on every dry-run sample that uses them, so
// Ivan can get Derek's OK first:
//   - E2/E3 for several projects ("checking back on A, B and C");
//   - the signature block under the email.

export const GROUPED_SUBJECT = "Your recent bids";
export const FLAG_GROUPED_FOLLOWUP = "grouped_followup_wording_not_on_page";
export const FLAG_SIGNATURE = "signature_not_on_page";

// "rodger caffey" -> "Rodger", "RODGER" -> "Rodger", "Katie" -> "Katie".
// Blank, or an address instead of a name -> null (the email then opens with "Hey,").
export function firstName(personName) {
  const first = String(personName ?? "").trim().split(/\s+/)[0] || "";
  if (!first || first.includes("@") || !/[a-z]/i.test(first)) return null;
  const flat = first === first.toLowerCase() || (first.length > 1 && first === first.toUpperCase());
  return flat ? first[0].toUpperCase() + first.slice(1).toLowerCase() : first;
}

// "A", "A and B", "A, B and C".
export function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * step: "e1" | "e2" | "e3". names: short project names, newest bid first (1-3).
 * Returns { subject, bodyText, bodyHtml, flags }. subject is null for E2/E3: they are replies
 * in the E1 thread, so the sender uses "Re: <E1 subject>".
 */
export function renderBidEmail({ step, firstName: first = null, names = [], signature = null }) {
  const list = (names || []).filter(Boolean);
  if (!list.length) throw new Error("bid_email_needs_a_project_name");
  if (!["e1", "e2", "e3"].includes(step)) throw new Error(`bid_email_unknown_step:${step}`);
  const hi = first ? `Hey ${first},` : "Hey,";
  const flags = [];
  let subject = null;
  let body;
  if (step === "e1" && list.length === 1) {
    subject = list[0];
    body = `${hi} did y'all win ${list[0]}? You should have a bid from us on the SWPPP. Let us know when you need it.`;
  } else if (step === "e1") {
    subject = GROUPED_SUBJECT;
    body = `${hi} did y'all win any of these? ${list.join(", ")}. You should have SWPPP bids from us on each one. Let us know when you need us.`;
  } else {
    const short = joinNames(list);
    if (list.length > 1) flags.push(FLAG_GROUPED_FOLLOWUP);
    body = step === "e2"
      ? `${hi} checking back on ${short}. If it went your way, we can have the SWPPP ready before you mobilize.`
      : `${hi} last note on ${short}. If you won it, happy to get the SWPPP going. If it went another way, no worries.`;
  }
  const sig = String(signature ?? "").replace(/\r\n/g, "\n").trim();
  if (sig) flags.push(FLAG_SIGNATURE);
  const bodyText = sig ? `${body}\n\n${sig}` : body;
  // Plain HTML, no tracking pixel, so it reads like a person typed it.
  const bodyHtml = `<div>${escapeHtml(bodyText).replace(/\n/g, "<br>")}</div>`;
  return { subject, bodyText, bodyHtml, flags };
}

export const replySubject = (firstSubject) => (/^re:/i.test(String(firstSubject || "")) ? firstSubject : `Re: ${firstSubject}`);
