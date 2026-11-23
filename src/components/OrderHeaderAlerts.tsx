import type { Project } from "../data";
import { documentReviewNote } from "../orderFiles";
import { getOrderEnvironmentReview } from "../orderReview";

import { focusOrderSection } from "../orderSectionFocus";

export function OrderHeaderAlerts({project}: {project: Project}) {
  const { checks, siteWarnings } = getOrderEnvironmentReview(project);
  const unresolved = checks.filter(check => !check.resolved);
  const packageReview = documentReviewNote(project.generationNote) || (project.generationState === "current" &&
    Object.values(project.generation?.outputs ?? {}).some(receipt => receipt.outcome === "failed" || receipt.outcome === "review_required"));
  if (!siteWarnings.length && !unresolved.length && !packageReview) return null;
  return <div className="order-alerts">
    {packageReview && <button type="button" className="order-alert-link" onClick={() => focusOrderSection("order-documents")}>Package needs review</button>}
    {siteWarnings.length > 0 && <button type="button" className="order-alert-link" onClick={() => focusOrderSection(siteWarnings[0].target)}>
      {siteWarnings[0].target === "order-field-coordinates" ? "Review site location" : "Review lookup notes"}
    </button>}
    {unresolved.length > 0 && <button type="button" className="order-alert-link" onClick={() => focusOrderSection(unresolved[0].target)}>
      {unresolved.length} environmental {unresolved.length === 1 ? "check" : "checks"} to review
    </button>}
  </div>;
}
