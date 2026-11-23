import {describe, expect, it} from "vitest";
import type {GenerationOutput, Project} from "./data";
import {orderFiles} from "./orderFiles";

const oldFile = "https://example.invalid/prior.pdf";
const url = "https://example.invalid/current.pdf";
const record = (documentKey:string, outcome:GenerationOutput["outcome"], link?:string) => ({documentKey, outcome, url:link});
function order(state:Project["generationState"], outputs: Record<string,GenerationOutput>) {
  return {stateTemplateName:"Oklahoma", jobOrderLink:oldFile, generationState:state, generation:{outputs}} as Project;
}

describe("opt-in order file records", () => {
  it("matches template-specific receipts and counts only usable links", () => {
    const files=orderFiles(order("current", {noi:record("noi","produced",url),not:record("not","produced","#"),job_order:record("job_order","failed")}));
    expect(files.keys["NOI PDF Form"]).toBe("noi");
    expect(files.count).toBe(1);
    expect(files.jobLink).toBeUndefined();
  });
  it("uses a current job receipt before the order link, including receipts outside the template", () => {
    const files=orderFiles(order("current",{job_order:record("job_order","produced",url),site_notice:record("site_notice","review_required")}));
    expect(files.count).toBe(1);
    expect(files.jobLink).toBe(url);
    expect(files.targets).toContain("Construction Site Notice");
  });
  it("keeps earlier results separate from independently recorded links", () => {
    const files=orderFiles(order("stale",{job_order:record("job_order","produced",url)}));
    expect(files.jobLink).toBe(oldFile);
    expect(files.count).toBe(1);
    expect(files.earlier[0].link).toBe(url);
  });
});
