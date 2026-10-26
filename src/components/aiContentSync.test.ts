import { describe, expect, it } from "vitest";
import { websiteCheckMessage } from "./aiContentSync";

describe("AI Content website check", () => {
  it("summarises the result in plain words", () => {
    expect(websiteCheckMessage({ imported: 0, trashed: 0 })).toBe("Website checked. No new or removed articles.");
    expect(websiteCheckMessage(null)).toBe("Website checked. No new or removed articles.");
    expect(websiteCheckMessage({ imported: 1, trashed: 2 })).toBe("Website checked: 1 new article added, 2 removed.");
  });
  it("never writes when the page opens (import runs only from the button)", async () => {
    const fsModule = "fs"; // dynamic so the app type-check needs no Node types
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (path: URL, encoding: string) => string };
    const src = readFileSync(new URL("./AIContent.tsx", import.meta.url), "utf8");
    const effects = src.split("useEffect(").slice(1).map((chunk: string) => chunk.split("}, [")[0]);
    for (const body of effects) expect(body).not.toMatch(/handleImportWP|import-wp|method:\s*"POST"/);
    expect(src).not.toMatch(/setInterval\(handleImportWP/);
    expect(src).toMatch(/onClick=\{handleImportWP\}/);
  });
});
