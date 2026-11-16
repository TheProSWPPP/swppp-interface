import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Project, ProjectStatus } from "../data";
import ProjectList from "./ProjectList";

const make = (i: number, status: ProjectStatus): Project => ({
  id: `p${i}`, projectName: `Project ${i}`, email: `buyer${i}@example.invalid`, status,
  dateReceived: "2026-10-01", dueDate: "2026-10-29 10:29:00", specialRequirements: "", latitude: "", longitude: "",
  soilData: "", endangeredSpecies: "", waterway: "", landDisturbanceArea: 0,
} as Project);

const render = (projects: Project[]) => renderToStaticMarkup(createElement(ProjectList, {
  projects, onSelectProject: () => {}, onDeleteProject: () => {}, onBulkDeleteProjects: () => {},
}));

describe("ProjectList", () => {
  const projects = [
    ...Array.from({ length: 30 }, (_, i) => make(i, "Ready")),
    ...Array.from({ length: 4 }, (_, i) => make(100 + i, "Approved for Generation")),
    make(200, "Pending Review"),
  ];

  it("tile counts include every listed status", () => {
    const html = render(projects);
    expect(html).toMatch(/Generated<\/p><p[^>]*>30</);
    expect(html).toMatch(/Being prepared<\/p><p[^>]*>4</);
    expect(html).toMatch(/Needs review<\/p><p[^>]*>1</);
    expect(html).toMatch(/New requests<\/p><p[^>]*>0</);
  });

  it("renders one page of projects with a plain show-more control", () => {
    const html = render(projects);
    expect(html.match(/<h4/g)?.length).toBe(25);
    expect(html).toContain("Showing 25 of 35 projects");
    expect(html).toContain("Show 10 more");
    expect(html).toContain("Due Oct 29, 2026, 10:29 AM");
  });

  it("has no show-more control when everything fits", () => {
    expect(render(projects.slice(0, 5))).not.toContain("more</button>");
  });

  it("shows generated orders and distinct failed attempts under matching tile and filter labels", () => {
    const html = render([make(1, "Generated"), make(2, "Generation Incomplete"), make(3, "Generation Failed"), make(4, "Pending Review")]);
    expect(html).toMatch(/Generated<\/p><p[^>]*>1</);
    expect(html).toMatch(/Needs review<\/p><p[^>]*>3</);
    expect(html).toContain('<option value="ready">Generated (1)</option>');
    expect(html).toContain('<option value="review">Needs review (3)</option>');
    expect(html).toContain('>Generation Incomplete</span>');
    expect(html).toContain('>Generation Failed</span>');
    expect(html).toContain('>Pending review</span>');
  });
});
