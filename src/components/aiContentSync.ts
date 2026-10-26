// Plain summary of a "Check website for changes" run (POST /api/ai-content/import-wp).
export function websiteCheckMessage(result: { imported?: number; trashed?: number } | null): string {
  const imported = Number(result?.imported) || 0;
  const removed = Number(result?.trashed) || 0;
  if (!imported && !removed) return "Website checked. No new or removed articles.";
  const parts = [];
  if (imported) parts.push(`${imported} new article${imported === 1 ? "" : "s"} added`);
  if (removed) parts.push(`${removed} removed`);
  return `Website checked: ${parts.join(", ")}.`;
}
