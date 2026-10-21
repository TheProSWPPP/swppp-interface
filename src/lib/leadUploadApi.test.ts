import { afterEach, expect, it, vi } from "vitest";
import { uploadLeadsCsv } from "./leadUploadApi";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(res: Partial<Response> & { text?: () => Promise<string> }) {
  const fetchMock = vi.fn().mockResolvedValue(res);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const file = new File(["a,b\n1,2\n"], "sheet.csv", { type: "text/csv" });

it("sends the chosen kind as a form field", async () => {
  const f = stubFetch({ ok: true, json: async () => ({ job_id: "j1", status: "uploaded" }) });
  await uploadLeadsCsv(file, "bid_sheet");
  const body = f.mock.calls[0][1].body as FormData;
  expect(body.get("kind")).toBe("bid_sheet");
  expect(body.get("file")).toBeInstanceOf(File);
});

it("sends no kind field when none is given", async () => {
  const f = stubFetch({ ok: true, json: async () => ({ job_id: "j1", status: "uploaded" }) });
  await uploadLeadsCsv(file);
  expect((f.mock.calls[0][1].body as FormData).has("kind")).toBe(false);
});

it("shows the server's sentence, not the JSON, when the upload is refused", async () => {
  stubFetch({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: "This looks like the estimator's bid tracker. Use Upload bid sheet." }),
  });
  await expect(uploadLeadsCsv(file, "project_list")).rejects.toThrow(
    "This looks like the estimator's bid tracker. Use Upload bid sheet.",
  );
});
