import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LeadImportHistory, { StoredRow } from "./LeadImportHistory";
import type { LeadImportJob, LeadImportRow } from "../lib/leadUploadApi";

const job: LeadImportJob = {
  id: "synthetic-done", filename: "synthetic.csv", status: "done",
  total_rows: 3, cleaned_rows: 2, uploaded_rows: 1, error_message: null,
  created_at: "2026-10-08T10:00:00Z", updated_at: "2026-10-08T10:01:00Z",
};

describe("recorded import history", () => {
  it("retains the stored MBT company and never substitutes cleaned values for absent source data", () => {
    const row: LeadImportRow = {
      id: "row-1", row_index: 0, status: "rejected", pipedrive_lead_id: null,
      raw_data: { "Project Title": "Raw project", "Winning Bidder": "Raw contractor" },
      cleaned_data: { "Project Title": "Clean project", Company: "Clean company" },
      error_message: null, updated_at: "2026-10-08T10:00:00Z",
    };
    const html = renderToStaticMarkup(createElement(StoredRow, { row, expanded: true, onToggle: () => {} }));
    expect(html).toContain("Stored source company: Raw contractor");
    expect(html).toContain("Stored source email: Missing");
    expect(html).toContain("Recorded result: rejected");
    expect(html).toContain("Recorded lead ID: Missing");
    expect(html).toContain("Stored cleaned values");
    expect(html).toContain("Clean company");
  });

  it("escapes stored row strings and shows absent cleaned fields as missing", () => {
    const row: LeadImportRow = {
      id: "row-2", row_index: 1, status: "error", pipedrive_lead_id: null,
      raw_data: { "Project Title": "<script>alert(1)</script>", Email: null },
      cleaned_data: null, error_message: "Source parse failed",
      updated_at: "2026-10-08T10:00:00Z",
    };
    const html = renderToStaticMarkup(createElement(StoredRow, { row, expanded: true, onToggle: () => {} }));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Stored source email: Missing");
    expect(html).toContain("Recorded row error: Source parse failed");
    expect(html).toMatch(/Stored cleaned values<\/h4><p[^>]*>Missing<\/p>/);
  });

  it("identifies stored evidence limits before any row request", () => {
    const html = renderToStaticMarkup(createElement(LeadImportHistory, { job }));
    expect(html).toContain("Recorded import results");
    expect(html).toContain("synthetic.csv");
    expect(html).toContain("Stored rows may have been updated");
    expect(html).toContain("CRM contact selected at import and selection reason are unavailable");
    expect(html).toContain("do not verify current Pipedrive data");
    expect(html).not.toMatch(/<a\b|href=|>Approve<|>Delete<|>Restore</);
  });

  it("labels a failed job as partial and keeps row review available", () => {
    const html = renderToStaticMarkup(createElement(LeadImportHistory, { job: { ...job, status: "error", error_message: "Partial import" } }));
    expect(html).toContain("Failed or partial import");
    expect(html).toContain("Partial import");
    expect(html).toContain("Rejected");
    expect(html).toContain("Search stored rows");
  });
});
