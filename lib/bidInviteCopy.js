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

// Words that mean the "name" is a placeholder, a role or a team, not a person: the email then
// opens with "Hey," instead of "Hey Estimating,".
const NOT_A_NAME = new Set(["n/a", "tbd", "tba", "none", "unknown", "null", "test", "name", "contact", "first", "firstname",
  "estimating", "estimator", "estimators", "estimation", "department", "dept", "office", "team", "bids", "bid", "bidding", "info", "admin",
  "sales", "precon", "preconstruction", "project", "projects", "manager", "accounts", "purchasing", "procurement", "the", "general",
  "construction", "contractor", "operations", "support", "hello", "plans", "planroom"]);
const TITLES = /^(mr|mrs|ms|miss|mx|dr|prof|rev|sir|madam|mister)\.?$/i;
const SUFFIX = /^(jr|sr|ii|iii|iv|v|pe|p\.e|phd|esq|mba|cpa)\.?$/i;

// "rodger caffey" -> "Rodger", "RODGER" -> "Rodger", "Caffey, Rodger" -> "Rodger", "Dr. Jane Doe" -> "Jane".
// Blank, an address, a placeholder (N/A, TBD) or a role ("Estimating Department") -> null, and the
// email opens with "Hey,".
export function firstName(personName) {
  let raw = String(personName ?? "").replace(/\s+/g, " ").trim();
  if (!raw || raw.includes("@")) return null;
  // "NA" alone is a placeholder; "Na" inside a name ("Li Na") is a name.
  if (/^n\.?\s*\/?\s*a\.?$/i.test(raw)) return null;
  // "Last, First" and "Last, First, Jr." (suffix parts dropped first).
  const comma = raw.split(",").map((p) => p.trim()).filter(Boolean).filter((p) => !SUFFIX.test(p));
  if (comma.length === 2 && /[a-z]/i.test(comma[1])) raw = comma[1];
  else if (comma.length === 1) raw = comma[0];
  const words = raw.split(" ").map((w) => w.replace(/^[^\p{L}]+|[^\p{L}'.-]+$/gu, "")).filter(Boolean);
  if (words.some((w) => NOT_A_NAME.has(w.toLowerCase().replace(/\.$/, "")))) return null;
  const first = words.find((w) => !TITLES.test(w)) || "";
  const bare = first.replace(/\.$/, "");
  if (!/^\p{L}[\p{L}'-]*$/u.test(bare) || bare.replace(/[^\p{L}]/gu, "").length < 2) return null;
  const flat = bare === bare.toLowerCase() || bare === bare.toUpperCase();
  return flat ? bare[0].toUpperCase() + bare.slice(1).toLowerCase() : bare;
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
