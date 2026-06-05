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
