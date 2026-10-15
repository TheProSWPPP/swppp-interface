import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { execFile } from "child_process";

// Plan scan in two passes, working from a PDF on disk of any size:
// 1. Map every sheet from its text layer plus a small picture, and pick the sheets worth reading closely.
// 2. Read those sheets closely: full text layer plus the sheet cut into sharp, overlapping tiles.
// Ghostscript does all PDF work page by page, so a 150 MB plan set never has to fit in memory or under an upload limit.

export const PLAN_SCAN_MODEL = "gemini-4-argon";
// Gemini 4 Argon list price per 1M tokens (output includes thinking). Rises to $4 / $20 on 2026-12-01.
const PRICE_IN = 2.0;
const PRICE_OUT = 10.0;

const MAX_CLOSE_PAGES = 8;
const MAP_TEXT_CHARS = 2500;
const CLOSE_TEXT_CHARS = 20000;
const OTHER_TEXT_CHARS = 600;
const OTHER_TEXT_TOTAL = 60000;

function runGs(args, { timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", ...args], { maxBuffer: 1 << 30, encoding: "buffer", timeout }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || "").trim().slice(0, 300) || error.message;
        const err = new Error(`Ghostscript failed: ${detail}${error.killed ? " (killed)" : ""}`);
        err.code = "PLAN_GS_FAILED";
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

function withTempDir(baseDir, prefix, fn) {
  const dir = fs.mkdtempSync(path.join(baseDir || os.tmpdir(), prefix));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

export function tidyPageText(text) {
  return String(text || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function dirBytes(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    try { total += fs.statSync(path.join(dir, name)).size; } catch (_) {}
  }
  return total;
}

function readHead(file, maxBytes) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(maxBytes, fs.fstatSync(fd).size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Text layer per page. Some sheets draw hatching with millions of font glyphs, which makes Ghostscript slow and
// makes it write gigabytes of "text"; stop at maxTotalBytes or maxMs and treat the remaining pages as image-only.
export async function pageTexts(file, tmpDir, { maxTotalBytes = 80 * 1024 * 1024, maxPageBytes = 2 * 1024 * 1024, maxMs = 60000 } = {}) {
  return withTempDir(tmpDir, "plan-txt-", async (dir) => {
    let capped = false;
    const startedAt = Date.now();
    await new Promise((resolve, reject) => {
      const child = execFile("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=txtwrite", `-sOutputFile=${dir}/p-%05d.txt`, file], { timeout: 420000 }, (error, _stdout, stderr) => {
        clearInterval(watch);
        if (error && !capped) {
          const err = new Error(`Ghostscript failed: ${String(stderr || "").trim().slice(0, 300) || error.message}`);
          err.code = "PLAN_GS_FAILED";
          return reject(err);
        }
        resolve();
      });
      const watch = setInterval(() => {
        if (dirBytes(dir) > maxTotalBytes || Date.now() - startedAt > maxMs) {
          capped = true;
          clearInterval(watch);
          child.kill("SIGKILL");
        }
      }, 250);
    });
    const names = fs.readdirSync(dir).sort();
    // The page being written when Ghostscript was stopped is incomplete; drop it.
    if (capped) names.pop();
    const texts = names.map((name) => {
      const size = fs.statSync(path.join(dir, name)).size;
      return size > maxPageBytes ? "" : tidyPageText(readHead(path.join(dir, name), maxPageBytes));
    });
    texts.capped = capped;
    return texts;
  });
}

export async function pageThumbnails(file, tmpDir, { width = 1024, height = 704, quality = 60 } = {}) {
  return withTempDir(tmpDir, "plan-th-", async (dir) => {
    await runGs(["-sDEVICE=jpeg", `-dJPEGQ=${quality}`, "-dPDFFitPage", `-g${width}x${height}`, `-sOutputFile=${dir}/p-%05d.jpg`, file], { timeout: 420000 });
    return fs.readdirSync(dir).sort().map((name) => fs.readFileSync(path.join(dir, name)));
  });
}

// Copy chosen pages (ascending) into a small PDF so the close reads never reparse a huge file.
export async function extractPages(file, pages, outFile) {
  await runGs(["-sDEVICE=pdfwrite", `-sPageList=${pages.join(",")}`, `-sOutputFile=${outFile}`, file], { timeout: 300000 });
  return outFile;
}

export function parsePgm(buffer) {
  const header = buffer.toString("latin1", 0, Math.min(buffer.length, 512)).match(/^P5\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+255\s/);
  if (!header) throw new Error("Unexpected page image format from Ghostscript");
  return { width: Number(header[1]), height: Number(header[2]), data: buffer.subarray(header[0].length) };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodeGrayPng(gray, width, height) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) gray.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth; color type 0 (grayscale), default compression/filter/interlace
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Cut a grayscale page into overlapping tiles of roughly tileSize px.
export function cutTiles({ width, height, data }, { tileSize = 1600, overlap = 0.08 } = {}) {
  const cols = Math.max(1, Math.ceil(width / tileSize));
  const rows = Math.max(1, Math.ceil(height / tileSize));
  const tw = Math.ceil(width / cols);
  const th = Math.ceil(height / rows);
  const ox = cols > 1 ? Math.round(tw * overlap) : 0;
  const oy = rows > 1 ? Math.round(th * overlap) : 0;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.max(0, c * tw - ox), y0 = Math.max(0, r * th - oy);
      const x1 = Math.min(width, (c + 1) * tw + ox), y1 = Math.min(height, (r + 1) * th + oy);
      const w = x1 - x0, h = y1 - y0;
      const gray = Buffer.alloc(w * h);
      for (let y = 0; y < h; y++) data.copy(gray, y * w, (y0 + y) * width + x0, (y0 + y) * width + x1);
      tiles.push({ row: r, col: c, rows, cols, png: encodeGrayPng(gray, w, h) });
    }
  }
  return tiles;
}

// Render one page so its long side is about maxSide px (never above maxDpi) and cut it into tiles.
export async function pageTiles(file, page, { maxSide = 4800, maxDpi = 200 } = {}) {
  const pageArgs = [`-dFirstPage=${page}`, `-dLastPage=${page}`, "-sOutputFile=-", file];
  const probe = parsePgm(await runGs(["-sDEVICE=pgmraw", "-r18", ...pageArgs]));
  const inchesLong = Math.max(probe.width, probe.height) / 18;
  const dpi = Math.max(72, Math.min(maxDpi, Math.floor(maxSide / inchesLong)));
  const image = parsePgm(await runGs(["-sDEVICE=pgmraw", `-r${dpi}`, "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4", ...pageArgs]));
  return { dpi, tiles: cutTiles(image) };
}

const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9.]+/g, "");

// A quote counts as found in a page's text layer when it is there verbatim, or when every number in it and
// most of its words are on that page (CAD text often splits a label and its value onto different lines).
export function quoteInText(quote, pageText) {
  const q = normalize(quote), p = normalize(pageText);
  if (!q) return false;
  if (p.includes(q)) return true;
  const numbers = String(quote).match(/\d+(?:[.,]\d+)*/g) || [];
  if (!numbers.length || !numbers.every((n) => p.includes(normalize(n)))) return false;
  const words = String(quote).toLowerCase().match(/[a-z]{3,}/g) || [];
  const lower = String(pageText).toLowerCase();
  return words.length === 0 || words.filter((w) => lower.includes(w)).length / words.length >= 0.7;
}

// Mark each evidence entry: "text" = quote found in the PDF's own text on that page, "not_in_text" = page has
// text but the quote is not in it (staff should look), "image_only" = scanned page, read from the picture.
export function verifyEvidence(evidence, texts) {
  for (const entry of Object.values(evidence || {})) {
    if (!entry || typeof entry !== "object") continue;
    const page = Number(entry.page);
    const text = page >= 1 && page <= texts.length ? texts[page - 1] : "";
    entry.verified = !entry.quote ? "none" : text.length > 50 ? (quoteInText(entry.quote, text) ? "text" : "not_in_text") : "image_only";
  }
  return evidence;
}

export function choosePages(readClosely, pageCount, max = MAX_CLOSE_PAGES) {
  const picked = [...new Set((Array.isArray(readClosely) ? readClosely : []).map(Number).filter((p) => Number.isInteger(p) && p >= 1 && p <= pageCount))].slice(0, max);
  if (!picked.length) for (let p = 1; p <= Math.min(pageCount, max); p++) picked.push(p);
  return picked.sort((a, b) => a - b);
}

const MAP_PROMPT = `You are indexing a set of construction/civil plan sheets so a stormwater (SWPPP) preparer can find the right sheets. Each page above has its extracted text layer (empty for scanned pages) and a small image.
Return JSON: {"sheets":[{"page":<pdf page number>,"sheet":"<sheet number as printed in the title block, or null>","title":"<sheet title as printed>","kind":"cover|index|general_notes|survey|demolition|site_plan|erosion_control|swppp|grading|drainage|utility|paving|landscape|details|geotech|architectural|structural|mep|specifications|other"}],
"readClosely":[<up to ${MAX_CLOSE_PAGES} page numbers, most useful first>]}
For readClosely pick the pages most likely to state: the disturbed area / limits of disturbance / site or project acreage (often on the cover, site plan, erosion control or SWPPP sheets, or drainage area tables); the site address, owner/developer and coordinates (cover sheet, title block); erosion control / SWPPP notes; soil or geotechnical information; nearby creeks or receiving waters; construction phasing. Always include the cover sheet and the erosion control or SWPPP plan when they exist.`;

export const EVIDENCE_PROMPT = `
EVIDENCE (required, this is how staff verify your work):
Add a top-level "evidence" object. For each of these fields that you filled: estimatedDisturbedArea, totalProjectArea, siteAddress, latitude, longitude, ownerName, ownerAddress, ownerPhone, ownerEmail, contactPerson, soilComposition, nearestWaterbody, waterbodyImpairment, projectStartDate, projectFinishDate
give {"page": <pdf page number>, "sheet": "<sheet number>", "quote": "<the exact words/numbers as printed on the plans, copied character for character, max 200 chars>", "confidence": "high|medium|low"}.
- high = the value is printed on the plans exactly as you report it (after unit conversion only).
- medium = you derived it from printed numbers (for example summed areas or converted square feet), show the arithmetic in the field's details.
- low = you estimated it from the drawing scale or inferred it. Never mark an estimate as high.
If you cannot quote anything for a field, set the field to null instead of guessing, except estimatedDisturbedArea which may be estimated with confidence low.

DISTURBED AREA RULES:
- Search every page given for: disturbed area, area of disturbance, limits of disturbance (LOD) area, total disturbed acreage, land disturbance, site area, project area, lot area, drainage area tables, SWPPP or erosion control data blocks, NOI notes.
- Prefer a printed disturbed-area value over anything else. If only the total site/lot area is printed, report that as totalProjectArea and decide whether the whole site is disturbed from the plans; say why in details.
- For linear projects (pipelines, roads, trails) with no printed area, compute length x disturbance width from printed stationing/lengths and the trench/corridor width, show the arithmetic, confidence medium if both numbers are printed. The width is the strip actually worked: use a limits-of-construction width when the plans print one; otherwise use 25 feet for a buried pipe or conduit line, and the paved or path width plus 10 feet on each side for roads, trails and sidewalks. A permanent easement or right-of-way width is a property line, not disturbance, so never use it as the width and never add easement acreages.
- In a quantities table, the disturbed area is the footprint of all ground-disturbing work: clearing and grubbing, excavation and embankment, subgrade preparation or treatment, base and pavement removal or replacement, trenching. Seeding, sodding or hydro-mulch quantities cover only the strips restored with vegetation and are usually smaller than the disturbed area, so never use them alone when larger ground-disturbing quantities are listed. Convert square yards to acres (multiply by 9, divide by 43,560).
- When you estimate from building, slab or pavement footprints, the footprint alone undercounts: add the graded working room around buildings and pavement (about 10 feet beyond their edges), utility and septic trenches, and staging or stockpile areas, and show each piece in details.
- Convert square feet to acres (divide by 43,560) and keep 2 decimals.

COORDINATES RULE: report latitude/longitude only when the plans print them as latitude/longitude (decimal degrees or degrees-minutes-seconds). Do not convert state plane, northing/easting or survey control coordinates; leave latitude and longitude null in that case.

Also add "exhibitSheets": {"siteMap": ["<sheet numbers for cover/vicinity map and site plan>"], "erosionControl": ["<sheet numbers for erosion control plan and details>"]}.`;

const imagePart = (mimeType, buffer, level) => ({ inline_data: { mime_type: mimeType, data: buffer.toString("base64") }, mediaResolution: { level } });

async function callModel(parts, { apiKey, model, fetchImpl = fetch, timeoutMs = 420000 }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: 32768, temperature: 0.1, responseMimeType: "application/json" } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`Gemini API error ${res.status}`);
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const text = (json.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (!text) throw new Error("Gemini returned an empty response for the plan scan.");
    try {
      const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim());
      return { data: Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed, usage: json.usageMetadata || {} };
    } catch (e) {
      throw new Error(`Gemini returned invalid JSON: ${e.message}`);
    }
  }
  throw lastError;
}

export async function scanPlanSet(file, { apiKey, basePrompt, model = PLAN_SCAN_MODEL, tmpDir = os.tmpdir(), fetchImpl, log = () => {} }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const started = Date.now();
  const [texts, thumbs] = await Promise.all([pageTexts(file, tmpDir), pageThumbnails(file, tmpDir)]);
  while (texts.length < thumbs.length) texts.push("");
  const pageCount = texts.length;
  if (!pageCount) throw new Error("No pages could be read from this PDF.");
  log(`Plan scan: ${pageCount} pages, text on ${texts.filter((t) => t.length > 50).length}${texts.capped ? " (text extraction stopped early on heavy sheets)" : ""}, ${((Date.now() - started) / 1000).toFixed(0)}s to read`);

  const mapParts = [];
  const mapChars = pageCount > 150 ? 1200 : MAP_TEXT_CHARS;
  for (let i = 0; i < pageCount; i++) {
    mapParts.push({ text: `=== PDF page ${i + 1} of ${pageCount} ===\nTEXT LAYER:\n${texts[i].slice(0, mapChars) || "(no text layer)"}` });
    if (thumbs[i]) mapParts.push(imagePart("image/jpeg", thumbs[i], "MEDIA_RESOLUTION_LOW"));
  }
  mapParts.push({ text: MAP_PROMPT });
  const map = await callModel(mapParts, { apiKey, model, fetchImpl });
  const sheets = Array.isArray(map.data.sheets) ? map.data.sheets : [];
  const close = choosePages(map.data.readClosely, pageCount);
  const sheetFor = (p) => sheets.find((s) => Number(s.page) === p) || {};
  log(`Plan scan: reading pages ${close.join(", ")} closely`);

  const smallFile = path.join(tmpDir, `plan-close-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  const readParts = [];
  try {
    await extractPages(file, close, smallFile);
    for (let k = 0; k < close.length; k++) {
      const page = close[k];
      const sheet = sheetFor(page);
      readParts.push({ text: `=== PDF page ${page} (sheet ${sheet.sheet || "?"}: ${sheet.title || ""}) ===\nTEXT LAYER:\n${texts[page - 1].slice(0, CLOSE_TEXT_CHARS) || "(no text layer, read the images)"}` });
      const { tiles } = await pageTiles(smallFile, k + 1);
      readParts.push({ text: `Page ${page} zoomed in as ${tiles.length} overlapping tiles (${tiles[0].rows} rows x ${tiles[0].cols} columns, left to right, top to bottom):` });
      for (const tile of tiles) readParts.push(imagePart("image/png", tile.png, "MEDIA_RESOLUTION_ULTRA_HIGH"));
    }
  } finally {
    try { fs.unlinkSync(smallFile); } catch (_) {}
  }
  const index = sheets.map((s) => `page ${s.page}: ${s.sheet || "-"} ${s.title || ""} [${s.kind || "?"}]`).join("\n");
  const otherText = texts.map((t, i) => (close.includes(i + 1) || !t ? "" : `[p${i + 1}] ${t.slice(0, OTHER_TEXT_CHARS)}`)).filter(Boolean).join("\n").slice(0, OTHER_TEXT_TOTAL);
  readParts.push({ text: `SHEET INDEX OF THE WHOLE SET (${pageCount} pages):\n${index}\n\nOther pages' text layers, condensed, in case a value is only stated there:\n${otherText}` });
  readParts.push({ text: String(basePrompt).replace("Return ONLY valid JSON, no markdown formatting.", "") + EVIDENCE_PROMPT + "\n\nReturn ONLY valid JSON, no markdown formatting." });
  const read = await callModel(readParts, { apiKey, model, fetchImpl });

  const data = read.data && typeof read.data === "object" ? read.data : {};
  verifyEvidence(data.evidence, texts);
  data.sheetIndex = sheets.map((s) => ({ page: Number(s.page), sheet: s.sheet || null, title: s.title || "", kind: s.kind || "other" }));
  data.pagesReadClosely = close;

  const inputTokens = (map.usage.promptTokenCount || 0) + (read.usage.promptTokenCount || 0);
  const outputTokens = (map.usage.candidatesTokenCount || 0) + (read.usage.candidatesTokenCount || 0);
  const thoughtsTokens = (map.usage.thoughtsTokenCount || 0) + (read.usage.thoughtsTokenCount || 0);
  data._usage = {
    model,
    inputTokens,
    outputTokens,
    thoughtsTokens,
    totalTokens: inputTokens + outputTokens + thoughtsTokens,
    estimatedCostUSD: (inputTokens * PRICE_IN + (outputTokens + thoughtsTokens) * PRICE_OUT) / 1_000_000,
    pdfPages: pageCount,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  return data;
}
