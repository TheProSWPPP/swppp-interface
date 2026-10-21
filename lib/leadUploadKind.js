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

export const BID_SHEET_WRONG_FILE = "This doesn't look like the bid tracker. Use Upload project list.";
export const PROJECT_LIST_WRONG_FILE = "This looks like the estimator's bid tracker. Use Upload bid sheet.";
export const BID_SHEET_BAD_ORIGIN =
  "Some rows in this file are not marked as bid invitations, so they cannot be imported as a bid sheet.";

/** The form value as sent, or null when absent/blank. Never throws. */
export function readUploadKind(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

/**
 * @param {string|null} kind   readUploadKind() output
 * @param {{csv: string, source: string}} normalized   normalizeLeadCsv() output
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
