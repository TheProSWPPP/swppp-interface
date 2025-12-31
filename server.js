import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const PROJECTS_FILE = path.join(__dirname, "projects.json");
const ARCHIVE_FILE = path.join(__dirname, "archive.json");

function loadData(file, defaultVal) {
  if (fs.existsSync(file)) {
    try {
      const content = fs.readFileSync(file, "utf8");
      return JSON.parse(content);
    } catch (e) {
      console.error(`Error loading ${file}`, e);
    }
  }
  return defaultVal;
}

function saveData(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Error saving to ${file}`, e);
  }
}

// Initial Mock Data (Seed)
const initialProjects = [
  {
    id: "1",
    projectName: "Velez New Construction",
    email: "lisa.martin@innosoft832c.com",
    status: "Processing",
    isIndustrial: false,
    dateReceived: "17/11/2025",
    dueDate: "2025-11-20",
    specialRequirements: "E-Portal Hard Copy Needed",
    latitude: "30.2672° N",
    longitude: "97.7431° W",
    soilData: "Clay, silty clay loam",
    endangeredSpecies: "Houston toad",
    waterway: "Colorado River",
    landDisturbanceArea: 2,
    invoiceTotal: 1250.0,
    trelloLink: "https://trellocd79.com/c/ghi789aus",
    jobOrderLink: "https://dropbox1203.com/s/aus_joborder3.pdf",
    folderLink: "https://dropbox9667.com/sh/aus_projectfolder3",
    invoiceLink: "https://quickbooks.intelligents8344.com/invoice/AUS-3003",
  },
  {
    id: "2",
    projectName: "Peace River Wildlife Center",
    email: "emily.park@greengridc8d9.com",
    status: "New",
    isIndustrial: false,
    dateReceived: "13/11/2025",
    dueDate: "2025-11-18",
    specialRequirements: "24-Hour Turnaround E-Portal",
    latitude: "35.7796° N",
    longitude: "78.6382° W",
    soilData: "Loamy sand, sandy clay",
    endangeredSpecies: "Red-cockaded woodpecker",
    waterway: "Neuse River",
    landDisturbanceArea: 4,
    invoiceTotal: 850.5,
    trelloLink: "https://trelloed18.com/c/mno345ral",
    jobOrderLink: "https://dropbox27f4.com/s/ral_joborder5.pdf",
    folderLink: "https://dropboxbf1b.com/sh/ral_projectfolder5",
    invoiceLink: "https://quickbooks.intelligents4696.com/invoice/RAL-5005",
  },
];

let projects = loadData(PROJECTS_FILE, initialProjects);
let archive = loadData(ARCHIVE_FILE, []);

// API Routes
app.get("/api/projects", (req, res) => {
  res.json(projects);
});

app.post("/api/projects", (req, res) => {
  const newProject = req.body;

  // Basic validation/defaults
  if (!newProject.id) newProject.id = Date.now().toString();
  if (!newProject.status) newProject.status = "New";
  if (!newProject.projectName) newProject.projectName = "Untitled Project";
  if (!newProject.dateReceived)
    newProject.dateReceived = new Date().toLocaleDateString("en-GB");

  projects.push(newProject);
  saveData(PROJECTS_FILE, projects);
  console.log("New project received:", newProject.projectName);
  res.status(201).json(newProject);
});

app.put("/api/projects/:id", (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const index = projects.findIndex((p) => p.id === id);
  if (index !== -1) {
    projects[index] = { ...projects[index], ...updates };
    saveData(PROJECTS_FILE, projects);
    res.json(projects[index]);
  } else {
    res.status(404).json({ error: "Project not found" });
  }
});

app.delete("/api/projects/:id", (req, res) => {
  const { id } = req.params;
  const index = projects.findIndex((p) => p.id === id);

  if (index !== -1) {
    const project = projects[index];
    const archivedProject = { ...project, deletedAt: new Date().toISOString() };
    archive.push(archivedProject);
    projects.splice(index, 1);
    saveData(PROJECTS_FILE, projects);
    saveData(ARCHIVE_FILE, archive);
    console.log(`Archived project: ${project.projectName}`);
    res.status(204).send();
  } else {
    res.status(404).json({ error: "Project not found" });
  }
});

app.get("/api/archive", (req, res) => {
  res.json(archive);
});

app.post("/api/archive/:id/restore", (req, res) => {
  const { id } = req.params;
  const index = archive.findIndex((p) => p.id === id);

  if (index !== -1) {
    const project = archive[index];
    const { deletedAt, ...rest } = project;
    projects.push(rest);
    archive.splice(index, 1);
    saveData(PROJECTS_FILE, projects);
    saveData(ARCHIVE_FILE, archive);
    res.json(rest);
  } else {
    res.status(404).json({ error: "Project not found in archive" });
  }
});

// Cleanup Task (Every 24 hours)
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  const initialLen = archive.length;
  archive = archive.filter((p) => {
    const deletedTime = new Date(p.deletedAt).getTime();
    return now - deletedTime < THIRTY_DAYS_MS;
  });
  if (archive.length !== initialLen) {
    saveData(ARCHIVE_FILE, archive);
    console.log(
      `Cleaned up ${initialLen - archive.length} expired archived projects.`
    );
  }
}, 24 * 60 * 60 * 1000);

// Serve static files
app.use(express.static(path.join(__dirname, "dist")));

// Fallback for SPA
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
