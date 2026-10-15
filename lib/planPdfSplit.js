import { PDFDocument } from "pdf-lib";

// Split a PDF into chunks that each fit under maxBytes using pdf-lib
export async function splitPdf(pdfBuffer, maxBytes) {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();

  // Binary search for how many pages fit in one chunk
  async function findChunkSize(startPage) {
    const remaining = totalPages - startPage;
    let lo = 1, hi = Math.min(remaining, 200);
    // Quick check: do all remaining pages fit?
    const allDoc = await PDFDocument.create();
    const allIdx = Array.from({ length: remaining }, (_, i) => startPage + i);
    const allCopied = await allDoc.copyPages(pdfDoc, allIdx);
    for (const p of allCopied) allDoc.addPage(p);
    const allBytes = await allDoc.save();
    if (allBytes.byteLength <= maxBytes) return remaining;

    // Binary search
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const doc = await PDFDocument.create();
      const idx = Array.from({ length: mid }, (_, i) => startPage + i);
      const copied = await doc.copyPages(pdfDoc, idx);
      for (const p of copied) doc.addPage(p);
      const bytes = await doc.save();
      if (bytes.byteLength <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  const chunks = [];
  let page = 0;
  while (page < totalPages) {
    const count = await findChunkSize(page);
    const doc = await PDFDocument.create();
    const idx = Array.from({ length: count }, (_, i) => page + i);
    const copied = await doc.copyPages(pdfDoc, idx);
    for (const p of copied) doc.addPage(p);
    const bytes = Buffer.from(await doc.save());
    // Pages that share one huge resource (e.g. an embedded image) stay full size when split.
    // Sending them would upload the whole file once per page and still fail, so stop here.
    if (bytes.length > maxBytes) {
      const error = new Error(`Plan PDF cannot be split under ${(maxBytes / 1024 / 1024).toFixed(0)} MB: page ${page + 1} alone is ${(bytes.length / 1024 / 1024).toFixed(1)} MB.`);
      error.code = "PLAN_PDF_UNSPLITTABLE";
      throw error;
    }
    chunks.push({ buffer: bytes, startPage: page + 1, endPage: page + count, totalPages });
    console.log(`Chunk: pages ${page + 1}-${page + count} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    page += count;
  }
  return chunks;
}
