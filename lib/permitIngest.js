// Pure logic for EPA Envirofacts TXR050000 ingest. No I/O.

const LEGAL_SUFFIXES = /\b(l\.?l\.?c|l\.?p|inc|incorporated|co|corp|corporation|ltd|company|limited|lllp|llp|pllc)\b/g;

/** Active Multi-Sector NOI? TXR05 prefix = NOI, TXRNE = NEC (excluded). EFF = active. */
export function isActiveNoi(row) {
  const epn = (row?.external_permit_nmbr || "").toUpperCase();
  const status = (row?.permit_status_code || "").toUpperCase();
  if (!epn.startsWith("TXR05")) return false; // excludes TXRNE (NEC) and anything else
  return status === "EFF";
}

/** Collapse runs of space-separated single letters into one token (e.g. "k a t" -> "kat").
 *  This makes initialisms ("K.A.T.") match their unspaced form ("KAT") after punctuation
 *  stripping turns dots into spaces. */
function collapseInitials(s) {
  return s.replace(/\b(?:[a-z](?:\s+(?=[a-z]\b))?)+\b/g, (m) => m.replace(/\s+/g, ""));
}

/** Normalize an operator name to a dedupe key: lowercase, strip punctuation + legal suffixes. */
export function operatorKey(name) {
  if (!name) return "";
  const cleaned = String(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,/#!$%^*;:{}=\-_`~()'"]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapseInitials(cleaned).replace(/\s+/g, " ").trim();
}

/** Trim an EPA timestamp ("2026-08-13 00:00:00") to a date string, or null. */
function toDate(v) {
  if (!v) return null;
  return String(v).slice(0, 10);
}

/** Map a raw EPA row to our permit_facilities record shape. */
export function shapeFacility(row) {
  const operator = row?.permit_name || null;
  return {
    external_permit_nmbr: row?.external_permit_nmbr || null,
    master_permit: "TXR050000",
    state: "TX",
    operator_name: operator,
    operator_key: operatorKey(operator),
    coverage_type: "NOI",
    effective_date: toDate(row?.effective_date),
    expiration_date: toDate(row?.expiration_date),
    original_issue_date: toDate(row?.original_issue_date),
    status: "pool",
  };
}
