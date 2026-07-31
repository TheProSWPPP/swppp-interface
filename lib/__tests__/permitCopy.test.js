import { describe, it, expect } from "vitest";
import { choosePermitCopy, DEFAULT_EXPIRY_SWITCH_AT } from "../permitCopy.js";

// TXR050000 expires 2026-08-13, and TCEQ opens the renewal applications at 8:00 AM that same
// day, closing them 90 days later on 2026-11-12. So the campaign runs for three months AFTER
// the date it was originally pointed at, and the copy has to flip from "expires soon" to
// "has expired, you have until Nov 12".

const TPL = {
  subject: "Action needed: your {{permit}} stormwater permit expires Aug 13",
  body_html: "<p>is set to expire</p>",
  expired_subject: "Your {{permit}} stormwater permit has expired",
  expired_body_html: "<p>expired on August 13</p>",
  expiry_switch_at: DEFAULT_EXPIRY_SWITCH_AT,
};

describe("choosePermitCopy", () => {
  it("uses the pre-expiry pitch before the window opens", () => {
    const c = choosePermitCopy(TPL, new Date("2026-08-13T12:59:00Z"));
    expect(c.variant).toBe("pre");
    expect(c.subject).toContain("expires Aug 13");
  });

  it("flips the moment TCEQ's forms go live", () => {
    const c = choosePermitCopy(TPL, new Date("2026-08-13T13:00:00Z"));
    expect(c.variant).toBe("expired");
    expect(c.subject).toContain("has expired");
  });

  it("is still on the expired copy late in the 90-day window", () => {
    expect(choosePermitCopy(TPL, new Date("2026-11-11T00:00:00Z")).variant).toBe("expired");
  });

  it("keeps sending the pre-expiry copy when no expired copy is written yet", () => {
    for (const missing of [{ expired_subject: null }, { expired_body_html: null }]) {
      const c = choosePermitCopy({ ...TPL, ...missing }, new Date("2026-09-01T00:00:00Z"));
      expect(c.variant).toBe("pre");
      expect(c.subject).toBe(TPL.subject);
    }
  });

  it("honours a switch date moved on the row, since TCEQ says Aug 14 and our records say Aug 13", () => {
    const moved = { ...TPL, expiry_switch_at: "2026-08-14T13:00:00Z" };
    expect(choosePermitCopy(moved, new Date("2026-08-13T20:00:00Z")).variant).toBe("pre");
    expect(choosePermitCopy(moved, new Date("2026-08-14T13:00:00Z")).variant).toBe("expired");
  });

  it("accepts a Date from pg as well as a string", () => {
    const c = choosePermitCopy({ ...TPL, expiry_switch_at: new Date("2026-08-13T13:00:00Z") }, new Date("2026-08-20T00:00:00Z"));
    expect(c.variant).toBe("expired");
  });

  it("falls back to the switch default when the row has no date", () => {
    const c = choosePermitCopy({ ...TPL, expiry_switch_at: null }, new Date("2026-09-01T00:00:00Z"));
    expect(c.variant).toBe("expired");
  });

  it("stays on the known-good copy if the switch date is unparseable", () => {
    expect(choosePermitCopy({ ...TPL, expiry_switch_at: "not a date" }, new Date("2026-09-01T00:00:00Z")).variant).toBe("pre");
  });

  it("does not throw on a missing template row", () => {
    expect(choosePermitCopy(null).variant).toBe("pre");
    expect(choosePermitCopy(undefined).subject).toBeNull();
  });

  it("today still sends the pre-expiry pitch", () => {
    expect(choosePermitCopy(TPL, new Date("2026-07-31T12:00:00Z")).variant).toBe("pre");
  });
});
