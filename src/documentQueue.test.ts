import { describe, expect, it } from "vitest";
import type { ProjectStatus } from "./data";
import {
  countDocumentGroups,
  documentGroup,
  documentStatusLabel,
  dueState,
  finishBeforeStart,
  formatDay,
  formatDueDate,
  parseWallDate,
  visibleSlice,
} from "./documentQueue";

describe("document status groups", () => {
  it("counts every status into exactly one tile, including Ready", () => {
    const statuses: ProjectStatus[] = ["Ready", "Ready", "Complete", "Pending Review", "Approved for Generation", "Processing", "Manual Processing", "New", ""];
    const counts = countDocumentGroups(statuses.map((status) => ({ status })));
    expect(counts).toEqual({ new: 2, review: 1, progress: 3, ready: 3 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(statuses.length);
  });

  it("gives each list badge the same group its tile counts it in", () => {
    expect(documentGroup("Ready")).toBe("ready");
    expect(documentStatusLabel("Ready")).toBe("Documents ready");
    expect(documentGroup("Approved for Generation")).toBe("progress");
    expect(documentStatusLabel("Approved for Generation")).toBe("Being prepared");
    expect(documentGroup("Pending Review")).toBe("review");
    expect(documentStatusLabel(undefined)).toBe("New request");
  });
});

describe("due dates", () => {
  it("formats stored stamps in plain words without shifting the day", () => {
    expect(formatDueDate("2026-10-29 10:29:00")).toBe("Oct 29, 2026, 10:29 AM");
    expect(formatDueDate("2026-10-29")).toBe("Oct 29, 2026");
    expect(formatDueDate("2026-10-29 00:00:00")).toBe("Oct 29, 2026");
    expect(formatDueDate("10/29/26")).toBe("Oct 29, 2026");
    expect(formatDay("2026-10-26 14:08:00")).toBe("Oct 26, 2026");
    expect(formatDay("10/26/26")).toBe("Oct 26, 2026");
  });

  it("shows unreadable values as typed and says when there is none", () => {
    expect(formatDueDate("next Friday")).toBe("next Friday");
    expect(formatDueDate("2026-02-31")).toBe("2026-02-31");
    expect(formatDueDate("")).toBe("No due date");
    expect(parseWallDate(undefined)).toBeNull();
  });

  it("marks overdue and tomorrow from the wall-clock value", () => {
    const now = new Date(2026, 9, 26, 12, 0);
    expect(dueState("2026-10-26 09:00:00", now)).toBe("overdue");
    expect(dueState("2026-10-27 09:00:00", now)).toBe("tomorrow");
    expect(dueState("2026-10-29", now)).toBe("upcoming");
    expect(dueState("soon", now)).toBe("unknown");
  });
});

describe("finish before start", () => {
  it("flags only readable dates in the wrong order", () => {
    expect(finishBeforeStart("10/26/26", "02/16/26")).toBe(true);
    expect(finishBeforeStart("08/21/26", "08/20/26")).toBe(true);
    expect(finishBeforeStart("02/16/26", "10/26/26")).toBe(false);
    expect(finishBeforeStart("10/26/26", "10/26/26")).toBe(false);
    expect(finishBeforeStart("", "02/16/26")).toBe(false);
    expect(finishBeforeStart("N/A", "02/16/26")).toBe(false);
  });
});

describe("list paging", () => {
  it("shows one page and reports what is left", () => {
    const items = Array.from({ length: 60 }, (_, i) => i);
    expect(visibleSlice(items, 25)).toEqual({ items: items.slice(0, 25), remaining: 35 });
    expect(visibleSlice(items, 75).remaining).toBe(0);
    expect(visibleSlice([], 25)).toEqual({ items: [], remaining: 0 });
  });
});
