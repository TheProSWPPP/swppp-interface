import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabasePool, databaseHealthHandler } from "../database.js";

afterEach(() => vi.restoreAllMocks());

describe("database interruption recovery", () => {
  it("releases a job waiting for a database that accepts TCP but never completes startup", async () => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const pool = createDatabasePool(`postgres://test@127.0.0.1:${server.address().port}/test?sslmode=disable`);
    let outcome;
    try {
      outcome = await Promise.race([
        pool.query("SELECT 1").then(() => "unexpected success", e => e.message),
        delay(11_000, "job still waiting"),
      ]);
    } finally {
      for (const socket of sockets) socket.destroy();
      await pool.end();
      await new Promise(resolve => server.close(resolve));
    }
    expect(outcome).toMatch(/timeout/i);
  }, 15_000);

  it("handles an idle database disconnection without an uncaught process error or sensitive error text", async () => {
    const pool = createDatabasePool();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => pool.emit("error", Object.assign(new Error("private connection details"), { code: "ECONNRESET" }))).not.toThrow();
      expect(warn.mock.calls.flat().join(" ")).toContain("ECONNRESET");
      expect(warn.mock.calls.flat().join(" ")).not.toContain("private connection details");
    } finally { await pool.end(); }
  });
});

describe("database readiness", () => {
  const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  it("reports unavailable when the configured database cannot be queried, without exposing the error", async () => {
    const res = response();
    await databaseHealthHandler({ query: async () => { throw new Error("private database details"); } }, true)({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ status: "unavailable", database: false });
  });
  it("reports unavailable when database configuration is absent", async () => {
    const res = response();
    await databaseHealthHandler(null, false)({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ status: "unavailable", database: false });
  });
  it("reports ready after a successful database query", async () => {
    const res = response();
    await databaseHealthHandler({ query: async () => ({ rows: [{ ready: 1 }] }) }, true)({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "ok", database: true });
  });
});

describe.runIf(process.env.SDR_TEST_DATABASE_URL)("database server interruption limits", () => {
  it("cancels a long-running statement and can immediately execute the next query", async () => {
    const pool = createDatabasePool(process.env.SDR_TEST_DATABASE_URL);
    try {
      await expect(pool.query("SELECT pg_sleep(61)")).rejects.toMatchObject({ code: "57014" });
      expect((await pool.query("SELECT 1 AS ready")).rows).toEqual([{ ready: 1 }]);
    } finally { await pool.end(); }
  }, 70_000);
});
