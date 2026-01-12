import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

const N8N_WEBHOOK_URL =
  "https://proswppp.app.n8n.cloud/webhook/state-document-generator";

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
  // Skip auth for health check
  if (req.path === "/health") return next();

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
      "SELECT data FROM projects WHERE archived = FALSE ORDER BY (data->>'dateReceived') DESC"
    );
    res.json(result.rows.map((r) => r.data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects", async (req, res) => {
  const newProject = req.body;
  if (!newProject.id) newProject.id = Date.now().toString();
  // FORCE status to Pending Review regardless of payload for new creations
  newProject.status = "Pending Review";
  if (!newProject.projectName) newProject.projectName = "Untitled Project";
  if (!newProject.dateReceived)
    newProject.dateReceived = new Date().toLocaleDateString("en-GB");

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
