import { describe, it, expect } from "vitest";
import { looksLikeWeakContact } from "../permitDrafts.js";

describe("looksLikeWeakContact", () => {
  it("flags wrong-department titles", () => {
    expect(looksLikeWeakContact("Human Resources Manager")).toBe(true);
    expect(looksLikeWeakContact("Director of Marketing and Membership")).toBe(true);
    expect(looksLikeWeakContact("Regional Sales Manager")).toBe(true);
    expect(looksLikeWeakContact("QA/Mobile Tester")).toBe(true);
    expect(looksLikeWeakContact("HR Coordinator")).toBe(true);
    expect(looksLikeWeakContact("Architectural Sales Manager")).toBe(true);
  });

  it("keeps decision-maker / compliance titles", () => {
    expect(looksLikeWeakContact("Safety Director")).toBe(false);
    expect(looksLikeWeakContact("Environmental Health & Safety Manager")).toBe(false);
    expect(looksLikeWeakContact("Plant Manager")).toBe(false);
    expect(looksLikeWeakContact("President")).toBe(false);
    expect(looksLikeWeakContact("General Manager")).toBe(false);
    expect(looksLikeWeakContact("Chief Executive Officer")).toBe(false);
  });

  it("lets a strong signal override a weak one", () => {
    // 'Sales' is weak, but 'Operations' is a real decision-maker signal.
    expect(looksLikeWeakContact("Sales & Operations Manager")).toBe(false);
    expect(looksLikeWeakContact("VP Sales")).toBe(false);
  });

  it("treats untitled contacts as not-weak (can't tell)", () => {
    expect(looksLikeWeakContact("")).toBe(false);
    expect(looksLikeWeakContact(null)).toBe(false);
    expect(looksLikeWeakContact(undefined)).toBe(false);
  });
});
