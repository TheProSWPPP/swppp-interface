// Apollo email finder for permit operators. For each promoted operator not yet
// probed: company search -> primary domain -> people search -> pick a decision-maker
// -> /people/match {reveal_personal_emails} to reveal the email (~1 credit, ONLY when
// a domain was found). Stores a row in permit_operator_email for EVERY probed operator
// (email NULL when none found = "discarded"), so we never re-probe / re-spend on the
// same company. Promoted-only + caller-capped — never the full pool.
const APOLLO_BASE = "https://api.apollo.io/v1";

async function apollo(path, body) {
  const r = await fetch(APOLLO_BASE + path, {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.APOLLO_API_KEY,
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = {}; }
  return { status: r.status, j };
}

const isRealEmail = (e) => e && !/not_unlocked|@domain\.com$/i.test(e) && /@/.test(e);
const DECISION_MAKER = /owner|president|principal|founder|manager|director|operations|environment|safety|compliance/i;

/**
 * Probe up to `cap` promoted operators for an email. Returns counts.
 * @returns {Promise<{probed:number, found:number, discarded:number, hadDomain:number}>}
 */
export async function findEmailsForPromoted(pool, { cap = 25 } = {}) {
  if (!process.env.APOLLO_API_KEY) {
    const e = new Error("Apollo not configured.");
    e.status = 503;
    throw e;
  }
  const limit = Math.min(100, Math.max(1, parseInt(cap, 10) || 25));

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (f.operator_key) f.operator_key, f.operator_name
       FROM permit_facilities f
      WHERE f.status IN ('promoted','enriched') AND f.operator_name IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM permit_operator_email e WHERE e.operator_key = f.operator_key)
      ORDER BY f.operator_key, f.score DESC
      LIMIT $1`,
    [limit],
  );

  let found = 0;
  let hadDomain = 0;
  for (const op of rows) {
    let domain = null, orgId = null, email = null, name = null, title = null;
    try {
      const co = await apollo("/mixed_companies/search", { q_organization_name: op.operator_name, page: 1, per_page: 1 });
      const org = (co.j.organizations || co.j.accounts || [])[0];
      domain = org?.primary_domain || null;
      orgId = org?.id || null;
      if (domain && orgId) {
        hadDomain++;
        const ppl = await apollo("/mixed_people/search", { organization_ids: [orgId], page: 1, per_page: 10 });
        const people = ppl.j.people || [];
        const pick = people.find((p) => DECISION_MAKER.test(p.title || "")) || people[0];
        if (pick) {
          const m = await apollo("/people/match", {
            first_name: pick.first_name, last_name: pick.last_name,
            domain, organization_name: op.operator_name, reveal_personal_emails: true,
          });
          const e = m.j.person?.email;
          if (isRealEmail(e)) {
            email = e;
            name = `${pick.first_name || ""} ${pick.last_name || ""}`.trim() || null;
            title = pick.title || null;
            found++;
          }
        }
      }
    } catch { /* skip on error — still record the probe below */ }

    await pool.query(
      `INSERT INTO permit_operator_email (operator_key, operator_name, email, contact_name, title, domain, apollo_org_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (operator_key) DO UPDATE SET
         email = EXCLUDED.email, contact_name = EXCLUDED.contact_name, title = EXCLUDED.title,
         domain = EXCLUDED.domain, apollo_org_id = EXCLUDED.apollo_org_id, probed_at = NOW()`,
      [op.operator_key, op.operator_name, email, name, title, domain, orgId],
    );
    await new Promise((r) => setTimeout(r, 350)); // be gentle on Apollo
  }

  return { probed: rows.length, found, discarded: rows.length - found, hadDomain };
}
