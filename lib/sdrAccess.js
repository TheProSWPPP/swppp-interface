// SDR access-control helpers — owner-scoping for queries, per-lead advisory lock.

/**
 * Build owner-scoped WHERE-fragment + param for SDR queries.
 * Admin users (role === 'admin') see everything; SDR users see only their own rows.
 *
 * Usage pattern:
 *   const params = [status];
 *   let sql = `SELECT * FROM sdr_drafts WHERE status = $1`;
 *   const scope = ownerScope(req.sdrUser);
 *   if (scope.requires) {
 *     params.push(scope.value);
 *     sql += ` AND ${scope.column} = $${params.length}`;
 *   }
 *   await pool.query(sql, params);
 *
 * @param {object} user - JWT claims (must include role and sub)
 * @param {string} columnName - default 'assigned_user_id'
 */
export function ownerScope(user, columnName = "assigned_user_id") {
  if (!user) return { requires: true, column: columnName, value: "__no_user__" }; // deny-all if no user
  if (user.role === "admin") return { requires: false, column: columnName, value: null };
  return { requires: true, column: columnName, value: user.sub };
}

// ── Lead visibility ────────────────────────────────────────────────────────────────────
//
// `ownerScope` above works because drafts, sends and mailboxes each carry an owner column.
// A LEAD does not: `sdr_lead_state` has no per-user column, which is the actual root cause
// of the 2026-07-28 finding that /api/sdr/leads returned a byte-identical payload to an
// admin and to an SDR who owns nothing.
//
// The rule (locked by Ivan 2026-07-29, do not "improve" it in passing):
//
//   a lead with NO draft at all is a shared pool, visible to everyone
//   the moment a draft exists, the lead is private to that draft's assignee, plus admin
//
// Ivan's words: "everyone can although they get round robin assigned at sending time."
// On the live book that is 7,753 shared + each rep's own: michael 8,010, terry 8,039,
// josie 8,025, cameron/sarah/daniela 7,753, derek 8,831 by admin bypass.
//
// Written as a pair of EXISTS rather than a LEFT JOIN on purpose. A LEFT JOIN to sdr_drafts
// fans out one row per draft: measured 8,075 rows for 8,010 distinct leads, which corrupts
// `COUNT(*) OVER()` and breaks paging. Both EXISTS collapse to a hashed SubPlan (loops=1),
// so this is a hash build per query, not a correlated probe per row.
//
// DO NOT reuse this in lib/autoOutreach.js. Its :73-77 dedup guard is a structurally
// identical NOT EXISTS against sdr_drafts and means the opposite thing (skip leads already
// drafted). Merging the two inverts the engine's dedup and re-mails contacted leads.

// Which drafts make a lead private. Deliberately the SAME status set the auto-outreach engine
// treats as "already drafted" (`lib/autoOutreach.js:73-77`). A draft that failed, was rejected,
// or was cancelled did not result in contact, and the engine will re-offer that lead to any rep
// after 30 days, so it must not sit privately in one person's list in the meantime. Measured:
// 141 leads were privatised forever by a dead draft before this clause existed.
//
// `assigned_user_id IS NOT NULL` matters just as much. A draft with no assignee belongs to
// nobody, so without this a lead carrying one would satisfy neither half and vanish for every
// SDR at once while staying visible to admin. Five such drafts exist today on one lead.
const LIVE_DRAFT = `vd.assigned_user_id IS NOT NULL
                      AND vd.status IN ('pending','approved','edited','sent')`;

const LEAD_VISIBLE_SQL = (alias, ph) =>
  `(NOT EXISTS (SELECT 1 FROM sdr_drafts vd
                 WHERE vd.pipedrive_lead_id = ${alias}.pipedrive_lead_id
                   AND ${LIVE_DRAFT})
    OR EXISTS (SELECT 1 FROM sdr_drafts vd
                WHERE vd.pipedrive_lead_id = ${alias}.pipedrive_lead_id
                  AND vd.assigned_user_id = ${ph}
                  AND vd.status IN ('pending','approved','edited','sent')))`;

/**
 * Lead-visibility fragment for any query over `sdr_lead_state`.
 *
 * @param {object} user   JWT claims (role + sub); admin gets no clause
 * @param {string} alias  table alias for sdr_lead_state in the target query
 * @returns {{requires:boolean, value:string|null, sql:(placeholder:string)=>string}}
 */
export function leadVisibilityScope(user, alias = "s") {
  if (user?.role === "admin") return { requires: false, value: null, sql: () => "TRUE" };
  // No user: the nil UUID, which is a VALID uuid that no row can carry, so the second EXISTS
  // evaluates false and the caller is left with the shared pool.
  //
  // Deliberately not `ownerScope`'s `'__no_user__'` string. That does not evaluate false, it
  // raises Postgres 22P02 (invalid input syntax for type uuid) — verified against the live DB.
  // The intent still holds there because an error denies too, but it denies by 500 rather than
  // by returning nothing, and a comment claiming otherwise is worse than no comment. Every
  // route using this sits behind the JWT gate at server.js:479-489 anyway, so this is defence
  // in depth rather than the gate itself.
  const value = user?.sub || "00000000-0000-0000-0000-000000000000";
  return { requires: true, value, sql: (ph) => LEAD_VISIBLE_SQL(alias, ph) };
}

/**
 * Is a single lead visible to this user? Used by the by-id routes.
 *
 * A scoped list endpoint is worthless if the detail route answers by id for anybody, which is
 * exactly what was live before this: GET /api/sdr/leads/:leadId/detail returned every draft's
 * subject, body and assignee for any lead to any SDR, so the correctly-scoped
 * GET /api/sdr/drafts/:id was fully defeated by it.
 *
 * @returns {Promise<boolean>} true if the user may see this lead
 */
export async function leadVisibleTo(pool, user, leadId) {
  if (user?.role === "admin") return true;
  if (!leadId) return false;
  const scope = leadVisibilityScope(user, "s");
  const { rows } = await pool.query(
    `SELECT 1 FROM sdr_lead_state s WHERE s.pipedrive_lead_id = $1 AND ${scope.sql("$2")} LIMIT 1`,
    [String(leadId), scope.value],
  );
  return rows.length > 0;
}

/**
 * Acquire a per-lead Postgres advisory lock for the duration of the transaction.
 * Prevents two parallel draft→approve→send transitions on the same lead racing into Apollo.
 *
 * Must be called inside a transaction (BEGIN/COMMIT). Lock auto-releases on tx end.
 *
 * @param {import('pg').PoolClient} client - active transaction client
 * @param {string} leadId - pipedrive_lead_id (string)
 */
export async function acquireLeadLock(client, leadId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [String(leadId)]);
}

/**
 * Convenience: run a function inside a tx with the per-lead advisory lock held.
 */
export async function withLeadLock(pool, leadId, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await acquireLeadLock(client, leadId);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
