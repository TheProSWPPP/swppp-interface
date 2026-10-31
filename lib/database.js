import pg from "pg";

export function createDatabasePool(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    ssl: connectionString ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    // Leave time for the server's cancellation response; also bound a dead socket.
    query_timeout: 65_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  pool.on("error", error => console.warn("[database] idle connection closed", error.code || "unknown"));
  return pool;
}

export function databaseHealthHandler(pool, configured) {
  return async (_req, res) => {
    if (configured) {
      try {
        await pool.query({ text: "SELECT 1", query_timeout: 3000 });
        return res.json({ status: "ok", database: true });
      } catch { /* Readiness must reflect an unavailable database without leaking details. */ }
    }
    return res.status(503).json({ status: "unavailable", database: false });
  };
}
