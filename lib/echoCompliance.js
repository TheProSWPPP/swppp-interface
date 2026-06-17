// Pure parsing + scoring for EPA ECHO CWA compliance summaries. No I/O.

function toInt(v) { const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : 0; }

/** Pull the violation/inspection counts out of an ECHO get_facilities JSON body.
 *  `error:true` means ECHO returned an error (e.g. throttling: "exceed 300/hour or
 *  1,500/day") — callers MUST NOT treat that as "zero violations" and overwrite data. */
export function parseEchoSummary(json) {
  const r = json && json.Results;
  if (!r || r.Error) {
    // null/empty body (fetch failure) or an ECHO error (e.g. throttling) — NOT "zero violations".
    return { error: true, found: false, sv: 0, cv: 0, vioLast4Q: 0, insp: 0, penalties: 0 };
  }
  return {
    error: false,
    found: toInt(r.QueryRows) > 0,
    sv: toInt(r.SVRows), cv: toInt(r.CVRows), vioLast4Q: toInt(r.VioLast4QRows),
    insp: toInt(r.INSPRows), penalties: toInt(r.TotalPenalties),
  };
}

/** 0..20 "renewal pain" signal. Current violation dominates; significant violations and
 *  any inspection history add smaller bumps. Tunable; current violations are the hot tier. */
export function compliancePain(c = {}) {
  let p = 0;
  if (toInt(c.vioLast4Q) > 0 || toInt(c.cv) > 0) p += 12; // out of compliance NOW = hottest
  if (toInt(c.sv) > 0) p += 6;                             // significant violation on record
  if (toInt(c.insp) > 0) p += 2;                           // has been inspected = on the radar
  return Math.min(20, p);
}
