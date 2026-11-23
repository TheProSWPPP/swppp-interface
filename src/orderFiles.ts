import type { GenerationOutput, Project } from "./data";
import { getAvailableDocumentLink, getDocumentsForTemplate } from "./templates";

const names: Record<string, string> = {
  swppp: "SWPPP", cover_letter: "Job Cover Letter", site_notice: "Construction Site Notice",
  noi: "NOI", not: "NOT", job_order: "Job Order PDF",
};

export function documentReviewNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const note = value.replace(/\r\n?/g, "\n").trim();
  return note || undefined;
}

function fileKey(name: string) {
  if (/^NOI\b/.test(name)) return "noi";
  if (/^NOT\b/.test(name)) return "not";
  return Object.keys(names).find(key => names[key] === name) ?? name;
}

export function receiptLink(receipt: GenerationOutput | undefined, fallback?: string) {
  return getAvailableDocumentLink(receipt ? (receipt.outcome === "produced" ? receipt.url : undefined) : fallback);
}

export function orderFiles(project: Project) {
  const targets = [...getDocumentsForTemplate(project.stateTemplateId || project.stateTemplateName), "Job Order PDF"];
  const keys: Record<string, string> = Object.fromEntries(targets.map(name => [name, fileKey(name)]));
  const outputs = project.generation?.outputs ?? {};
  const current = project.generationState === "current";
  for (const key of Object.keys(outputs)) {
    if (current && !Object.values(keys).includes(key)) {
      const name = names[key] || key;
      targets.push(name);
      keys[name] = key;
    }
  }
  const link = (name: string) => receiptLink(current ? outputs[keys[name]] : undefined, name === "Job Order PDF" ? project.jobOrderLink : undefined);
  return {
    targets, keys, count: targets.filter(name => link(name)).length, jobLink: link("Job Order PDF"),
    earlier: current ? [] : Object.entries(outputs).map(([key, receipt]) => ({
      name: targets.find(name => keys[name] === key) || names[key] || key,
      receipt, link: receiptLink(receipt),
    })),
  };
}
