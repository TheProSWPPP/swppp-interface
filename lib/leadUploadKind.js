// Explicit upload intent for POST /api/leads/upload.
//
// Derek uploads two different sheets: the monthly CMD project list (cold outreach) and the
// estimator's bid tracker (customers and warm leads who must never get cold sequences).
// Auto-detection (lib/leadCsvNormalize.js detectSource) stays as the mechanism, but the
// upload screen now has one button per sheet and the server refuses a mismatch instead of
// quietly importing the wrong sheet under the wrong origin.
//
// A request with no `kind` (older clients) is accepted exactly as before.

import { parseCsv, ORIGIN_COLUMN } from "./leadCsvNormalize.js";

export const UPLOAD_KINDS = ["bid_sheet", "project_list"];

export const BID_SHEET_WRONG_FILE = "This doesn't look like a bid invites sheet. Use CMD upload.";
export const PROJECT_LIST_WRONG_FILE = "This looks like a bid invites sheet. Use Bid invites upload.";
/** "Platform must be BC, CC, ISQFT or Other (rows 4, 9)". Lists the first ten rows. */
export function platformErrorMessage(platformErrors) {
  const rows = platformErrors.map((e) => e.row);
  const shown = rows.slice(0, 10).join(", ");
  const more = rows.length > 10 ? ` and ${rows.length - 10} more` : "";
  return `Platform must be BC, CC, ISQFT or Other (${rows.length === 1 ? "row" : "rows"} ${shown}${more})`;
}
export const BID_SHEET_BAD_ORIGIN =
  "Some rows in this file are not marked as bid invitations, so they cannot be imported as a bid invites sheet.";

/** The form value as sent, or null when absent/blank. Never throws. */
export function readUploadKind(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

/**
 * @param {string|null} kind   readUploadKind() output
 * @param {{csv: string, source: string, platformErrors?: {row: number}[]}} normalized   normalizeLeadCsv() output
 * @returns {{ok: true} | {ok: false, status: 400, error: string}}
 */
export function checkUploadKind(kind, normalized) {
  if (kind === null) return { ok: true };
  if (!UPLOAD_KINDS.includes(kind)) {
    return { ok: false, status: 400, error: `Unknown upload kind "${kind}". Use bid_sheet or project_list.` };
  }
  const isTracker = normalized.source === "bid-aggregator";
  if (kind === "project_list") {
    return isTracker ? { ok: false, status: 400, error: PROJECT_LIST_WRONG_FILE } : { ok: true };
  }
  if (!isTracker) return { ok: false, status: 400, error: BID_SHEET_WRONG_FILE };

  // A Platform cell that is not BC, CC, ISQFT or Other refuses the whole file, so a typo can
  // never become a lead origin the Bid Invite guards do not recognise.
  if (normalized.platformErrors?.length) {
    return { ok: false, status: 400, error: platformErrorMessage(normalized.platformErrors) };
  }

  // The tracker must come out of normalisation with every row marked as a bid invitation.
  // normalizeLeadCsv keeps a pre-existing "Lead Origin" column verbatim, so check the output.
  const rows = parseCsv(normalized.csv);
  const col = rows.length ? rows[0].indexOf(ORIGIN_COLUMN) : -1;
  if (col < 0) return { ok: false, status: 400, error: BID_SHEET_BAD_ORIGIN };
  for (const r of rows.slice(1)) {
    if (!String(r[col] ?? "").startsWith("Bid Invite")) {
      return { ok: false, status: 400, error: BID_SHEET_BAD_ORIGIN };
    }
  }
  return { ok: true };
}
