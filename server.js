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
    (req.path === "/api/abbreviation-cache" && (req.method === "GET" || req.method === "POST"))
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
    console.log("Table 'ai_content' verified/created.");

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
  } catch (err) {
    console.error("CRITICAL: Error initializing database:", err);
  }
}

initDB();

// Fallback in-memory store if no DB is connected (for local dev)
let memoryProjects = [];
let memoryArchive = [];
let memoryContent = [];

// API Routes
app.get("/health", (req, res) => {
  res.json({ status: "ok", database: !!process.env.DATABASE_URL });
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
    // Enforce one pillar per state unless explicitly forced
    if (!force) {
      if (process.env.DATABASE_URL) {
        const existing = await pool.query("SELECT id FROM ai_content WHERE type = 'pillar' AND state = $1", [state]);
        if (existing.rows.length > 0) return res.status(409).json({ error: `Pillar already exists for ${state}`, existingId: existing.rows[0].id });
      } else {
        const existing = memoryContent.find((c) => c.type === "pillar" && c.state === state);
        if (existing) return res.status(409).json({ error: `Pillar already exists for ${state}`, existingId: existing.id });
      }
    }
  }

  if (!type || !keyword) return res.status(400).json({ error: "type and keyword required" });

  // Auto-link spoke to state pillar if not specified
  if (type === "spoke" && state && !pillarId) {
    if (process.env.DATABASE_URL) {
      const pillar = await pool.query("SELECT id FROM ai_content WHERE type = 'pillar' AND state = $1 LIMIT 1", [state]);
      if (pillar.rows.length > 0) pillarId = pillar.rows[0].id;
    } else {
      const pillar = memoryContent.find((c) => c.type === "pillar" && c.state === state);
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
    await pool.query(
      `INSERT INTO ai_content (id, type, status, keyword, state, pillar_id)
       VALUES ($1, $2, 'queued', $3, $4, $5)`,
      [id, type, keyword, state || null, pillarId || null]
    );
    const result = await pool.query("SELECT * FROM ai_content WHERE id = $1", [id]);
    const r = result.rows[0];
    res.status(201).json({
      id: r.id, type: r.type, status: r.status, keyword: r.keyword,
      state: r.state, pillarId: r.pillar_id,
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

    // Build pillar context if this is a spoke with a pillar
    let pillarContext = null;
    if (row.type === "spoke" && row.pillar_id) {
      const pillar = await pool.query("SELECT keyword, wordpress_url FROM ai_content WHERE id = $1", [row.pillar_id]);
      if (pillar.rows.length > 0) {
        pillarContext = {
          pillarKeyword: pillar.rows[0].keyword,
          pillarWordpressUrl: pillar.rows[0].wordpress_url,
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

// n8n callback — no auth (added to skip list above)
app.post("/api/ai-content/callback", async (req, res) => {
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
const STUCK_MINUTES = 15;
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

// Serve static files from the dist directory
app.use(express.static(path.join(__dirname, "dist")));

// Fallback for SPA
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
