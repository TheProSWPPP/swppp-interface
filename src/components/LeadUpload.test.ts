import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import LeadUpload, { ProgressRow } from "./LeadUpload";
import type { LeadImportJob } from "../lib/leadUploadApi";

const job: LeadImportJob = {
  id: "synthetic", filename: "synthetic.csv", status: "done", total_rows: 2,
  cleaned_rows: 2, uploaded_rows: 1, error_message: null,
  created_at: "2026-10-08T10:00:00Z", updated_at: "2026-10-08T10:00:00Z",
};

it("keeps the existing upload entry point before a job is selected", () => {
  const html = renderToStaticMarkup(createElement(LeadUpload));
  expect(html).toContain("Lead Import");
  expect(html).toContain("Drop CSV here or click to browse");
  expect(html).not.toContain("Recorded import results");
});

it("offers recorded rows for a terminal card without a delete control", () => {
  const html = renderToStaticMarkup(createElement(ProgressRow, { job, onHistory: () => {} }));
  expect(html).toContain("View recorded rows");
  expect(html).not.toContain("Delete this job");
});

it("keeps a ready card focused on the existing approval path", () => {
  const html = renderToStaticMarkup(createElement(ProgressRow, { job: { ...job, status: "ready" }, onOpen: () => {}, onDelete: () => {} }));
  expect(html).toContain("Ready for Pipedrive upload");
  expect(html).toContain("Delete this job");
  expect(html).not.toContain("View recorded rows");
});
