import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { PDFDocument } from "pdf-lib";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });


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
- This is used directly in a SWPPP document — provide a detailed, numbered sequence of ALL construction phases
- Standard SWPPP phases to look for and include (adapt based on what the project actually shows):
  1. Mobilization and installation of erosion/sediment controls (silt fence, inlet protection, construction entrance)
  2. Site clearing, demolition, and tree removal (if applicable)
  3. Rough grading and earthwork/mass excavation
  4. Underground utilities installation (water, sewer, storm drain, electrical, gas)
  5. Subgrade preparation
  6. Paving, curb and gutter, concrete flatwork
  7. Vertical construction (foundations, framing, building construction)
  8. Finish grading and final earthwork
  9. Landscaping, seeding, sodding, and permanent stabilization
  10. Removal of temporary erosion controls and site cleanup
- Write each activity as a complete sentence. Be specific to the project type (residential, commercial, utility, road, etc.)
- Minimum 6-8 activities; more if the project warrants it

INSTRUCTIONS FOR SOIL AND WATERWAY DATA:
- soilComposition: Look for soil boring logs, geotechnical notes, soil survey references, or any mention of soil types (clay, sandy loam, etc.). If none found, return null.
- nearestWaterbody: Look for any streams, rivers, lakes, creeks, drainage channels, or water features labeled on the plans or in drainage notes.
- waterbodyImpairment: Look for any notes about 303(d) listed waters, impaired waters, TMDL, or water quality concerns. Return "not impaired" if plans show no impairment notes.
- siteCoordinates: Look for any GPS coordinates, latitude/longitude, or geographic coordinates on the plans (often on cover sheet or location map).

EXTRACT ALL OF THE FOLLOWING (set to null if truly not findable):

{
  "estimatedDisturbedArea": { "value": "number in acres", "method": "explicit_label | calculated_from_dimensions | estimated_from_scale", "details": "how you determined this" },
  "totalProjectArea": { "value": "number in acres", "method": "explicit_label | calculated_from_dimensions | estimated_from_scale", "details": "how you determined this" },
  "projectDescription": "2-3 sentence description of the construction project type, scope, and key features",
  "sequenceOfActivities": "Full numbered sequence of construction activities as described above — write as a numbered list with each item on a new line (1. Activity one\n2. Activity two\n...)",
  "soilComposition": "soil types found in geotechnical notes or soil survey (e.g., 'Clay loam, sandy clay')",
  "nearestWaterbody": "name of nearest stream, river, lake, or water feature shown on or near the plans",
  "waterbodyImpairment": "impairment status — look for 303(d) listing, TMDL notes, or water quality notes. Use 'not impaired' if no issues noted.",
  "endangeredSpeciesNotes": "any notes about endangered/threatened species, critical habitat, wetlands, or sensitive ecological areas on the plans",
  "historicalPlacesNotes": "any notes about historical places, cultural resources, or archaeological sites",
  "projectStartDate": "MM/DD/YY if found on plans",
  "projectFinishDate": "MM/DD/YY if found on plans",
  "ownerName": "property or project owner name from title block or cover sheet",
  "ownerAddress": "owner mailing address",
  "ownerPhone": "owner or primary contact phone number",
  "ownerEmail": "owner or primary contact email",
  "contactPerson": "engineer of record, project manager, or primary contact name and credentials",
  "siteAddress": "project site street address from plans",
  "latitude": "decimal degrees latitude if shown on plans (e.g., 29.7604)",
  "longitude": "decimal degrees longitude if shown on plans (e.g., -95.3698)",
  "summary": "3-5 sentence overview of these civil plans including project type, key features, notable environmental or site conditions, and any stormwater-relevant details"
}

Return ONLY valid JSON, no markdown formatting.`;

async function callGemini(base64Data) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: "application/pdf", data: base64Data } }, { text: GEMINI_PROMPT }] }],
        generationConfig: { maxOutputTokens: 8192, temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(160000),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  const analysisData = JSON.parse(cleaned);

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
  req.setTimeout(180000);
  res.setTimeout(180000);

  try {
    let analysisData;

    const LIMIT = 15 * 1024 * 1024;
    let pdfBuffer;

    if (req.file) {
      const { projectName } = req.body;
      console.log(`Analyzing uploaded PDF: ${projectName || id} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);
      if (!req.file.originalname.toLowerCase().endsWith(".pdf")) {
        return res.status(400).json({ error: "Only PDF files are supported." });
      }
      pdfBuffer = req.file.buffer;

    } else {
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
      const MAX_DOWNLOAD = 40 * 1024 * 1024;
      const chunks = [];
      let totalSize = 0;
      for await (const chunk of pdfFetch.body) {
        totalSize += chunk.length;
        if (totalSize > MAX_DOWNLOAD) return res.status(400).json({ error: "PDF exceeds 40 MB. Please upload directly." });
        chunks.push(chunk);
      }
      pdfBuffer = Buffer.concat(chunks);
      console.log(`Downloaded ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB`);
    }

    // Compress if over limit
    if (pdfBuffer.length > LIMIT) {
      console.log(`Compressing PDF (${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB)...`);
      try {
        const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
        pdfBuffer = Buffer.from(await pdfDoc.save({ useObjectStreams: true }));
        console.log(`Compressed to ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB`);
      } catch (err) {
        console.warn("Compression failed:", err.message);
      }
    }
    if (pdfBuffer.length > LIMIT) {
      return res.status(400).json({
        error: `PDF is ${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB after compression (max 15 MB). Please split the drawings or reduce image quality.`,
      });
    }

    // Get page count
    let pdfPages = null;
    try {
      const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
      pdfPages = pdfDoc.getPageCount();
    } catch (_) {}

    // Call Gemini directly
    const base64Data = pdfBuffer.toString("base64");
    console.log(`Sending ${(base64Data.length / 1024 / 1024).toFixed(1)} MB base64 (${pdfPages ?? "?"} pages) to Gemini...`);
    analysisData = await callGemini(base64Data);
    if (analysisData._usage && pdfPages !== null) {
      analysisData._usage.pdfPages = pdfPages;
      // Refine cost estimate: Gemini charges 258 tokens/page for PDFs
      // promptTokenCount already includes page tokens, so formula is still correct
      // but show per-page cost as additional context
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
      return res.status(504).json({ error: "Analysis timed out. The civil drawings may be too large." });
    }
    if (err.message === "terminated" || err.message === "fetch failed") {
      return res.status(502).json({ error: "PDF download was interrupted (file may be too large). Please upload the file directly instead." });
    }
    res.status(500).json({ error: err.message });
  }
});

// Multer error handler — returns JSON instead of Express default HTML
app.use((err, _req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File is too large. Maximum upload size is 30 MB." });
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
