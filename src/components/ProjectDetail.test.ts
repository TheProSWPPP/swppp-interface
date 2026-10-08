import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Project, ProjectStatus } from "../data";
import {
  getAvailableDocumentLink,
  getDocumentsForTemplate,
  getTemplateDocLink,
  STATE_TEMPLATES,
} from "../templates";
import ProjectDetail from "./ProjectDetail";

const knownTemplate = STATE_TEMPLATES[0];

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "synthetic-project",
    projectName: "Synthetic project",
    email: "buyer@example.invalid",
    status: "Ready",
    dateReceived: "2026-10-08",
    dueDate: "2026-10-15",
    specialRequirements: "",
    latitude: "",
    longitude: "",
    soilData: "",
    endangeredSpecies: "",
    waterway: "",
    landDisturbanceArea: 0,
    swpppProjectDescription: "Synthetic project description",
    stateTemplateId: knownTemplate.id,
    stateTemplateName: knownTemplate.name,
    trelloLink: "",
    jobOrderLink: "",
    folderLink: "",
    invoiceLink: "",
    ...overrides,
  };
}

function render(overrides: Partial<Project> = {}) {
  return renderToStaticMarkup(
    createElement(ProjectDetail, {
      project: project(overrides),
      onBack: () => {},
      onUpdate: () => {},
      onDelete: () => {},
    }),
  );
}

function sections(html: string) {
  const documents = html.split("Documents to be Generated")[1]?.split("Financials")[0] ?? "";
  const quickLinks = html.split("Quick Links")[1]?.split("Status &amp; Actions")[0] ?? "";
  const rows = documents
    .split('<div class="flex flex-col border rounded-xl')
    .slice(1)
    .map((row) => '<div class="flex flex-col border rounded-xl' + row);
  return { documents, quickLinks, rows };
}

function rowFor(html: string, label: string) {
  const row = sections(html).rows.find((candidate) => candidate.includes(`>${label}`));
  expect(row, `document row ${label}`).toBeDefined();
  return row!;
}

function jobOrderQuickLink(html: string) {
  const { quickLinks } = sections(html);
  const label = quickLinks.indexOf(">Job Order PDF</span>");
  expect(label).toBeGreaterThan(-1);
  const item = quickLinks.slice(0, label).match(/<(?:a|div)\b[^>]*class="flex items-center gap-2\.5[^>]*>/g)?.at(-1);
  expect(item).toBeDefined();
  return item!;
}

function buttonFor(html: string, label: string) {
  const text = html.indexOf(label);
  expect(text).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", text);
  return html.slice(start, html.indexOf("</button>", text) + 9);
}

describe("document link availability", () => {
  it.each([
    ["", undefined], ["   ", undefined], ["#", undefined], ["  #  ", undefined],
    ["#fragment", undefined], ["/relative.pdf", undefined], ["//example.invalid/file", undefined],
    ["javascript:alert(1)", undefined], ["data:text/plain,hello", undefined],
    ["https://", undefined], ["http:// user", undefined],
    ["https://user@example.invalid/file", undefined],
    ["https://user:pass@example.invalid/file", undefined],
    [" http://example.invalid/a ", "http://example.invalid/a"],
    ["  https://example.invalid/job.pdf?token=a%2Bb&x=1#page=2  ", "https://example.invalid/job.pdf?token=a%2Bb&x=1#page=2"],
    [null, undefined], [42, undefined], [{ href: "https://example.invalid" }, undefined],
  ])("guards a supplied document URL %j", (input, expected) => {
    expect(getAvailableDocumentLink(input)).toBe(expected);
  });

  it("omits placeholder template links by ID/name and preserves a future valid value", () => {
    expect(getTemplateDocLink(knownTemplate.id, "SWPPP")).toBeUndefined();
    expect(getTemplateDocLink(knownTemplate.name, "SWPPP")).toBeUndefined();
    expect(getTemplateDocLink(knownTemplate.id, "Job Order PDF")).toBeUndefined();
    expect(getTemplateDocLink("unknown", "SWPPP")).toBeUndefined();
    const original = knownTemplate.templateLinks!.SWPPP;
    try {
      knownTemplate.templateLinks!.SWPPP = " https://example.invalid/template?signature=a%2Bb#part ";
      expect(getTemplateDocLink(knownTemplate.id, "SWPPP")).toBe("https://example.invalid/template?signature=a%2Bb#part");
      expect(getTemplateDocLink(knownTemplate.name, "SWPPP")).toBe("https://example.invalid/template?signature=a%2Bb#part");
      const row = rowFor(render(), "SWPPP");
      expect(row).toMatch(/<a\b[^>]*href="https:\/\/example\.invalid\/template\?signature=a%2Bb#part"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
      expect(row).toContain("View Template Doc");
    } finally {
      knownTemplate.templateLinks!.SWPPP = original;
    }
  });

  it("shows known Ready documents without false file or template anchors", () => {
    const html = render();
    const { documents, rows } = sections(html);
    expect(rows).toHaveLength(knownTemplate.documents.length + 1);
    for (const row of rows) {
      expect(row).toContain("File link unavailable");
      expect(row).not.toMatch(/<a\b|href=|target=|role="link"|tabindex=|onclick=|cursor-pointer/);
      expect(row).not.toContain("lucide-external-link");
      expect(row).not.toContain("Awaiting Approval");
    }
    expect(documents).not.toContain("View Template Doc");
    expect(jobOrderQuickLink(html)).toMatch(/^<div\b/);
    expect(jobOrderQuickLink(html)).not.toMatch(/href=|target=|role=|tabindex=/);
  });

  it.each(["Ready", "Complete", "Approved for Generation"] as ProjectStatus[])(
    "links only a supplied Job Order in %s and suppresses its pending label",
    (status) => {
      const destination = "https://example.invalid/job.pdf?token=a%2Bb#page=2";
      const html = render({ status, jobOrderLink: `  ${destination}  ` });
      const { rows } = sections(html);
      expect(rows).toHaveLength(knownTemplate.documents.length + 1);
      const job = rowFor(html, "Job Order PDF");
      expect(job).toMatch(/<a\b[^>]*href="https:\/\/example\.invalid\/job\.pdf\?token=a%2Bb#page=2"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
      expect(job).not.toMatch(/File link unavailable|Generating\.\.\.|Awaiting Approval/);
      expect(job).toContain("lucide-external-link");
      expect(jobOrderQuickLink(html)).toMatch(/<a\b[^>]*href="https:\/\/example\.invalid\/job\.pdf\?token=a%2Bb#page=2"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
      for (const row of rows.filter((candidate) => !candidate.includes(">Job Order PDF"))) {
        expect(row).not.toMatch(/<a\b|href=|target=/);
        if (status === "Approved for Generation") {
          expect(row).toContain(row.includes("(Automated)") ? "Generating..." : "Manual - Pending Automation");
        } else {
          expect(row).toContain("File link unavailable");
        }
      }
    },
  );

  it.each(["Ready", "Complete"] as ProjectStatus[])(
    "shows unavailable output files in %s when no Job Order URL exists", (status) => {
      const { rows } = sections(render({ status }));
      expect(rows).toHaveLength(knownTemplate.documents.length + 1);
      for (const row of rows) {
        expect(row).toContain("File link unavailable");
        expect(row).not.toMatch(/<a\b|Generating\.\.\.|Awaiting Approval/);
      }
    },
  );

  it.each(["Processing", "Pending Review", "New", "Manual Processing", ""] as ProjectStatus[])(
    "keeps %s rows unlinked and their existing preapproval/manual labels", (status) => {
      const { rows, documents } = sections(render({ status }));
      expect(rows).toHaveLength(knownTemplate.documents.length + 1);
      expect(documents).not.toMatch(/<a\b|href=|View Template Doc/);
      expect(rowFor(render({ status }), "Job Order PDF")).toContain("Awaiting Approval");
      expect(rowFor(render({ status }), "SWPPP")).toContain("Manual - Pending Automation");
    },
  );

  it.each([" ", "#", " #fragment ", "/job.pdf", "javascript:alert(1)"])(
    "does not link invalid Job Order value %j in either section", (jobOrderLink) => {
      const html = render({ jobOrderLink });
      const { documents } = sections(html);
      expect(documents).not.toMatch(/<a\b|href=/);
      expect(jobOrderQuickLink(html)).toMatch(/^<div\b/);
      expect(jobOrderQuickLink(html)).not.toMatch(/href=|target=/);
    },
  );

  it.each([
    { stateTemplateId: "unknown", stateTemplateName: "unknown" },
    { stateTemplateId: undefined, stateTemplateName: "unknown" },
    { stateTemplateId: undefined, stateTemplateName: undefined },
    { stateTemplateId: "stale", stateTemplateName: knownTemplate.name },
  ])("retains default documents and no template link for unmatched selection %j", (selection) => {
    expect(getDocumentsForTemplate(selection.stateTemplateId || selection.stateTemplateName)).toHaveLength(3);
    const { rows, documents } = sections(render(selection));
    expect(rows).toHaveLength(4);
    expect(documents).toContain("SWPPP");
    expect(documents).toContain("Job Cover Letter");
    expect(documents).toContain("Construction Site Notice");
    expect(documents).not.toMatch(/<a\b|View Template Doc/);
  });

  it("preserves approval, retrigger and upload control labels and disabled conditions", () => {
    expect(render({ status: "New" })).toContain(">Accept</button>");
    const noPlans = render({ status: "Pending Review", plansUploaded: false, isIndustrial: false });
    expect(buttonFor(noPlans, "Approve &amp; Generate")).toMatch(/^<button\b[^>]*disabled=""/);
    const withPlans = render({ status: "Pending Review", plansUploaded: true });
    expect(buttonFor(withPlans, "Approve &amp; Generate")).not.toContain('disabled=""');
    const industrial = render({ status: "Pending Review", isIndustrial: true });
    expect(buttonFor(industrial, "Confirm Manual Processing")).not.toContain('disabled=""');
    expect(render({ status: "Approved for Generation" })).toContain("Re-trigger Generation");
    expect(render({ status: "Pending Review" })).toContain("Upload PDF (max 1 GB)");
  });
});
