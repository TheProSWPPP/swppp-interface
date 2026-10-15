import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { splitPdf } from "../planPdfSplit.js";

const noise = (length, seed) => {
  let x = seed, out = "";
  for (let i = 0; i < length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out += String.fromCharCode(33 + (x % 90)); }
  return out;
};

async function pagesWithOwnContent(pageCount) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792]);
    for (let line = 0; line < 40; line++) page.drawText(noise(90, i * 1000 + line), { x: 20, y: 760 - line * 18, size: 8, font });
  }
  return Buffer.from(await doc.save());
}

// Every page draws one large shared drawing, like plan sets that reuse one embedded image.
async function pagesSharingOneLargeResource(pageCount) {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const sheet = source.addPage([612, 792]);
  for (let line = 0; line < 1500; line++) sheet.drawText(noise(120, line), { x: 5, y: 780 - (line % 95) * 8, size: 6, font });
  const doc = await PDFDocument.create();
  const [shared] = await doc.embedPdf(await source.save(), [0]);
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]).drawPage(shared);
  return Buffer.from(await doc.save());
}

describe("splitPdf", () => {
  it("splits ordinary pages into chunks under the limit that cover every page once", async () => {
    const pdf = await pagesWithOwnContent(12);
    const limit = Math.ceil(pdf.length / 3);
    const chunks = await splitPdf(pdf, limit);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.buffer.length <= limit)).toBe(true);
    expect(chunks.map(c => [c.startPage, c.endPage])).toEqual(
      chunks.map((c, i) => [i === 0 ? 1 : chunks[i - 1].endPage + 1, c.endPage]));
    expect(chunks.at(-1).endPage).toBe(12);
  });

  it("returns the whole file as one chunk when it already fits", async () => {
    const pdf = await pagesWithOwnContent(3);
    const chunks = await splitPdf(pdf, pdf.length * 2);
    expect(chunks).toHaveLength(1);
    expect([chunks[0].startPage, chunks[0].endPage]).toEqual([1, 3]);
  });

  it("stops when a single page is still over the limit instead of uploading the file once per page", async () => {
    const pdf = await pagesSharingOneLargeResource(6);
    const onePage = (await splitPdf(pdf, Number.MAX_SAFE_INTEGER))[0].buffer.length;
    await expect(splitPdf(pdf, Math.floor(onePage / 4))).rejects.toMatchObject({ code: "PLAN_PDF_UNSPLITTABLE" });
  });
});
