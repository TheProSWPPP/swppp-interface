import { describe, expect, it } from "vitest";
import { readableSubject } from "./nurtureApi";

describe("readableSubject", () => {
  it("replaces Brevo template tags with plain placeholders", () => {
    expect(readableSubject("{{ contact.PERMIT }} expires 8/13 - 50% off renewal")).toBe("[permit] expires 8/13 - 50% off renewal");
    expect(readableSubject('Hope your project is going well, {{ contact.FIRSTNAME | default: "there" }}')).toBe("Hope your project is going well, [first name]");
    expect(readableSubject("{{contact.PERMIT_NUMBER}}")).toBe("[permit number]");
  });
  it("leaves plain subjects alone", () => {
    expect(readableSubject("Spring SWPPP checklist")).toBe("Spring SWPPP checklist");
    expect(readableSubject(null)).toBe("");
  });
});
