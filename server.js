import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Initial Mock Data
let projects = [
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
  {
    id: "3",
    projectName: "Maslow Park",
    email: "jane.doe@acmeretail4a61.com",
    status: "Pending Review",
    dateReceived: "15/11/2025",
    dueDate: "2025-11-20",
    specialRequirements: "E-Portal Hard Copy Needed",
    latitude: "33.7490° N",
    longitude: "84.3880° W",
    soilData: "Clay loam, sandy clay loam",
    endangeredSpecies: "Wood Stork, Eastern Indigo Snake",
    waterway: "Chattahoochee River",
    landDisturbanceArea: 3,
    trelloLink: "https://trelloef8f.com/c/abc123atl",
    jobOrderLink: "https://dropboxaddd.com/s/atl_joborder1.pdf",
    folderLink: "https://dropbox8368.com/sh/atl_projectfolder1",
    invoiceLink: "https://quickbooks.intelligents8bf9.com/invoice/ATL-1001",
  },
  {
    id: "4",
    projectName: "Harbor View Development",
    email: "alex.tan@bluesky6a58.com",
    status: "Complete",
    dateReceived: "14/11/2025",
    dueDate: "2025-11-19",
    specialRequirements: "E-Portal 24-Hour Turnaround",
    latitude: "47.6062° N",
    longitude: "122.3321° W",
    soilData: "Silty clay loam, sandy loam",
    endangeredSpecies: "Chinook salmon",
    waterway: "Lake Union",
    landDisturbanceArea: 3,
    trelloLink: "https://trelloe210.com/c/jkl012sea",
    jobOrderLink: "https://dropboxe322.com/s/sea_joborder4.pdf",
    folderLink: "https://dropbox769d.com/sh/sea_projectfolder4",
    invoiceLink: "https://quickbooks.intelligents62c7.com/invoice/SEA-4004",
  },
  {
    id: "5",
    projectName: "Mountain Side Estates",
    email: "sam.lee@nextgenclouda270.com",
    status: "Approved for Generation",
    dateReceived: "16/11/2025",
    dueDate: "2025-11-21",
    specialRequirements: "Hard Copy Needed E-Portal",
    latitude: "39.7392° N",
    longitude: "104.9903° W",
    soilData: "Sandy loam, silt loam",
    endangeredSpecies: "Preble's meadow jumping mouse",
    waterway: "South Platte River",
    landDisturbanceArea: 5,
    trelloLink: "https://trelloe17c.com/c/def456den",
    jobOrderLink: "https://dropbox2186.com/s/den_joborder2.pdf",
    folderLink: "https://dropboxdd1b.com/sh/den_projectfolder2",
    invoiceLink: "https://quickbooks.intelligents623d.com/invoice/DEN-2002",
  },
];

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
    newProject.dateReceived = new Date().toLocaleDateString("en-GB"); // DD/MM/YYYY

  projects.push(newProject);
  console.log("New project received:", newProject.projectName);
  res.status(201).json(newProject);
});

// Update Project (needed for UI interactions to persist in memory)
app.put("/api/projects/:id", (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const index = projects.findIndex((p) => p.id === id);
  if (index !== -1) {
    projects[index] = { ...projects[index], ...updates };
    res.json(projects[index]);
  } else {
    res.status(404).json({ error: "Project not found" });
  }
});

// Delete Project
app.delete("/api/projects/:id", (req, res) => {
  const { id } = req.params;
  projects = projects.filter((p) => p.id !== id);
  res.status(204).send();
});

// Serve static files
app.use(express.static(path.join(__dirname, "dist")));

// Fallback for SPA
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
