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
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
// Disk storage for large PDFs (up to 300MB). Temp files cleaned up after processing.
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 300 * 1024 * 1024 } });


const N8N_WEBHOOK_URL =
  "https://proswppp.app.n8n.cloud/webhook/state-document-generator";

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
app.use(bodyParser.json());

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
    (req.path === "/api/projects" && req.method === "POST")
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
  } catch (err) {
    console.error("CRITICAL: Error initializing database:", err);
  }
}

initDB();

// Fallback in-memory store if no DB is connected (for local dev)
let memoryProjects = [];
let memoryArchive = [];

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
      // LARGE PATH (> 50 MB): compress first, then File API
      console.log(`PDF is ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB — exceeds ${(FILE_API_LIMIT / 1024 / 1024).toFixed(0)} MB File API limit, compressing...`);

      // Try pdf.co compression (presigned URL upload, supports up to 100 MB)
      if (PDF_CO_API_KEY) {
        console.log("Trying pdf.co compression...");
        const compressed = await compressWithPdfCo(pdfBuffer);
        if (compressed && compressed.length < pdfBuffer.length) {
          pdfBuffer = compressed;
        }
      }

      // Try pdf-lib compression (fast, local — only for files ≤ 100 MB)
      if (pdfBuffer.length > FILE_API_LIMIT && pdfBuffer.length <= PDFLIB_LIMIT) {
        try {
          console.log("Trying pdf-lib compression...");
          const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
          pdfPages = pdfDoc.getPageCount();
          const compressed = Buffer.from(await pdfDoc.save({ useObjectStreams: true }));
          if (compressed.length < pdfBuffer.length) {
            console.log(`pdf-lib: ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB → ${(compressed.length / 1024 / 1024).toFixed(1)} MB`);
            pdfBuffer = compressed;
          }
        } catch (e) {
          console.warn("pdf-lib compression failed:", e.message);
        }
      }

      if (pdfBuffer.length <= FILE_API_LIMIT) {
        // Compression worked — use File API (all pages)
        console.log(`Compressed to ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB — using File API (all pages)...`);
        const tempPath = path.join(os.tmpdir(), `swppp-gemini-${Date.now()}.pdf`);
        fs.writeFileSync(tempPath, pdfBuffer);
        tempFiles.push(tempPath);
        pdfBuffer = null;
        analysisData = await callGeminiWithFile(tempPath);
      } else {
        // Still too large — extract pages as last resort
        console.log(`Still ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB after compression — extracting pages...`);
        const PAGE_EXTRACT_LIMIT = 150 * 1024 * 1024;
        if (pdfBuffer.length <= PAGE_EXTRACT_LIMIT) {
          try {
            const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
            const totalPages = pdfDoc.getPageCount();
            pdfPages = totalPages;
            let pagesToExtract = Math.min(totalPages, 60);
            while (pagesToExtract >= 5) {
              const newDoc = await PDFDocument.create();
              const indices = Array.from({ length: pagesToExtract }, (_, i) => i);
              const copiedPages = await newDoc.copyPages(pdfDoc, indices);
              for (const page of copiedPages) newDoc.addPage(page);
              const extracted = Buffer.from(await newDoc.save());
              if (extracted.length <= FILE_API_LIMIT) {
                console.log(`Extracted ${pagesToExtract}/${totalPages} pages: ${(extracted.length / 1024 / 1024).toFixed(1)} MB — using File API`);
                const tempPath = path.join(os.tmpdir(), `swppp-gemini-${Date.now()}.pdf`);
                fs.writeFileSync(tempPath, extracted);
                tempFiles.push(tempPath);
                pdfBuffer = null;
                analysisData = await callGeminiWithFile(tempPath);
                break;
              }
              pagesToExtract = Math.floor(pagesToExtract * 0.7);
            }
          } catch (e) {
            console.warn("Page extraction failed:", e.message);
          }
        }
        if (!analysisData) {
          throw new Error(`PDF is too large for analysis (${(pdfBuffer.length / 1024 / 1024).toFixed(0)} MB). Try a smaller file.`);
        }
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

// Cleanup Task
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

// Serve static files from the dist directory
app.use(express.static(path.join(__dirname, "dist")));

// Fallback for SPA
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
