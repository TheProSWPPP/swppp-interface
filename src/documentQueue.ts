import type { Project, ProjectStatus } from "./data";
import { toDateInputFormat } from "./utils";

// One status grouping for the Documents tiles AND the project list, so a tile count always
// equals what the list shows under the same filter. Before this, the "Completed" tile counted
// only "Complete" while 430 projects sat in "Ready" (documents done) and were counted nowhere.
export type DocumentGroup = "new" | "review" | "progress" | "ready";

export const DOCUMENT_GROUPS: { key: DocumentGroup; label: string }[] = [
  { key: "new", label: "New requests" },
  { key: "review", label: "Pending review" },
  { key: "progress", label: "Being prepared" },
  { key: "ready", label: "Documents ready" },
];

export function documentGroup(status: ProjectStatus | string | undefined): DocumentGroup {
  switch (status) {
    case "Pending Review":
      return "review";
    case "Processing":
    case "Manual Processing":
    case "Approved for Generation":
      return "progress";
    case "Ready":
    case "Complete":
      return "ready";
    default:
      return "new";
  }
}

export function documentGroupLabel(group: DocumentGroup): string {
  return DOCUMENT_GROUPS.find((g) => g.key === group)!.label;
}

// Plain status words for the list badge. Each one names its tile group.
export function documentStatusLabel(status: ProjectStatus | string | undefined): string {
  switch (status) {
    case "Approved for Generation":
      return "Being prepared";
    case "Processing":
      return "Being prepared";
    case "Manual Processing":
      return "Being prepared by hand";
    case "Ready":
    case "Complete":
      return "Documents ready";
    case "Pending Review":
      return "Pending review";
    default:
      return "New request";
  }
}

export function countDocumentGroups(projects: Pick<Project, "status">[]): Record<DocumentGroup, number> {
  const counts: Record<DocumentGroup, number> = { new: 0, review: 0, progress: 0, ready: 0 };
  for (const p of projects) counts[documentGroup(p.status)]++;
  return counts;
}

// Due dates arrive as "2026-10-29 10:29:00", "2026-10-29" or "10/29/26". They are wall-clock
// values with no time zone, so parse the parts directly instead of letting Date guess.
export function parseWallDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
    return isNaN(d.getTime()) || d.getMonth() !== +m[2] - 1 ? null : d;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const d = new Date(year, +m[1] - 1, +m[2]);
    return isNaN(d.getTime()) || d.getMonth() !== +m[1] - 1 ? null : d;
  }
  return null;
}

// "Oct 29, 2026" or "Oct 29, 2026, 10:29 AM". Unreadable input is shown as typed, never hidden.
export function formatDueDate(value: string | undefined | null): string {
  const d = parseWallDate(value);
  if (!d) return value ? String(value) : "No due date";
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (d.getHours() === 0 && d.getMinutes() === 0) return day;
  return `${day}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

// Date only, e.g. "Oct 26, 2026", for received dates.
export function formatDay(value: string | undefined | null): string {
  const d = parseWallDate(value);
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : value ? String(value) : "Unknown";
}

export function dueState(value: string | undefined | null, now = new Date()): "overdue" | "tomorrow" | "upcoming" | "unknown" {
  const d = parseWallDate(value);
  if (!d) return "unknown";
  if (d.getTime() < now.getTime()) return "overdue";
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return d.toDateString() === tomorrow.toDateString() ? "tomorrow" : "upcoming";
}

// True when both dates are readable and the finish is before the start. Stored data is not changed.
export function finishBeforeStart(start: string | undefined, finish: string | undefined): boolean {
  const a = toDateInputFormat(start), b = toDateInputFormat(finish);
  return !!a && !!b && b < a;
}

export const DOCUMENT_PAGE_SIZE = 25;

export function visibleSlice<T>(items: T[], shown: number): { items: T[]; remaining: number } {
  const n = Math.max(0, Math.min(items.length, shown));
  return { items: items.slice(0, n), remaining: items.length - n };
}
