export type ProjectStatus =
  | "Processing"
  | "Pending Review"
  | "Complete"
  | "Approved for Generation"
  | "New"
  | "Manual Processing"
  | "";

export interface Project {
  id: string;
  projectName: string;
  email: string;
  status: ProjectStatus;
  isIndustrial?: boolean;
  plansUploaded?: boolean;
  dateReceived: string;
  dueDate: string;
  specialRequirements: string;
  latitude: string;
  longitude: string;
  soilData: string;
  endangeredSpecies: string;
  waterway: string;
  landDisturbanceArea: number;
  tceqSegment?: string;
  county?: string;
  ms4Operator?: string;
  noiType?: "Large" | "Small";
  waterbodyImpaired?: boolean;
  bestManagementPractices?: string[];
  projectAddress?: string;
  projectStartDate?: string;
  projectFinishDate?: string;
  projectDescription?: string;
  sequenceActivities?: string;
  invoiceTotal?: number;
  trelloLink: string;
  jobOrderLink: string;
  folderLink: string;
  invoiceLink: string;
}

export const projects: Project[] = [
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
