// Plain summary of a "Check website for changes" run (POST /api/ai-content/import-wp).
export function websiteCheckMessage(result: { imported?: number; trashed?: number; updated?: number; missing?: number } | null): string {
  const imported = Number(result?.imported) || 0;
  const removed = Number(result?.trashed) || 0;
  const updated = Number(result?.updated) || 0;
  const missing = Number(result?.missing) || 0;
  if (!imported && !removed && !updated && !missing) return "Website checked. No new or removed articles.";
  const parts = [];
  if (imported) parts.push(`${imported} new article${imported === 1 ? "" : "s"} added`);
  if (updated) parts.push(`${updated} article${updated === 1 ? "" : "s"} updated`);
  if (missing) parts.push(`${missing} not listed publicly; saved records kept`);
  if (removed) parts.push(`${removed} removed`);
  return `Website checked: ${parts.join(", ")}.`;
}
