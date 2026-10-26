import { describe, expect, it } from "vitest";
import { notUploadedNote } from "./leadUploadApi";

describe("notUploadedNote", () => {
  it("explains the gap on a finished import", () => {
    expect(notUploadedNote({ status: "done", total_rows: 1454, uploaded_rows: 1425 })).toBe(
      "29 rows were left out and not sent to Pipedrive. Open “View recorded rows” and choose Rejected to see which.",
    );
    expect(notUploadedNote({ status: "done", total_rows: 2, uploaded_rows: 1 })).toMatch(/^1 row was left out/);
  });
  it("stays quiet when everything went up or the job is still running", () => {
    expect(notUploadedNote({ status: "done", total_rows: 1279, uploaded_rows: 1279 })).toBeNull();
    expect(notUploadedNote({ status: "uploading", total_rows: 1454, uploaded_rows: 10 })).toBeNull();
    expect(notUploadedNote({ status: "done", total_rows: null, uploaded_rows: 0 })).toBeNull();
  });
});
