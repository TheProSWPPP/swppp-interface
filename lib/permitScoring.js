// Pure scoring for the permit pool. No I/O. `now` is injected for deterministic tests.

/** Years between an ISO date string and `now` (default huge if missing → oldest). */
function yearsAgo(dateStr, now) {
  if (!dateStr) return 99;
  const then = new Date(dateStr + "T00:00:00Z").getTime();
  const ref = new Date(now + "T00:00:00Z").getTime();
  if (Number.isNaN(then) || Number.isNaN(ref)) return 99;
  return (ref - then) / (365.25 * 24 * 3600 * 1000);
}

/**
 * Composite rank. Higher = warmer/bigger.
 * v1 inputs (EPA): original_issue_date, facility_count.
 * Later-phase inputs (default 0): sector_weight, compliance_pain.
 */
export function scoreFacility(f, opts = {}) {
  const now = opts.now || "2026-06-15";
  const recency = Math.max(0, 10 - yearsAgo(f.original_issue_date, now)); // 0..10, newer = higher
  const size = Math.min(15, (Number(f.facility_count) || 1) * 3);          // multi-site account, capped
  const sector = Number(f.sector_weight) || 0;
  const compliance = Number(f.compliance_pain) || 0;
  return Math.round((recency + size + sector + compliance) * 100) / 100;
}
