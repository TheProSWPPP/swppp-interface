import { expect, it } from "vitest";
import { campaignOpenRate, campaignRate, formatNurtureDate, type NurtureCampaign } from "../../lib/nurtureApi";

const campaign = (delivered: number | null, opens: number | null): NurtureCampaign => ({
  id: 1, name: "Campaign", subject: null, status: "sent", scheduledAt: null, sentDate: null, recipientsLists: [],
  stats: { sent: 150, delivered, uniqueViews: opens },
});

it("uses delivered emails and preserves a recorded zero", () => {
  expect(campaignRate(20, 100)).toBe("20%");
  expect(campaignRate(0, 100)).toBe("0%");
  expect(campaignRate(null, 100)).toBe("—");
  expect(campaignRate(10, null)).toBe("—");
  expect(campaignRate(undefined, 100)).toBe("—");
  expect(campaignRate(0, 0)).toBe("—");
});

it("does not display invalid provider measurements as conversion rates", () => {
  for (const value of [NaN, Infinity, -1, 101]) expect(campaignRate(value, 100)).toBe("—");
  expect(campaignRate(10, Infinity)).toBe("—");
});

it("weights campaign tracking by delivered emails rather than averaging percentages or using sends", () => {
  expect(campaignOpenRate([campaign(100, 10), campaign(300, 90)])).toBe("25%");
});

it("leaves aggregate tracking unavailable if any sent campaign lacks complete statistics", () => {
  expect(campaignOpenRate([campaign(100, 10), campaign(null, 20)])).toBe("—");
  expect(campaignOpenRate([campaign(100, 10), campaign(100, null)])).toBe("—");
  expect(campaignOpenRate([campaign(100, 10), { ...campaign(100, 10), stats: null }])).toBe("—");
  expect(campaignOpenRate([campaign(100, 10), campaign(100, 200)])).toBe("—");
});

it("excludes drafts, reports no campaigns as unavailable, and allows true zero tracking", () => {
  expect(campaignOpenRate([campaign(100, 0)])).toBe("0%");
  expect(campaignOpenRate([])).toBe("—");
  expect(campaignOpenRate([campaign(100, 20), { ...campaign(null, null), status: "draft" }])).toBe("20%");
});

it("formats dates in Chicago rather than the viewer timezone, including midnight and DST", () => {
  expect(formatNurtureDate("2026-10-03T01:00:00Z")).toBe("Oct 2, 2026 CT");
  expect(formatNurtureDate("2026-10-03T01:00:00Z", true)).toBe("Oct 2, 2026, 8:00 PM CT");
  expect(formatNurtureDate("2026-01-03T01:00:00Z", true)).toBe("Jan 2, 2026, 7:00 PM CT");
  expect(formatNurtureDate(null)).toBe("—");
  expect(formatNurtureDate("invalid")).toBe("—");
});
