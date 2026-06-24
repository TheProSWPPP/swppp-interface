import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { PDFDocument } from "pdf-lib";
import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import * as apolloClient from "./lib/apolloClient.js";
import * as pipedriveClient from "./lib/pipedriveClient.js";
import { ownerScope, withLeadLock } from "./lib/sdrAccess.js";
import { buildDraftFromLead } from "./lib/sdrDraftGenerator.js";
import { renderAllSteps, defaultSubject, SDR_TEMPLATES } from "./lib/sdrTemplates.js";
import { registerNurtureRoutes } from "./lib/nurtureRoutes.js";
import { registerPermitRoutes } from "./lib/permitRoutes.js";
import { registerPermitExportRoutes } from "./lib/permitExportRoutes.js";
import { runPermitIngest } from "./scripts/permit-ingest.mjs";
import { runEchoBulkRefresh } from "./scripts/echo-bulk-refresh.mjs";
import { syncLeadState } from "./lib/pipedriveSync.js";
import { sweepSentOutreach, upsertOutreach } from "./lib/outreachSync.js";
import * as gmailInbox from "./lib/gmailInbox.js";
import { dailyCap, rampDay } from "./lib/sendRamp.js";
import { pollEngagement } from "./lib/apolloEngagementPoll.js";
import { runAutoOutreach, pruneStaleQueuedDrafts } from "./lib/autoOutreach.js";
import { injectTracking, TRANSPARENT_GIF, trackEventId } from "./lib/sdrTracking.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
// Disk storage for large PDFs (up to 1GB). Temp files cleaned up after processing.
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 1024 * 1024 * 1024 } });


const N8N_WEBHOOK_URL =
  "https://proswppp.app.n8n.cloud/webhook/state-document-generator";

const N8N_CONTENT_WEBHOOK_URL =
  process.env.N8N_CONTENT_WEBHOOK_URL ||
  "https://proswppp.app.n8n.cloud/webhook/ai-content-generate";

const N8N_LEAD_IMPORT_WEBHOOK_URL =
  "https://proswppp.app.n8n.cloud/webhook/lead-import-unified";

const N8N_CALLBACK_SECRET = "swppp-lead-import-2026-r9k4hz3qwm8nbv";

const RAILWAY_PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${process.env.PORT || 3000}`;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-3.1-pro-preview";
const GEMINI_PROMPT = `You are an expert civil engineering plan reader specializing in stormwater pollution prevention plans (SWPPP). Analyze these construction/civil drawings thoroughly and extract the following information.

CRITICAL INSTRUCTIONS FOR AREA CALCULATION:
- Look for explicitly stated "Estimated Disturbed Area", "Total Disturbed Area", "Site Area", or similar labels
- If NO explicit area is stated, estimate it from the drawings using scale bar, boundary dimensions, or lot dimensions
- Always convert to acres (1 acre = 43,560 sq ft)
- Report both the value and how you determined it

CRITICAL INSTRUCTIONS FOR SEQUENCE OF ACTIVITIES:
- This goes directly into a SWPPP document. Use plain text heading+description format — NO markdown, NO asterisks, NO numbering, NO bullet symbols.
- FORMAT: Each phase is a short heading on its own line, followed immediately by 1-2 descriptive sentences on the next line. One blank line between phases.
- Example:
  Mobilization and Site Preparation
  Mobilization of equipment and personnel, installation of stabilized construction entrance, perimeter silt fence, and inlet protection BMPs.

  Clearing and Grubbing
  Removal of existing vegetation and site improvements within the limits of disturbance.

  Rough Grading and Earthwork
  Mass grading operations and subgrade preparation to establish design elevations and drainage patterns.

- FIRST identify the project type from the plans (e.g., waterline/utility, building, road, residential subdivision, wastewater, etc.) — then write ONLY the phases that apply to that type:

  WATERLINE / LINEAR UTILITY projects: Mobilization → ROW Preparation → Trench Excavation Safety Setup → Pipe/Utility Installation (name the pipe sizes and materials shown) → Tie-ins and Connections → Backfill and Compaction → Pavement/Surface Restoration → Final Stabilization → Temporary Controls Removal

  BUILDING / COMMERCIAL projects: Mobilization → Demolition/Clearing → Rough Grading → Underground Utilities → Subgrade/Paving → Structural/Vertical Construction → Finish Grading → Landscaping/Stabilization → Temporary Controls Removal

  ROAD / PAVEMENT projects: Mobilization → Demolition/Clearing → Subgrade Preparation → Drainage/Storm Sewer → Base Course → Paving → Curb/Sidewalk → Striping/Signage → Stabilization → Temporary Controls Removal

  RESIDENTIAL SUBDIVISION: Mobilization → Clearing/Grubbing → Mass Grading → Detention/Drainage Infrastructure → Utilities → Street/Paving → Lot Grading → Landscaping/Stabilization → Temporary Controls Removal

- Be specific: name actual pipe materials, sizes, or key features shown on the plans
- Omit phases not applicable; minimum 6 phases

INSTRUCTIONS FOR SOIL AND WATERWAY DATA:
- soilComposition: Look for soil boring logs, geotechnical notes, soil survey references, or any mention of soil types. If none found, return null.
- nearestWaterbody: Look for any streams, rivers, lakes, creeks, drainage channels, or water features labeled on the plans or in drainage notes.
- siteCoordinates: Look for any GPS coordinates, latitude/longitude, or geographic coordinates on the plans (often on cover sheet or location map). Convert DMS (degrees/minutes/seconds) to decimal degrees if needed.

EXTRACT ALL OF THE FOLLOWING (set to null if truly not findable):

{
  "estimatedDisturbedArea": { "value": "plain decimal number only, no text (e.g., 0.72 or 4.5)", "method": "explicit_label | calculated_from_dimensions | estimated_from_scale", "details": "how you determined this" },
  "totalProjectArea": { "value": "plain decimal number only", "method": "explicit_label | calculated_from_dimensions | estimated_from_scale", "details": "how you determined this" },
  "projectDescription": "Follow this exact format: 'This project consists of [construction type] located at [address] in [City], [County] County, [State]. Plans call for, but are not limited to, [key work items listed from the plans].' Two sentences maximum.",
  "sequenceOfActivities": "Full sequence of construction activities using the heading+description format described above. Plain text only, no markdown.",
  "soilComposition": "soil types found in geotechnical notes or soil survey (e.g., 'Clay loam, sandy clay')",
  "nearestWaterbody": "name of nearest stream, river, lake, or water feature shown on or near the plans",
  "waterbodyImpairment": "any 303(d) impairment notes, TMDL references, or water quality concerns found on the plans or in SW3P narrative. Return null if none mentioned.",
  "endangeredSpecies": "comma-separated list of threatened/endangered species common names if explicitly mentioned on the plans (e.g., 'Whooping crane, golden-cheeked warbler'). Civil drawings rarely contain this — return null if not found. Do NOT infer from location.",
  "historicalPlacesNotes": "any notes about historical places, cultural resources, or archaeological sites found on the plans",
  "projectStartDate": "MM/DD/YY if found on plans",
  "projectFinishDate": "MM/DD/YY if found on plans",
  "ownerName": "property or project owner name from title block or cover sheet",
  "ownerAddress": "mailing address of the project owner or developer — NOT the engineering firm address",
  "ownerPhone": "phone number of the project owner or developer in (XXX) XXX-XXXX format — NOT the engineering firm phone, NOT city inspection hotlines, NOT utility locate numbers from general notes. Return null if only non-owner phones are present.",
  "ownerEmail": "email of the project owner or developer — NOT the engineering firm. Return null if not clearly the owner's.",
  "contactPerson": "name of the project owner or their representative — NOT the engineer of record, NOT the PE who stamped the drawings, NOT the engineering firm name. Return null if only the design engineer is named.",
  "siteAddress": "project site street address from plans",
  "latitude": "decimal degrees latitude (e.g., 29.7604) — convert from DMS if needed",
  "longitude": "decimal degrees longitude (e.g., -95.3698) — convert from DMS if needed, use negative for West",
  "summary": "3-5 sentence overview of these civil plans including project type, key features, notable environmental or site conditions, and any stormwater-relevant details"
}

Return ONLY valid JSON, no markdown formatting.`;

async function callGemini(contentParts, timeoutMs = 180000) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: contentParts }],
        generationConfig: { maxOutputTokens: 8192, temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Gemini returned empty response — PDF may be unreadable or too large.");
  const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  let analysisData;
  try {
    analysisData = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("Gemini JSON parse failed. Raw text:", cleaned.slice(0, 500));
    throw new Error(`Gemini returned invalid JSON: ${parseErr.message}. This usually means the PDF was too complex or Gemini hit its output limit.`);
  }
  // Validate required fields exist
  if (!analysisData.summary && !analysisData.projectDescription) {
    console.warn("Gemini response missing key fields:", Object.keys(analysisData));
  }

  // Attach token usage + estimated cost (Gemini 3.1 Pro Preview pricing: $1.25 in / $10.00 out per 1M)
  const u = json.usageMetadata || {};
  const inputTokens = u.promptTokenCount || 0;
  const outputTokens = u.candidatesTokenCount || 0;
  const thoughtsTokens = u.thoughtsTokenCount || 0;
  analysisData._usage = {
    inputTokens,
    outputTokens,
    thoughtsTokens,
    totalTokens: u.totalTokenCount || 0,
    estimatedCostUSD: (inputTokens * 1.25 + outputTokens * 10.00) / 1_000_000,
  };
  console.log(`Gemini tokens — in: ${inputTokens}, out: ${outputTokens}, thinking: ${thoughtsTokens} (~$${analysisData._usage.estimatedCostUSD.toFixed(4)})`);
  return analysisData;
}

// Compress PDF using Ghostscript (lossy image compression, works on files of any size)
function compressWithGhostscript(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile("gs", [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.7",
      "-dPDFSETTINGS=/ebook",
      "-dColorImageResolution=200",
      "-dGrayImageResolution=200",
      "-dMonoImageResolution=300",
      "-dColorImageDownsampleType=/Bicubic",
      "-dGrayImageDownsampleType=/Bicubic",
      "-dNOPAUSE", "-dQUIET", "-dBATCH",
      `-sOutputFile=${outputPath}`,
      inputPath,
    ], { timeout: 300000 }, (error) => {
      if (error) reject(error);
      else resolve(outputPath);
    });
  });
}

// Split a PDF into chunks that each fit under maxBytes using pdf-lib
async function splitPdf(pdfBuffer, maxBytes) {
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
    chunks.push({ buffer: bytes, startPage: page + 1, endPage: page + count, totalPages });
    console.log(`Chunk: pages ${page + 1}-${page + count} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    page += count;
  }
  return chunks;
}

// Compress PDF using pdf.co presigned URL upload (supports up to 100MB)
const PDF_CO_API_KEY = process.env.PDF_CO_API_KEY;
async function compressWithPdfCo(pdfBuffer) {
  if (!PDF_CO_API_KEY) return null;
  try {
    // Step 1: Get presigned upload URL
    const presignedRes = await fetch(
      `https://api.pdf.co/v1/file/upload/get-presigned-url?name=plans.pdf&contenttype=application/pdf`,
      { headers: { "x-api-key": PDF_CO_API_KEY } }
    );
    const presignedJson = await presignedRes.json();
    if (presignedJson.error) { console.warn("pdf.co presigned URL error:", presignedJson.message); return null; }

    // Step 2: Upload via PUT to presigned URL
    const putRes = await fetch(presignedJson.presignedUrl, {
      method: "PUT",
      headers: { "x-api-key": PDF_CO_API_KEY, "Content-Type": "application/pdf" },
      body: pdfBuffer,
      signal: AbortSignal.timeout(300000),
    });
    if (!putRes.ok) { console.warn(`pdf.co upload failed: ${putRes.status}`); return null; }

    // Step 3: Compress (async mode for large files)
    const compressRes = await fetch("https://api.pdf.co/v1/pdf/optimize", {
      method: "POST",
      headers: { "x-api-key": PDF_CO_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: presignedJson.url,
        name: "compressed.pdf",
        async: true,
        profiles: JSON.stringify({
          ImageOptimizationFormat: "JPEG", JPEGQuality: 85,
          ResampleImages: true, ResamplingResolution: 200, GrayscaleImages: false,
        }),
      }),
    });
    const compressJson = await compressRes.json();
    if (compressJson.error) { console.warn("pdf.co compress error:", compressJson.message); return null; }

    // Step 4: Poll for completion
    const jobId = compressJson.jobId;
    const downloadUrl = compressJson.url;
    if (jobId) {
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const check = await fetch(`https://api.pdf.co/v1/job/check?jobid=${jobId}`, { headers: { "x-api-key": PDF_CO_API_KEY } });
        const checkJson = await check.json();
        if (checkJson.status === "success") break;
        if (checkJson.status === "error" || checkJson.status === "failed") { console.warn("pdf.co job failed"); return null; }
        console.log(`pdf.co job: ${checkJson.status}...`);
      }
    }

    // Step 5: Download compressed result
    const dlRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(120000) });
    if (!dlRes.ok) { console.warn("Failed to download from pdf.co"); return null; }
    const compressed = Buffer.from(await dlRes.arrayBuffer());
    console.log(`pdf.co: ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB → ${(compressed.length / 1024 / 1024).toFixed(1)} MB`);
    return compressed;
  } catch (err) {
    console.warn("pdf.co compression error:", err.message);
    return null;
  }
}

// Analyze a large PDF via Gemini File API (uses Google SDK for reliable upload)
async function callGeminiWithFile(filePath) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  // Step 1: Upload file via SDK
  const fileManager = new GoogleAIFileManager(GEMINI_API_KEY);
  console.log("Uploading to Gemini File API via SDK...");
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType: "application/pdf",
    displayName: `civil-plans-${Date.now()}.pdf`,
  });

  let file = uploadResult.file;
  console.log(`Gemini File API: uploaded ${file.name} (state: ${file.state})`);

  // Step 2: Wait for file processing
  while (file.state === "PROCESSING") {
    await new Promise(r => setTimeout(r, 3000));
    file = await fileManager.getFile(file.name);
    console.log(`Gemini file state: ${file.state}`);
  }
  if (file.state === "FAILED") {
    throw new Error("Gemini file processing failed. The PDF may be corrupt or unsupported.");
  }

  // Step 3: Generate content using the uploaded file
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { maxOutputTokens: 8192, temperature: 0.1 },
  });

  console.log("Calling Gemini with file reference...");
  const result = await model.generateContent([
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: GEMINI_PROMPT },
  ]);

  const text = result.response.text();
  if (!text) throw new Error("Gemini returned empty response — PDF may be unreadable.");

  const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  let analysisData;
  try {
    analysisData = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("Gemini JSON parse failed. Raw text:", cleaned.slice(0, 500));
    throw new Error(`Gemini returned invalid JSON: ${parseErr.message}`);
  }

  // Extract usage metadata
  const u = result.response.usageMetadata || {};
  const inputTokens = u.promptTokenCount || 0;
  const outputTokens = u.candidatesTokenCount || 0;
  const thoughtsTokens = u.thoughtsTokenCount || 0;
  analysisData._usage = {
    inputTokens,
    outputTokens,
    thoughtsTokens,
    totalTokens: u.totalTokenCount || 0,
    estimatedCostUSD: (inputTokens * 1.25 + outputTokens * 10.00) / 1_000_000,
  };
  console.log(`Gemini tokens — in: ${inputTokens}, out: ${outputTokens}, thinking: ${thoughtsTokens} (~$${analysisData._usage.estimatedCostUSD.toFixed(4)})`);
  return analysisData;
}

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// Basic Authentication Security Wall
const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "swppp2026";

// SDR JWT auth (Phase 3 — custom SDR interface)
const JWT_SECRET = process.env.SDR_JWT_SECRET || "swppp-sdr-dev-jwt-secret-change-me";
const JWT_TTL_SECONDS = 60 * 60 * 12; // 12h
if (!process.env.SDR_JWT_SECRET) {
  console.warn("Security: SDR_JWT_SECRET not set — using dev default. Set in Railway env before exposing /sdr publicly.");
}
if (!process.env.APOLLO_API_KEY) {
  console.warn("APOLLO_API_KEY not set — SDR Apollo integration disabled until configured.");
}
if (!process.env.PIPEDRIVE_API_TOKEN) {
  console.warn("PIPEDRIVE_API_TOKEN not set — SDR Pipedrive integration disabled until configured.");
}

function verifySdrJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

console.log(
  `Security: Using ADMIN_USERNAME=${
    process.env.ADMIN_USERNAME ? "DEFINED" : "NOT DEFINED (default: admin)"
  }`
);
console.log(
  `Security: Using ADMIN_PASSWORD=${
    process.env.ADMIN_PASSWORD ? "DEFINED" : "NOT DEFINED (default)"
  }`
);

app.use((req, res, next) => {
  // Skip auth for health check and external webhook endpoints
  if (
    req.path === "/health" ||
    (req.path === "/api/projects" && req.method === "POST") ||
    (req.path === "/api/ai-content/callback" && req.method === "POST") ||
    (req.path === "/api/leads/upload/callback" && req.method === "POST") ||
    (req.path === "/api/leads/upload/rows/persist" && req.method === "POST") ||
    (req.path === "/api/abbreviation-cache" && (req.method === "GET" || req.method === "POST")) ||
    (req.path === "/api/seo-ideas/batch" && req.method === "POST") ||
    (req.path === "/api/seo-ideas/known-keywords" && req.method === "GET" && req.query.callback_secret === N8N_CALLBACK_SECRET) ||
    (req.path === "/api/seo-ideas/seeds" && req.method === "GET" && req.query.callback_secret === N8N_CALLBACK_SECRET) ||
    (req.path === "/api/seo-ideas/existing-articles" && req.method === "GET" && req.query.callback_secret === N8N_CALLBACK_SECRET) ||
    (req.path === "/api/sdr/events/ingest" && req.method === "POST" && req.query.callback_secret === N8N_CALLBACK_SECRET) ||
    (req.path === "/api/sdr/drafts/generate" && req.method === "POST" && req.query.callback_secret === N8N_CALLBACK_SECRET) ||
    (req.path.startsWith("/api/sdr/track/") && req.method === "GET") ||
    // Google redirects the OAuth consent back here without our bearer token; the
    // signed `state` param carries identity + CSRF protection (verified in the handler).
    (req.path === "/api/sdr/inbox/oauth/callback" && req.method === "GET")
  ) {
    return next();
  }
  // n8n callbacks fetching rows need auth bypass via callback_secret query param
  if (
    /^\/api\/leads\/upload\/[^/]+\/rows(\/[^/]+)?$/.test(req.path) &&
    (req.method === "GET" || req.method === "PATCH") &&
    req.query.callback_secret === N8N_CALLBACK_SECRET
  ) {
    return next();
  }

  // SDR login + user picker are unauthenticated (login issues JWT; users fuels the picker)
  if (req.path === "/api/sdr/auth/login" && req.method === "POST") {
    return next();
  }
  if (req.path === "/api/sdr/auth/users" && req.method === "GET") {
    return next();
  }

  // SDR routes accept JWT bearer
  if (req.path.startsWith("/api/sdr/")) {
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      const claims = verifySdrJwt(authHeader.slice(7).trim());
      if (claims) {
        req.sdrUser = claims;
        return next();
      }
    }
    return res.status(401).json({ error: "Unauthorized" });
  }

  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Basic ")) {
    const b64auth = authHeader.split(" ")[1] || "";
    const decoded = Buffer.from(b64auth, "base64").toString();
    const splitIndex = decoded.indexOf(":");

    if (splitIndex !== -1) {
      const login = decoded.substring(0, splitIndex);
      const password = decoded.substring(splitIndex + 1);

      if (login === ADMIN_USER && password === ADMIN_PASS) {
        return next();
      }
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="SWPPP Dashboard"');
  res.status(401).send("Authentication required.");
});

// Database connection
// Railway automatically provides DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Shared per-mailbox daily send count (America/Chicago day). This is the single
// cap both the SDR and TXR050000/permit cold systems draw from — every email send
// records into sdr_sends, so this counts them together.
async function mailboxSentToday(mailboxId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM sdr_sends
      WHERE mailbox_id = $1
        AND (sent_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date`,
    [mailboxId],
  );
  return rows[0].n;
}

// Initial Database Schema Setup
async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL not found. Running in ephemeral memory mode.");
    return;
  }
  try {
    console.log("Database connected. Initializing tables...");
    const res = await pool.query("SELECT NOW()");
    console.log("Postgres connected successfully at:", res.rows[0].now);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT,
        data JSONB NOT NULL,
        archived BOOLEAN DEFAULT FALSE,
        deleted_at TIMESTAMP
      )
    `);
    console.log("Table 'projects' verified/created.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_content (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('spoke', 'pillar', 'comparison')),
        status TEXT NOT NULL DEFAULT 'queued',
        keyword TEXT NOT NULL,
        state TEXT,
        title TEXT,
        word_count INTEGER,
        pillar_id TEXT REFERENCES ai_content(id) ON DELETE SET NULL,
        wordpress_post_id INTEGER,
        wordpress_url TEXT,
        n8n_execution_id TEXT,
        error_message TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        generated_at TIMESTAMP,
        published_at TIMESTAMP
      )
    `);
    // Versioning columns (idempotent migrations)
    await pool.query(`ALTER TABLE ai_content ADD COLUMN IF NOT EXISTS version INT DEFAULT 1`);
    await pool.query(`ALTER TABLE ai_content ADD COLUMN IF NOT EXISTS base_pillar_id TEXT`);
    await pool.query(`ALTER TABLE ai_content ADD COLUMN IF NOT EXISTS legacy_wordpress_url TEXT`);
    await pool.query(`ALTER TABLE ai_content ADD COLUMN IF NOT EXISTS is_current BOOLEAN DEFAULT TRUE`);
    // Backfill base_pillar_id = id for existing pillars (each is its own base)
    await pool.query(`UPDATE ai_content SET base_pillar_id = id WHERE type = 'pillar' AND base_pillar_id IS NULL`);
    // Index for fast version lookups within a pillar lineage
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_content_base_pillar ON ai_content(base_pillar_id, version DESC) WHERE type = 'pillar'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_content_pillar_state_current ON ai_content(state, is_current) WHERE type = 'pillar'`);
    console.log("Table 'ai_content' verified/created (with versioning columns).");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lead_import_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        filename TEXT NOT NULL,
        uploaded_by TEXT,
        total_rows INT,
        cleaned_rows INT DEFAULT 0,
        uploaded_rows INT DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'uploaded'
          CHECK (status IN ('uploaded','cleaning','ready','uploading','done','error')),
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_import_jobs_status ON lead_import_jobs(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_import_jobs_created_at ON lead_import_jobs(created_at DESC)`);
    console.log("Table 'lead_import_jobs' verified/created.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lead_import_rows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id UUID NOT NULL REFERENCES lead_import_jobs(id) ON DELETE CASCADE,
        row_index INT NOT NULL,
        raw_data JSONB NOT NULL,
        cleaned_data JSONB,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','cleaned','approved','rejected','uploaded','error')),
        pipedrive_lead_id TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_import_rows_job_index ON lead_import_rows(job_id, row_index)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_import_rows_status ON lead_import_rows(status)`);
    console.log("Table 'lead_import_rows' verified/created.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS abbreviation_cache (
        raw TEXT PRIMARY KEY,
        clean TEXT NOT NULL,
        fallback BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("Table 'abbreviation_cache' verified/created.");

    // Phase 5 — AI SEO Content Ideas (weekly DataForSEO + Claude clustering)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS seo_ideas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        suggested_title TEXT NOT NULL,
        target_keyword TEXT NOT NULL,
        keyword_normalized TEXT NOT NULL,
        suggested_type TEXT NOT NULL DEFAULT 'spoke'
          CHECK (suggested_type IN ('pillar','spoke','comparison')),
        parent_pillar_keyword TEXT,
        state TEXT,
        monthly_volume INT,
        competition_index INT,
        cpc_usd NUMERIC(8,2),
        difficulty_score INT,
        intent TEXT,
        why_write TEXT,
        cluster_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected','converted')),
        converted_to_content_id TEXT,
        batch_id UUID NOT NULL,
        raw_metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_seo_ideas_status ON seo_ideas(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_seo_ideas_batch ON seo_ideas(batch_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_seo_ideas_keyword_norm ON seo_ideas(keyword_normalized)`);
    // Prevent re-suggesting an already-pending or already-approved keyword
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_seo_ideas_open_keyword ON seo_ideas(keyword_normalized) WHERE status IN ('pending','approved')`);
    console.log("Table 'seo_ideas' verified/created.");

    // Phase 3 — Custom SDR Interface (mirror of migrations/2026-05-14-sdr-schema.sql)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'sdr' CHECK (role IN ('sdr','admin')),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_mailboxes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        display_name TEXT,
        apollo_mailbox_id TEXT UNIQUE,
        owner_user_id UUID REFERENCES sdr_users(id) ON DELETE SET NULL,
        pipedrive_sender_id INT,
        daily_send_limit INT NOT NULL DEFAULT 20,
        warmup_started_at TIMESTAMPTZ,
        warmup_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (warmup_status IN ('pending','warming','ready','paused','disabled')),
        warmup_current_cap INT NOT NULL DEFAULT 0,
        deliverability_score NUMERIC(5,2),
        last_health_check_at TIMESTAMPTZ,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_mailboxes_warmup_status ON sdr_mailboxes(warmup_status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_mailboxes_owner ON sdr_mailboxes(owner_user_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_drafts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pipedrive_lead_id TEXT NOT NULL,
        pipedrive_contact_id TEXT,
        pipedrive_org_id TEXT,
        contact_id_snapshot TEXT NOT NULL,
        contact_email_snapshot TEXT NOT NULL,
        org_id_snapshot TEXT,
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('AGC','LBA','CM','PB')),
        apollo_sequence_id TEXT,
        apollo_template_id TEXT,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        assigned_mailbox_id UUID REFERENCES sdr_mailboxes(id) ON DELETE SET NULL,
        assigned_user_id UUID REFERENCES sdr_users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','edited','rejected','sent','failed','cancelled')),
        reject_reason TEXT,
        scheduled_for TIMESTAMPTZ,
        approved_at TIMESTAMPTZ,
        approved_by UUID REFERENCES sdr_users(id) ON DELETE SET NULL,
        sent_at TIMESTAMPTZ,
        error_message TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_drafts_status ON sdr_drafts(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_drafts_lead ON sdr_drafts(pipedrive_lead_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_drafts_mailbox ON sdr_drafts(assigned_mailbox_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_drafts_scheduled ON sdr_drafts(scheduled_for) WHERE status IN ('pending','approved')`);
    // Race guard: at most ONE in-flight (un-sent) draft per lead+trigger. Without this,
    // two concurrent generate calls (double-click, or n8n + human) both pass the
    // read-then-insert dedup and create two drafts → both approved → DOUBLE Apollo
    // enrollment of a real prospect. Drop pre-existing open dups (keep newest) first so
    // the index can build; wrapped so a failure can't block startup.
    try {
      await pool.query(`
        DELETE FROM sdr_drafts a USING sdr_drafts b
        WHERE a.status IN ('pending','approved','edited')
          AND b.status IN ('pending','approved','edited')
          AND a.pipedrive_lead_id = b.pipedrive_lead_id
          AND a.trigger_type = b.trigger_type
          AND a.created_at < b.created_at`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sdr_drafts_open ON sdr_drafts(pipedrive_lead_id, trigger_type) WHERE status IN ('pending','approved','edited')`);
    } catch (e) {
      console.warn("uq_sdr_drafts_open index could not be created:", e.message);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_sends (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        draft_id UUID NOT NULL REFERENCES sdr_drafts(id) ON DELETE CASCADE,
        pipedrive_lead_id TEXT NOT NULL,
        apollo_sequence_id TEXT NOT NULL,
        apollo_contact_id TEXT,
        apollo_emailer_message_id TEXT,
        mailbox_id UUID REFERENCES sdr_mailboxes(id) ON DELETE SET NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'enrolled'
          CHECK (status IN ('enrolled','sent','bounced','replied','unsubscribed','failed')),
        last_status_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Apollo sequence step tracking (added 2026-06-17). Idempotent.
    await pool.query(`ALTER TABLE sdr_sends ADD COLUMN IF NOT EXISTS current_step INT`);
    await pool.query(`ALTER TABLE sdr_sends ADD COLUMN IF NOT EXISTS total_steps INT`);
    await pool.query(`ALTER TABLE sdr_sends ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE sdr_sends ADD COLUMN IF NOT EXISTS step_status TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_sends_lead ON sdr_sends(pipedrive_lead_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_sends_sequence ON sdr_sends(apollo_sequence_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_sends_status ON sdr_sends(status)`);

    // Per-lead outreach ledger (lib/outreachSync.js). One row per (lead, source):
    // 'pipedrive' swept from the sent folder, 'interface' written by approve-and-send.
    // Replaces the misleading person-level last_outgoing_mail_time in the Leads view.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_outreach_log (
        pipedrive_lead_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('pipedrive','interface')),
        sent_at TIMESTAMPTZ NOT NULL,
        sender_name TEXT,
        sender_email TEXT,
        subject TEXT,
        external_ref TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (pipedrive_lead_id, source)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_log_lead ON sdr_outreach_log(pipedrive_lead_id)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_outreach_sweep_state (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        last_swept_at TIMESTAMPTZ,
        last_thread_ts TIMESTAMPTZ
      )
    `);
    await pool.query(`INSERT INTO sdr_outreach_sweep_state (id) VALUES (1) ON CONFLICT DO NOTHING`);

    // Unified inbox: per-mailbox Gmail OAuth (lib/gmailInbox.js). One row per connected
    // .co mailbox holding its refresh token. owner_user_id binds the mailbox to its SDR
    // (matched by email local-part) so a rep sees only their inbox; admin sees all.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_inbox_accounts (
        mailbox_email TEXT PRIMARY KEY,
        refresh_token TEXT,
        owner_user_id UUID REFERENCES sdr_users(id) ON DELETE SET NULL,
        connected_by_user_id UUID REFERENCES sdr_users(id) ON DELETE SET NULL,
        last_error TEXT,
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Mailbox sending signature, mirrored from Apollo (editable in the interface).
    await pool.query(`ALTER TABLE sdr_mailboxes ADD COLUMN IF NOT EXISTS signature_html TEXT`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_engagement_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source TEXT NOT NULL DEFAULT 'apollo' CHECK (source IN ('apollo','pipedrive')),
        event_type TEXT NOT NULL,
        apollo_event_id TEXT UNIQUE,
        apollo_sequence_id TEXT,
        apollo_emailer_message_id TEXT,
        pipedrive_lead_id TEXT,
        pipedrive_contact_id TEXT,
        mailbox_email TEXT,
        occurred_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL,
        processed_at TIMESTAMPTZ,
        process_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (process_status IN ('pending','processed','skipped','error')),
        process_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_events_lead_time ON sdr_engagement_events(pipedrive_lead_id, occurred_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_events_type ON sdr_engagement_events(event_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_events_process_status ON sdr_engagement_events(process_status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_events_sequence ON sdr_engagement_events(apollo_sequence_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_migrations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pipedrive_lead_id TEXT NOT NULL,
        from_system TEXT NOT NULL CHECK (from_system IN ('pipedrive','apollo','none')),
        to_system TEXT NOT NULL CHECK (to_system IN ('pipedrive','apollo','none')),
        reason TEXT,
        triggered_by UUID REFERENCES sdr_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_migrations_lead ON sdr_migrations(pipedrive_lead_id)`);

    // Mirror of Pipedrive lead + linked-person outreach state (populated by lib/pipedriveSync.js).
    // Lets the interface show who's already been contacted and dedup before sending.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_lead_state (
        pipedrive_lead_id TEXT PRIMARY KEY,
        pipedrive_person_id TEXT,
        person_name TEXT,
        person_email TEXT,
        last_outgoing_mail_time TIMESTAMPTZ,
        email_messages_count INT,
        last_activity_date DATE,
        lowbid_flag BOOLEAN NOT NULL DEFAULT FALSE,
        sequence_started TEXT,
        project_stage TEXT,
        trigger_type TEXT,
        lead_title TEXT,
        outreach_status TEXT NOT NULL DEFAULT 'clear'
          CHECK (outreach_status IN ('clear','contacted_recent','contacted_stale','sequenced')),
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Bid/Start dates from Pipedrive (added 2026-06-17). Idempotent for existing tables.
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS bid_date DATE`);
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS start_date DATE`);
    // Manual trigger override (Postgres-only, NOT a Pipedrive field — per the
    // "track SDR state in Postgres" rule). Wins over stage-derivation in the sync.
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS trigger_override TEXT`);
    // Pipedrive lead owner name — who's working a manually-contacted lead.
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS owner_name TEXT`);
    // Pipedrive "Lead Score" (numeric, higher = better) — drives priority/ranked auto-enroll.
    await pool.query(`ALTER TABLE sdr_lead_state ADD COLUMN IF NOT EXISTS lead_score DOUBLE PRECISION`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_lead_state_status ON sdr_lead_state(outreach_status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sdr_lead_state_person ON sdr_lead_state(pipedrive_person_id)`);
    // Who initiated a draft: a human ('manual') or the auto-outreach engine ('automatic').
    await pool.query(`ALTER TABLE sdr_drafts ADD COLUMN IF NOT EXISTS initiated_by TEXT NOT NULL DEFAULT 'manual'`);
    // Single-row SDR settings (auto-outreach config). id pinned to 1.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_settings (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        auto_outreach_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        auto_outreach_mode TEXT NOT NULL DEFAULT 'queue' CHECK (auto_outreach_mode IN ('queue','send')),
        auto_min_score DOUBLE PRECISION,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT
      )
    `);
    await pool.query(`INSERT INTO sdr_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    // Editable first-touch draft copy per trigger. Seeded from the code templates; the
    // draft generator reads here first and falls back to code, so generation can't break.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sdr_first_touch_templates (
        trigger_type TEXT PRIMARY KEY CHECK (trigger_type IN ('AGC','LBA','CM','PB')),
        body TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT
      )
    `);
    for (const t of ["AGC", "LBA", "CM", "PB"]) {
      const codeBody = SDR_TEMPLATES[t]?.[0]?.body;
      if (codeBody) {
        await pool.query(
          `INSERT INTO sdr_first_touch_templates (trigger_type, body) VALUES ($1, $2)
           ON CONFLICT (trigger_type) DO NOTHING`,
          [t, codeBody],
        );
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS nurture_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sdr_user TEXT,
        action TEXT NOT NULL,
        target_kind TEXT,
        target_id TEXT,
        summary TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_nurture_audit_time ON nurture_audit(created_at DESC)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS permit_facilities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        external_permit_nmbr TEXT UNIQUE NOT NULL,
        master_permit TEXT NOT NULL DEFAULT 'TXR050000',
        state TEXT NOT NULL DEFAULT 'TX',
        operator_name TEXT,
        operator_key TEXT NOT NULL DEFAULT '',
        coverage_type TEXT NOT NULL DEFAULT 'NOI' CHECK (coverage_type IN ('NOI','NEC')),
        site_address TEXT,
        city TEXT,
        zip TEXT,
        sector_code TEXT,
        ownership_type TEXT,
        compliance_flags JSONB NOT NULL DEFAULT '{}',
        effective_date DATE,
        expiration_date DATE,
        original_issue_date DATE,
        score NUMERIC(8,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pool'
          CHECK (status IN ('pool','promoted','scraped','enriched','enrolled','exported','engaged','dead')),
        last_pulled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_facilities_master ON permit_facilities(master_permit)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_facilities_status ON permit_facilities(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_facilities_opkey ON permit_facilities(operator_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_facilities_score ON permit_facilities(score DESC)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS permit_operators (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        operator_key TEXT UNIQUE NOT NULL,
        operator_name TEXT,
        customer_number TEXT,
        state TEXT NOT NULL DEFAULT 'TX',
        facility_count INT NOT NULL DEFAULT 0,
        best_score NUMERIC(8,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pool',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_operators_score ON permit_operators(best_score DESC)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permit_enrichment (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        external_permit_nmbr TEXT UNIQUE NOT NULL
          REFERENCES permit_facilities(external_permit_nmbr) ON DELETE CASCADE,
        operator_key TEXT,
        customer_number TEXT,
        contact_name TEXT,
        mailing_address TEXT,
        site_address TEXT,
        sic_code TEXT,
        sector TEXT,
        channel TEXT NOT NULL DEFAULT 'mail' CHECK (channel IN ('mail','email','phone','none')),
        tceq_status TEXT,
        source TEXT NOT NULL DEFAULT 'tceq',
        enriched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_enrichment_channel ON permit_enrichment(channel)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permit_engine_settings (
        id INT PRIMARY KEY DEFAULT 1,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        daily_enroll_cap INT NOT NULL DEFAULT 50,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permit_engine_settings_singleton CHECK (id = 1)
      )`);
    await pool.query(`INSERT INTO permit_engine_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    await pool.query(`ALTER TABLE sdr_mailboxes ADD COLUMN IF NOT EXISTS permit_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE sdr_mailboxes ADD COLUMN IF NOT EXISTS permit_signature TEXT`);
    // Seed/refresh the three reps' permit sign-offs (only when not already set).
    await pool.query(`UPDATE sdr_mailboxes SET permit_signature = $2 WHERE lower(email) = $1 AND permit_signature IS NULL`, ['dc@proswppp.co', 'Regards,\nDerek E. Chinners - Founder\nPro SWPPP, LLC\nwww.ProSWPPP.com']);
    await pool.query(`UPDATE sdr_mailboxes SET permit_signature = $2 WHERE lower(email) = $1 AND permit_signature IS NULL`, ['jg@proswppp.co', 'Regards,\nJosie Godfrey\nPro SWPPP, LLC\nwww.ProSWPPP.com']);
    await pool.query(`UPDATE sdr_mailboxes SET permit_signature = $2 WHERE lower(email) = $1 AND permit_signature IS NULL`, ['th@proswppp.co', 'Regards,\nTerry Harris\nPro SWPPP, LLC\nwww.ProSWPPP.com']);
    // Warmup ramp anchors to each mailbox's FIRST send (stamped in approve-and-send),
    // so the clock only starts when the team actually begins — no calendar seed here.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permit_msgp_template (
        id INT PRIMARY KEY DEFAULT 1,
        subject TEXT NOT NULL DEFAULT '',
        body_html TEXT NOT NULL DEFAULT '',
        apollo_sequence_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permit_msgp_template_singleton CHECK (id = 1)
      )`);
    await pool.query(
      `INSERT INTO permit_msgp_template (id, subject, body_html) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
      [
        "Action needed: your TXR050000 stormwater permit expires Aug 13",
        `<div style="font-family:Georgia,'Times New Roman',serif;color:#1a5276;font-size:15px;line-height:1.55">
<p>{{first_name}},</p>
<p>It's just {{sender_first}} with <strong>Pro SWPPP</strong>. Our records show your Texas industrial stormwater permit (TXR050000) is set to expire on <strong>August 13, 2026</strong>.</p>
<p>Every operator on this permit renews on the same cycle this year, so the window fills up fast.</p>
<p>We can handle {{operator}}'s renewal start to finish... the updated SWPPP, the filings, all of it, done before the deadline.</p>
<p>Want us to take it from here? Just reply and we'll get started.</p>
<p>We appreciate your business.</p>
<p>{{signature}}</p>
</div>`,
      ]
    );
    console.log("SDR tables (sdr_users, sdr_mailboxes, sdr_drafts, sdr_sends, sdr_engagement_events, sdr_migrations) verified/created.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS permit_outreach (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        operator_key TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'mail' CHECK (channel IN ('mail','email')),
        status TEXT NOT NULL DEFAULT 'exported' CHECK (status IN ('exported','mailed','emailed','replied','skipped')),
        batch_id TEXT,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_outreach_opkey ON permit_outreach(operator_key)`);

    // Automation Roadmap — shared task list (team posts work, Derek tracks/edits/comments)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS automation_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned'
          CHECK (status IN ('planned','in_progress','blocked','done')),
        sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
        updates JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_automation_tasks_status ON automation_tasks(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_automation_tasks_order ON automation_tasks(sort_order)`);

    // Idempotent seed — only when the table is empty
    const taskCount = await pool.query("SELECT COUNT(*)::int AS n FROM automation_tasks");
    if (taskCount.rows[0].n === 0) {
      const txrBrief = [
        "Target: Active permittee list for the Texas Industrial Multi-Sector General Permit (TCEQ permit no. TXR050000). Public record.",
        "",
        "Action: Scrape the active permittee list from the TCEQ public website.",
        "",
        "Purpose: Lead source for industrial stormwater SWPPP renewal services — existing facilities (recurring inspections + 5-year permit renewal), higher-value than construction.",
        "",
        "Timing: TX TXR050000 expires August 2026. Market window = June–Aug 2026 (now).",
        "",
        "Repeatable engine: One industrial MSGP per state, each with its own expiry. Pull list → market facilities ~6 months before that state's expiry.",
        "",
        "Pipeline: pull list → AI compliance-doc generation (permit → compliant draft) → market expiring facilities → follow-up sequence. Output destination: lead import / Slack.",
      ].join("\n");
      await pool.query(
        `INSERT INTO automation_tasks (title, description, status, sort_order) VALUES
           ($1, $2, $3, $4),
           ($5, $6, $7, $8)`,
        [
          "SDR Interface", "Custom SDR outreach interface — Pipedrive + Apollo draft review, mailbox warmup, send approval.", "in_progress", 1000,
          "Pull TXR050000 permittee list", txrBrief, "planned", 2000,
        ]
      );
      console.log("Seeded automation_tasks with starter roadmap items.");
    }
    console.log("Table 'automation_tasks' verified/created.");
  } catch (err) {
    console.error("CRITICAL: Error initializing database:", err);
  }
}

initDB();

// Pipedrive → sdr_lead_state sync: once shortly after boot, then every 6h.
// Non-blocking; failures are logged and retried on the next tick.
if (process.env.DATABASE_URL && process.env.PIPEDRIVE_API_TOKEN) {
  const runSync = () =>
    syncLeadState(pool)
      .then(async (r) => {
        console.log("[sync] sdr_lead_state:", JSON.stringify(r));
        // Right after a sync, prune queued drafts whose contact was emailed in Pipedrive
        // since we drafted them (so a rep never approves an already-contacted lead).
        try {
          const pruned = await pruneStaleQueuedDrafts(pool);
          if (pruned) console.log(`[auto-outreach] pruned ${pruned} stale queued draft(s)`);
        } catch (e) {
          console.error("[auto-outreach] prune failed:", e.message);
        }
        // Incremental sweep of the Pipedrive sent folder → per-lead outreach ledger.
        try {
          const sw = await sweepSentOutreach(pool, { full: false });
          console.log("[outreach-sweep]", JSON.stringify(sw));
        } catch (e) {
          console.error("[outreach-sweep] failed:", e.message);
        }
      })
      .catch((e) => console.error("[sync] sdr_lead_state failed:", e.message));
  setTimeout(runSync, 30_000);
  setInterval(runSync, 6 * 60 * 60 * 1000);
}

// Send-mode enrollment: enroll each freshly-created auto draft by calling the SAME
// approve-and-send path a human uses (internal HTTP + a short-lived minted token). Reuses
// its dedup + warmup cap + Apollo enroll + Pipedrive write-back untouched; a 409/429 just
// means a guardrail correctly skipped that lead. Shared by the cron and the manual trigger.
async function enrollAutoDrafts(createdDrafts) {
  const out = { enrolled: 0, skipped: 0 };
  for (const d of createdDrafts || []) {
    try {
      const token = jwt.sign({ sub: d.assigned_user_id, username: "auto-outreach", role: "admin" }, JWT_SECRET, { expiresIn: 300 });
      const resp = await fetch(`http://127.0.0.1:${port}/api/sdr/drafts/${d.id}/approve-and-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: "{}",
      });
      if (resp.ok) {
        out.enrolled++;
      } else {
        out.skipped++;
        const txt = await resp.text();
        console.warn(`[auto-outreach] enroll skip draft ${d.id}: ${resp.status} ${txt.slice(0, 140)}`);
      }
    } catch (e) {
      out.skipped++;
      console.warn(`[auto-outreach] enroll error draft ${d.id}: ${e.message}`);
    }
  }
  return out;
}

// Auto-outreach engine: when enabled (sdr_settings), top-up each active mailbox's daily
// cap with the highest lead-score eligible leads. Default mode drafts to the Queue for
// approval. Runs hourly during business hours (America/Chicago) only.
if (process.env.DATABASE_URL && process.env.PIPEDRIVE_API_TOKEN && process.env.APOLLO_API_KEY) {
  const runAuto = () => {
    const hr = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(new Date()),
    );
    const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short" }).format(new Date());
    if (hr < 8 || hr >= 17 || day === "Sat" || day === "Sun") return; // business hours only
    runAutoOutreach(pool, { mailboxSentToday })
      .then(async (r) => {
        if (r && r.created) console.log("[auto-outreach]", JSON.stringify({ mode: r.mode, created: r.created, capacity: r.capacity }));
        if (r && r.mode === "send" && Array.isArray(r.createdDrafts)) {
          const er = await enrollAutoDrafts(r.createdDrafts);
          console.log("[auto-outreach] send results:", JSON.stringify(er));
        }
      })
      .catch((e) => console.error("[auto-outreach] run failed:", e.message));
  };
  setTimeout(runAuto, 90_000);
  setInterval(runAuto, 60 * 60 * 1000);
}

// Apollo engagement poll: per-lead replies + bounces fed into /api/sdr/events/ingest.
// Every ~2 min (in-process cron, not n8n). First run 60s after boot.
if (process.env.DATABASE_URL && process.env.APOLLO_API_KEY) {
  const runEngPoll = () =>
    pollEngagement(pool, { baseUrl: `http://127.0.0.1:${port}`, callbackSecret: N8N_CALLBACK_SECRET })
      .then((r) => { if (r && (r.emitted || r.skipped)) console.log("[engagement-poll]", JSON.stringify(r)); })
      .catch((e) => console.error("[engagement-poll] failed:", e.message));
  setTimeout(runEngPoll, 60_000);
  setInterval(runEngPoll, 2 * 60 * 1000);
}

// Permit engine monthly refresh: EPA pool re-pull + bulk ECHO compliance refresh.
// Gated by env opt-in AND the master switch so it never runs unexpectedly.
// Bulk refresh uses the EPA ZIP download (not the rate-capped per-permit API), so it
// can run hands-off here. Requires `unzip` on PATH; failure is logged, not fatal.
if (process.env.DATABASE_URL && process.env.PERMIT_REFRESH_ENABLED === "true") {
  const runPermitRefresh = async () => {
    try {
      const s = await pool.query(`SELECT active FROM permit_engine_settings WHERE id = 1`);
      if (!s.rows[0]?.active) { console.log("[permit-refresh] skipped — engine inactive"); return; }
      const ing = await runPermitIngest(pool);
      console.log(`[permit-refresh] ingest=${JSON.stringify(ing)}`);
      try {
        const comp = await runEchoBulkRefresh({ pool });
        console.log(`[permit-refresh] compliance=${JSON.stringify(comp)}`);
      } catch (ce) {
        console.error("[permit-refresh] bulk compliance refresh failed (ingest still applied):", ce.message);
      }
    } catch (e) { console.error("[permit-refresh] failed:", e.message); }
  };
  setInterval(runPermitRefresh, 30 * 24 * 60 * 60 * 1000); // ~monthly
}

// Fallback in-memory store if no DB is connected (for local dev)
let memoryProjects = [];
let memoryArchive = [];
let memoryContent = [];

// API Routes
app.get("/health", (req, res) => {
  res.json({ status: "ok", database: !!process.env.DATABASE_URL });
});

// SDR identity — passwordless. The dashboard sits behind the basic-auth wall
// (derek:dereksystem) which is the real perimeter; this endpoint just records
// "who's working" so per-user mailbox/draft scoping has a subject.
// Accepts a username, returns a JWT. No password required.
app.post("/api/sdr/auth/login", async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: "Database not configured" });
  }
  const { username } = req.body || {};
  if (!username) {
    return res.status(400).json({ error: "username required" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, username, email, display_name, role, active
       FROM sdr_users WHERE username = $1 LIMIT 1`,
      [username],
    );
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(404).json({ error: "Unknown user" });
    }
    await pool.query(`UPDATE sdr_users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
    const token = jwt.sign(
      { sub: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_TTL_SECONDS },
    );
    return res.json({
      token,
      expires_in: JWT_TTL_SECONDS,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("/api/sdr/auth/login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

// SDR — list selectable users (passwordless picker fuel)
app.get("/api/sdr/auth/users", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const { rows } = await pool.query(
      `SELECT username, display_name, role
       FROM sdr_users WHERE active = TRUE ORDER BY role DESC, username`,
    );
    res.json({ users: rows });
  } catch (err) {
    console.error("/api/sdr/auth/users error:", err);
    res.status(500).json({ error: "Failed to list users" });
  }
});

// SDR — return current user from JWT (req.sdrUser set by global middleware)
app.get("/api/sdr/auth/me", (req, res) => {
  if (!req.sdrUser) return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: req.sdrUser });
});

// SDR mailboxes — list (owner-scoped; admin sees all)
app.get("/api/sdr/mailboxes", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const scope = ownerScope(req.sdrUser, "owner_user_id");
    const params = [];
    let sql = `SELECT id, email, display_name, apollo_mailbox_id, owner_user_id,
                      daily_send_limit, warmup_status, warmup_current_cap, warmup_started_at,
                      deliverability_score, last_health_check_at, active, signature_html,
                      created_at, updated_at,
                      (SELECT count(*)::int FROM sdr_sends s
                         WHERE s.mailbox_id = sdr_mailboxes.id
                           AND (s.sent_at AT TIME ZONE 'America/Chicago')::date
                               = (now() AT TIME ZONE 'America/Chicago')::date) AS sent_today
               FROM sdr_mailboxes`;
    if (scope.requires) {
      params.push(scope.value);
      sql += ` WHERE ${scope.column} = $${params.length}`;
    }
    sql += ` ORDER BY email`;
    const { rows } = await pool.query(sql, params);
    // Attach the ramped daily cap + warmup day so the UI can show "3/5 sent today".
    // sent_today counts the shared sdr_sends log (the one per-mailbox cap that the
    // SDR and TXR050000/permit cold systems both draw from).
    const mailboxes = rows.map((m) => ({
      ...m,
      daily_cap: dailyCap(m.warmup_started_at),
      warmup_day: rampDay(m.warmup_started_at),
    }));
    res.json({ mailboxes });
  } catch (err) {
    console.error("GET /api/sdr/mailboxes error:", err);
    res.status(500).json({ error: "Failed to list mailboxes" });
  }
});

// SDR mailbox — enable/disable a sender (admin only). A disabled mailbox is skipped by
// draft generation and the auto-outreach rotation (and can't be sent from).
app.patch("/api/sdr/mailboxes/:id", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  if (req.sdrUser?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { active } = req.body || {};
  if (typeof active !== "boolean") return res.status(400).json({ error: "active (boolean) required" });
  try {
    const { rows } = await pool.query(
      `UPDATE sdr_mailboxes SET active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, active`,
      [active, req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "Mailbox not found" });
    await pool.query(
      `INSERT INTO nurture_audit (sdr_user, action, target_kind, target_id, summary)
       VALUES ($1, 'mailbox.toggle', 'sdr_mailbox', $2, $3)`,
      [req.sdrUser?.username || req.sdrUser?.sub, req.params.id, active ? "enabled" : "disabled"],
    ).catch(() => {});
    res.json({ mailbox: rows[0] });
  } catch (err) {
    console.error("PATCH /api/sdr/mailboxes/:id error:", err);
    res.status(500).json({ error: "Failed to update mailbox" });
  }
});

// SDR mailbox — view/edit the sending signature (admin). Writes to Apollo, mirrors to DB.
app.put("/api/sdr/mailboxes/:id/signature", express.json(), async (req, res) => {
  if (req.sdrUser?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { signature_html } = req.body || {};
  if (typeof signature_html !== "string") return res.status(400).json({ error: "signature_html (string) required" });
  try {
    const { rows } = await pool.query(`SELECT apollo_mailbox_id FROM sdr_mailboxes WHERE id = $1`, [req.params.id]);
    const apolloId = rows[0]?.apollo_mailbox_id;
    if (!apolloId) return res.status(404).json({ error: "Mailbox not found or not Apollo-linked" });
    if (process.env.APOLLO_API_KEY) await apolloClient.updateEmailAccountSignature(apolloId, signature_html);
    const { rows: upd } = await pool.query(
      `UPDATE sdr_mailboxes SET signature_html = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, signature_html`,
      [signature_html, req.params.id],
    );
    res.json({ mailbox: upd[0] });
  } catch (err) {
    console.error("PUT /api/sdr/mailboxes/:id/signature error:", err);
    res.status(500).json({ error: err.message || "Failed to update signature" });
  }
});

// SDR settings — auto-outreach config (read by anyone signed in; only admins change it).
app.get("/api/sdr/settings", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const { rows } = await pool.query(`SELECT * FROM sdr_settings WHERE id = 1`);
    res.json({ settings: rows[0] || { auto_outreach_enabled: false, auto_outreach_mode: "queue", auto_min_score: null } });
  } catch (err) {
    console.error("GET /api/sdr/settings error:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

app.patch("/api/sdr/settings", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  if (req.sdrUser?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { auto_outreach_enabled, auto_outreach_mode, auto_min_score } = req.body || {};
  if (auto_outreach_mode !== undefined && !["queue", "send"].includes(auto_outreach_mode)) {
    return res.status(400).json({ error: "auto_outreach_mode must be 'queue' or 'send'" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE sdr_settings SET
         auto_outreach_enabled = COALESCE($1, auto_outreach_enabled),
         auto_outreach_mode    = COALESCE($2, auto_outreach_mode),
         auto_min_score        = CASE WHEN $3::text = 'unset' THEN NULL
                                      WHEN $4::float8 IS NOT NULL THEN $4::float8
                                      ELSE auto_min_score END,
         updated_at = NOW(), updated_by = $5
       WHERE id = 1 RETURNING *`,
      [
        typeof auto_outreach_enabled === "boolean" ? auto_outreach_enabled : null,
        auto_outreach_mode ?? null,
        auto_min_score === null ? "unset" : null,
        typeof auto_min_score === "number" ? auto_min_score : null,
        req.sdrUser?.username || req.sdrUser?.sub,
      ],
    );
    await pool.query(
      `INSERT INTO nurture_audit (sdr_user, action, target_kind, target_id, summary)
       VALUES ($1, 'settings.auto_outreach', 'sdr_settings', '1', $2)`,
      [req.sdrUser?.username || req.sdrUser?.sub, JSON.stringify(rows[0])],
    ).catch(() => {});
    res.json({ settings: rows[0] });
  } catch (err) {
    console.error("PATCH /api/sdr/settings error:", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// Manually trigger one auto-outreach pass (admin). Respects the configured mode: queue
// creates drafts for review, send also enrolls them through approve-and-send. Optional
// body.max caps the batch (handy for a controlled test). Requires the engine enabled.
app.post("/api/sdr/auto-outreach/run", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  if (req.sdrUser?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const max = req.body?.max != null ? Math.max(1, Math.min(50, Number(req.body.max))) : undefined;
  try {
    const r = await runAutoOutreach(pool, { mailboxSentToday, maxDrafts: max });
    if (r.mode === "send" && Array.isArray(r.createdDrafts) && r.createdDrafts.length) {
      r.sendResults = await enrollAutoDrafts(r.createdDrafts);
    }
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error("POST /api/sdr/auto-outreach/run error:", err);
    res.status(500).json({ error: err.message || "Auto-outreach run failed" });
  }
});

// First-touch draft templates (editable copy that buildDraftFromLead uses). Read by any
// signed-in user; only admins edit. Merge fields: {First} {ENV} {SWPPP} {Sig}.
app.get("/api/sdr/first-touch-templates", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const { rows } = await pool.query(`SELECT trigger_type, body, updated_at, updated_by FROM sdr_first_touch_templates`);
    const byTrigger = {};
    for (const r of rows) byTrigger[r.trigger_type] = r;
    res.json({ templates: byTrigger });
  } catch (err) {
    console.error("GET /api/sdr/first-touch-templates error:", err);
    res.status(500).json({ error: "Failed to load first-touch templates" });
  }
});

app.put("/api/sdr/first-touch-templates/:trigger", express.json({ limit: "256kb" }), async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  if (req.sdrUser?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const trigger = String(req.params.trigger || "").toUpperCase();
  if (!["AGC", "LBA", "CM", "PB"].includes(trigger)) return res.status(400).json({ error: "Invalid trigger" });
  const { body } = req.body || {};
  if (typeof body !== "string" || !body.trim()) return res.status(400).json({ error: "body (non-empty string) required" });
  try {
    const { rows } = await pool.query(
      `INSERT INTO sdr_first_touch_templates (trigger_type, body, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (trigger_type) DO UPDATE SET body = EXCLUDED.body, updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING trigger_type, body, updated_at, updated_by`,
      [trigger, body, req.sdrUser?.username || req.sdrUser?.sub],
    );
    await pool.query(
      `INSERT INTO nurture_audit (sdr_user, action, target_kind, target_id, summary)
       VALUES ($1, 'first_touch.update', 'sdr_first_touch_template', $2, $3)`,
      [req.sdrUser?.username || req.sdrUser?.sub, trigger, `${body.length} chars`],
    ).catch(() => {});
    res.json({ template: rows[0] });
  } catch (err) {
    console.error("PUT /api/sdr/first-touch-templates error:", err);
    res.status(500).json({ error: "Failed to save first-touch template" });
  }
});

// SDR lead-state — mirror of Pipedrive outreach state. Read by the interface to show
// who's already been contacted (dedup). Newest sync first; optional ?status= and ?q= filters.
// Whitelist of sortable columns (guards against SQL injection via ?sort=).
const LEAD_SORT_COLUMNS = {
  lead_title: "s.lead_title",
  project_stage: "s.project_stage",
  outreach_status: "s.outreach_status",
  trigger_type: "s.trigger_type",
  last_contact: "s.last_outgoing_mail_time",
  bid_date: "s.bid_date",
  start_date: "s.start_date",
  lead_score: "s.lead_score",
  synced_at: "s.synced_at",
};

app.get("/api/sdr/leads", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const params = [];
    const where = [];
    const addFilter = (clause, value) => {
      params.push(value);
      where.push(clause.replace("$$", `$${params.length}`));
    };
    if (req.query.status) {
      const st = String(req.query.status);
      if (st === "fresh" || st === "clear") addFilter("s.outreach_status = $$", "clear");
      else if (st === "contacted") where.push("s.outreach_status IN ('contacted_recent','contacted_stale')");
      else addFilter("s.outreach_status = $$", st); // sequenced | exact value
    }
    if (req.query.trigger) {
      if (req.query.trigger === "none") where.push("s.trigger_type IS NULL");
      else addFilter("s.trigger_type = $$", req.query.trigger);
    }
    if (req.query.stage) addFilter("s.project_stage = $$", req.query.stage);
    // Outreach source filter (references the `ol` LATERAL below, which is in scope by the
    // time WHERE is evaluated): pipedrive | interface | none (never outreached).
    if (req.query.source) {
      const src = String(req.query.source);
      if (src === "none") where.push("ol.source IS NULL");
      else addFilter("ol.source = $$", src);
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      const p = `$${params.length}`;
      where.push(`(s.lead_title ILIKE ${p} OR s.person_name ILIKE ${p} OR s.person_email ILIKE ${p})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Pagination (1-based page; default 50/page, hard max 200).
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    // Sort (whitelisted column + direction).
    const sortCol = LEAD_SORT_COLUMNS[req.query.sort] || "s.synced_at";
    const sortDir = String(req.query.dir).toLowerCase() === "asc" ? "ASC" : "DESC";
    // Nulls last on the chosen column, then a stable tiebreak.
    const orderSql = `ORDER BY ${sortCol} ${sortDir} NULLS LAST, s.last_outgoing_mail_time DESC NULLS LAST`;

    // "Outreached by": the rep on the most-recently SENT draft — lead-level proof we
    // actually outreached this lead. Drafts in other states (pending/edited/rejected)
    // are NOT outreach, so they must not credit a rep here (was attributing to the
    // latest draft of any status → false "outreached by" on un-sent leads).
    // "Sequence stage": most-recent Apollo enrollment send (status + when).
    const pageSql = `
      SELECT s.*,
             CASE WHEN s.last_outgoing_mail_time IS NULL THEN NULL
                  ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - s.last_outgoing_mail_time)) / 86400)::int END AS days_since_outgoing,
             ob.outreached_by,
             ob.outreached_status,
             ob.initiated_by,
             ol.sent_at AS outreach_sent_at,
             ol.source AS outreach_source,
             ol.sender_name AS outreach_sender_name,
             ol.sender_email AS outreach_sender_email,
             snd.send_status,
             snd.send_sequence_id,
             snd.sent_at AS send_sent_at,
             snd.current_step AS send_current_step,
             snd.total_steps AS send_total_steps,
             snd.next_send_at AS send_next_at,
             COUNT(*) OVER() AS _total
      FROM sdr_lead_state s
      LEFT JOIN LATERAL (
        SELECT COALESCE(u.display_name, u.username) AS outreached_by, d.status AS outreached_status,
               d.initiated_by
        FROM sdr_drafts d
        LEFT JOIN sdr_users u ON u.id = d.assigned_user_id
        WHERE d.pipedrive_lead_id = s.pipedrive_lead_id
          AND d.status = 'sent'
        ORDER BY d.sent_at DESC NULLS LAST, d.created_at DESC
        LIMIT 1
      ) ob ON TRUE
      LEFT JOIN LATERAL (
        SELECT status AS send_status, apollo_sequence_id AS send_sequence_id, sent_at,
               current_step, total_steps, next_send_at
        FROM sdr_sends
        WHERE pipedrive_lead_id = s.pipedrive_lead_id
        ORDER BY sent_at DESC NULLS LAST
        LIMIT 1
      ) snd ON TRUE
      LEFT JOIN LATERAL (
        SELECT sent_at, source, sender_name, sender_email
        FROM sdr_outreach_log
        WHERE pipedrive_lead_id = s.pipedrive_lead_id
        ORDER BY sent_at DESC
        LIMIT 1
      ) ol ON TRUE
      ${whereSql}
      ${orderSql}
      LIMIT ${limit} OFFSET ${offset}`;

    const { rows } = await pool.query(pageSql, params);
    const total = rows.length ? Number(rows[0]._total) : 0;
    for (const r of rows) delete r._total;

    // Global facet counts (whole table) for the summary tiles.
    const { rows: facetRows } = await pool.query(
      `SELECT outreach_status, COUNT(*)::int n FROM sdr_lead_state GROUP BY 1`,
    );
    const byStatus = Object.fromEntries(facetRows.map((r) => [r.outreach_status, r.n]));
    const grandTotal = facetRows.reduce((a, r) => a + r.n, 0);

    res.json({
      leads: rows,
      count: rows.length,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      facets: { byStatus, grandTotal },
    });
  } catch (err) {
    console.error("GET /api/sdr/leads error:", err);
    res.status(500).json({ error: err.message || "Failed to load leads" });
  }
});

// Distinct stage/trigger values for the Leads filter dropdowns.
app.get("/api/sdr/leads/filters", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const { rows: stages } = await pool.query(
      `SELECT project_stage AS v, COUNT(*)::int n FROM sdr_lead_state
       WHERE project_stage IS NOT NULL AND project_stage <> '' GROUP BY 1 ORDER BY 2 DESC`,
    );
    const { rows: triggers } = await pool.query(
      `SELECT COALESCE(trigger_type, 'none') AS v, COUNT(*)::int n FROM sdr_lead_state GROUP BY 1 ORDER BY 2 DESC`,
    );
    res.json({ stages, triggers });
  } catch (err) {
    console.error("GET /api/sdr/leads/filters error:", err);
    res.status(500).json({ error: err.message || "Failed to load filters" });
  }
});

// Write-back: add a note to a lead in Pipedrive from the interface (two-way sync).
// Single, user-initiated note — not a bulk action.
app.post("/api/sdr/leads/:leadId/note", async (req, res) => {
  if (!process.env.PIPEDRIVE_API_TOKEN) return res.status(503).json({ error: "Pipedrive not configured" });
  const { leadId } = req.params;
  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "content required" });
  try {
    const who = req.sdrUser?.username || "interface";
    // Tag the note with who added it from the SDR console for traceability.
    const body = `${content}\n\n— added by ${who} via SDR console`;
    const note = await pipedriveClient.addNote({ leadId, content: body });
    res.json({ ok: true, note_id: note?.id ?? null });
  } catch (err) {
    console.error("POST /api/sdr/leads/:leadId/note error:", err);
    res.status(500).json({ error: err.message || "Failed to add note" });
  }
});

// Full per-lead detail for the drawer: mirror row + live Pipedrive lead/person
// + our drafts/sends + engagement events. Aggregated server-side so the drawer
// is one round-trip.
app.get("/api/sdr/leads/:leadId/detail", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  const { leadId } = req.params;
  try {
    const { rows: leadRows } = await pool.query(
      `SELECT s.*,
              CASE WHEN s.last_outgoing_mail_time IS NULL THEN NULL
                   ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - s.last_outgoing_mail_time)) / 86400)::int END AS days_since_outgoing,
              ob.outreached_by, ob.outreached_status, ob.initiated_by,
              ol.sent_at AS outreach_sent_at, ol.source AS outreach_source,
              ol.sender_name AS outreach_sender_name, ol.sender_email AS outreach_sender_email
       FROM sdr_lead_state s
       LEFT JOIN LATERAL (
         SELECT COALESCE(u.display_name, u.username) AS outreached_by, d.status AS outreached_status, d.initiated_by
         FROM sdr_drafts d LEFT JOIN sdr_users u ON u.id = d.assigned_user_id
         WHERE d.pipedrive_lead_id = s.pipedrive_lead_id AND d.status = 'sent'
         ORDER BY d.sent_at DESC NULLS LAST, d.created_at DESC LIMIT 1
       ) ob ON TRUE
       LEFT JOIN LATERAL (
         SELECT sent_at, source, sender_name, sender_email FROM sdr_outreach_log
         WHERE pipedrive_lead_id = s.pipedrive_lead_id ORDER BY sent_at DESC LIMIT 1
       ) ol ON TRUE
       WHERE s.pipedrive_lead_id = $1`,
      [leadId],
    );
    const lead = leadRows[0] || null;
    if (!lead) return res.status(404).json({ error: "Lead not found in mirror" });

    const [{ rows: drafts }, { rows: sends }, { rows: events }] = await Promise.all([
      pool.query(
        `SELECT d.id, d.trigger_type, d.status, d.subject, d.body, d.created_at, d.sent_at, d.assigned_user_id,
                COALESCE(u.display_name, u.username) AS assigned_to,
                mb.email AS sent_from, mb.signature_html AS sender_signature
         FROM sdr_drafts d
         LEFT JOIN sdr_users u ON u.id = d.assigned_user_id
         LEFT JOIN sdr_mailboxes mb ON mb.id = d.assigned_mailbox_id
         WHERE d.pipedrive_lead_id = $1 ORDER BY d.created_at DESC`,
        [leadId],
      ),
      pool.query(
        `SELECT id, apollo_sequence_id, status, sent_at FROM sdr_sends
         WHERE pipedrive_lead_id = $1 ORDER BY sent_at DESC NULLS LAST`,
        [leadId],
      ),
      pool.query(
        `SELECT event_type, occurred_at, mailbox_email FROM sdr_engagement_events
         WHERE pipedrive_lead_id = $1 ORDER BY occurred_at DESC LIMIT 50`,
        [leadId],
      ),
    ]);

    // Live Pipedrive lead + person (best-effort; drawer still renders if PD is down).
    let pdLead = null;
    let pdPerson = null;
    if (process.env.PIPEDRIVE_API_TOKEN) {
      try {
        pdLead = await pipedriveClient.getLead(leadId);
        if (pdLead?.person_id?.value || lead.pipedrive_person_id) {
          pdPerson = await pipedriveClient.getPerson(pdLead?.person_id?.value || lead.pipedrive_person_id);
        }
      } catch (e) {
        console.warn("[detail] Pipedrive fetch failed:", e.message);
      }
    }

    res.json({ lead, drafts, sends, events, pd_lead: pdLead, pd_person: pdPerson });
  } catch (err) {
    console.error("GET /api/sdr/leads/:leadId/detail error:", err);
    res.status(500).json({ error: err.message || "Failed to load detail" });
  }
});

// Pipedrive "Project Stage" custom-field hash (mirrors lib/pipedriveSync F.STAGE).
const PD_STAGE_FIELD = "7c1852c27664d1118f75660223a6af9e99d10f2c";
// Stage → derived trigger (mirrors STAGE_TRIGGER in lib/pipedriveSync).
const STAGE_TRIGGER_MAP = { AGC: "AGC", LBA: "LBA", CM: "CM", PB: "PB", OB: "PB", "PRE-BID": "PB" };

const VALID_TRIGGERS = ["AGC", "LBA", "CM", "PB"];

// Write-back: set a lead's Project Stage in Pipedrive (and re-derive trigger),
// and/or set a manual trigger_override (Postgres-only, no Pipedrive field).
// Body: { project_stage?, trigger_override? } — trigger_override "" or "clear"
// removes the override and reverts to stage-derived.
app.patch("/api/sdr/leads/:leadId", async (req, res) => {
  const { leadId } = req.params;
  const stage = req.body?.project_stage != null ? String(req.body.project_stage).trim() : null;
  const hasTriggerField = Object.prototype.hasOwnProperty.call(req.body || {}, "trigger_override");
  const rawOverride = hasTriggerField ? String(req.body.trigger_override || "").trim().toUpperCase() : null;
  const override = rawOverride && rawOverride !== "CLEAR" ? rawOverride : null;
  if (hasTriggerField && override && !VALID_TRIGGERS.includes(override)) {
    return res.status(400).json({ error: "trigger_override must be AGC/LBA/CM/PB or empty" });
  }
  if (!stage && !hasTriggerField) return res.status(400).json({ error: "project_stage or trigger_override required" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    // Stage write-back hits Pipedrive; trigger_override is Postgres-only.
    if (stage) {
      if (!process.env.PIPEDRIVE_API_TOKEN) return res.status(503).json({ error: "Pipedrive not configured" });
      await pipedriveClient.updateLead(leadId, { [PD_STAGE_FIELD]: stage });
    }
    // Single typed UPDATE handles every case: stage-only keeps the override;
    // override set wins; override="" reverts trigger_type to stage-derived from
    // the row's own project_stage. Explicit ::casts avoid NULL type inference.
    // $1 stage(or null), $2 hasTriggerField(bool), $3 override(or null), $4 leadId.
    const { rows } = await pool.query(
      `UPDATE sdr_lead_state SET
         project_stage = COALESCE($1::text, project_stage),
         trigger_override = CASE WHEN $2::bool THEN $3::text ELSE trigger_override END,
         trigger_type = COALESCE(
           CASE WHEN $2::bool THEN $3::text ELSE trigger_override END,
           CASE upper(COALESCE($1::text, project_stage))
             WHEN 'AGC' THEN 'AGC' WHEN 'LBA' THEN 'LBA' WHEN 'CM' THEN 'CM'
             WHEN 'PB' THEN 'PB' WHEN 'OB' THEN 'PB' WHEN 'PRE-BID' THEN 'PB'
             ELSE NULL END
         )
       WHERE pipedrive_lead_id = $4
       RETURNING project_stage, trigger_type, trigger_override`,
      [stage, hasTriggerField, override, leadId],
    );
    res.json({ ok: true, ...(rows[0] || {}) });
  } catch (err) {
    console.error("PATCH /api/sdr/leads/:leadId error:", err);
    res.status(500).json({ error: err.message || "Failed to update lead" });
  }
});

// Write-back: log an activity (call/task/meeting) on a lead in Pipedrive.
app.post("/api/sdr/leads/:leadId/activity", async (req, res) => {
  if (!process.env.PIPEDRIVE_API_TOKEN) return res.status(503).json({ error: "Pipedrive not configured" });
  const { leadId } = req.params;
  const subject = String(req.body?.subject || "").trim();
  const type = String(req.body?.type || "call").trim();
  const dueDate = req.body?.due_date ? String(req.body.due_date) : null;
  const done = !!req.body?.done;
  if (!subject) return res.status(400).json({ error: "subject required" });
  try {
    const who = req.sdrUser?.username || "interface";
    const act = await pipedriveClient.addActivity({
      leadId,
      subject,
      type,
      dueDate,
      done,
      note: `Logged by ${who} via SDR console`,
    });
    res.json({ ok: true, activity_id: act?.id ?? null });
  } catch (err) {
    console.error("POST /api/sdr/leads/:leadId/activity error:", err);
    res.status(500).json({ error: err.message || "Failed to log activity" });
  }
});

// SDR lead-state — trigger an on-demand Pipedrive sync (admin only).
app.post("/api/sdr/sync/leads", async (req, res) => {
  if (req.sdrUser?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  if (!process.env.PIPEDRIVE_API_TOKEN) return res.status(503).json({ error: "Pipedrive not configured" });
  // Fire-and-forget: a full sync (hundreds of leads × per-person fetch) exceeds the
  // gateway request timeout. Kick it off and return immediately; the in-module
  // `running` guard makes overlapping triggers safe. Poll GET /api/sdr/leads for results.
  syncLeadState(pool, { force: true })
    .then((r) => console.log("[sync] on-demand sdr_lead_state:", JSON.stringify(r)))
    .catch((e) => console.error("[sync] on-demand failed:", e.message));
  res.status(202).json({ started: true, note: "Sync running in background; poll GET /api/sdr/leads for updated state." });
});

// SDR outreach ledger — sweep the Pipedrive sent folder into sdr_outreach_log
// (admin only). body { full:true } pages the whole sent folder (initial backfill);
// otherwise incremental from the last watermark. Fire-and-forget for the full run.
app.post("/api/sdr/outreach/sweep", async (req, res) => {
  if (req.sdrUser?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  if (!process.env.PIPEDRIVE_API_TOKEN) return res.status(503).json({ error: "Pipedrive not configured" });
  const full = req.body?.full === true;
  if (full) {
    sweepSentOutreach(pool, { full: true })
      .then((r) => console.log("[outreach-sweep] full:", JSON.stringify(r)))
      .catch((e) => console.error("[outreach-sweep] full failed:", e.message));
    return res.status(202).json({ started: true, full: true });
  }
  try {
    const r = await sweepSentOutreach(pool, { full: false });
    res.json(r);
  } catch (err) {
    console.error("POST /api/sdr/outreach/sweep error:", err);
    res.status(500).json({ error: err.message || "Sweep failed" });
  }
});

// ---------------------------------------------------------------------------
// Unified inbox (Gmail OAuth per .co mailbox) — lib/gmailInbox.js
// ---------------------------------------------------------------------------
const _gmailTokenCache = new Map(); // mailbox_email → { token, exp }

async function accessTokenForMailbox(mailboxEmail) {
  const cached = _gmailTokenCache.get(mailboxEmail);
  if (cached && cached.exp > Date.now() + 30_000) return cached.token;
  const { rows } = await pool.query(`SELECT refresh_token FROM sdr_inbox_accounts WHERE mailbox_email=$1`, [mailboxEmail]);
  const rt = rows[0]?.refresh_token;
  if (!rt) throw Object.assign(new Error(`Mailbox ${mailboxEmail} not connected`), { status: 409 });
  const { accessToken, expiresIn } = await gmailInbox.refreshAccessToken(rt);
  _gmailTokenCache.set(mailboxEmail, { token: accessToken, exp: Date.now() + (expiresIn || 3600) * 1000 });
  return accessToken;
}

// All .co mailboxes visible to this user: admin sees every mailbox, an SDR sees the one
// whose local-part matches their own (jg@proswppp.com → jg@proswppp.co), connected or not.
async function visibleMailboxes(sdrUser) {
  const isAdmin = sdrUser?.role === "admin";
  const { rows } = await pool.query(
    `SELECT m.email, (a.mailbox_email IS NOT NULL) AS connected, a.connected_at,
            COALESCE(u.display_name, u.username) AS owner_name
       FROM sdr_mailboxes m
       LEFT JOIN sdr_inbox_accounts a ON a.mailbox_email = m.email
       LEFT JOIN sdr_users u ON u.id = a.owner_user_id
      WHERE $1 OR split_part(m.email,'@',1) = (SELECT split_part(email,'@',1) FROM sdr_users WHERE id=$2)
      ORDER BY m.email`,
    [isAdmin, sdrUser?.sub],
  );
  return rows;
}

async function resolveMailbox(sdrUser, requested) {
  const vis = await visibleMailboxes(sdrUser);
  const connected = vis.filter((v) => v.connected).map((v) => v.email);
  if (requested) {
    const r = String(requested).toLowerCase();
    if (!connected.includes(r)) throw Object.assign(new Error("Mailbox not accessible"), { status: 403 });
    return r;
  }
  return connected[0] || null;
}

function parseEmailAddr(s) {
  if (!s) return null;
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : String(s)).trim().toLowerCase();
}

// Start consent → returns the Google URL the client redirects to (client does window.location).
app.get("/api/sdr/inbox/oauth/start", async (req, res) => {
  if (!gmailInbox.isConfigured()) return res.status(503).json({ error: "Google OAuth not configured" });
  const mailbox = req.query.mailbox ? String(req.query.mailbox).toLowerCase() : undefined;
  // Non-admins may only connect their own mailbox.
  if (mailbox) {
    const vis = await visibleMailboxes(req.sdrUser);
    if (!vis.some((v) => v.email === mailbox)) return res.status(403).json({ error: "Mailbox not yours to connect" });
  }
  const state = jwt.sign({ sub: req.sdrUser.sub, mailbox, t: "inbox_oauth" }, JWT_SECRET, { expiresIn: 600 });
  res.json({ url: gmailInbox.buildAuthUrl({ state, loginHint: mailbox }) });
});

// Google redirects here (no bearer; identity + CSRF via the signed state JWT).
app.get("/api/sdr/inbox/oauth/callback", async (req, res) => {
  const appBase = process.env.PUBLIC_BASE_URL || "https://swppp-interface-production.up.railway.app";
  try {
    const claims = verifySdrJwt(String(req.query.state || ""));
    if (!claims || claims.t !== "inbox_oauth") return res.status(400).send("Invalid OAuth state");
    if (req.query.error) return res.redirect(`${appBase}/#/sdr?tab=inbox&error=${encodeURIComponent(String(req.query.error))}`);
    const { refreshToken, email } = await gmailInbox.exchangeCode(String(req.query.code));
    if (!email) return res.status(400).send("Could not determine the mailbox email");
    const local = email.split("@")[0];
    const { rows: ow } = await pool.query(`SELECT id FROM sdr_users WHERE split_part(email,'@',1)=$1 LIMIT 1`, [local]);
    await pool.query(
      `INSERT INTO sdr_inbox_accounts (mailbox_email, refresh_token, owner_user_id, connected_by_user_id, connected_at, updated_at)
       VALUES ($1,$2,$3,$4,NOW(),NOW())
       ON CONFLICT (mailbox_email) DO UPDATE SET
         refresh_token = COALESCE(EXCLUDED.refresh_token, sdr_inbox_accounts.refresh_token),
         owner_user_id = EXCLUDED.owner_user_id,
         connected_by_user_id = EXCLUDED.connected_by_user_id,
         last_error = NULL, updated_at = NOW()`,
      [email, refreshToken, ow[0]?.id || null, claims.sub],
    );
    _gmailTokenCache.delete(email);
    res.redirect(`${appBase}/#/sdr?tab=inbox&connected=${encodeURIComponent(email)}`);
  } catch (e) {
    console.error("inbox oauth callback error:", e.message);
    res.redirect(`${appBase}/#/sdr?tab=inbox&error=${encodeURIComponent(e.message)}`);
  }
});

// Connected/visible mailboxes for this user (drives the connect buttons + switcher).
app.get("/api/sdr/inbox/accounts", async (req, res) => {
  try {
    const accounts = await visibleMailboxes(req.sdrUser);
    res.json({ accounts, isAdmin: req.sdrUser?.role === "admin", configured: gmailInbox.isConfigured() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Thread list for a mailbox (scoped). Each thread linked to its lead by sender email.
app.get("/api/sdr/inbox/threads", async (req, res) => {
  try {
    const mailbox = await resolveMailbox(req.sdrUser, req.query.mailbox);
    if (!mailbox) return res.json({ mailbox: null, threads: [], note: "No connected mailbox" });
    const token = await accessTokenForMailbox(mailbox);
    const q = req.query.q ? String(req.query.q) : "in:inbox";
    const threads = await gmailInbox.listThreads(token, { q, maxResults: 25 });
    const froms = [...new Set(threads.map((t) => parseEmailAddr(t.from)).filter(Boolean))];
    const leadMap = {};
    if (froms.length) {
      const { rows } = await pool.query(
        `SELECT lower(person_email) e, pipedrive_lead_id, lead_title FROM sdr_lead_state WHERE lower(person_email) = ANY($1)`,
        [froms],
      );
      for (const r of rows) leadMap[r.e] = { lead_id: r.pipedrive_lead_id, lead_title: r.lead_title };
    }
    for (const t of threads) {
      const e = parseEmailAddr(t.from);
      t.lead = e ? leadMap[e] || null : null;
    }
    res.json({ mailbox, threads });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Full thread (all messages, decoded bodies).
app.get("/api/sdr/inbox/threads/:id", async (req, res) => {
  try {
    const mailbox = await resolveMailbox(req.sdrUser, req.query.mailbox);
    if (!mailbox) return res.status(409).json({ error: "No connected mailbox" });
    const token = await accessTokenForMailbox(mailbox);
    const thread = await gmailInbox.getThread(token, req.params.id);
    gmailInbox.markThreadRead(token, req.params.id).catch(() => {});
    res.json({ mailbox, ...thread });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Reply in-thread, sent from the mailbox.
app.post("/api/sdr/inbox/threads/:id/reply", express.json(), async (req, res) => {
  try {
    const mailbox = await resolveMailbox(req.sdrUser, req.body?.mailbox || req.query.mailbox);
    if (!mailbox) return res.status(409).json({ error: "No connected mailbox" });
    const token = await accessTokenForMailbox(mailbox);
    const { to, subject, body, inReplyTo, references } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: "to and body are required" });
    const r = await gmailInbox.sendReply(token, {
      threadId: req.params.id,
      from: mailbox,
      to,
      subject: subject || "",
      bodyText: body,
      inReplyTo,
      references,
    });
    res.json({ ok: true, id: r.id });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Cross-mailbox OUTREACH overview: the signal-only view. Aggregates inbox threads
// across every mailbox the user can see, keeps only conversations whose counterpart
// is a lead in our book (i.e. tied to outreach), and tags each with its mailbox + lead.
app.get("/api/sdr/inbox/overview", async (req, res) => {
  try {
    const vis = await visibleMailboxes(req.sdrUser);
    const boxes = vis.filter((v) => v.connected).map((v) => v.email);
    if (!boxes.length) return res.json({ threads: [], mailboxes: [] });
    // 1) Inbound REPLIES from the connected Gmail inboxes, matched to a known SDR lead or
    //    permit operator by the From address. These are openable threads. (We do NOT read
    //    in:sent — the mailboxes run Apollo warmup, which floods Sent with fake emails;
    //    real sends come from our own records below.)
    const all = [];
    for (const mb of boxes) {
      let token;
      try {
        token = await accessTokenForMailbox(mb);
      } catch {
        continue;
      }
      try {
        const threads = await gmailInbox.listThreads(token, { q: "in:inbox", maxResults: 25 });
        for (const t of threads) all.push({ ...t, mailbox: mb });
      } catch {
        /* skip a mailbox that errors, keep the rest */
      }
    }
    const froms = [...new Set(all.map((t) => parseEmailAddr(t.from)).filter(Boolean))];
    const leadMap = {};
    const permitMap = {};
    if (froms.length) {
      const [sdrRes, permitRes] = await Promise.all([
        pool.query(
          `SELECT lower(s.person_email) e, s.pipedrive_lead_id, s.lead_title
             FROM sdr_lead_state s WHERE lower(s.person_email) = ANY($1)`,
          [froms],
        ),
        pool.query(
          `SELECT lower(email) e, contact_name, operator_key FROM permit_operator_email WHERE lower(email) = ANY($1)`,
          [froms],
        ),
      ]);
      for (const r of sdrRes.rows) leadMap[r.e] = r;
      for (const r of permitRes.rows) permitMap[r.e] = r;
    }
    const repliedLeads = new Set();
    const repliedOps = new Set();
    const replyThreads = [];
    for (const t of all) {
      const e = parseEmailAddr(t.from);
      const sdr = e ? leadMap[e] : null;
      const permit = e ? permitMap[e] : null;
      if (sdr) {
        repliedLeads.add(sdr.pipedrive_lead_id);
        replyThreads.push({ ...t, openable: true, kind: "sdr", direction: "in", lead: { lead_id: sdr.pipedrive_lead_id, lead_title: sdr.lead_title } });
      } else if (permit) {
        repliedOps.add(permit.operator_key);
        replyThreads.push({ ...t, openable: true, kind: "permit", direction: "in", lead: null, permit: { operator_key: permit.operator_key, contact_name: permit.contact_name } });
      }
    }

    // 2) Recent SENDS from our own send records (reliable; no warmup noise). A lead/operator
    //    that already has a reply above is shown as that thread, not duplicated as a send row.
    const sendItems = [];
    const [sdrSends, permitSends] = await Promise.all([
      pool.query(
        `SELECT o.pipedrive_lead_id, o.sender_name, o.sender_email, o.subject, o.sent_at, s.lead_title, s.person_email
           FROM sdr_outreach_log o JOIN sdr_lead_state s ON s.pipedrive_lead_id = o.pipedrive_lead_id
          WHERE o.source = 'interface' ORDER BY o.sent_at DESC LIMIT 40`,
      ),
      pool.query(
        `SELECT ps.operator_key, ps.sent_at, po.operator_name, m.email AS mailbox_email,
                pe.email AS op_email, pe.contact_name
           FROM permit_sends ps
           LEFT JOIN permit_operators po ON po.operator_key = ps.operator_key
           LEFT JOIN sdr_mailboxes m ON m.id = ps.mailbox_id
           LEFT JOIN LATERAL (SELECT email, contact_name FROM permit_operator_email pe
                               WHERE pe.operator_key = ps.operator_key LIMIT 1) pe ON TRUE
          ORDER BY ps.sent_at DESC LIMIT 40`,
      ),
    ]);
    for (const r of sdrSends.rows) {
      if (repliedLeads.has(r.pipedrive_lead_id)) continue;
      sendItems.push({
        id: `sent:sdr:${r.pipedrive_lead_id}`, openable: false, mailbox: r.sender_email || "",
        kind: "sdr", direction: "out", subject: r.subject, from: r.sender_email, to: r.person_email,
        date: r.sent_at ? new Date(r.sent_at).toISOString() : null, snippet: "", messageCount: 1, unread: false,
        sender_name: r.sender_name, lead: { lead_id: r.pipedrive_lead_id, lead_title: r.lead_title },
      });
    }
    for (const r of permitSends.rows) {
      if (repliedOps.has(r.operator_key)) continue;
      sendItems.push({
        id: `sent:permit:${r.operator_key}`, openable: false, mailbox: r.mailbox_email || "",
        kind: "permit", direction: "out", subject: r.operator_name ? `MSGP outreach · ${r.operator_name}` : "MSGP outreach",
        from: r.mailbox_email, to: r.op_email, date: r.sent_at ? new Date(r.sent_at).toISOString() : null,
        snippet: "", messageCount: 1, unread: false, lead: null,
        permit: { operator_key: r.operator_key, contact_name: r.contact_name || r.operator_name },
      });
    }

    const threads = [...replyThreads, ...sendItems]
      .sort((a, b) => (Date.parse(b.date || "") || 0) - (Date.parse(a.date || "") || 0));
    res.json({ threads, mailboxes: boxes });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// SDR engagement — on-demand Apollo replies/bounces poll (admin only). Returns scan counts.
app.post("/api/sdr/engagement/poll", async (req, res) => {
  if (req.sdrUser?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const result = await pollEngagement(pool, {
      baseUrl: `http://127.0.0.1:${port}`,
      callbackSecret: N8N_CALLBACK_SECRET,
      force: true,
    });
    res.json(result);
  } catch (err) {
    console.error("POST /api/sdr/engagement/poll error:", err);
    res.status(500).json({ error: err.message || "Poll failed" });
  }
});

// SDR sequences — list all Apollo sequences with their editable step templates.
app.get("/api/sdr/sequences", async (req, res) => {
  if (!process.env.APOLLO_API_KEY) return res.status(503).json({ error: "Apollo not configured" });
  try {
    const list = await apolloClient.searchSequences({ perPage: 50 });
    const seqs = list.emailer_campaigns || [];
    const out = [];
    for (const s of seqs) {
      const detail = await apolloClient.getSequenceDetail(s.id);
      const steps = detail.emailer_steps || [];
      const touches = detail.emailer_touches || [];
      const tmpls = detail.emailer_templates || [];
      const stepRows = touches
        .map((t) => {
          const step = steps.find((x) => x.id === t.emailer_step_id) || {};
          const tpl = tmpls.find((x) => x.id === t.emailer_template_id) || {};
          return {
            position: step.position ?? null,
            step_type: step.type || null,
            template_id: tpl.id || null,
            subject: tpl.subject ?? "",
            body_html: tpl.body_html ?? "",
          };
        })
        .filter((r) => r.template_id)
        .sort((a, b) => (a.position || 0) - (b.position || 0));
      out.push({ id: s.id, name: s.name, active: s.active, num_steps: s.num_steps, steps: stepRows });
    }
    res.json({ sequences: out });
  } catch (err) {
    console.error("GET /api/sdr/sequences error:", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to load sequences" });
  }
});

// SDR sequences — update a step's email template (admin only, audited). HTML body.
app.put("/api/sdr/sequences/templates/:templateId", express.json({ limit: "1mb" }), async (req, res) => {
  if (req.sdrUser?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  if (!process.env.APOLLO_API_KEY) return res.status(503).json({ error: "Apollo not configured" });
  const { subject, body_html } = req.body || {};
  if (subject === undefined && body_html === undefined) {
    return res.status(400).json({ error: "Nothing to update — provide subject and/or body_html" });
  }
  try {
    const result = await apolloClient.updateEmailerTemplate(req.params.templateId, { subject, body_html });
    if (process.env.DATABASE_URL) {
      await pool.query(
        `INSERT INTO nurture_audit (sdr_user, action, target_kind, target_id, summary)
         VALUES ($1, 'sequence.template.update', 'apollo_template', $2, $3)`,
        [req.sdrUser?.username || req.sdrUser?.sub, req.params.templateId,
         `subject:${subject !== undefined} body:${body_html !== undefined} (${(body_html || "").length} chars)`],
      ).catch(() => {});
    }
    res.json({ ok: true, template: result.emailer_template || result });
  } catch (err) {
    console.error("PUT /api/sdr/sequences/templates error:", err);
    res.status(err.status || 500).json({ error: err.message || "Update failed" });
  }
});

// SDR mailboxes — sync from Apollo (admin only). Pulls live mailbox list and upserts.
app.post("/api/sdr/mailboxes/sync", async (req, res) => {
  if (req.sdrUser?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const accounts = await apolloClient.listEmailAccounts();
    const synced = [];
    for (const mb of accounts) {
      const dailyLimit = mb.email_daily_threshold ?? 20;
      const warmupCap = mb.mailwarming_vendor?.max_daily_emails ?? 0;
      const warmupStatus = mb.mailwarming_vendor?.inbox_status === "started" ? "warming" : "pending";
      const score = mb.deliverability_score?.deliverability_score ?? null;
      await pool.query(
        `INSERT INTO sdr_mailboxes (email, display_name, apollo_mailbox_id,
                                     daily_send_limit, warmup_status, warmup_current_cap,
                                     deliverability_score, last_health_check_at, active, signature_html)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)
         ON CONFLICT (email) DO UPDATE
           SET apollo_mailbox_id = EXCLUDED.apollo_mailbox_id,
               daily_send_limit = EXCLUDED.daily_send_limit,
               warmup_status = EXCLUDED.warmup_status,
               warmup_current_cap = EXCLUDED.warmup_current_cap,
               deliverability_score = EXCLUDED.deliverability_score,
               last_health_check_at = NOW(),
               active = EXCLUDED.active,
               signature_html = EXCLUDED.signature_html,
               updated_at = NOW()`,
        [mb.email, mb.email, mb.id, dailyLimit, warmupStatus, warmupCap, score, mb.active !== false, mb.signature_html ?? null],
      );
      synced.push({ email: mb.email, apollo_id: mb.id });
    }
    res.json({ synced_count: synced.length, synced });
  } catch (err) {
    console.error("POST /api/sdr/mailboxes/sync error:", err);
    res.status(500).json({ error: err.message || "Apollo sync failed" });
  }
});

// SDR — self-hosted open/click tracking (PUBLIC, hit by the email recipient).
// Keyed by draft id. We resolve the draft → contact email + sequence, then feed an
// event into /api/sdr/events/ingest (reusing its dedup + side effects). Per-lead
// opens/clicks without Apollo's Professional webhook.
async function logTrackEvent(token, kind, url) {
  if (!process.env.DATABASE_URL) return;
  try {
    // Token is either a draft id (body-injected, legacy) or `c-<apolloContactId>`
    // (template pixel — Apollo escapes body HTML so the pixel lives in the template
    // keyed by {{contact.id}}). Resolve both to the draft for email + sequence.
    let d;
    if (typeof token === "string" && token.startsWith("c-")) {
      const { rows } = await pool.query(
        `SELECT d.contact_email_snapshot, d.apollo_sequence_id, d.pipedrive_lead_id
         FROM sdr_sends s JOIN sdr_drafts d ON d.id = s.draft_id
         WHERE s.apollo_contact_id = $1 ORDER BY s.sent_at DESC LIMIT 1`,
        [token.slice(2)],
      );
      d = rows[0];
    } else {
      const { rows } = await pool.query(
        `SELECT contact_email_snapshot, apollo_sequence_id, pipedrive_lead_id FROM sdr_drafts WHERE id = $1`,
        [token],
      );
      d = rows[0];
    }
    if (!d) return;
    const ev = {
      type: kind === "open" ? "email_opened" : "email_clicked",
      sequence_id: d.apollo_sequence_id,
      email: d.contact_email_snapshot,
      created_at: new Date().toISOString(),
      id: trackEventId(kind, token, url),
      source: "self_tracking",
      clicked_url: url || undefined,
    };
    await fetch(`http://127.0.0.1:${port}/api/sdr/events/ingest?callback_secret=${encodeURIComponent(N8N_CALLBACK_SECRET)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ev),
    });
  } catch (e) {
    console.error("logTrackEvent failed:", e.message);
  }
}

app.get("/api/sdr/track/open/:token", (req, res) => {
  // Respond with the pixel immediately; log async so the image never blocks.
  res.set("Content-Type", "image/gif")
    .set("Cache-Control", "no-store, no-cache, must-revalidate, private")
    .set("Pragma", "no-cache")
    .send(TRANSPARENT_GIF);
  logTrackEvent(String(req.params.token).replace(/\.gif$/i, ""), "open").catch(() => {});
});

app.get("/api/sdr/track/click/:token", (req, res) => {
  const dest = req.query.u;
  if (!dest || !/^https?:\/\//i.test(String(dest))) return res.status(400).send("Invalid redirect target");
  res.redirect(302, String(dest));
  logTrackEvent(String(req.params.token), "click", String(dest)).catch(() => {});
});

// SDR — Apollo webhook ingest. n8n forwards Apollo events here with
// ?callback_secret=...  We insert into sdr_engagement_events (idempotent on
// apollo_event_id) and run side effects per event_type.
//
// Apollo event payload shape (verified from Apollo docs):
//   { id, type, sequence_id, contact_id, email_account_id, email,
//     emailer_message_id, created_at, ... }
//
// Event types we act on:
//   email_sent / email_opened / email_clicked → just log
//   email_replied → clear Sequence_Started on Pipedrive lead + mark sdr_sends=replied
//                   + remove contact from Apollo sequence
//   email_bounced → mark sdr_sends=bounced + flag mailbox in metadata
//   email_unsubscribed → mark sdr_sends=unsubscribed + flag do_not_mail in metadata
app.post("/api/sdr/events/ingest", express.json({ limit: "1mb" }), async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  const ev = req.body || {};
  const eventType = ev.type || ev.event_type || ev.event;
  if (!eventType) return res.status(400).json({ error: "Missing event type" });

  const sequenceId = ev.sequence_id || ev.emailer_campaign_id || null;
  const emailerMessageId = ev.emailer_message_id || ev.message_id || null;
  const contactEmail = ev.email || ev.contact?.email || null;
  const mailboxEmail = ev.email_account?.email || ev.from_email || null;
  const occurredAt = ev.created_at || ev.timestamp || new Date().toISOString();
  // Apollo doesn't always send an event id — synthesize a stable dedupe key so
  // webhook retries don't double-insert (NULLs never conflict in a UNIQUE index).
  const apolloEventId =
    ev.id || ev.event_id ||
    `synthetic:${crypto.createHash("sha1").update([eventType, emailerMessageId, contactEmail, sequenceId, occurredAt].join("|")).digest("hex")}`;

  try {
    // 1. Find the originating sdr_sends row for Pipedrive lead context.
    //    Match priority: emailer_message_id → sequence+email → email-only (latest sent).
    let leadId = null;
    let sendRow = null;
    const pickSend = async (sql, params) => {
      const { rows } = await pool.query(sql, params);
      return rows[0] || null;
    };
    const SEND_COLS = `s.id, s.pipedrive_lead_id, s.draft_id, s.apollo_sequence_id, s.apollo_contact_id, d.pipedrive_contact_id, d.contact_email_snapshot`;
    if (emailerMessageId) {
      sendRow = await pickSend(
        `SELECT ${SEND_COLS} FROM sdr_sends s JOIN sdr_drafts d ON d.id = s.draft_id
         WHERE s.apollo_emailer_message_id = $1 ORDER BY s.sent_at DESC LIMIT 1`,
        [emailerMessageId],
      );
    }
    if (!sendRow && sequenceId && contactEmail) {
      sendRow = await pickSend(
        `SELECT ${SEND_COLS} FROM sdr_sends s JOIN sdr_drafts d ON d.id = s.draft_id
         WHERE s.apollo_sequence_id = $1 AND d.contact_email_snapshot = $2
         ORDER BY s.sent_at DESC LIMIT 1`,
        [sequenceId, contactEmail],
      );
    }
    if (!sendRow && contactEmail) {
      sendRow = await pickSend(
        `SELECT ${SEND_COLS} FROM sdr_sends s JOIN sdr_drafts d ON d.id = s.draft_id
         WHERE d.contact_email_snapshot = $1 ORDER BY s.sent_at DESC LIMIT 1`,
        [contactEmail],
      );
    }
    if (sendRow) leadId = sendRow.pipedrive_lead_id;

    // 2. Insert engagement event (idempotent by apollo_event_id incl. synthetic key)
    const insertResult = await pool.query(
      `INSERT INTO sdr_engagement_events (
         source, event_type, apollo_event_id, apollo_sequence_id,
         apollo_emailer_message_id, pipedrive_lead_id, pipedrive_contact_id, mailbox_email,
         occurred_at, payload, process_status, processed_at
       ) VALUES ('apollo', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NULL)
       ON CONFLICT (apollo_event_id) DO NOTHING
       RETURNING id`,
      [
        eventType,
        apolloEventId,
        sequenceId || sendRow?.apollo_sequence_id || null,
        emailerMessageId,
        leadId,
        sendRow?.pipedrive_contact_id || null,
        mailboxEmail,
        occurredAt,
        ev,
      ],
    );
    const newlyInserted = insertResult.rows.length > 0;

    // 3. Side effects based on event type
    let sideEffect = "none";

    if (eventType === "email_sent" || eventType === "email_opened" || eventType === "email_clicked" || eventType === "link_clicked") {
      sideEffect = "logged-only";
      // Backfill the Apollo message id onto the send row on first 'sent' event so
      // later open/click/reply events can match by message id directly.
      if (eventType === "email_sent" && sendRow && emailerMessageId) {
        await pool.query(
          `UPDATE sdr_sends SET apollo_emailer_message_id = COALESCE(apollo_emailer_message_id, $2),
                                status = CASE WHEN status = 'enrolled' THEN 'sent' ELSE status END,
                                last_status_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [sendRow.id, emailerMessageId],
        );
      }
      // First click on a lead = high engagement → one Pipedrive note, ever.
      // Gated on newlyInserted so webhook retries can't double-note.
      if (
        (eventType === "email_clicked" || eventType === "link_clicked") &&
        newlyInserted && leadId && process.env.PIPEDRIVE_API_TOKEN
      ) {
        const { rows: clickRows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM sdr_engagement_events
           WHERE pipedrive_lead_id = $1 AND event_type IN ('email_clicked','link_clicked')`,
          [leadId],
        );
        if (clickRows[0]?.n === 1) {
          sideEffect = "first-click-note";
          try {
            await pipedriveClient.addNote({
              leadId,
              content: `[Auto] Apollo: first link CLICK${contactEmail ? ` from ${contactEmail}` : ""} — high engagement, consider a call.`,
            });
          } catch (e) {
            console.error("Pipedrive note on first click failed:", e.message);
          }
        }
      }
    } else if (eventType === "email_replied" || eventType === "reply_received") {
      sideEffect = "reply";
      if (sendRow) {
        await pool.query(
          `UPDATE sdr_sends SET status = 'replied', last_status_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [sendRow.id],
        );
      }
      // Clear Pipedrive Sequence_Started so the lead is no longer "in" a sequence
      if (leadId && process.env.PIPEDRIVE_API_TOKEN) {
        try {
          await pipedriveClient.updateLead(leadId, {
            [pdSequenceStartedKey]: "",
          });
          await pipedriveClient.addNote({
            leadId,
            content: `[Auto] Apollo: REPLY received${contactEmail ? ` from ${contactEmail}` : ""}. Sequence_Started cleared.`,
          });
        } catch (e) {
          console.error("Pipedrive sync on reply failed:", e.message);
        }
      }
      // Remove from Apollo sequence to stop further follow-ups
      // (Apollo usually auto-pauses on reply, but we belt-and-suspender)
      const replySeqId = sendRow?.apollo_sequence_id || sequenceId;
      if (sendRow?.apollo_contact_id && replySeqId && process.env.APOLLO_API_KEY) {
        try {
          await apolloClient.removeContactsFromSequence(replySeqId, [sendRow.apollo_contact_id], "remove");
        } catch (e) {
          console.error("Apollo remove-from-sequence on reply failed:", e.message);
        }
      }
    } else if (eventType === "email_bounced" || eventType === "bounce") {
      sideEffect = "bounce";
      if (sendRow) {
        await pool.query(
          `UPDATE sdr_sends SET status = 'bounced', last_status_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [sendRow.id],
        );
      }
      if (leadId && process.env.PIPEDRIVE_API_TOKEN) {
        try {
          await pipedriveClient.addNote({
            leadId,
            content: `[Auto] Apollo: bounce${contactEmail ? ` on ${contactEmail}` : ""}.`,
          });
        } catch (e) {
          console.error("Pipedrive note on bounce failed:", e.message);
        }
      }
    } else if (eventType === "lead_unsubscribed" || eventType === "unsubscribed" || eventType === "email_unsubscribed") {
      sideEffect = "unsubscribe";
      if (sendRow) {
        await pool.query(
          `UPDATE sdr_sends SET status = 'unsubscribed', last_status_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [sendRow.id],
        );
      }
      if (leadId && process.env.PIPEDRIVE_API_TOKEN) {
        try {
          await pipedriveClient.updateLead(leadId, {
            [pdSequenceStartedKey]: "",
          });
          await pipedriveClient.addNote({
            leadId,
            content: `[Auto] Apollo: unsubscribed${contactEmail ? ` (${contactEmail})` : ""}. Sequence_Started cleared.`,
          });
        } catch (e) {
          console.error("Pipedrive sync on unsubscribe failed:", e.message);
        }
      }
      // Hard-stop any remaining Apollo follow-ups for an unsubscribed contact
      const unsubSeqId = sendRow?.apollo_sequence_id || sequenceId;
      if (sendRow?.apollo_contact_id && unsubSeqId && process.env.APOLLO_API_KEY) {
        try {
          await apolloClient.removeContactsFromSequence(unsubSeqId, [sendRow.apollo_contact_id], "remove");
        } catch (e) {
          console.error("Apollo remove-from-sequence on unsubscribe failed:", e.message);
        }
      }
    }

    // 4. Mark event processed
    if (apolloEventId) {
      await pool.query(
        `UPDATE sdr_engagement_events
         SET process_status = 'processed', processed_at = NOW()
         WHERE apollo_event_id = $1`,
        [apolloEventId],
      );
    }

    return res.json({ ok: true, side_effect: sideEffect, lead_id: leadId, send_updated: !!sendRow });
  } catch (err) {
    console.error("/api/sdr/events/ingest error:", err);
    if (apolloEventId) {
      await pool.query(
        `UPDATE sdr_engagement_events
         SET process_status = 'error', process_error = $2, processed_at = NOW()
         WHERE apollo_event_id = $1`,
        [apolloEventId, String(err.message).slice(0, 500)],
      ).catch(() => {});
    }
    return res.status(500).json({ error: err.message || "Event ingest failed" });
  }
});

// Pipedrive field key for Sequence_Started (used by /events/ingest)
const pdSequenceStartedKey = "48c4bb758e8642d6372c7fff9df3c0ea716170f1";

// Apollo contact custom fields carrying the approved draft into the sequence
// step-1 template (created via API 2026-06-11; override via env if recreated)
const APOLLO_CF_DRAFT_SUBJECT = process.env.APOLLO_CF_DRAFT_SUBJECT || "6a2adb32a2b9130020474786";
const APOLLO_CF_DRAFT_BODY = process.env.APOLLO_CF_DRAFT_BODY || "6a2adb32bfaa320020f80f97";
// swppp_track carries the draft id into the open-pixel ({{contact.swppp_track}} in the
// template) — Apollo escapes body HTML so the pixel must live in the template.
// NOTE: the original field (6a32559593e27d000c4ee92f) was created malformed (type:null),
// so Apollo silently dropped every write to it and all sends failed `snippets_missing`.
// Recreated 2026-06-23 as a proper textarea field; this is the working id.
const APOLLO_CF_TRACK = process.env.APOLLO_CF_TRACK || "6a3b065762456a00208db22b";

// SDR drafts — list (owner-scoped; admin sees all)
app.get("/api/sdr/drafts", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const scope = ownerScope(req.sdrUser, "assigned_user_id");
    const status = req.query.status; // optional filter
    const params = [];
    // Enrich each draft with its lead's outreach state (for the dedup badge).
    let sql = `
      SELECT d.*,
             ls.outreach_status,
             ls.last_outgoing_mail_time,
             ls.person_name AS lead_person_name,
             CASE WHEN ls.last_outgoing_mail_time IS NULL THEN NULL
                  ELSE EXTRACT(DAY FROM (NOW() - ls.last_outgoing_mail_time))::int END AS days_since_outgoing
      FROM sdr_drafts d
      LEFT JOIN sdr_lead_state ls ON ls.pipedrive_lead_id = d.pipedrive_lead_id`;
    const where = [];
    if (status) {
      params.push(status);
      where.push(`d.status = $${params.length}`);
    }
    if (scope.requires) {
      params.push(scope.value);
      where.push(`d.${scope.column} = $${params.length}`);
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY d.created_at DESC LIMIT 200`;
    const { rows } = await pool.query(sql, params);
    res.json({ drafts: rows });
  } catch (err) {
    console.error("GET /api/sdr/drafts error:", err);
    res.status(500).json({ error: "Failed to list drafts" });
  }
});

// SDR drafts — single fetch
app.get("/api/sdr/drafts/:id", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const scope = ownerScope(req.sdrUser, "assigned_user_id");
    const params = [req.params.id];
    let sql = `SELECT * FROM sdr_drafts WHERE id = $1`;
    if (scope.requires) {
      params.push(scope.value);
      sql += ` AND ${scope.column} = $${params.length}`;
    }
    const { rows } = await pool.query(sql, params);
    if (!rows[0]) return res.status(404).json({ error: "Draft not found" });
    res.json({ draft: rows[0] });
  } catch (err) {
    console.error("GET /api/sdr/drafts/:id error:", err);
    res.status(500).json({ error: "Failed to fetch draft" });
  }
});

// SDR templates — return the 4 trigger templates rendered with placeholder context
// (used by the UI to preview what an Apollo sequence should look like)
app.get("/api/sdr/templates", (req, res) => {
  const out = {};
  for (const t of Object.keys(SDR_TEMPLATES)) {
    out[t] = {
      steps: renderAllSteps(t, { first: "{First}", env: "EPA", swppp: "SWPPP", sig: "{Sig}" }),
      default_subject: defaultSubject("{Lead Title}", "SWPPP"),
    };
  }
  res.json({ templates: out });
});

// SDR engagement — per-lead engagement scores + per-trigger/per-sender rates.
// Score = replies×10 + clicks×5 + opens×1, recency-decayed (half-life 7 days),
// so a click yesterday outranks five opens last month. Owner-scoped like drafts.
app.get("/api/sdr/engagement/summary", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  try {
    const scope = ownerScope(req.sdrUser, "d.assigned_user_id");
    const params = [];
    let ownerWhere = "";
    if (scope.requires) {
      params.push(scope.value);
      ownerWhere = ` AND d.assigned_user_id = $${params.length}`;
    }

    const leads = await pool.query(
      `SELECT
         d.id AS draft_id,
         d.pipedrive_lead_id,
         d.trigger_type,
         d.assigned_user_id,
         d.contact_email_snapshot,
         d.metadata->>'pipedrive_lead_title' AS lead_title,
         d.sent_at,
         s.status AS send_status,
         COUNT(e.id) FILTER (WHERE e.event_type = 'email_opened')::int AS opens,
         COUNT(e.id) FILTER (WHERE e.event_type IN ('email_clicked','link_clicked'))::int AS clicks,
         COUNT(e.id) FILTER (WHERE e.event_type IN ('email_replied','reply_received'))::int AS replies,
         MAX(e.occurred_at) AS last_event_at,
         ROUND(COALESCE(SUM(
           (CASE WHEN e.event_type IN ('email_replied','reply_received') THEN 10
                 WHEN e.event_type IN ('email_clicked','link_clicked') THEN 5
                 WHEN e.event_type = 'email_opened' THEN 1
                 ELSE 0 END)
           * EXP(-LN(2) * GREATEST(EXTRACT(EPOCH FROM (NOW() - e.occurred_at)), 0) / (7 * 86400))
         ), 0)::numeric, 2)::float AS score
       FROM sdr_drafts d
       LEFT JOIN LATERAL (
         SELECT status FROM sdr_sends WHERE draft_id = d.id ORDER BY sent_at DESC LIMIT 1
       ) s ON TRUE
       LEFT JOIN sdr_engagement_events e ON e.pipedrive_lead_id = d.pipedrive_lead_id
       WHERE d.status = 'sent'${ownerWhere}
       GROUP BY d.id, s.status
       ORDER BY score DESC, last_event_at DESC NULLS LAST, d.sent_at DESC
       LIMIT 200`,
      params,
    );

    const byTrigger = await pool.query(
      `SELECT
         d.trigger_type,
         COUNT(DISTINCT d.id)::int AS sent,
         COUNT(DISTINCT d.id) FILTER (WHERE e.event_type = 'email_opened')::int AS opened,
         COUNT(DISTINCT d.id) FILTER (WHERE e.event_type IN ('email_clicked','link_clicked'))::int AS clicked,
         COUNT(DISTINCT d.id) FILTER (WHERE e.event_type IN ('email_replied','reply_received'))::int AS replied
       FROM sdr_drafts d
       LEFT JOIN sdr_engagement_events e ON e.pipedrive_lead_id = d.pipedrive_lead_id
       WHERE d.status = 'sent'${ownerWhere}
       GROUP BY d.trigger_type
       ORDER BY d.trigger_type`,
      params,
    );

    const bySender = await pool.query(
      `SELECT
         u.username,
         u.display_name,
         COUNT(DISTINCT d.id)::int AS sent,
         COUNT(DISTINCT d.id) FILTER (WHERE e.event_type = 'email_opened')::int AS opened,
         COUNT(DISTINCT d.id) FILTER (WHERE e.event_type IN ('email_clicked','link_clicked'))::int AS clicked,
         COUNT(DISTINCT d.id) FILTER (WHERE e.event_type IN ('email_replied','reply_received'))::int AS replied
       FROM sdr_drafts d
       JOIN sdr_users u ON u.id = d.assigned_user_id
       LEFT JOIN sdr_engagement_events e ON e.pipedrive_lead_id = d.pipedrive_lead_id
       WHERE d.status = 'sent'${ownerWhere}
       GROUP BY u.username, u.display_name
       ORDER BY u.username`,
      params,
    );

    res.json({ leads: leads.rows, by_trigger: byTrigger.rows, by_sender: bySender.rows });
  } catch (err) {
    console.error("GET /api/sdr/engagement/summary error:", err);
    res.status(500).json({ error: "Failed to build engagement summary" });
  }
});

// SDR drafts — generate from a Pipedrive lead (n8n calls this on lead update).
// Body: { pipedrive_lead_id, trigger_type, apollo_sequence_id?, assigned_user_id? }
app.post("/api/sdr/drafts/generate", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  if (!process.env.PIPEDRIVE_API_TOKEN) return res.status(503).json({ error: "Pipedrive not configured" });
  const { pipedrive_lead_id, trigger_type, apollo_sequence_id, assigned_user_id } = req.body || {};
  if (!pipedrive_lead_id) {
    return res.status(400).json({ error: "pipedrive_lead_id required (trigger_type optional — inferred from Pipedrive Trigger_* fields)" });
  }
  // Permission check only applies to JWT-auth'd users; callback_secret callers (n8n) bypass.
  if (req.sdrUser && assigned_user_id && req.sdrUser.role !== "admin" && assigned_user_id !== req.sdrUser.sub) {
    return res.status(403).json({ error: "Cannot assign draft to another user" });
  }
  try {
    const payload = await buildDraftFromLead({
      pipedriveLeadId: pipedrive_lead_id,
      triggerType: trigger_type,
      pool,
      assignedUserId: assigned_user_id || null,
      apolloSequenceId: apollo_sequence_id || null,
    });

    // Live freshness re-check at the moment of outreach. buildDraftFromLead just
    // fetched the person, so `person_last_outgoing` is live (no extra API call).
    // Mark the mirror with the fresh signal so a stale bulk-sync can't let an
    // already-contacted lead slip through, and block recently-contacted ones.
    if (payload.person_last_outgoing) {
      const lastOut = payload.person_last_outgoing;
      const ms = new Date(lastOut.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(lastOut) ? "" : "Z")).getTime();
      const daysAgo = Number.isNaN(ms) ? null : Math.floor((Date.now() - ms) / 86400000);
      const freshStatus = daysAgo === null ? "clear" : daysAgo <= 60 ? "contacted_recent" : "contacted_stale";
      if (process.env.DATABASE_URL) {
        await pool.query(
          `UPDATE sdr_lead_state
             SET last_outgoing_mail_time = $1,
                 outreach_status = CASE WHEN sequence_started IS NOT NULL THEN 'sequenced' ELSE $2 END,
                 synced_at = NOW()
           WHERE pipedrive_lead_id = $3`,
          [lastOut, freshStatus, payload.pipedrive_lead_id],
        );
      }
      // Recently emailed → block unless an admin explicitly overrides.
      if (freshStatus === "contacted_recent") {
        if (req.body?.override === true) {
          if (req.sdrUser && req.sdrUser.role !== "admin") {
            return res.status(403).json({ error: "Admin override required to outreach an already-contacted lead" });
          }
          console.log(`[dedup] generate override by ${req.sdrUser?.username || "n8n"}: ${payload.pipedrive_lead_id} emailed ${daysAgo}d ago`);
        } else {
          return res.status(409).json({
            code: "already_outreached",
            lastOutgoing: lastOut,
            daysAgo,
            personName: payload.person_name,
            message: `${payload.person_name || "This lead"} was already emailed ${daysAgo}d ago in Pipedrive (live check). Confirm to outreach anyway.`,
          });
        }
      }
    }

    // Idempotency — same lead + trigger with an open draft
    const dup = await pool.query(
      `SELECT id, status FROM sdr_drafts
       WHERE pipedrive_lead_id = $1 AND trigger_type = $2
         AND status IN ('pending','approved','edited','sent') LIMIT 1`,
      [payload.pipedrive_lead_id, payload.trigger_type],
    );
    if (dup.rows[0]) {
      return res.status(409).json({
        error: "Open draft already exists for this lead + trigger",
        existing: dup.rows[0],
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO sdr_drafts (
         pipedrive_lead_id, pipedrive_contact_id, pipedrive_org_id,
         contact_id_snapshot, contact_email_snapshot, org_id_snapshot,
         trigger_type, apollo_sequence_id,
         subject, body, assigned_mailbox_id, assigned_user_id, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        payload.pipedrive_lead_id, payload.pipedrive_contact_id, payload.pipedrive_org_id,
        payload.contact_id_snapshot, payload.contact_email_snapshot, payload.org_id_snapshot,
        payload.trigger_type, payload.apollo_sequence_id,
        payload.subject, payload.body, payload.assigned_mailbox_id, payload.assigned_user_id,
        payload.metadata,
      ],
    );
    res.status(201).json({ draft: rows[0] });
  } catch (err) {
    // Lost the race to a concurrent generate (uq_sdr_drafts_open) — surface as a clean
    // conflict instead of a 500, same shape as the read-then-insert dedup above.
    if (err.code === "23505") {
      return res.status(409).json({ error: "Open draft already exists for this lead + trigger" });
    }
    console.error("POST /api/sdr/drafts/generate error:", err);
    res.status(err.status || 500).json({ error: err.message || "Draft generation failed" });
  }
});

// SDR drafts — create (typically called by n8n or internal job; sdrUser must be admin OR the assigned_user_id matches)
app.post("/api/sdr/drafts", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  const {
    pipedrive_lead_id,
    pipedrive_contact_id,
    pipedrive_org_id,
    contact_id_snapshot,
    contact_email_snapshot,
    org_id_snapshot,
    trigger_type,
    apollo_sequence_id,
    apollo_template_id,
    subject,
    body,
    assigned_mailbox_id,
    assigned_user_id,
    scheduled_for,
    metadata,
  } = req.body || {};

  if (!pipedrive_lead_id || !contact_id_snapshot || !contact_email_snapshot || !trigger_type || !subject || !body) {
    return res.status(400).json({ error: "Missing required fields: pipedrive_lead_id, contact_id_snapshot, contact_email_snapshot, trigger_type, subject, body" });
  }
  if (!["AGC", "LBA", "CM", "PB"].includes(trigger_type)) {
    return res.status(400).json({ error: "trigger_type must be one of AGC, LBA, CM, PB" });
  }
  if (req.sdrUser.role !== "admin" && assigned_user_id && assigned_user_id !== req.sdrUser.sub) {
    return res.status(403).json({ error: "Cannot assign draft to another user" });
  }

  try {
    const dup = await pool.query(
      `SELECT id FROM sdr_drafts
       WHERE pipedrive_lead_id = $1 AND trigger_type = $2
         AND status IN ('pending','approved','edited','sent') LIMIT 1`,
      [pipedrive_lead_id, trigger_type],
    );
    if (dup.rows[0]) {
      return res.status(409).json({ error: "Open draft already exists for this lead + trigger", existing_id: dup.rows[0].id });
    }
    const { rows } = await pool.query(
      `INSERT INTO sdr_drafts (
         pipedrive_lead_id, pipedrive_contact_id, pipedrive_org_id,
         contact_id_snapshot, contact_email_snapshot, org_id_snapshot,
         trigger_type, apollo_sequence_id, apollo_template_id,
         subject, body, assigned_mailbox_id, assigned_user_id,
         scheduled_for, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        pipedrive_lead_id, pipedrive_contact_id || null, pipedrive_org_id || null,
        contact_id_snapshot, contact_email_snapshot, org_id_snapshot || null,
        trigger_type, apollo_sequence_id || null, apollo_template_id || null,
        subject, body, assigned_mailbox_id || null, assigned_user_id || null,
        scheduled_for || null, metadata || {},
      ],
    );
    res.status(201).json({ draft: rows[0] });
  } catch (err) {
    console.error("POST /api/sdr/drafts error:", err);
    res.status(500).json({ error: "Failed to create draft" });
  }
});

// SDR drafts — edit subject/body while pending or approved (not after sent)
app.patch("/api/sdr/drafts/:id", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  const { subject, body, scheduled_for, assigned_mailbox_id, apollo_sequence_id } = req.body || {};
  if (!subject && !body && !scheduled_for && !assigned_mailbox_id && !apollo_sequence_id) {
    return res.status(400).json({ error: "Provide at least one field to update" });
  }
  // Sequence reassignment changes WHERE the contact gets enrolled — admin only.
  if (apollo_sequence_id && req.sdrUser?.role !== "admin") {
    return res.status(403).json({ error: "Only admin can change apollo_sequence_id" });
  }
  try {
    const scope = ownerScope(req.sdrUser, "assigned_user_id");
    const params = [req.params.id];
    let where = `id = $1 AND status IN ('pending','approved','edited')`;
    if (scope.requires) {
      params.push(scope.value);
      where += ` AND ${scope.column} = $${params.length}`;
    }
    const sets = [];
    if (subject) { params.push(subject); sets.push(`subject = $${params.length}`); }
    if (body) { params.push(body); sets.push(`body = $${params.length}`); }
    if (scheduled_for) { params.push(scheduled_for); sets.push(`scheduled_for = $${params.length}`); }
    if (assigned_mailbox_id) { params.push(assigned_mailbox_id); sets.push(`assigned_mailbox_id = $${params.length}`); }
    if (apollo_sequence_id) { params.push(apollo_sequence_id); sets.push(`apollo_sequence_id = $${params.length}`); }
    sets.push(`status = 'edited'`);
    sets.push(`updated_at = NOW()`);
    const { rows } = await pool.query(
      `UPDATE sdr_drafts SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
      params,
    );
    if (!rows[0]) return res.status(404).json({ error: "Draft not found or not editable" });
    res.json({ draft: rows[0] });
  } catch (err) {
    console.error("PATCH /api/sdr/drafts/:id error:", err);
    res.status(500).json({ error: "Failed to update draft" });
  }
});

// SDR drafts — reject
app.post("/api/sdr/drafts/:id/reject", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  const reason = req.body?.reason || "(no reason given)";
  try {
    const scope = ownerScope(req.sdrUser, "assigned_user_id");
    const params = [req.params.id, reason];
    let where = `id = $1 AND status IN ('pending','approved','edited')`;
    if (scope.requires) {
      params.push(scope.value);
      where += ` AND ${scope.column} = $${params.length}`;
    }
    const { rows } = await pool.query(
      `UPDATE sdr_drafts SET status = 'rejected', reject_reason = $2, updated_at = NOW()
       WHERE ${where} RETURNING *`,
      params,
    );
    if (!rows[0]) return res.status(404).json({ error: "Draft not found or not rejectable" });
    // Leave a Pipedrive trail so Derek can see why a lead was skipped (non-fatal)
    if (process.env.PIPEDRIVE_API_TOKEN && rows[0].pipedrive_lead_id) {
      try {
        await pipedriveClient.addNote({
          leadId: rows[0].pipedrive_lead_id,
          content: `[Auto] Apollo draft rejected by ${req.sdrUser?.username || "system"}: ${reason}`,
        });
      } catch (e) {
        console.error("Pipedrive note on reject failed:", e.message);
      }
    }
    res.json({ draft: rows[0] });
  } catch (err) {
    console.error("POST /api/sdr/drafts/:id/reject error:", err);
    res.status(500).json({ error: "Failed to reject draft" });
  }
});

// SDR drafts — refresh from Pipedrive. Re-runs the draft generator against the
// live lead and overwrites the draft's content + snapshots. User-triggered, so
// clobbering manual edits is intentional (the button warns about it).
app.post("/api/sdr/drafts/:id/refresh", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  if (!process.env.PIPEDRIVE_API_TOKEN) return res.status(503).json({ error: "Pipedrive not configured" });
  try {
    const scope = ownerScope(req.sdrUser, "assigned_user_id");
    const params = [req.params.id];
    let sql = `SELECT * FROM sdr_drafts WHERE id = $1 AND status IN ('pending','approved','edited')`;
    if (scope.requires) {
      params.push(scope.value);
      sql += ` AND ${scope.column} = $${params.length}`;
    }
    const { rows } = await pool.query(sql, params);
    const draft = rows[0];
    if (!draft) return res.status(404).json({ error: "Draft not found or not refreshable" });

    const payload = await buildDraftFromLead({
      pipedriveLeadId: draft.pipedrive_lead_id,
      triggerType: draft.trigger_type,
      pool,
      assignedUserId: draft.assigned_user_id,
      apolloSequenceId: draft.apollo_sequence_id,
    });

    const { rows: updRows } = await pool.query(
      `UPDATE sdr_drafts SET
         subject = $2, body = $3,
         contact_id_snapshot = $4, contact_email_snapshot = $5, org_id_snapshot = $6,
         pipedrive_contact_id = $7, pipedrive_org_id = $8,
         apollo_sequence_id = COALESCE(apollo_sequence_id, $9),
         metadata = $10, status = 'pending', updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        draft.id, payload.subject, payload.body,
        payload.contact_id_snapshot, payload.contact_email_snapshot, payload.org_id_snapshot,
        payload.pipedrive_contact_id, payload.pipedrive_org_id,
        payload.apollo_sequence_id,
        payload.metadata,
      ],
    );
    res.json({ draft: updRows[0] });
  } catch (err) {
    console.error("POST /api/sdr/drafts/:id/refresh error:", err);
    res.status(err.status || 500).json({ error: err.message || "Refresh failed" });
  }
});

// SDR drafts — approve + atomically enroll in Apollo + record sdr_sends.
// Wrapped in per-lead advisory lock to prevent parallel enrollment races.
app.post("/api/sdr/drafts/:id/approve-and-send", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });
  if (!process.env.APOLLO_API_KEY) return res.status(503).json({ error: "Apollo not configured" });

  try {
    // Pre-fetch the draft (outside tx) to get the lead_id for the advisory lock
    const scope = ownerScope(req.sdrUser, "assigned_user_id");
    const preParams = [req.params.id];
    let preSql = `SELECT * FROM sdr_drafts WHERE id = $1`;
    if (scope.requires) {
      preParams.push(scope.value);
      preSql += ` AND ${scope.column} = $${preParams.length}`;
    }
    const pre = await pool.query(preSql, preParams);
    const draft = pre.rows[0];
    if (!draft) return res.status(404).json({ error: "Draft not found" });
    if (!["pending", "approved", "edited"].includes(draft.status)) {
      return res.status(409).json({ error: `Draft is ${draft.status}, cannot send` });
    }
    if (!draft.apollo_sequence_id) {
      return res.status(400).json({ error: "Draft has no apollo_sequence_id set — specify which Apollo sequence to enroll into" });
    }
    if (!draft.assigned_mailbox_id) {
      return res.status(400).json({ error: "Draft has no assigned_mailbox_id" });
    }

    // Dedup guard: never silently re-email an already-contacted lead. Live re-check
    // against Pipedrive (`last_outgoing_mail_time` on the linked person) — the mirror
    // can be up to ~6h stale, so we check live at the moment of send. An admin can
    // override; non-admins are blocked. If the Pipedrive check itself fails, we allow
    // the send rather than hard-block on an outage (and log it).
    let overrideContext = null;
    {
      const personId = draft.contact_id_snapshot || draft.pipedrive_contact_id;
      if (personId && process.env.PIPEDRIVE_API_TOKEN) {
        let lastOut = null;
        let personName = null;
        try {
          const person = await pipedriveClient.getPerson(personId);
          lastOut = person?.last_outgoing_mail_time || null;
          personName = person?.name || null;
        } catch (e) {
          console.warn("approve-and-send dedup precheck failed (allowing send):", e.message);
        }
        if (lastOut) {
          // Offset-aware parse (matches the generate gate + daysSince) — appending a bare
          // "Z" to a timestamp that already carries Z/offset yields Invalid Date → NaN.
          const ms = new Date(lastOut.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(lastOut) ? "" : "Z")).getTime();
          const daysAgo = Number.isNaN(ms) ? null : Math.floor((Date.now() - ms) / 86400000);
          // Only block RECENT contact (<= 60d) — same window the generate gate uses, so a
          // draft you were allowed to create can't be silently un-sendable when older.
          const blockRecent = daysAgo !== null && daysAgo <= 60;
          if (blockRecent) {
            if (req.body?.override === true) {
              if (req.sdrUser?.role !== "admin") {
                return res.status(403).json({ error: "Admin override required to send to an already-contacted lead" });
              }
              overrideContext = `admin override by ${req.sdrUser?.username || req.sdrUser?.sub}: last emailed ${daysAgo}d ago (${lastOut})`;
              console.log(`[dedup] ${overrideContext} — lead ${draft.pipedrive_lead_id}`);
            } else {
              return res.status(409).json({
                code: "already_outreached",
                lastOutgoing: lastOut,
                daysAgo,
                personName,
                message: `${personName || "This lead"} was already emailed ${daysAgo}d ago via Pipedrive. Admin override required to send.`,
              });
            }
          }
        }
      }
    }

    // Resolve mailbox → apollo_mailbox_id
    const { rows: mbRows } = await pool.query(
      `SELECT id, email, apollo_mailbox_id, warmup_started_at FROM sdr_mailboxes WHERE id = $1`,
      [draft.assigned_mailbox_id],
    );
    const mailbox = mbRows[0];
    if (!mailbox?.apollo_mailbox_id) {
      return res.status(500).json({ error: "Assigned mailbox has no apollo_mailbox_id — run /api/sdr/mailboxes/sync" });
    }

    // Warmup ramp: enforce the per-mailbox daily send cap (gradual climb to 40).
    // The clock starts on first send (warmup_started_at null → day 1). Hard cap,
    // no override (adjust the ramp to change it). The count is the SHARED per-mailbox
    // total — both the SDR and TXR050000/permit cold systems record into sdr_sends.
    {
      const startedAt = mailbox.warmup_started_at; // null until first send → day 1
      const cap = dailyCap(startedAt);
      const sentToday = await mailboxSentToday(mailbox.id);
      if (sentToday >= cap) {
        const day = rampDay(startedAt);
        return res.status(429).json({
          code: "daily_cap_reached",
          mailbox: mailbox.email,
          sentToday,
          cap,
          rampDay: day,
          message: `Daily send cap reached for ${mailbox.email}: ${sentToday}/${cap} sent today (warmup day ${day}). The cap rises as the inbox warms up — try again tomorrow.`,
        });
      }
    }

    // Per-lead lock + tx: match Apollo contact, enroll, record send, mark draft sent.
    // `enrolled` tracks whether the Apollo call succeeded — if it did and a later
    // DB write fails, we must NOT mark the draft 'failed' (re-approving would
    // enroll the contact in Apollo a second time).
    let enrolled = false;
    let apolloContactId = null;
    let enrollResponse = null;

    let result;
    try {
      result = await withLeadLock(pool, draft.pipedrive_lead_id, async (client) => {
        // Match snapshot email → Apollo ACCOUNT CONTACT id (find-or-create)
        const match = await apolloClient.matchContactByEmail(draft.contact_email_snapshot);
        apolloContactId = match?.id || match?.contact?.id;
        if (!apolloContactId) throw new Error(`Apollo could not match contact by email ${draft.contact_email_snapshot}`);

        // Carry the approved subject/body into Apollo contact custom fields.
        // The sequences' step-1 templates merge {{contact.swppp_draft_subject/body}},
        // so what was approved in the queue is exactly what Apollo sends.
        // Must succeed BEFORE enrollment — otherwise Apollo would send raw merge tags.
        // NOTE: tracking pixel + styling live in the Apollo TEMPLATE (which renders),
        // NOT here — Apollo HTML-escapes custom-field values, so the body stays plain.
        await apolloClient.updateContactCustomFields(apolloContactId, {
          [APOLLO_CF_DRAFT_SUBJECT]: draft.subject,
          [APOLLO_CF_DRAFT_BODY]: draft.body,
          [APOLLO_CF_TRACK]: draft.id, // open-pixel token, rendered via {{contact.swppp_track}}
        });

        // Enroll in sequence with the assigned mailbox as the sender
        enrollResponse = await apolloClient.addContactsToSequence(
          draft.apollo_sequence_id,
          [apolloContactId],
          mailbox.apollo_mailbox_id,
        );

        // Apollo returns HTTP 200 even when it silently DROPS the contact (e.g.
        // `contacts_finished_in_other_campaigns` for a lead already touched by another
        // sequence, or an unverified email). In that case `contacts` is empty and the
        // id shows up under `skipped_contact_ids`. We must NOT report a send, log the
        // ledger, or fire a Pipedrive activity — that would attribute outreach that
        // never left the building. Throw before `enrolled` flips so the draft is left
        // un-sent with the reason surfaced.
        const skipReason = enrollResponse?.skipped_contact_ids?.[apolloContactId];
        const addedOk =
          !skipReason &&
          Array.isArray(enrollResponse?.contacts) &&
          enrollResponse.contacts.length > 0;
        if (!addedOk) {
          const reason = skipReason || "not added (Apollo returned no enrolled contact)";
          const e = new Error(`Apollo did not enroll the contact: ${reason}`);
          e.status = 409;
          e.code = "apollo_skipped";
          e.skipReason = reason;
          throw e;
        }
        enrolled = true;

        // Mark draft sent
        const { rows: updRows } = await client.query(
          `UPDATE sdr_drafts SET status = 'sent', sent_at = NOW(), approved_at = NOW(),
                                  approved_by = $2, updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [draft.id, req.sdrUser.sub],
        );

        // Record sdr_sends row
        const { rows: sendRows } = await client.query(
          `INSERT INTO sdr_sends (draft_id, pipedrive_lead_id, apollo_sequence_id,
                                   apollo_contact_id, mailbox_id, status)
           VALUES ($1, $2, $3, $4, $5, 'enrolled')
           RETURNING *`,
          [draft.id, draft.pipedrive_lead_id, draft.apollo_sequence_id, apolloContactId, mailbox.id],
        );

        // Start the warmup ramp clock on this mailbox's first-ever send.
        await client.query(
          `UPDATE sdr_mailboxes SET warmup_started_at = NOW()
            WHERE id = $1 AND warmup_started_at IS NULL`,
          [mailbox.id],
        );

        return { draft: updRows[0], send: sendRows[0], apollo_response: enrollResponse };
      });
    } catch (txErr) {
      if (!enrolled) throw txErr; // Apollo never enrolled — safe to fall through to the 'failed' path

      // Apollo enrolled but local bookkeeping failed: record best-effort state so
      // the draft can't be re-approved, surface the warning instead of erroring.
      console.error("approve-and-send: Apollo enrolled but DB write failed:", txErr);
      const warn = `Apollo enrolled OK but local bookkeeping failed: ${String(txErr.message).slice(0, 500)}`;
      const { rows: updRows } = await pool.query(
        `UPDATE sdr_drafts SET status = 'sent', sent_at = NOW(), approved_at = NOW(),
                                approved_by = $2, error_message = $3, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [draft.id, req.sdrUser.sub, warn],
      ).catch(() => ({ rows: [] }));
      const { rows: sendRows } = await pool.query(
        `INSERT INTO sdr_sends (draft_id, pipedrive_lead_id, apollo_sequence_id,
                                 apollo_contact_id, mailbox_id, status)
         VALUES ($1, $2, $3, $4, $5, 'enrolled') RETURNING *`,
        [draft.id, draft.pipedrive_lead_id, draft.apollo_sequence_id, apolloContactId, mailbox.id],
      ).catch(() => ({ rows: [] }));
      result = { draft: updRows[0] || { ...draft, status: "sent" }, send: sendRows[0] || null, apollo_response: enrollResponse, warning: warn };
    }

    // Per-lead outreach ledger (interface source). Sender = the .co mailbox that
    // sends via Apollo (not a Pipedrive-connected mailbox, so it never lands in the
    // sent-folder sweep — this is how interface sends enter the ledger). Runs after
    // the send is recorded so it covers the Apollo-enrolled-but-DB-failed fallback too.
    try {
      await upsertOutreach(pool, {
        pipedrive_lead_id: draft.pipedrive_lead_id,
        source: "interface",
        sent_at: new Date().toISOString(),
        sender_name: req.sdrUser?.username || null,
        sender_email: mailbox.email,
        subject: draft.subject,
        external_ref: result?.send?.id ? String(result.send.id) : null,
      });
    } catch (e) {
      console.error("outreach ledger upsert (interface) failed:", e.message);
    }

    // Pipedrive write-back (non-fatal): mark the lead in-sequence (dedup), drop a
    // note with the interface deep-link, and log a dated Activity so the send shows
    // in the lead's Pipedrive timeline. No new custom field — state lives in Postgres.
    if (process.env.PIPEDRIVE_API_TOKEN) {
      try {
        await pipedriveClient.updateLead(draft.pipedrive_lead_id, {
          [pdSequenceStartedKey]: `Apollo:${draft.trigger_type} ${new Date().toISOString().slice(0, 10)}`,
        });
        const appBase = process.env.PUBLIC_BASE_URL || "https://swppp-interface-production.up.railway.app";
        await pipedriveClient.addNote({
          leadId: draft.pipedrive_lead_id,
          content:
            `[Auto] Apollo: enrolled in ${draft.trigger_type} sequence (${draft.apollo_sequence_id}) by ${req.sdrUser?.username || "system"}. ` +
            `Sender: ${mailbox.email}. Sequence_Started set.` +
            (overrideContext ? ` ⚠️ ${overrideContext}.` : "") +
            `\nOpen in interface: ${appBase}/#/sdr?lead=${draft.pipedrive_lead_id}`,
        });
        await pipedriveClient.addActivity({
          leadId: draft.pipedrive_lead_id,
          subject: `Outreach sent: ${draft.trigger_type} sequence via ${mailbox.email} (interface)`,
          type: "email",
          done: true,
          note: `Enrolled in Apollo ${draft.trigger_type} sequence (${draft.apollo_sequence_id}) by ${req.sdrUser?.username || "auto"}.`,
        });
      } catch (e) {
        console.error("Pipedrive sync on send failed:", e.message);
        result.pipedrive_sync = `failed: ${e.message}`;
      }
    }

    res.json(result);
  } catch (err) {
    console.error("POST /api/sdr/drafts/:id/approve-and-send error:", err);
    // Mark draft as failed if we got past pre-checks
    await pool.query(
      `UPDATE sdr_drafts SET status = 'failed', error_message = $2, updated_at = NOW()
       WHERE id = $1 AND status IN ('pending','approved','edited')`,
      [req.params.id, String(err.message).slice(0, 1000)],
    ).catch(() => {});
    const payload = { error: err.message || "Approve-and-send failed" };
    if (err.code) payload.code = err.code;
    if (err.skipReason) payload.skipReason = err.skipReason;
    res.status(err.status || 500).json(payload);
  }
});

app.get("/api/projects", async (req, res) => {
  if (!process.env.DATABASE_URL) {
    // Migration for memory mode
    memoryProjects = memoryProjects.map((p) =>
      p.status === "New" ? { ...p, status: "Pending Review" } : p
    );
    return res.json(memoryProjects);
  }

  try {
    // Auto-migrate "New" to "Pending Review" in DB
    await pool.query(
      "UPDATE projects SET status = 'Pending Review', data = jsonb_set(data, '{status}', '\"Pending Review\"') WHERE status = 'New' AND archived = FALSE"
    );

    const result = await pool.query(
      "SELECT data FROM projects WHERE archived = FALSE ORDER BY id DESC"
    );
    res.json(result.rows.map((r) => r.data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects", async (req, res) => {
  const newProject = req.body;
  if (!newProject.id) newProject.id = Date.now().toString();
  // Default to "New" status if not provided (allows external webhooks to set their own status)
  if (!newProject.status) newProject.status = "New";
  if (!newProject.projectName) newProject.projectName = "Untitled Project";

  // Convert date to MM/DD/YY format
  const convertToMMDDYY = (dateStr) => {
    if (!dateStr) return "";
    // If already MM/DD/YY, return as is
    if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(dateStr)) return dateStr;

    try {
      let date;
      // Handle DD/MM/YYYY or DD/MM/YY
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(dateStr)) {
        const parts = dateStr.split("/");
        // If first part > 12, assume DD/MM/YYYY
        if (parseInt(parts[0]) > 12) {
          const day = parseInt(parts[0]);
          const month = parseInt(parts[1]) - 1;
          const year =
            parts[2].length === 2
              ? 2000 + parseInt(parts[2])
              : parseInt(parts[2]);
          date = new Date(year, month, day);
        } else {
          // Already MM/DD format, parse normally
          date = new Date(dateStr);
        }
      } else {
        date = new Date(dateStr);
      }

      if (isNaN(date.getTime())) return dateStr;

      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const year = String(date.getFullYear()).slice(-2);
      return `${month}/${day}/${year}`;
    } catch {
      return dateStr;
    }
  };

  if (!newProject.dateReceived) {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const year = String(now.getFullYear()).slice(-2);
    newProject.dateReceived = `${month}/${day}/${year}`;
  } else {
    newProject.dateReceived = convertToMMDDYY(newProject.dateReceived);
  }

  // Convert other date fields
  if (newProject.projectStartDate) {
    newProject.projectStartDate = convertToMMDDYY(newProject.projectStartDate);
  }
  if (newProject.projectFinishDate) {
    newProject.projectFinishDate = convertToMMDDYY(
      newProject.projectFinishDate
    );
  }

  // Add creation timestamp
  if (!newProject.createdAt) newProject.createdAt = new Date().toISOString();

  // Map API fields
  if (newProject.CivilDrawings)
    newProject.civilDrawingsLink = newProject.CivilDrawings;

  if (!process.env.DATABASE_URL) {
    memoryProjects.push(newProject);
    return res.status(201).json(newProject);
  }

  try {
    await pool.query(
      "INSERT INTO projects (id, name, status, data) VALUES ($1, $2, $3, $4)",
      [newProject.id, newProject.projectName, newProject.status, newProject]
    );
    res.status(201).json(newProject);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/projects/:id", async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  if (!process.env.DATABASE_URL) {
    const index = memoryProjects.findIndex((p) => p.id === id);
    if (index !== -1) {
      memoryProjects[index] = { ...memoryProjects[index], ...updates };
      return res.json(memoryProjects[index]);
    }
    return res.status(404).json({ error: "Not found" });
  }

  try {
    const current = await pool.query(
      "SELECT data FROM projects WHERE id = $1",
      [id]
    );
    if (current.rows.length === 0)
      return res.status(404).json({ error: "Not found" });

    const oldStatus = current.rows[0].data.status;
    const updatedData = { ...current.rows[0].data, ...updates };
    const newStatus = updatedData.status;

    await pool.query(
      "UPDATE projects SET name = $1, status = $2, data = $3 WHERE id = $4",
      [updatedData.projectName, updatedData.status, updatedData, id]
    );

    // Trigger n8n webhook on approval
    if (
      newStatus !== oldStatus &&
      (newStatus === "Approved for Generation" ||
        newStatus === "Manual Processing")
    ) {
      console.log(
        `Triggering n8n webhook for project: ${updatedData.projectName}`
      );
      fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedData),
      })
        .then((response) => {
          console.log(`n8n webhook response: ${response.status}`);
        })
        .catch((err) => {
          console.error("Failed to trigger n8n webhook:", err);
        });
    }

    res.json(updatedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  const { id } = req.params;

  if (!process.env.DATABASE_URL) {
    const index = memoryProjects.findIndex((p) => p.id === id);
    if (index !== -1) {
      const project = memoryProjects[index];
      project.deletedAt = new Date().toISOString();
      memoryArchive.push(project);
      memoryProjects.splice(index, 1);
      return res.status(204).send();
    }
    return res.status(404).json({ error: "Not found" });
  }

  try {
    const now = new Date().toISOString();
    await pool.query(
      "UPDATE projects SET archived = TRUE, deleted_at = $1 WHERE id = $2",
      [now, id]
    );
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/archive", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json(memoryArchive);

  try {
    const result = await pool.query(
      "SELECT data, deleted_at FROM projects WHERE archived = TRUE ORDER BY deleted_at DESC"
    );
    res.json(result.rows.map((r) => ({ ...r.data, deletedAt: r.deleted_at })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/archive/:id/restore", async (req, res) => {
  const { id } = req.params;

  if (!process.env.DATABASE_URL) {
    const index = memoryArchive.findIndex((p) => p.id === id);
    if (index !== -1) {
      const project = memoryArchive[index];
      delete project.deletedAt;
      memoryProjects.push(project);
      memoryArchive.splice(index, 1);
      return res.json(project);
    }
    return res.status(404).json({ error: "Not found" });
  }

  try {
    await pool.query(
      "UPDATE projects SET archived = FALSE, deleted_at = NULL WHERE id = $1",
      [id]
    );
    const result = await pool.query("SELECT data FROM projects WHERE id = $1", [
      id,
    ]);
    res.json(result.rows[0].data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Project (Single or Bulk)
app.post("/api/projects/delete", async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids))
    return res.status(400).json({ error: "IDs array required" });

  if (!process.env.DATABASE_URL) {
    const now = new Date().toISOString();
    ids.forEach((id) => {
      const index = memoryProjects.findIndex((p) => p.id === id);
      if (index !== -1) {
        const project = memoryProjects[index];
        project.deletedAt = now;
        memoryArchive.push(project);
        memoryProjects.splice(index, 1);
      }
    });
    return res.status(204).send();
  }

  try {
    const now = new Date().toISOString();
    await pool.query(
      "UPDATE projects SET archived = TRUE, deleted_at = $1 WHERE id = ANY($2)",
      [now, ids]
    );
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== AI Content Routes ====================

app.get("/api/ai-content/stats", async (req, res) => {
  if (!process.env.DATABASE_URL) {
    const stats = { queued: 0, generating: 0, draft: 0, published: 0, failed: 0, spoke: 0, pillar: 0, comparison: 0 };
    const stateMap = {};
    memoryContent.forEach((c) => {
      if (stats[c.status] !== undefined) stats[c.status]++;
      if (stats[c.type] !== undefined) stats[c.type]++;
      if (c.state) {
        if (!stateMap[c.state]) stateMap[c.state] = { pillar: 0, spoke: 0, comparison: 0, total: 0 };
        stateMap[c.state][c.type]++;
        stateMap[c.state].total++;
      }
    });
    return res.json({ ...stats, states: stateMap });
  }
  try {
    const statusResult = await pool.query(
      "SELECT status, COUNT(*)::int as count FROM ai_content GROUP BY status"
    );
    const typeResult = await pool.query(
      "SELECT type, COUNT(*)::int as count FROM ai_content GROUP BY type"
    );
    const stateResult = await pool.query(
      "SELECT state, type, COUNT(*)::int as count FROM ai_content WHERE state IS NOT NULL GROUP BY state, type"
    );
    const stats = { queued: 0, generating: 0, draft: 0, published: 0, failed: 0, spoke: 0, pillar: 0, comparison: 0 };
    statusResult.rows.forEach((r) => { stats[r.status] = r.count; });
    typeResult.rows.forEach((r) => { stats[r.type] = r.count; });
    const stateMap = {};
    stateResult.rows.forEach((r) => {
      if (!stateMap[r.state]) stateMap[r.state] = { pillar: 0, spoke: 0, comparison: 0, total: 0 };
      stateMap[r.state][r.type] = r.count;
      stateMap[r.state].total += r.count;
    });
    res.json({ ...stats, states: stateMap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import existing WP articles into ai_content table
app.post("/api/ai-content/import-wp", async (req, res) => {
  try {
    // Fetch published posts from WP
    const wpPosts = [];
    let page = 1;
    while (true) {
      const wpRes = await fetch(
        `https://proswppp.com/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=id,title,slug,date,link,categories,content`,
      );
      if (!wpRes.ok) break;
      const posts = await wpRes.json();
      if (!posts.length) break;
      wpPosts.push(...posts);
      page++;
    }

    const US_STATES = [
      "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware",
      "Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky",
      "Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi",
      "Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico",
      "New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania",
      "Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont",
      "Virginia","Washington","West Virginia","Wisconsin","Wyoming",
    ];

    // Detect state from title
    const detectState = (title) => {
      const lower = title.toLowerCase();
      // Check longest names first to avoid "Virginia" matching "West Virginia"
      const sorted = [...US_STATES].sort((a, b) => b.length - a.length);
      for (const state of sorted) {
        if (lower.includes(state.toLowerCase())) return state;
      }
      return null;
    };

    // Detect article type from title + content
    // Pillar = state-level SWPPP requirements guide (one per state)
    // Pattern: "[State] SWPPP Requirements..." or "SWPPP Requirements [State]..."
    const detectType = (title, state) => {
      const lower = title.toLowerCase();
      if (lower.includes("comparison") || lower.includes("best swppp services") || lower.includes("vs")) return "comparison";
      if (state && (lower.includes("swppp requirements") || lower.includes("swppp compliance") || lower.includes("stormwater permit compliance"))) return "pillar";
      return "spoke";
    };

    let imported = 0;
    let skipped = 0;
    const results = [];
    const pillarStates = new Set(); // Track which states already have a pillar in this import

    for (const post of wpPosts) {
      const title = post.title.rendered.replace(/&#038;/g, "&").replace(/&#8211;/g, "–");
      const content = post.content?.rendered || "";
      const state = detectState(title);
      let type = detectType(title, state);
      const wordCount = content.replace(/<[^>]+>/g, " ").split(/\s+/).length;

      // One pillar per state — if we already assigned a pillar for this state, demote to spoke
      if (type === "pillar" && state) {
        if (pillarStates.has(state)) {
          type = "spoke";
        } else {
          pillarStates.add(state);
        }
      }
      const id = `wp_import_${post.id}`;

      // Check if already imported — if so, sync URL and status
      if (process.env.DATABASE_URL) {
        const exists = await pool.query("SELECT id, status, wordpress_url FROM ai_content WHERE id = $1 OR wordpress_post_id = $2", [id, post.id]);
        if (exists.rows.length > 0) {
          const existing = exists.rows[0];
          const wpUrl = post.link || `https://proswppp.com/?p=${post.id}`;
          // Update if status changed (draft→published) or URL changed
          if (existing.status !== "published" || existing.wordpress_url !== wpUrl) {
            await pool.query(
              "UPDATE ai_content SET status = 'published', wordpress_url = $1, published_at = $2, updated_at = NOW() WHERE id = $3",
              [wpUrl, post.date, existing.id]
            );
          }
          skipped++;
          continue;
        }
      } else {
        const existing = memoryContent.find((c) => c.id === id || c.wordpressPostId === post.id);
        if (existing) {
          existing.status = "published";
          existing.wordpressUrl = post.link || `https://proswppp.com/?p=${post.id}`;
          skipped++;
          continue;
        }
      }

      const item = {
        id,
        type,
        status: "published",
        keyword: title,
        state,
        title,
        wordCount,
        wordpressPostId: post.id,
        wordpressUrl: post.link || `https://proswppp.com/?p=${post.id}`,
        publishedAt: post.date,
      };

      if (process.env.DATABASE_URL) {
        await pool.query(
          `INSERT INTO ai_content (id, type, status, keyword, state, title, word_count, wordpress_post_id, wordpress_url, published_at, created_at, updated_at)
           VALUES ($1, $2, 'published', $3, $4, $5, $6, $7, $8, $9, $9, NOW())`,
          [id, type, title, state, title, wordCount, post.id, item.wordpressUrl, post.date]
        );
      } else {
        memoryContent.push(item);
      }

      results.push({ id, type, state, title: title.slice(0, 60), wordCount });
      imported++;
    }

    // Detect trashed posts — remove entries whose WP post no longer exists
    let trashed = 0;
    if (process.env.DATABASE_URL) {
      const liveWpIds = new Set(wpPosts.map((p) => p.id));
      const dbEntries = await pool.query(
        "SELECT id, wordpress_post_id FROM ai_content WHERE wordpress_post_id IS NOT NULL AND status = 'published'"
      );
      for (const row of dbEntries.rows) {
        if (!liveWpIds.has(row.wordpress_post_id)) {
          await pool.query("DELETE FROM ai_content WHERE id = $1", [row.id]);
          trashed++;
        }
      }
    }

    res.json({ imported, skipped, trashed, total: wpPosts.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ai-content", async (req, res) => {
  const { type, status, state } = req.query;

  if (!process.env.DATABASE_URL) {
    let filtered = memoryContent;
    if (type) filtered = filtered.filter((c) => c.type === type);
    if (status) filtered = filtered.filter((c) => c.status === status);
    if (state) filtered = filtered.filter((c) => c.state === state);
    return res.json(filtered);
  }

  try {
    let query = "SELECT * FROM ai_content WHERE 1=1";
    const params = [];
    if (type) { params.push(type); query += ` AND type = $${params.length}`; }
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    if (state) { params.push(state); query += ` AND state = $${params.length}`; }
    query += " ORDER BY created_at DESC";

    const result = await pool.query(query, params);
    res.json(result.rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      keyword: r.keyword,
      state: r.state,
      title: r.title,
      wordCount: r.word_count,
      pillarId: r.pillar_id,
      wordpressPostId: r.wordpress_post_id,
      wordpressUrl: r.wordpress_url,
      n8nExecutionId: r.n8n_execution_id,
      errorMessage: r.error_message,
      metadata: r.metadata,
      version: r.version || 1,
      basePillarId: r.base_pillar_id,
      legacyWordpressUrl: r.legacy_wordpress_url,
      isCurrent: r.is_current !== false,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      generatedAt: r.generated_at,
      publishedAt: r.published_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai-content", async (req, res) => {
  let { type, keyword, state, pillarId, force } = req.body;

  // Pillar auto-generates keyword from state
  if (type === "pillar") {
    if (!state) return res.status(400).json({ error: "state required for pillar articles" });
    keyword = `Construction & Industrial SWPPP Requirements in ${state}`;
    // Enforce one CURRENT pillar per state unless explicitly forced (versioning is handled via separate route)
    if (!force) {
      if (process.env.DATABASE_URL) {
        const existing = await pool.query("SELECT id FROM ai_content WHERE type = 'pillar' AND state = $1 AND is_current = TRUE", [state]);
        if (existing.rows.length > 0) return res.status(409).json({ error: `Pillar already exists for ${state}`, existingId: existing.rows[0].id });
      } else {
        const existing = memoryContent.find((c) => c.type === "pillar" && c.state === state && c.isCurrent !== false);
        if (existing) return res.status(409).json({ error: `Pillar already exists for ${state}`, existingId: existing.id });
      }
    }
  }

  if (!type || !keyword) return res.status(400).json({ error: "type and keyword required" });

  // Auto-link spoke to state pillar if not specified — pick the CURRENT version
  if (type === "spoke" && state && !pillarId) {
    if (process.env.DATABASE_URL) {
      const pillar = await pool.query("SELECT id FROM ai_content WHERE type = 'pillar' AND state = $1 AND is_current = TRUE ORDER BY version DESC LIMIT 1", [state]);
      if (pillar.rows.length > 0) pillarId = pillar.rows[0].id;
    } else {
      const pillar = memoryContent.find((c) => c.type === "pillar" && c.state === state && c.isCurrent !== false);
      if (pillar) pillarId = pillar.id;
    }
  }

  const id = `content_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const item = {
    id, type, status: "queued", keyword,
    state: state || null,
    pillarId: pillarId || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (!process.env.DATABASE_URL) {
    memoryContent.push(item);
    return res.status(201).json(item);
  }

  try {
    // For pillars: base_pillar_id = self (each pillar starts its own lineage at v1, is_current=true)
    const basePillarId = type === "pillar" ? id : null;
    await pool.query(
      `INSERT INTO ai_content (id, type, status, keyword, state, pillar_id, base_pillar_id, version, is_current)
       VALUES ($1, $2, 'queued', $3, $4, $5, $6, 1, TRUE)`,
      [id, type, keyword, state || null, pillarId || null, basePillarId]
    );
    const result = await pool.query("SELECT * FROM ai_content WHERE id = $1", [id]);
    const r = result.rows[0];
    res.status(201).json({
      id: r.id, type: r.type, status: r.status, keyword: r.keyword,
      state: r.state, pillarId: r.pillar_id,
      version: r.version, basePillarId: r.base_pillar_id, isCurrent: r.is_current,
      createdAt: r.created_at, updatedAt: r.updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/ai-content/:id", async (req, res) => {
  const { id } = req.params;
  const { keyword, state, type, pillarId, status, wordpressUrl, title } = req.body;

  if (!process.env.DATABASE_URL) {
    const item = memoryContent.find((c) => c.id === id);
    if (!item) return res.status(404).json({ error: "Not found" });
    if (keyword) item.keyword = keyword;
    if (state !== undefined) item.state = state;
    if (type) item.type = type;
    if (pillarId !== undefined) item.pillarId = pillarId;
    if (status) {
      item.status = status;
      if (status === "published") item.publishedAt = new Date().toISOString();
    }
    if (wordpressUrl !== undefined) item.wordpressUrl = wordpressUrl;
    if (title !== undefined) item.title = title;
    item.updatedAt = new Date().toISOString();
    return res.json(item);
  }

  try {
    const fields = [];
    const params = [];
    if (keyword) { params.push(keyword); fields.push(`keyword = $${params.length}`); }
    if (state !== undefined) { params.push(state); fields.push(`state = $${params.length}`); }
    if (type) { params.push(type); fields.push(`type = $${params.length}`); }
    if (pillarId !== undefined) { params.push(pillarId); fields.push(`pillar_id = $${params.length}`); }
    if (status) {
      params.push(status); fields.push(`status = $${params.length}`);
      if (status === "published") fields.push("published_at = NOW()");
    }
    if (wordpressUrl !== undefined) { params.push(wordpressUrl); fields.push(`wordpress_url = $${params.length}`); }
    if (title !== undefined) { params.push(title); fields.push(`title = $${params.length}`); }
    if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

    fields.push("updated_at = NOW()");
    params.push(id);
    await pool.query(`UPDATE ai_content SET ${fields.join(", ")} WHERE id = $${params.length}`, params);

    const result = await pool.query("SELECT * FROM ai_content WHERE id = $1", [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const r = result.rows[0];
    res.json({
      id: r.id, type: r.type, status: r.status, keyword: r.keyword,
      state: r.state, title: r.title, wordCount: r.word_count,
      pillarId: r.pillar_id, wordpressPostId: r.wordpress_post_id,
      wordpressUrl: r.wordpress_url, n8nExecutionId: r.n8n_execution_id,
      errorMessage: r.error_message, metadata: r.metadata,
      createdAt: r.created_at, updatedAt: r.updated_at,
      generatedAt: r.generated_at, publishedAt: r.published_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/ai-content/:id", async (req, res) => {
  const { id } = req.params;

  if (!process.env.DATABASE_URL) {
    const index = memoryContent.findIndex((c) => c.id === id);
    if (index === -1) return res.status(404).json({ error: "Not found" });
    memoryContent.splice(index, 1);
    return res.status(204).send();
  }

  try {
    const result = await pool.query("DELETE FROM ai_content WHERE id = $1", [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai-content/delete-bulk", async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: "ids array required" });

  if (!process.env.DATABASE_URL) {
    ids.forEach((id) => {
      const index = memoryContent.findIndex((c) => c.id === id);
      if (index !== -1) memoryContent.splice(index, 1);
    });
    return res.status(204).send();
  }

  try {
    await pool.query("DELETE FROM ai_content WHERE id = ANY($1)", [ids]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai-content/:id/generate", async (req, res) => {
  const { id } = req.params;

  if (!process.env.DATABASE_URL) {
    const item = memoryContent.find((c) => c.id === id);
    if (!item) return res.status(404).json({ error: "Not found" });
    item.status = "generating";
    item.updatedAt = new Date().toISOString();
    // Fire webhook (no-op in dev without n8n)
    return res.json(item);
  }

  try {
    const current = await pool.query("SELECT * FROM ai_content WHERE id = $1", [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const row = current.rows[0];

    await pool.query(
      "UPDATE ai_content SET status = 'generating', error_message = NULL, updated_at = NOW() WHERE id = $1",
      [id]
    );

    // Build pillar context if this is a spoke with a pillar.
    // Walk to the CURRENT version of the pillar lineage so spokes always link to the live URL.
    let pillarContext = null;
    if (row.type === "spoke" && row.pillar_id) {
      const linked = await pool.query("SELECT base_pillar_id, state FROM ai_content WHERE id = $1", [row.pillar_id]);
      const basePillarId = linked.rows[0]?.base_pillar_id || row.pillar_id;
      const pillar = await pool.query(
        "SELECT keyword, wordpress_url FROM ai_content WHERE base_pillar_id = $1 AND is_current = TRUE ORDER BY version DESC LIMIT 1",
        [basePillarId]
      );
      const fallback = pillar.rows[0] || (await pool.query("SELECT keyword, wordpress_url FROM ai_content WHERE id = $1", [row.pillar_id])).rows[0];
      if (fallback) {
        pillarContext = {
          pillarKeyword: fallback.keyword,
          pillarWordpressUrl: fallback.wordpress_url,
        };
      }
    }

    const webhookPayload = {
      content_id: row.id,
      type: row.type,
      keyword: row.keyword,
      state: row.state,
      callback_url: `${RAILWAY_PUBLIC_URL}/api/ai-content/callback`,
      pillar_context: pillarContext,
    };

    console.log(`Triggering n8n content generation for: ${row.keyword} (${row.type})`);
    fetch(N8N_CONTENT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    })
      .then((response) => console.log(`n8n content webhook response: ${response.status}`))
      .catch((err) => {
        console.error("Failed to trigger n8n content webhook:", err);
        pool.query(
          "UPDATE ai_content SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2",
          [`Webhook failed: ${err.message}`, id]
        );
      });

    res.json({ ...row, status: "generating" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai-content/generate-bulk", async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: "ids array required" });

  const results = [];
  for (const id of ids) {
    try {
      const response = await fetch(`${RAILWAY_PUBLIC_URL}/api/ai-content/${id}/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: req.headers.authorization,
        },
      });
      results.push({ id, status: response.ok ? "triggered" : "failed" });
    } catch (err) {
      results.push({ id, status: "failed", error: err.message });
    }
  }
  res.json({ results });
});

// n8n callback — HMAC-protected (allows passthrough for legacy n8n that hasn't been updated yet,
// guarded behind a feature flag so we can flip to strict once the n8n side is patched).
app.post("/api/ai-content/callback", async (req, res) => {
  const expectedSig = req.get("X-N8N-Signature");
  if (process.env.AI_CONTENT_CALLBACK_STRICT === "true") {
    const computed = crypto.createHmac("sha256", N8N_CALLBACK_SECRET).update(JSON.stringify(req.body)).digest("hex");
    if (expectedSig !== computed) {
      console.warn("AI content callback HMAC mismatch — rejecting");
      return res.status(401).json({ error: "invalid signature" });
    }
  } else if (expectedSig) {
    // If n8n sends a sig and it's wrong, log it but don't reject (transition mode)
    const computed = crypto.createHmac("sha256", N8N_CALLBACK_SECRET).update(JSON.stringify(req.body)).digest("hex");
    if (expectedSig !== computed) console.warn("AI content callback HMAC sent but mismatched (non-strict mode, allowing)");
  }
  const { content_id, status, wordpress_post_id, wordpress_url, title, word_count, n8n_execution_id, error_message } = req.body;
  if (!content_id) return res.status(400).json({ error: "content_id required" });

  console.log(`AI content callback: ${content_id} → ${status}`);

  if (!process.env.DATABASE_URL) {
    const item = memoryContent.find((c) => c.id === content_id);
    if (!item) return res.status(404).json({ error: "Not found" });
    if (status) item.status = status;
    if (title) item.title = title;
    if (word_count) item.wordCount = word_count;
    if (wordpress_post_id) item.wordpressPostId = wordpress_post_id;
    if (wordpress_url) item.wordpressUrl = wordpress_url;
    if (n8n_execution_id) item.n8nExecutionId = n8n_execution_id;
    if (error_message) item.errorMessage = error_message;
    item.updatedAt = new Date().toISOString();
    if (status === "draft") item.generatedAt = new Date().toISOString();
    return res.json({ ok: true });
  }

  try {
    const fields = ["updated_at = NOW()"];
    const params = [];
    if (status) { params.push(status); fields.push(`status = $${params.length}`); }
    if (title) { params.push(title); fields.push(`title = $${params.length}`); }
    if (word_count) { params.push(word_count); fields.push(`word_count = $${params.length}`); }
    if (wordpress_post_id) { params.push(wordpress_post_id); fields.push(`wordpress_post_id = $${params.length}`); }
    if (wordpress_url) { params.push(wordpress_url); fields.push(`wordpress_url = $${params.length}`); }
    if (n8n_execution_id) { params.push(n8n_execution_id); fields.push(`n8n_execution_id = $${params.length}`); }
    if (error_message) { params.push(error_message); fields.push(`error_message = $${params.length}`); }
    if (status === "draft") fields.push("generated_at = NOW()");

    params.push(content_id);
    await pool.query(`UPDATE ai_content SET ${fields.join(", ")} WHERE id = $${params.length}`, params);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Pillar Versioning
// - List all versions in a pillar lineage
// - Regenerate as new version (clones metadata, bumps version, NOT yet current)
// - Atomically promote a version to current (DB flip + WP URL update with rollback)
// ============================================================================

// List all versions in a pillar's lineage (by base_pillar_id)
app.get("/api/ai-content/pillar/:state/versions", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json([]);
  const { state } = req.params;
  try {
    const r = await pool.query(
      `SELECT id, version, status, title, wordpress_url, generated_at, published_at, is_current, base_pillar_id
       FROM ai_content
       WHERE type = 'pillar' AND state = $1
       ORDER BY version DESC, created_at DESC`,
      [state]
    );
    res.json(r.rows.map((row) => ({
      id: row.id,
      version: row.version,
      status: row.status,
      title: row.title,
      wordpressUrl: row.wordpress_url,
      generatedAt: row.generated_at,
      publishedAt: row.published_at,
      isCurrent: row.is_current,
      basePillarId: row.base_pillar_id,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Regenerate as new version: clones metadata from a pillar, bumps version, kicks off n8n.
// New version is NOT immediately current — must be promoted via /set-current after generation completes.
app.post("/api/ai-content/:id/regenerate-as-new-version", async (req, res) => {
  const { id } = req.params;
  if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB required" });
  try {
    const cur = await pool.query("SELECT * FROM ai_content WHERE id = $1", [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: "Not found" });
    const row = cur.rows[0];
    if (row.type !== "pillar") return res.status(400).json({ error: "Only pillars can be versioned" });

    const basePillarId = row.base_pillar_id || row.id;
    const maxV = await pool.query(
      "SELECT COALESCE(MAX(version), 1) AS max_version FROM ai_content WHERE base_pillar_id = $1",
      [basePillarId]
    );
    const newVersion = (maxV.rows[0].max_version || 1) + 1;
    const newId = `content_${Date.now()}_v${newVersion}_${Math.random().toString(36).slice(2, 6)}`;

    await pool.query(
      `INSERT INTO ai_content (id, type, status, keyword, state, base_pillar_id, version, is_current, legacy_wordpress_url)
       VALUES ($1, 'pillar', 'queued', $2, $3, $4, $5, FALSE, $6)`,
      [newId, row.keyword, row.state, basePillarId, newVersion, row.wordpress_url]
    );

    // Trigger n8n. n8n will CREATE a brand-new WP draft post (versioned slug) — does NOT
    // touch the live v1 post. The live URL is only swapped at /set-current promotion time.
    const webhookPayload = {
      content_id: newId,
      type: "pillar",
      keyword: row.keyword,
      state: row.state,
      callback_url: `${RAILWAY_PUBLIC_URL}/api/ai-content/callback`,
      pillar_context: null,
      // is_new_version flag tells n8n to use the versioned-slug create path
      is_new_version: true,
      existing_wp_post_id: row.wordpress_post_id,  // for reference / audit only
      existing_wp_url: row.wordpress_url,
      base_pillar_id: basePillarId,
      version: newVersion,
    };

    await pool.query("UPDATE ai_content SET status = 'generating', updated_at = NOW() WHERE id = $1", [newId]);

    fetch(N8N_CONTENT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    })
      .then((r) => console.log(`n8n new-version webhook: ${r.status}`))
      .catch((err) => {
        console.error("Webhook failed:", err);
        pool.query("UPDATE ai_content SET status = 'failed', error_message = $1 WHERE id = $2", [`Webhook: ${err.message}`, newId]);
      });

    const created = await pool.query("SELECT * FROM ai_content WHERE id = $1", [newId]);
    const c = created.rows[0];
    res.status(201).json({
      id: c.id,
      type: c.type,
      status: c.status,
      version: c.version,
      basePillarId: c.base_pillar_id,
      isCurrent: c.is_current,
      keyword: c.keyword,
      state: c.state,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Promote a version to current.
//
// Real safety flow (preserves SEO URL of the original v1):
//   1) Fetch new version's content from its WP draft post
//   2) PATCH the v1 (current) WP post with new content  — same URL, same slug, SEO preserved
//   3) Trash the v2 draft WP post (cleanup)
//   4) Transaction: flip is_current to v2 in DB, copy v2's content URL onto v2's row's wordpress_url=v1's URL
//
// On any failure, rollback DB. WP changes are best-effort (we log + flag) — the v1 post
// is only modified after we've fetched v2's content successfully.
app.post("/api/ai-content/:id/set-current", async (req, res) => {
  const { id } = req.params;
  if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB required" });
  const client = await pool.connect();
  try {
    const cur = await client.query("SELECT * FROM ai_content WHERE id = $1", [id]);
    if (cur.rows.length === 0) { client.release(); return res.status(404).json({ error: "Not found" }); }
    const newVer = cur.rows[0];
    if (newVer.type !== "pillar") { client.release(); return res.status(400).json({ error: "Only pillars can be promoted" }); }
    if (newVer.status !== "draft" && newVer.status !== "published") {
      client.release();
      return res.status(400).json({ error: `Cannot promote — version still ${newVer.status}` });
    }

    const basePillarId = newVer.base_pillar_id || newVer.id;

    // Find the current v1 (or whichever is currently live)
    const liveR = await client.query(
      "SELECT * FROM ai_content WHERE base_pillar_id = $1 AND is_current = TRUE AND id <> $2",
      [basePillarId, newVer.id]
    );
    const live = liveR.rows[0]; // may be undefined if no current set yet

    // Step 1: pull v2 content from WP if v2 has a wp post
    let v2Content = null;
    let v2Title = null;
    if (newVer.wordpress_post_id) {
      try {
        const wpResp = await fetch(`https://proswppp.com/wp-json/wp/v2/posts/${newVer.wordpress_post_id}?context=edit`, {
          headers: { Authorization: `Basic ${Buffer.from(`${process.env.WP_USER || ''}:${process.env.WP_APP_PASSWORD || ''}`).toString("base64")}` },
        });
        if (wpResp.ok) {
          const data = await wpResp.json();
          v2Content = data?.content?.raw || data?.content?.rendered || null;
          v2Title = data?.title?.raw || data?.title?.rendered || newVer.title;
        }
      } catch (e) {
        console.warn(`Could not fetch v2 WP content (${newVer.wordpress_post_id}):`, e.message);
      }
    }

    // Step 2: if there's a live post and we have v2 content, overwrite live post with v2's content
    if (live && live.wordpress_post_id && v2Content) {
      try {
        const patchResp = await fetch(`https://proswppp.com/wp-json/wp/v2/posts/${live.wordpress_post_id}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(`${process.env.WP_USER || ''}:${process.env.WP_APP_PASSWORD || ''}`).toString("base64")}`,
          },
          body: JSON.stringify({ title: v2Title, content: v2Content, status: "publish" }),
        });
        if (!patchResp.ok) console.warn(`WP PATCH on v1 (${live.wordpress_post_id}) failed: ${patchResp.status}`);
      } catch (e) {
        console.warn("WP PATCH on v1 errored:", e.message);
      }
    }

    // Step 3: trash the v2 draft post (cleanup)
    if (newVer.wordpress_post_id && live?.wordpress_post_id && newVer.wordpress_post_id !== live.wordpress_post_id) {
      try {
        await fetch(`https://proswppp.com/wp-json/wp/v2/posts/${newVer.wordpress_post_id}?force=false`, {
          method: "DELETE",
          headers: { Authorization: `Basic ${Buffer.from(`${process.env.WP_USER || ''}:${process.env.WP_APP_PASSWORD || ''}`).toString("base64")}` },
        });
      } catch (e) {
        console.warn("WP DELETE v2 draft errored:", e.message);
      }
    }

    // Step 4: DB flip — atomic transaction
    await client.query("BEGIN");
    await client.query("UPDATE ai_content SET is_current = FALSE, updated_at = NOW() WHERE base_pillar_id = $1", [basePillarId]);
    // v2 inherits v1's URL/post_id (the live SEO URL), saves v2's draft URL as legacy_wordpress_url for audit
    if (live && live.wordpress_post_id) {
      await client.query(
        `UPDATE ai_content SET is_current = TRUE,
                                wordpress_post_id = $1,
                                wordpress_url = $2,
                                legacy_wordpress_url = $3,
                                status = 'published',
                                published_at = NOW(),
                                updated_at = NOW()
         WHERE id = $4`,
        [live.wordpress_post_id, live.wordpress_url, newVer.wordpress_url || null, newVer.id]
      );
    } else {
      await client.query("UPDATE ai_content SET is_current = TRUE, updated_at = NOW() WHERE id = $1", [newVer.id]);
    }
    await client.query("COMMIT");
    client.release();
    res.json({ ok: true, id, version: newVer.version, basePillarId, demoted: live?.id, preserved_url: live?.wordpress_url });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    client.release();
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Phase 5 — AI SEO Content Ideas
// Weekly cron in n8n calls DataForSEO + Claude clustering, batch-posts ideas here.
// Derek reviews in AI Content → Ideas tab; approve converts to ai_content row.
// ============================================================================

const SEO_IDEAS_DEFAULT_SEEDS = [
  "swppp",
  "stormwater compliance",
  "erosion control plan",
  "construction stormwater permit",
  "msgp",
  "sediment control",
  "swppp inspection",
  "rain event monitoring",
  "stormwater contractors",
  "erosion and sediment control",
];

function normalizeKw(k) {
  return String(k || "").trim().toLowerCase().replace(/\s+/g, " ");
}

const MIN_IDEA_SCORE = parseInt(process.env.MIN_IDEA_SCORE || "50", 10);

function ideaOpportunityScore(idea) {
  const vol = idea.monthly_volume || 0;
  const comp = idea.competition_index == null ? 50 : idea.competition_index;
  const compMult = Math.max(0.05, 1 - comp / 100);
  const intentMult = idea.intent === "commercial" ? 1.4 : idea.intent === "local" ? 1.2 : 1.0;
  return Math.round(vol * compMult * intentMult);
}

// n8n: fetch current seed list (env-overridable)
app.get("/api/seo-ideas/seeds", (req, res) => {
  const fromEnv = process.env.SEO_IDEAS_SEEDS
    ? process.env.SEO_IDEAS_SEEDS.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  res.json({ seeds: fromEnv && fromEnv.length ? fromEnv : SEO_IDEAS_DEFAULT_SEEDS });
});

// n8n: dedup helper — keywords we already target (live ai_content) or already proposed/rejected
app.get("/api/seo-ideas/known-keywords", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ keywords: [] });
  try {
    const live = await pool.query("SELECT DISTINCT keyword FROM ai_content WHERE keyword IS NOT NULL");
    const ideas = await pool.query("SELECT DISTINCT keyword_normalized FROM seo_ideas WHERE status IN ('pending','approved','rejected','converted')");
    const set = new Set();
    for (const r of live.rows) set.add(normalizeKw(r.keyword));
    for (const r of ideas.rows) set.add(r.keyword_normalized);
    res.json({ keywords: Array.from(set) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// n8n: existing articles + pending ideas for cannibalization avoidance — pass to Claude
app.get("/api/seo-ideas/existing-articles", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ articles: [], pending_ideas: [] });
  try {
    const articlesRes = await pool.query(
      `SELECT type, state, title, keyword
         FROM ai_content
        WHERE (is_current IS TRUE OR is_current IS NULL)
          AND status NOT IN ('failed')
          AND title IS NOT NULL
        ORDER BY type, state NULLS LAST, title`
    );
    const pendingRes = await pool.query(
      `SELECT suggested_type AS type, state, suggested_title AS title, target_keyword AS keyword
         FROM seo_ideas
        WHERE status IN ('pending','approved')
          AND suggested_title IS NOT NULL
        ORDER BY suggested_type, state NULLS LAST, suggested_title`
    );
    res.json({
      articles: articlesRes.rows.map((row) => ({
        type: row.type,
        state: row.state,
        title: row.title,
        keyword: row.keyword,
      })),
      pending_ideas: pendingRes.rows.map((row) => ({
        type: row.type,
        state: row.state,
        title: row.title,
        keyword: row.keyword,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// n8n batch insert (HMAC-protected)
app.post("/api/seo-ideas/batch", express.json({ limit: "2mb" }), async (req, res) => {
  const sig = req.headers["x-callback-signature"];
  const computed = crypto.createHmac("sha256", N8N_CALLBACK_SECRET).update(JSON.stringify(req.body)).digest("hex");
  if (sig !== computed) return res.status(401).json({ error: "Invalid signature" });

  const { batch_id, ideas } = req.body || {};
  if (!batch_id || !Array.isArray(ideas) || ideas.length === 0) {
    return res.status(400).json({ error: "batch_id and ideas[] required" });
  }
  if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB required" });

  let inserted = 0;
  let skipped = 0;
  let filtered = 0;
  const errors = [];

  // Cannibalization guard prep: load existing live keywords + open seo_ideas keywords + state pillars once
  const liveRes = await pool.query("SELECT DISTINCT keyword FROM ai_content WHERE keyword IS NOT NULL AND (is_current IS TRUE OR is_current IS NULL)");
  const liveKeywords = liveRes.rows.map((r) => normalizeKw(r.keyword));
  const openIdeasRes = await pool.query("SELECT DISTINCT keyword_normalized FROM seo_ideas WHERE status IN ('pending','approved','converted')");
  const openIdeaKeywords = openIdeasRes.rows.map((r) => r.keyword_normalized).filter(Boolean);
  // Combined set used for substring overlap detection (live articles + already-proposed ideas)
  const overlapSet = [...new Set([...liveKeywords, ...openIdeaKeywords])];
  const pillarStatesRes = await pool.query("SELECT DISTINCT state FROM ai_content WHERE type = 'pillar' AND state IS NOT NULL AND (is_current IS TRUE OR is_current IS NULL)");
  const pillarStates = new Set(pillarStatesRes.rows.map((r) => String(r.state).toLowerCase().trim()));
  const pendingPillarStatesRes = await pool.query("SELECT DISTINCT state FROM seo_ideas WHERE suggested_type = 'pillar' AND state IS NOT NULL AND status IN ('pending','approved')");
  const pendingPillarStates = new Set(pendingPillarStatesRes.rows.map((r) => String(r.state).toLowerCase().trim()));

  // Within-batch dedup: sort ideas by descending volume so the strongest variant wins;
  // weaker overlapping siblings get rejected against an in-flight inserted set.
  const sortedIdeas = [...ideas].sort((a, b) => (b.monthly_volume || 0) - (a.monthly_volume || 0));
  const insertedThisBatch = []; // normalized keywords inserted so far this batch
  const insertedPillarStatesThisBatch = new Set();

  for (const idea of sortedIdeas) {
    const kn = normalizeKw(idea.target_keyword);
    if (!kn) { skipped++; continue; }

    // Guard 0: score threshold — skip Minimal-tier ideas
    if (ideaOpportunityScore(idea) < MIN_IDEA_SCORE) { filtered++; continue; }

    // Guard 1: state-pillar dedup — refuse a new pillar for a state that already has one
    // (live ai_content OR already-pending idea OR already-inserted earlier in this batch)
    if (idea.suggested_type === "pillar" && idea.state) {
      const sLower = String(idea.state).toLowerCase().trim();
      if (pillarStates.has(sLower) || pendingPillarStates.has(sLower) || insertedPillarStatesThisBatch.has(sLower)) {
        errors.push({ keyword: idea.target_keyword, error: `pillar already exists or pending for ${idea.state}` });
        skipped++;
        continue;
      }
    }

    // Guard 2: keyword-substring overlap with live ai_content OR already-proposed ideas
    const overlap = overlapSet.find((k) => k && (k === kn || k.includes(kn) || kn.includes(k)));
    if (overlap) {
      errors.push({ keyword: idea.target_keyword, error: `cannibalization risk: overlaps "${overlap}"` });
      skipped++;
      continue;
    }

    // Guard 3: within-batch dedup — substring overlap against earlier inserts in this same batch
    const inBatch = insertedThisBatch.find((k) => k === kn || k.includes(kn) || kn.includes(k));
    if (inBatch) {
      errors.push({ keyword: idea.target_keyword, error: `within-batch dedup: overlaps stronger sibling "${inBatch}"` });
      skipped++;
      continue;
    }

    try {
      const result = await pool.query(
        `INSERT INTO seo_ideas (
           suggested_title, target_keyword, keyword_normalized, suggested_type,
           parent_pillar_keyword, state, monthly_volume, competition_index, cpc_usd,
           difficulty_score, intent, why_write, cluster_name, batch_id, raw_metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (keyword_normalized) WHERE status IN ('pending','approved') DO NOTHING
         RETURNING id`,
        [
          idea.suggested_title,
          idea.target_keyword,
          kn,
          idea.suggested_type || "spoke",
          idea.parent_pillar_keyword || null,
          idea.state || null,
          idea.monthly_volume ?? null,
          idea.competition_index ?? null,
          idea.cpc_usd ?? null,
          idea.difficulty_score ?? null,
          idea.intent || null,
          idea.why_write || null,
          idea.cluster_name || null,
          batch_id,
          idea.raw_metadata || {},
        ]
      );
      if (result.rowCount === 0) {
        skipped++;
      } else {
        inserted++;
        insertedThisBatch.push(kn);
        if (idea.suggested_type === "pillar" && idea.state) {
          insertedPillarStatesThisBatch.add(String(idea.state).toLowerCase().trim());
        }
      }
    } catch (err) {
      errors.push({ keyword: idea.target_keyword, error: err.message });
    }
  }
  res.json({ ok: true, batch_id, inserted, skipped, filtered, min_score: MIN_IDEA_SCORE, errors });
});

app.get("/api/seo-ideas", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json([]);
  const status = req.query.status || "pending";
  const batch_id = req.query.batch_id;
  try {
    const params = [];
    let query = "SELECT * FROM seo_ideas WHERE 1=1";
    if (status !== "all") { params.push(status); query += ` AND status = $${params.length}`; }
    if (batch_id) { params.push(batch_id); query += ` AND batch_id = $${params.length}`; }
    query += " ORDER BY (monthly_volume IS NULL), monthly_volume DESC NULLS LAST, created_at DESC";
    const r = await pool.query(query, params);
    res.json(r.rows.map((row) => ({
      id: row.id,
      suggestedTitle: row.suggested_title,
      targetKeyword: row.target_keyword,
      suggestedType: row.suggested_type,
      parentPillarKeyword: row.parent_pillar_keyword,
      state: row.state,
      monthlyVolume: row.monthly_volume,
      competitionIndex: row.competition_index,
      cpcUsd: row.cpc_usd != null ? Number(row.cpc_usd) : null,
      difficultyScore: row.difficulty_score,
      intent: row.intent,
      whyWrite: row.why_write,
      clusterName: row.cluster_name,
      status: row.status,
      convertedToContentId: row.converted_to_content_id,
      batchId: row.batch_id,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/seo-ideas/batches", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT batch_id,
              MIN(created_at) AS created_at,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='pending')::int AS pending,
              COUNT(*) FILTER (WHERE status='approved')::int AS approved,
              COUNT(*) FILTER (WHERE status='rejected')::int AS rejected,
              COUNT(*) FILTER (WHERE status='converted')::int AS converted
       FROM seo_ideas
       GROUP BY batch_id
       ORDER BY created_at DESC
       LIMIT 20`
    );
    res.json(r.rows.map((row) => ({
      batchId: row.batch_id,
      createdAt: row.created_at,
      total: row.total,
      pending: row.pending,
      approved: row.approved,
      rejected: row.rejected,
      converted: row.converted,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/seo-ideas/:id/reject", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB required" });
  try {
    const r = await pool.query(
      "UPDATE seo_ideas SET status = 'rejected', reviewed_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING id",
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Not found or already reviewed" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve → create ai_content row → mark idea converted
app.post("/api/seo-ideas/:id/approve", express.json(), async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB required" });
  const { id } = req.params;
  const { typeOverride, stateOverride, pillarId, kickoffNow } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ideaRes = await client.query("SELECT * FROM seo_ideas WHERE id = $1", [id]);
    if (ideaRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Idea not found" });
    }
    const idea = ideaRes.rows[0];
    if (idea.status !== "pending" && idea.status !== "approved") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Idea is ${idea.status}, cannot approve` });
    }

    const finalType = typeOverride || idea.suggested_type || "spoke";
    const finalState = stateOverride !== undefined ? stateOverride : idea.state;

    // For pillars use the canonical state-keyword; for others use idea's target keyword
    let finalKeyword = idea.target_keyword;
    if (finalType === "pillar") {
      if (!finalState) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "state required for pillar" });
      }
      finalKeyword = `Construction & Industrial SWPPP Requirements in ${finalState}`;
      const existing = await client.query(
        "SELECT id FROM ai_content WHERE type = 'pillar' AND state = $1 AND is_current = TRUE",
        [finalState]
      );
      if (existing.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Pillar already exists for ${finalState}`, existingId: existing.rows[0].id });
      }
    }

    // Auto-link spoke to current pillar if not specified
    let linkPillarId = pillarId || null;
    if (finalType === "spoke" && finalState && !linkPillarId) {
      const pillar = await client.query(
        "SELECT id FROM ai_content WHERE type = 'pillar' AND state = $1 AND is_current = TRUE ORDER BY version DESC LIMIT 1",
        [finalState]
      );
      if (pillar.rows.length > 0) linkPillarId = pillar.rows[0].id;
    }

    const newId = `content_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const basePillarId = finalType === "pillar" ? newId : null;
    await client.query(
      `INSERT INTO ai_content (id, type, status, keyword, state, pillar_id, base_pillar_id, version, is_current, title)
       VALUES ($1,$2,'queued',$3,$4,$5,$6,1,TRUE,$7)`,
      [newId, finalType, finalKeyword, finalState, linkPillarId, basePillarId, idea.suggested_title]
    );

    await client.query(
      "UPDATE seo_ideas SET status = 'converted', converted_to_content_id = $1, reviewed_at = NOW(), updated_at = NOW() WHERE id = $2",
      [newId, id]
    );

    await client.query("COMMIT");

    // Optional fire-and-forget kickoff to existing /generate flow
    if (kickoffNow) {
      fetch(`${RAILWAY_PUBLIC_URL}/api/ai-content/${newId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: req.headers.authorization || "" },
      }).catch((err) => console.error("Kickoff failed:", err));
    }

    res.json({ ok: true, contentId: newId, type: finalType, state: finalState, keyword: finalKeyword, kickedOff: !!kickoffNow });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================================
// Lead Import — replaces Dropbox folder rotation
// React drops CSV → /api/leads/upload → n8n unified workflow → callbacks
// ============================================================================

app.post("/api/leads/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!req.file.originalname.toLowerCase().endsWith(".csv")) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Only CSV files accepted" });
  }
  if (!process.env.DATABASE_URL) {
    fs.unlinkSync(req.file.path);
    return res.status(503).json({ error: "Database required for lead imports" });
  }

  let jobId;
  try {
    const result = await pool.query(
      `INSERT INTO lead_import_jobs (filename, uploaded_by, status) VALUES ($1, $2, 'uploaded') RETURNING id`,
      [req.file.originalname, req.body.uploaded_by || null]
    );
    jobId = result.rows[0].id;
  } catch (err) {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: `Job creation failed: ${err.message}` });
  }

  let csvBase64;
  try {
    const fileBuffer = fs.readFileSync(req.file.path);
    csvBase64 = fileBuffer.toString("base64");
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }

  // Fire n8n webhook async — n8n parses, batches, runs AI abbreviations + Pipedrive create,
  // posts callbacks at each stage. Don't await; status polling handles UI updates.
  fetch(N8N_LEAD_IMPORT_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      filename: req.file.originalname,
      csv_base64: csvBase64,
      callback_url: `${RAILWAY_PUBLIC_URL}/api/leads/upload/callback`,
      callback_secret: N8N_CALLBACK_SECRET,
    }),
  }).catch((err) => {
    console.error("[lead-import] n8n webhook fire failed:", err.message);
    pool.query(
      `UPDATE lead_import_jobs SET status='error', error_message=$1, updated_at=NOW() WHERE id=$2`,
      [`n8n webhook unreachable: ${err.message}`, jobId]
    ).catch(() => {});
  });

  res.json({ job_id: jobId, status: "uploaded" });
});

// Auto-mark stuck jobs as error if no progress for STUCK_MINUTES.
// Runs both inline (on status polling) AND on a 5-min interval so jobs get
// reaped even when no one is actively viewing the UI.
const STUCK_MINUTES = 60;
async function reapStuckJobs() {
  if (!process.env.DATABASE_URL) return;
  try {
    const result = await pool.query(
      `UPDATE lead_import_jobs
         SET status = 'error',
             error_message = COALESCE(error_message, 'Auto-failed: no progress for ' || $1 || ' min'),
             updated_at = NOW()
       WHERE status IN ('uploaded','cleaning','uploading')
         AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
       RETURNING id`,
      [STUCK_MINUTES]
    );
    if (result.rowCount > 0) {
      console.log(`[lead-import] reaped ${result.rowCount} stuck job(s)`);
    }
  } catch (err) {
    console.error("[lead-import] reap stuck jobs failed:", err.message);
  }
}

// Background reaper — runs every 5 min so jobs are auto-failed even
// when no one is polling the UI (covers full n8n instance crash case)
if (process.env.DATABASE_URL) {
  setInterval(() => { reapStuckJobs().catch(() => {}); }, 5 * 60 * 1000);
}

app.get("/api/leads/upload/:job_id/status", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database required" });
  try {
    await reapStuckJobs();
    const result = await pool.query(
      `SELECT id, filename, status, total_rows, cleaned_rows, uploaded_rows, error_message, created_at, updated_at
       FROM lead_import_jobs WHERE id = $1`,
      [req.params.job_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Job not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/leads/upload/:job_id", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database required" });
  try {
    const result = await pool.query(
      `DELETE FROM lead_import_jobs WHERE id = $1 RETURNING id`,
      [req.params.job_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Job not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/leads/upload", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database required" });
  try {
    await reapStuckJobs();
    const result = await pool.query(
      `SELECT id, filename, status, total_rows, cleaned_rows, uploaded_rows, error_message, created_at, updated_at
       FROM lead_import_jobs ORDER BY created_at DESC LIMIT 25`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/leads/upload/callback", express.json({ limit: "1mb" }), async (req, res) => {
  if (N8N_CALLBACK_SECRET) {
    const sig = req.headers["x-callback-signature"];
    const computed = crypto
      .createHmac("sha256", N8N_CALLBACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");
    if (sig !== computed) return res.status(401).json({ error: "Invalid signature" });
  }

  const { job_id, status, total_rows, cleaned_rows_delta, uploaded_rows_delta, error_message } = req.body;
  if (!job_id) return res.status(400).json({ error: "job_id required" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database required" });

  try {
    const fields = ["updated_at = NOW()"];
    const params = [];
    if (status) { params.push(status); fields.push(`status = $${params.length}`); }
    if (typeof total_rows === "number") { params.push(total_rows); fields.push(`total_rows = $${params.length}`); }
    if (typeof cleaned_rows_delta === "number") { params.push(cleaned_rows_delta); fields.push(`cleaned_rows = COALESCE(cleaned_rows,0) + $${params.length}`); }
    if (typeof uploaded_rows_delta === "number") { params.push(uploaded_rows_delta); fields.push(`uploaded_rows = COALESCE(uploaded_rows,0) + $${params.length}`); }
    if (error_message) { params.push(error_message); fields.push(`error_message = $${params.length}`); }
    else if (status === "done") { fields.push(`error_message = NULL`); }
    params.push(job_id);
    await pool.query(
      `UPDATE lead_import_jobs SET ${fields.join(", ")} WHERE id = $${params.length}`,
      params
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// n8n persists parsed + cleaned rows here. Called per-row or in batches.
// Body: { job_id, rows: [{ row_index, raw_data, cleaned_data?, status? }, ...], callback_secret }
app.post("/api/leads/upload/rows/persist", express.json({ limit: "10mb" }), async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database required" });
  const { job_id, rows, callback_secret } = req.body || {};
  if (callback_secret !== N8N_CALLBACK_SECRET) return res.status(401).json({ error: "Invalid secret" });
  if (!job_id || !Array.isArray(rows)) return res.status(400).json({ error: "job_id and rows[] required" });

  try {
    for (const row of rows) {
      const { row_index, raw_data, cleaned_data, status } = row;
      if (typeof row_index !== "number" || !raw_data) continue;
      // Upsert by (job_id, row_index)
      await pool.query(
        `INSERT INTO lead_import_rows (job_id, row_index, raw_data, cleaned_data, status, updated_at)
         VALUES ($1, $2, $3, $4, COALESCE($5, 'pending'), NOW())
         ON CONFLICT (job_id, row_index) DO UPDATE
           SET raw_data = EXCLUDED.raw_data,
               cleaned_data = COALESCE(EXCLUDED.cleaned_data, lead_import_rows.cleaned_data),
               status = COALESCE($5, lead_import_rows.status),
               updated_at = NOW()`,
        [job_id, row_index, raw_data, cleaned_data || null, status || null]
      );
    }
    res.json({ ok: true, persisted: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add unique index for upsert (job_id, row_index)
app.get("/api/leads/upload/:job_id/rows", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database required" });

  // Backward-compat: if no `page` query param, return a plain array (old client shape).
  // New paginated client passes ?page=0&page_size=50&filter=...&search=...
  const isLegacyClient = req.query.page === undefined && req.query.page_size === undefined;
  if (isLegacyClient) {
    try {
      const result = await pool.query(
        `SELECT id, row_index, raw_data, cleaned_data, status, pipedrive_lead_id, error_message, updated_at
         FROM lead_import_rows WHERE job_id = $1
         ORDER BY (cleaned_data->>'abbreviation_fallback')::boolean DESC NULLS LAST, row_index ASC`,
        [req.params.job_id]
      );
      return res.json(result.rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const page = Math.max(0, parseInt(req.query.page) || 0);
  const pageSize = Math.min(200, Math.max(10, parseInt(req.query.page_size) || 50));
  const filter = (req.query.filter || "all").toString();
  const search = (req.query.search || "").toString().trim();

  try {
    const where = ["job_id = $1"];
    const params = [req.params.job_id];

    if (filter === "review") {
      where.push(`(cleaned_data->>'abbreviation_fallback')::boolean = true`);
    } else if (filter === "rejected") {
      where.push(`status = 'rejected'`);
    }

    if (search) {
      params.push(`%${search}%`);
      where.push(
        `(coalesce(cleaned_data->>'Project Title','') ILIKE $${params.length}
         OR coalesce(raw_data->>'Project Title','') ILIKE $${params.length}
         OR coalesce(raw_data->>'City','') ILIKE $${params.length}
         OR coalesce(raw_data->>'State','') ILIKE $${params.length})`
      );
    }

    const whereClause = `WHERE ${where.join(" AND ")}`;

    // Total count + summary counts (so UI can show 1.5k of 1.5k, X review, Y rejected)
    const summary = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status IN ('cleaned','approved'))::int AS approved,
         COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
         COUNT(*) FILTER (WHERE (cleaned_data->>'abbreviation_fallback')::boolean = true)::int AS review
       FROM lead_import_rows WHERE job_id = $1`,
      [req.params.job_id]
    );

    // Filtered count
    const filtered = await pool.query(
      `SELECT COUNT(*)::int AS count FROM lead_import_rows ${whereClause}`,
      params
    );

    // Sort: review-flagged first, then by row_index
    params.push(pageSize);
    params.push(page * pageSize);
    const result = await pool.query(
      `SELECT id, row_index, raw_data, cleaned_data, status, pipedrive_lead_id, error_message, updated_at
       FROM lead_import_rows ${whereClause}
       ORDER BY (cleaned_data->>'abbreviation_fallback')::boolean DESC NULLS LAST, row_index ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      rows: result.rows,
      page,
      page_size: pageSize,
      filtered_count: filtered.rows[0].count,
      summary: summary.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/leads/upload/:job_id/rows/:row_id", express.json({ limit: "100kb" }), async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database required" });
  const { cleaned_data, status } = req.body || {};
  try {
    const fields = ["updated_at = NOW()"];
    const params = [];
    if (cleaned_data) { params.push(cleaned_data); fields.push(`cleaned_data = $${params.length}`); }
    if (status) { params.push(status); fields.push(`status = $${params.length}`); }
    params.push(req.params.row_id, req.params.job_id);
    const result = await pool.query(
      `UPDATE lead_import_rows SET ${fields.join(", ")}
       WHERE id = $${params.length - 1} AND job_id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: "Row not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve: triggers n8n to push approved rows to Pipedrive.
// Marks all 'cleaned' rows as 'approved' (unless explicitly rejected) and fires the upload webhook.
app.post("/api/leads/upload/:job_id/approve", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database required" });
  const jobId = req.params.job_id;
  try {
    // Mark cleaned rows as approved
    await pool.query(
      `UPDATE lead_import_rows SET status = 'approved', updated_at = NOW()
       WHERE job_id = $1 AND status = 'cleaned'`,
      [jobId]
    );
    await pool.query(
      `UPDATE lead_import_jobs SET status = 'uploading', updated_at = NOW() WHERE id = $1`,
      [jobId]
    );

    // Fire n8n upload webhook
    const uploadWebhookUrl = "https://proswppp.app.n8n.cloud/webhook/lead-import-pipedrive-push";
    fetch(uploadWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        callback_url: `${RAILWAY_PUBLIC_URL}/api/leads/upload/callback`,
        callback_secret: N8N_CALLBACK_SECRET,
        rows_endpoint: `${RAILWAY_PUBLIC_URL}/api/leads/upload/${jobId}/rows?callback_secret=${encodeURIComponent(N8N_CALLBACK_SECRET)}`,
        rows_patch_url_template: `${RAILWAY_PUBLIC_URL}/api/leads/upload/${jobId}/rows/{row_id}?callback_secret=${encodeURIComponent(N8N_CALLBACK_SECRET)}`,
      }),
    }).catch((err) => {
      console.error("[lead-import] approve webhook fire failed:", err.message);
      pool.query(
        `UPDATE lead_import_jobs SET status='error', error_message=$1, updated_at=NOW() WHERE id=$2`,
        [`approve webhook failed: ${err.message}`, jobId]
      ).catch(() => {});
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Abbreviation cache — idempotency layer for AI title cleaning
// Same raw input → same cleaned output, prevents Pipedrive dedup breakage.
// ============================================================================

app.get("/api/abbreviation-cache", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ data: null });
  const raw = (req.query.raw || "").toString();
  if (!raw) return res.status(400).json({ error: "raw query param required" });
  try {
    const result = await pool.query(
      `SELECT clean, fallback FROM abbreviation_cache WHERE raw = $1`,
      [raw]
    );
    res.json({ data: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/abbreviation-cache", express.json({ limit: "100kb" }), async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ ok: true });
  const { raw, clean, fallback } = req.body;
  if (!raw || !clean) return res.status(400).json({ error: "raw and clean required" });
  try {
    await pool.query(
      `INSERT INTO abbreviation_cache (raw, clean, fallback) VALUES ($1, $2, $3) ON CONFLICT (raw) DO NOTHING`,
      [raw, clean, !!fallback]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analyze Civil Plans with Gemini
app.post("/api/projects/:id/analyze-plans", upload.single("file"), async (req, res) => {
  const { id } = req.params;
  req.setTimeout(600000); // 10 min for large files + compression + Gemini
  res.setTimeout(600000);
  const tempFiles = []; // Track multer temp files for cleanup

  try {
    let analysisData;
    const INLINE_LIMIT = 15 * 1024 * 1024; // 15 MB — max for Gemini inline base64
    const PDFLIB_LIMIT = 100 * 1024 * 1024; // 100 MB — max for pdf-lib page count read
    let pdfBuffer;

    if (req.file) {
      // === UPLOAD PATH (up to 300 MB, disk storage) ===
      tempFiles.push(req.file.path);
      const { projectName } = req.body;
      console.log(`Analyzing uploaded PDF: ${projectName || id} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);
      if (!req.file.originalname.toLowerCase().endsWith(".pdf")) {
        return res.status(400).json({ error: "Only PDF files are supported." });
      }
      pdfBuffer = fs.readFileSync(req.file.path);

    } else {
      // === LINK PATH (max 20 MB download) ===
      const { civilDrawingsLink, projectName } = req.body;
      if (!civilDrawingsLink) {
        return res.status(400).json({ error: "No file or civilDrawingsLink provided." });
      }
      console.log(`Downloading civil plans from link: ${projectName || id}`);

      let downloadUrl = civilDrawingsLink;
      if (downloadUrl.includes("dropbox.com")) {
        downloadUrl = downloadUrl.replace(/([?&])dl=0/, "$1dl=1");
        if (!downloadUrl.includes("dl=")) downloadUrl += (downloadUrl.includes("?") ? "&" : "?") + "dl=1";
      }

      const pdfFetch = await fetch(downloadUrl, { signal: AbortSignal.timeout(90000) });
      if (!pdfFetch.ok) {
        return res.status(400).json({ error: `Could not download PDF (HTTP ${pdfFetch.status}). Try uploading directly.` });
      }
      if ((pdfFetch.headers.get("content-type") || "").includes("text/html")) {
        return res.status(400).json({ error: "Link returned an HTML page, not a PDF. Use a direct file link or upload directly." });
      }
      const MAX_DOWNLOAD = 20 * 1024 * 1024;
      const chunks = [];
      let totalSize = 0;
      for await (const chunk of pdfFetch.body) {
        totalSize += chunk.length;
        if (totalSize > MAX_DOWNLOAD) return res.status(400).json({ error: "PDF exceeds 20 MB via link. Upload the file directly for larger files (up to 300 MB)." });
        chunks.push(chunk);
      }
      pdfBuffer = Buffer.concat(chunks);
      console.log(`Downloaded ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB`);
    }

    let pdfPages = null;
    const FILE_API_LIMIT = 50 * 1024 * 1024; // 50 MB — Gemini generateContent file limit

    // Get page count (only for files small enough for pdf-lib)
    if (pdfBuffer.length <= PDFLIB_LIMIT) {
      try {
        const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
        pdfPages = pdfDoc.getPageCount();
      } catch (_) {}
    }

    // === Choose analysis approach based on file size ===
    if (pdfBuffer.length <= INLINE_LIMIT) {
      // FAST PATH: inline base64 (≤ 15 MB) — all pages
      const base64Data = pdfBuffer.toString("base64");
      console.log(`Sending ${(base64Data.length / 1024 / 1024).toFixed(1)} MB base64 (${pdfPages ?? "?"} pages) inline to Gemini...`);
      analysisData = await callGemini([
        { inline_data: { mime_type: "application/pdf", data: base64Data } },
        { text: GEMINI_PROMPT },
      ]);
    } else if (pdfBuffer.length <= FILE_API_LIMIT) {
      // MEDIUM PATH: Gemini File API (15–50 MB) — all pages
      console.log(`PDF is ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB (${pdfPages ?? "?"} pages) — using Gemini File API...`);
      const tempPath = path.join(os.tmpdir(), `swppp-gemini-${Date.now()}.pdf`);
      fs.writeFileSync(tempPath, pdfBuffer);
      tempFiles.push(tempPath);
      pdfBuffer = null;
      analysisData = await callGeminiWithFile(tempPath);
    } else {
      // LARGE PATH (> 50 MB): compress with Ghostscript, then File API or split
      console.log(`PDF is ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB (${pdfPages ?? "?"} pages) — exceeds ${(FILE_API_LIMIT / 1024 / 1024).toFixed(0)} MB File API limit`);

      // Write buffer to disk for Ghostscript (works on files of any size, no memory spike)
      const gsInputPath = req.file?.path || path.join(os.tmpdir(), `swppp-gs-in-${Date.now()}.pdf`);
      if (!req.file) { fs.writeFileSync(gsInputPath, pdfBuffer); tempFiles.push(gsInputPath); }
      const gsOutputPath = path.join(os.tmpdir(), `swppp-gs-out-${Date.now()}.pdf`);
      tempFiles.push(gsOutputPath);

      // Step 1: Try Ghostscript compression (200 DPI, JPEG, preserves drawing detail)
      try {
        console.log("Compressing with Ghostscript...");
        await compressWithGhostscript(gsInputPath, gsOutputPath);
        const gsSize = fs.statSync(gsOutputPath).size;
        console.log(`Ghostscript: ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB → ${(gsSize / 1024 / 1024).toFixed(1)} MB`);
        if (gsSize < pdfBuffer.length) {
          pdfBuffer = fs.readFileSync(gsOutputPath);
        }
      } catch (e) {
        console.warn("Ghostscript not available or failed:", e.message);
        // Fallback: try pdf.co compression for files up to 100 MB
        const PDFCO_UPLOAD_LIMIT = 100 * 1024 * 1024;
        if (PDF_CO_API_KEY && pdfBuffer.length <= PDFCO_UPLOAD_LIMIT) {
          console.log("Falling back to pdf.co compression...");
          const compressed = await compressWithPdfCo(pdfBuffer);
          if (compressed && compressed.length < pdfBuffer.length) pdfBuffer = compressed;
        }
      }

      // Step 2: If compressed to ≤ 50 MB, send directly via File API (all pages, single file)
      if (pdfBuffer.length <= FILE_API_LIMIT) {
        console.log(`Compressed to ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB — using File API (all pages)...`);
        const tempPath = path.join(os.tmpdir(), `swppp-gemini-${Date.now()}.pdf`);
        fs.writeFileSync(tempPath, pdfBuffer);
        tempFiles.push(tempPath);
        pdfBuffer = null;
        analysisData = await callGeminiWithFile(tempPath);
      } else {
        // Step 3: Still > 50 MB — split into chunks and send all via File API (all pages)
        console.log(`Still ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB — splitting into chunks for multi-file analysis...`);
        const chunks = await splitPdf(pdfBuffer, FILE_API_LIMIT);
        pdfPages = chunks[0]?.totalPages || null;
        pdfBuffer = null; // Free memory

        // Upload all chunks to Gemini File API
        const fileManager = new GoogleAIFileManager(GEMINI_API_KEY);
        const uploadedChunks = [];
        for (const chunk of chunks) {
          const chunkPath = path.join(os.tmpdir(), `swppp-chunk-${Date.now()}-${chunk.startPage}.pdf`);
          fs.writeFileSync(chunkPath, chunk.buffer);
          tempFiles.push(chunkPath);
          console.log(`Uploading chunk pages ${chunk.startPage}-${chunk.endPage} (${(chunk.buffer.length / 1024 / 1024).toFixed(1)} MB)...`);
          const result = await fileManager.uploadFile(chunkPath, {
            mimeType: "application/pdf",
            displayName: `plans-p${chunk.startPage}-${chunk.endPage}.pdf`,
          });
          let file = result.file;
          while (file.state === "PROCESSING") {
            await new Promise(r => setTimeout(r, 3000));
            file = await fileManager.getFile(file.name);
          }
          if (file.state === "FAILED") throw new Error(`Chunk upload failed for pages ${chunk.startPage}-${chunk.endPage}`);
          uploadedChunks.push({ ...chunk, uri: file.uri, mimeType: file.mimeType });
        }

        // Build multi-file generateContent request
        console.log(`Analyzing ${uploadedChunks.length} chunks (${pdfPages} total pages) with Gemini...`);
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
          model: GEMINI_MODEL,
          generationConfig: { maxOutputTokens: 8192, temperature: 0.1 },
        });
        const parts = [];
        for (const chunk of uploadedChunks) {
          parts.push({ text: `Civil Plans pages ${chunk.startPage}-${chunk.endPage} of ${chunk.totalPages}:` });
          parts.push({ fileData: { mimeType: chunk.mimeType, fileUri: chunk.uri } });
        }
        parts.push({ text: GEMINI_PROMPT });

        const result = await model.generateContent(parts);
        const text = result.response.text();
        if (!text) throw new Error("Gemini returned empty response.");
        const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
        analysisData = JSON.parse(cleaned);

        const u = result.response.usageMetadata || {};
        const inputTokens = u.promptTokenCount || 0;
        const outputTokens = u.candidatesTokenCount || 0;
        const thoughtsTokens = u.thoughtsTokenCount || 0;
        analysisData._usage = {
          inputTokens, outputTokens, thoughtsTokens,
          totalTokens: u.totalTokenCount || 0,
          estimatedCostUSD: (inputTokens * 1.25 + outputTokens * 10.00) / 1_000_000,
          chunks: uploadedChunks.length,
        };
        console.log(`Gemini tokens — in: ${inputTokens}, out: ${outputTokens}, thinking: ${thoughtsTokens}, chunks: ${uploadedChunks.length} (~$${analysisData._usage.estimatedCostUSD.toFixed(4)})`);
      }
    }

    if (analysisData._usage && pdfPages !== null) {
      analysisData._usage.pdfPages = pdfPages;
      analysisData._usage.costPerPage = pdfPages > 0
        ? analysisData._usage.estimatedCostUSD / pdfPages
        : null;
    }

    // Save to DB
    if (process.env.DATABASE_URL) {
      const current = await pool.query("SELECT data FROM projects WHERE id = $1", [id]);
      if (current.rows.length > 0) {
        const updatedData = {
          ...current.rows[0].data,
          planAnalysisSummary: analysisData.summary || "",
          planAnalysisDate: new Date().toISOString(),
          planAnalysisRaw: analysisData,
        };
        await pool.query("UPDATE projects SET data = $1 WHERE id = $2", [updatedData, id]);
      }
    }

    res.json({ data: analysisData });
  } catch (err) {
    console.error("Plan analysis error:", err);
    if (err.name === "TimeoutError") {
      return res.status(504).json({ error: "Analysis timed out. The PDF may be too large or complex." });
    }
    if (err.message === "terminated" || err.message === "fetch failed") {
      return res.status(502).json({ error: "Connection was interrupted. Please try again." });
    }
    res.status(500).json({ error: err.message });
  } finally {
    // Clean up multer temp files from disk
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
});

// ── Automation Roadmap ──────────────────────────────────────────────
const VALID_TASK_STATUSES = ["planned", "in_progress", "blocked", "done"];

function mapTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    sortOrder: row.sort_order != null ? Number(row.sort_order) : 0,
    updates: Array.isArray(row.updates) ? row.updates : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

app.get("/api/automation-tasks", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json([]);
  try {
    const r = await pool.query(
      "SELECT * FROM automation_tasks ORDER BY sort_order ASC, created_at ASC"
    );
    res.json(r.rows.map(mapTask));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/automation-tasks", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB required" });
  const { title, description = "", status = "planned" } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "title is required" });
  if (!VALID_TASK_STATUSES.includes(status)) return res.status(400).json({ error: "invalid status" });
  try {
    const next = await pool.query("SELECT COALESCE(MAX(sort_order), 0) + 1000 AS n FROM automation_tasks");
    const r = await pool.query(
      `INSERT INTO automation_tasks (title, description, status, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title.trim(), description, status, next.rows[0].n]
    );
    res.status(201).json(mapTask(r.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/automation-tasks/:id", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB required" });
  const { title, description, status, sortOrder } = req.body || {};
  if (status !== undefined && !VALID_TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: "invalid status" });
  }
  const sets = [];
  const params = [];
  if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
  if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
  if (status !== undefined) { params.push(status); sets.push(`status = $${params.length}`); }
  if (sortOrder !== undefined) { params.push(sortOrder); sets.push(`sort_order = $${params.length}`); }
  if (sets.length === 0) return res.status(400).json({ error: "no fields to update" });
  sets.push("updated_at = NOW()");
  params.push(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE automation_tasks SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.json(mapTask(r.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/automation-tasks/:id/updates", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB required" });
  const { author = "", body = "" } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: "body is required" });
  const entry = {
    id: crypto.randomUUID(),
    author: (author || "").trim() || "Pro SWPPP",
    body: body.trim(),
    created_at: new Date().toISOString(),
  };
  try {
    const r = await pool.query(
      `UPDATE automation_tasks
       SET updates = updates || $1::jsonb, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([entry]), req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.status(201).json(mapTask(r.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/automation-tasks/:id", async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(501).json({ error: "DB required" });
  try {
    const r = await pool.query("DELETE FROM automation_tasks WHERE id = $1 RETURNING id", [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Multer error handler — returns JSON instead of Express default HTML
app.use((err, _req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File is too large. Maximum upload size is 300 MB." });
  }
  next(err);
});

// Cleanup Task — archived projects
setInterval(async () => {
  if (!process.env.DATABASE_URL) return;
  try {
    const result = await pool.query(
      "DELETE FROM projects WHERE archived = TRUE AND deleted_at < NOW() - INTERVAL '30 days'"
    );
    if (result.rowCount > 0) {
      console.log(`Cleaned up ${result.rowCount} expired archived projects.`);
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}, 24 * 60 * 60 * 1000);

// AI Content — timeout stuck "generating" items after 10 minutes
setInterval(async () => {
  if (!process.env.DATABASE_URL) return;
  try {
    const result = await pool.query(
      "UPDATE ai_content SET status = 'failed', error_message = 'Generation timed out after 10 minutes', updated_at = NOW() WHERE status = 'generating' AND updated_at < NOW() - INTERVAL '10 minutes'"
    );
    if (result.rowCount > 0) {
      console.log(`Timed out ${result.rowCount} stuck generating articles.`);
    }
  } catch (err) {
    console.error("AI content timeout error:", err);
  }
}, 60 * 1000); // Check every minute

// Brevo Nurture lane routes (inherit the /api/sdr/* JWT + basic-auth perimeter above).
// MUST be registered before the SPA catch-all below, or authenticated GETs to these
// routes get shadowed by the index.html fallback.
registerNurtureRoutes(app, pool);
registerPermitRoutes(app, pool);
registerPermitExportRoutes(app, pool);

// Serve static files from the dist directory
app.use(express.static(path.join(__dirname, "dist")));

// Fallback for SPA
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
