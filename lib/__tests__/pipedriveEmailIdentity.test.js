import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyOneLead } from "../emailVerifyRefresh.js";
import { setPrimaryEmail } from "../pipedriveClient.js";

const originalToken = process.env.PIPEDRIVE_API_TOKEN;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.PIPEDRIVE_API_TOKEN;
  else process.env.PIPEDRIVE_API_TOKEN = originalToken;
});



describe("setPrimaryEmail", () => {
  it("preserves every existing address and label while promoting a same-person correction", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "fixture";
    const current = [
      { value: "dead@acme.com", primary: true, label: "office" },
      { value: "new@acme.com", primary: false, label: "alternate" },
      { value: "secondary@acme.com", primary: false, label: "home" },
      { value: "personal@elsewhere.test", primary: false, label: "other" },
    ];
    let sent;
    globalThis.fetch = vi.fn(async (_url, options) => {
      if (options.method === "GET") return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { id: 9, email: current } }) };
      sent = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { id: 9, email: sent.email } }) };
    });
    await setPrimaryEmail(9, "new@acme.com", { keepOld: "dead@acme.com" });
    expect(sent.email).toEqual([
      { value: "new@acme.com", primary: true, label: "alternate" },
      { value: "dead@acme.com", primary: false, label: "office" },
      { value: "secondary@acme.com", primary: false, label: "home" },
      { value: "personal@elsewhere.test", primary: false, label: "other" },
    ]);
  });

  it("does not reintroduce a candidate removed from the person's fresh address list", async () => {
    process.env.PIPEDRIVE_API_TOKEN = "fixture";
    let writes = 0;
    globalThis.fetch = vi.fn(async (_url, options) => {
      if (options.method === "PUT") writes++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: {
        id: 9, email: [{ value: "dead@acme.com", primary: true, label: "office" }],
      } }) };
    });
    await expect(setPrimaryEmail(9, "removed@acme.com", { keepOld: "dead@acme.com" })).rejects.toMatchObject({ code: "email_identity_changed" });
    expect(writes).toBe(0);
  });
});


describe("fresh identity refusal keeps the invalid-address hold", () => {
  it.each([
    ["missing ID", { email: [{ value: "new@example.test" }] }],
    ["wrong ID", { id: 10, email: [{ value: "new@example.test" }] }],
    ["malformed email list", { id: 9, email: {} }],
    ["failed fresh read", null],
  ])("holds and cancels after %s", async (_name, fresh) => {
    process.env.PIPEDRIVE_API_TOKEN = "fixture";
    let puts = 0, stops = 0;
    globalThis.fetch = vi.fn(async (_url, options) => {
      if (options.method === "PUT") puts++;
      if (!fresh) throw new Error("fresh read timeout");
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: fresh }) };
    });
    const writes = [];
    const result = await verifyOneLead({ query: async (sql, params) => { writes.push({ sql, params }); return { rows: [], rowCount: 1 }; } },
      { leadId: "lead", personId: 9, orgId: 5, email: "bad@example.test" }, {
        verify: async email => ({ ok: email === "new@example.test", status: email === "new@example.test" ? "valid" : "invalid" }),
        listOrgPersons: async () => [{ id: 9, email: [{ value: "new@example.test" }] }],
        setPrimaryEmail, canUseApollo: () => false, addNote: async () => ({}),
        cancelInFlightOutreach: async () => { stops++; return { removedEnrollments: 0, unresolvedRemovals: 0 }; },
      });
    expect(result).toMatchObject({ outcome: "review", email_flag: "email_bad", resolved_email: null });
    expect(puts).toBe(0);
    expect(stops).toBe(1);
    expect(writes.find(w => w.sql.includes("UPDATE sdr_lead_state")).params).toEqual(["lead", "invalid", "bad@example.test", true, null, true, "email_bad"]);
  });
});
