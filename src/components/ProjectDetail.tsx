import { useState, useEffect } from "react";
import type { Project } from "../data";
import {
  ArrowLeft,
  CheckCircle,
  FileText,
  ExternalLink,
  Map,
  Loader2,
  Calendar,
  AlertTriangle,
  DollarSign,
  CreditCard,
  ClipboardList,
  ShieldCheck,
  Building,
  User,
  FileCode,
  FolderOpen,
  Trello,
  XCircle,
  Edit2,
  Zap,
  Printer,
  Globe,
  Upload,
  Sparkles,
} from "lucide-react";
import {
  cn,
  parseCoordinate,
  formatWaterwayUrl,
  toDateInputFormat,
  fromDateInputFormat,
} from "../utils";
import {
  getDocumentsForTemplate,
  getTemplateColor,
  getTemplateName,
  getTemplateDocLink,
  isAutomatedDocument,
} from "../templates";

interface ProjectDetailProps {
  project: Project;
  onBack: () => void;
  onUpdate: (project: Project) => void;
  onDelete: () => void;
}

export default function ProjectDetail({
  project,
  onBack,
  onUpdate,
  onDelete,
}: ProjectDetailProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRetriggering, setIsRetriggering] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [formData, setFormData] = useState<Project>(project);

  const isPending =
    project.status === "Pending Review" || project.status === "New";

  const isApproved =
    project.status === "Approved for Generation" ||
    project.status === "Complete";
  const isManual = project.status === "Manual Processing";
  const isNew = project.status === "New";

  const canApprove =
    project.status === "Pending Review" ||
    project.status === "Processing" ||
    project.status === "";

  useEffect(() => {
    setFormData({
      ...project,
      swpppProjectDescription:
        project.swpppProjectDescription ||
        `This project consists of the construction of a ${project.projectName} facility located in <city>, <county>, <state>.`,
    });
  }, [project]);

  // Aggressive Auto-Save: Save changes automatically after 1 second of inactivity
  useEffect(() => {
    if (isApproved) return; // Don't auto-save for approved projects

    const timer = setTimeout(() => {
      // Only save if formData has actually changed from the original project
      if (JSON.stringify(formData) !== JSON.stringify(project)) {
        onUpdate(formData);
      }
    }, 1000); // Wait 1 second after last change

    return () => clearTimeout(timer);
  }, [formData, isApproved]); // Trigger whenever formData changes

  // Automatic County and City Extraction
  useEffect(() => {
    if (
      !formData.latitude ||
      !formData.longitude ||
      (formData.county && formData.city) ||
      isApproved
    )
      return;

    const lat = parseCoordinate(formData.latitude);
    const lon = parseCoordinate(formData.longitude);

    if (lat === "0" || lon === "0") return;

    const timer = setTimeout(() => {
      fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10`,
      )
        .then((res) => res.json())
        .then((data) => {
          if (data.address) {
            // Extract county
            if (data.address.county && !formData.county) {
              handleChange(
                "county",
                data.address.county.replace(" County", ""),
              );
            }

            // Extract city (try multiple fields as they vary by location)
            if (!formData.city) {
              const city =
                data.address.city ||
                data.address.town ||
                data.address.village ||
                data.address.municipality ||
                data.address.hamlet;

              if (city) {
                handleChange("city", city);
              }
            }
          }
        })
        .catch((err) => console.error("Location lookup failed:", err));
    }, 1000); // Debounce to avoid hitting rate limits

    return () => clearTimeout(timer);
  }, [formData.latitude, formData.longitude, isApproved]);

  const handleChange = (field: keyof Project, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const toggleBMP = (bmp: string) => {
    const current = formData.bestManagementPractices || [];
    const updated = current.includes(bmp)
      ? current.filter((b) => b !== bmp)
      : [...current, bmp];
    handleChange("bestManagementPractices", updated);
  };

  const bmps = [
    "Stabilized Construction Entrance",
    "Silt Fence",
    "Inlet Protection Barriers",
    "Hay Bales",
    "Filter Mats",
    "Gabions",
  ];

  const handleApprove = () => {
    // Mock API call / Generation process
    setIsGenerating(true);
    setTimeout(() => {
      onUpdate({
        ...formData,
        status: formData.isIndustrial
          ? "Manual Processing"
          : "Approved for Generation",
      });
      setIsGenerating(false);
    }, 2000);
  };

  const handleAccept = () => {
    onUpdate({
      ...formData,
      status: "Pending Review",
    });
  };

  const handleCancelGeneration = () => {
    if (confirm("Cancel generation and reset status to Pending Review?")) {
      onUpdate({
        ...formData,
        status: "Pending Review",
      });
    }
  };

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete this project?")) {
      onDelete();
    }
  };

  const handleRetrigger = async () => {
    if (
      !confirm(
        "This will re-trigger the project generation with updated details. Continue?",
      )
    )
      return;

    setIsRetriggering(true);

    try {
      // Prepare data with Customer Details and Project Details fields
      const retriggerData = {
        projectName: formData.projectName,
        email: formData.email,
        dateReceived: formData.dateReceived,
        stateTemplateId: formData.stateTemplateId,
        stateTemplateName: formData.stateTemplateName,
        // Customer Details
        companyName: formData.companyName,
        contactName: formData.contactName,
        phone: formData.phone,
        customerAddress: formData.customerAddress,
        // Project Details
        projectAddress: formData.projectAddress,
        city: formData.city,
        projectStartDate: formData.projectStartDate,
        projectFinishDate: formData.projectFinishDate,
        civilDrawingsLink: formData.civilDrawingsLink,
        projectDescription: formData.projectDescription,
        sequenceActivities: formData.sequenceActivities,
        specialRequirements: formData.specialRequirements,
        landDisturbanceArea: formData.landDisturbanceArea,
      };

      const response = await fetch(
        "https://proswppp.app.n8n.cloud/webhook/re-trigger",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(retriggerData),
        },
      );

      if (response.ok) {
        const regeneratedData = await response.json();

        // Update project with all regenerated data from n8n
        // This includes environmental data, coordinates, etc.
        onUpdate({
          ...formData,
          ...regeneratedData,
          status: "Pending Review", // Keep as Pending Review for manual approval
        });

        alert(
          "Project data regenerated successfully! Please review the updated information before approving.",
        );
      } else {
        alert("Failed to re-trigger project. Please try again.");
      }
    } catch (error) {
      console.error("Re-trigger failed:", error);
      alert("Error re-triggering project. Please check your connection.");
    } finally {
      setIsRetriggering(false);
    }
  };

  const handleAnalyzePlans = async () => {
    if (!uploadedFile && !formData.civilDrawingsLink) {
      alert("Please add a Civil Drawings link or upload a PDF first.");
      return;
    }
    setIsAnalyzing(true);
    try {
      let response: Response;
      if (uploadedFile) {
        const formPayload = new FormData();
        formPayload.append("file", uploadedFile);
        formPayload.append("companyName", formData.companyName || "");
        formPayload.append("projectName", formData.projectName || "");
        response = await fetch(`/api/projects/${project.id}/analyze-plans`, {
          method: "POST",
          body: formPayload,
        });
      } else {
        response = await fetch(`/api/projects/${project.id}/analyze-plans`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            civilDrawingsLink: formData.civilDrawingsLink,
            companyName: formData.companyName,
            projectName: formData.projectName,
          }),
        });
      }
      if (response.ok) {
        const analysis = await response.json();
        const raw = analysis.data || analysis;
        const updates: Partial<Project> = {
          planAnalysisSummary: raw.summary || "",
          planAnalysisDate: new Date().toISOString(),
          planAnalysisRaw: raw,
        };
        // Only auto-fill fields that are currently empty
        if (!formData.landDisturbanceArea && raw.estimatedDisturbedArea?.value && raw.estimatedDisturbedArea.value !== "N/A") {
          const parsed = parseFloat(raw.estimatedDisturbedArea.value);
          if (!isNaN(parsed)) updates.landDisturbanceArea = parsed;
        }
        if (!formData.projectDescription && raw.projectDescription && raw.projectDescription !== "N/A") {
          updates.projectDescription = raw.projectDescription;
        }
        if (!formData.sequenceActivities && raw.sequenceOfActivities && raw.sequenceOfActivities !== "N/A") {
          updates.sequenceActivities = raw.sequenceOfActivities;
        }
        if (!formData.latitude && raw.latitude && raw.latitude !== "N/A") {
          updates.latitude = raw.latitude;
        }
        if (!formData.longitude && raw.longitude && raw.longitude !== "N/A") {
          updates.longitude = raw.longitude;
        }
        if (!formData.soilData && raw.soilComposition && raw.soilComposition !== "N/A") {
          updates.soilData = raw.soilComposition;
        }
        if (!formData.waterway && raw.nearestWaterbody && raw.nearestWaterbody !== "N/A") {
          updates.waterway = raw.nearestWaterbody;
        }
        if (formData.waterbodyImpaired === undefined && raw.waterbodyImpairment && raw.waterbodyImpairment !== "N/A") {
          updates.waterbodyImpaired = raw.waterbodyImpairment.toLowerCase() !== "not impaired" && raw.waterbodyImpairment.toLowerCase() !== "none";
        }
        if (!formData.contactName && (raw.contactPerson || raw.ownerName)) {
          const val = raw.contactPerson !== "N/A" ? raw.contactPerson : raw.ownerName !== "N/A" ? raw.ownerName : null;
          if (val) updates.contactName = val;
        }
        if (!formData.phone && raw.ownerPhone && raw.ownerPhone !== "N/A") {
          updates.phone = raw.ownerPhone;
        }
        if (!formData.customerAddress && raw.ownerAddress && raw.ownerAddress !== "N/A") {
          updates.customerAddress = raw.ownerAddress;
        }
        if (!formData.projectStartDate && raw.projectStartDate && raw.projectStartDate !== "N/A") {
          updates.projectStartDate = raw.projectStartDate;
        }
        if (!formData.projectFinishDate && raw.projectFinishDate && raw.projectFinishDate !== "N/A") {
          updates.projectFinishDate = raw.projectFinishDate;
        }
        if (!formData.projectAddress && raw.siteAddress && raw.siteAddress !== "N/A") {
          updates.projectAddress = raw.siteAddress;
        }
        const updatedForm = { ...formData, ...updates };
        setFormData(updatedForm);
        onUpdate(updatedForm);
        setUploadedFile(null);
      } else {
        const err = await response.json().catch(() => ({}));
        alert(err.error || "Analysis failed. Please check the civil drawings link and try again.");
      }
    } catch (error) {
      console.error("Plan analysis failed:", error);
      alert("Error analyzing plans. Please check your connection and try again.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="bg-white shadow-sm rounded-2xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              {isPending ? (
                <div className="relative group/title">
                  <input
                    type="text"
                    value={formData.projectName || ""}
                    onChange={(e) =>
                      handleChange("projectName", e.target.value)
                    }
                    onBlur={() => onUpdate(formData)}
                    onKeyDown={(e) => e.key === "Enter" && onUpdate(formData)}
                    className="text-xl font-bold text-slate-900 leading-tight bg-transparent border-none p-0 focus:ring-0 focus:outline-none min-w-[200px]"
                  />
                  <Edit2 className="h-3 w-3 text-slate-400 absolute -right-4 top-1/2 -translate-y-1/2 opacity-0 group-hover/title:opacity-100 transition-opacity pointer-events-none" />
                  <div className="absolute bottom-0 left-0 w-full h-px bg-slate-200 scale-x-0 group-hover/title:scale-x-100 transition-transform origin-left" />
                </div>
              ) : (
                <h3 className="text-xl font-bold text-slate-900 leading-tight">
                  {project.projectName}
                </h3>
              )}
              {(project.stateTemplateId || project.stateTemplateName) && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold border shadow-sm transition-all",
                    getTemplateColor(
                      project.stateTemplateId || project.stateTemplateName,
                    ),
                  )}
                >
                  <FileCode className="h-3 w-3" />
                  {getTemplateName(
                    project.stateTemplateId || project.stateTemplateName,
                  )}
                </span>
              )}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2">
                  {project["24hrTurnaround"] === "yes" && (
                    <span
                      className="p-1 rounded-full bg-red-50 text-red-600 border border-red-100 shadow-sm"
                      title="24hr Turnaround Required"
                    >
                      <Zap className="h-3.5 w-3.5" />
                    </span>
                  )}
                  {project.needHardCopy === "yes" && (
                    <span
                      className="p-1 rounded-full bg-amber-50 text-amber-600 border border-amber-100 shadow-sm"
                      title="Hard Copy Needed"
                    >
                      <Printer className="h-3.5 w-3.5" />
                    </span>
                  )}
                  {project.certifiedInspection === "yes" && (
                    <span
                      className="p-1 rounded-full bg-blue-50 text-blue-600 border border-blue-100 shadow-sm"
                      title="Certified Inspection Required"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                    </span>
                  )}
                  {project.eportalAccess === "yes" && (
                    <span
                      className="p-1 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100 shadow-sm"
                      title="E-Portal Access Required"
                    >
                      <Globe className="h-3.5 w-3.5" />
                    </span>
                  )}
                </div>
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border",
                    project.status === "Approved for Generation"
                      ? "bg-purple-50 text-purple-700 border-purple-200"
                      : project.status === "Complete"
                        ? "bg-green-50 text-green-700 border-green-200"
                        : project.status === "Manual Processing"
                          ? "bg-orange-50 text-orange-700 border-orange-200"
                          : project.status === "Ready"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : project.status === "New"
                              ? "bg-slate-100 text-slate-700 border-slate-200"
                              : "bg-indigo-50 text-indigo-700 border-indigo-200",
                  )}
                >
                  {project.status || "Draft"}
                </span>
                {(project.status === "Approved for Generation" ||
                  project.status === "Manual Processing" ||
                  project.status === "Ready") && (
                  <button
                    onClick={handleCancelGeneration}
                    className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2 py-0.5 rounded-full border border-red-200 transition-colors uppercase tracking-tight"
                    title="Cancel Generation & Reset"
                  >
                    <XCircle className="h-3 w-3" />
                    Cancel
                  </button>
                )}
              </div>
            </div>
            <p className="text-sm text-slate-500 flex items-center gap-3 mt-1.5">
              <span>{project.email}</span>
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              <span className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                Due {project.dueDate}
              </span>
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 p-6 lg:p-8 bg-slate-50/50">
        {/* Main Data Column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Customer Details */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-6 flex items-center gap-2">
              <User className="h-4 w-4" /> Customer Details
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Company Name
                </label>
                <input
                  type="text"
                  value={formData.companyName || ""}
                  onChange={(e) => handleChange("companyName", e.target.value)}
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Contact Name
                </label>
                <input
                  type="text"
                  value={formData.contactName || ""}
                  onChange={(e) => handleChange("contactName", e.target.value)}
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Phone
                </label>
                <input
                  type="text"
                  value={formData.phone || ""}
                  onChange={(e) => handleChange("phone", e.target.value)}
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Customer Address
                </label>
                <input
                  type="text"
                  value={formData.customerAddress || ""}
                  onChange={(e) =>
                    handleChange("customerAddress", e.target.value)
                  }
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Email
                </label>
                <input
                  type="email"
                  value={formData.email || ""}
                  onChange={(e) => handleChange("email", e.target.value)}
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>
            </div>
          </div>

          {/* Project Details */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-6 flex items-center gap-2">
              <Building className="h-4 w-4" /> Project Details
            </h4>
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2 space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    Project Address
                  </label>
                  <input
                    type="text"
                    value={formData.projectAddress || ""}
                    onChange={(e) =>
                      handleChange("projectAddress", e.target.value)
                    }
                    onBlur={() => onUpdate(formData)}
                    className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    disabled={isApproved}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={toDateInputFormat(formData.projectStartDate)}
                    onChange={(e) =>
                      handleChange(
                        "projectStartDate",
                        fromDateInputFormat(e.target.value),
                      )
                    }
                    onBlur={() => onUpdate(formData)}
                    className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    disabled={isApproved}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    Finish Date
                  </label>
                  <input
                    type="date"
                    value={toDateInputFormat(formData.projectFinishDate)}
                    onChange={(e) =>
                      handleChange(
                        "projectFinishDate",
                        fromDateInputFormat(e.target.value),
                      )
                    }
                    onBlur={() => onUpdate(formData)}
                    className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    disabled={isApproved}
                  />
                </div>
                <div className="md:col-span-2 space-y-3">
                  <label className="text-sm font-medium text-slate-700">
                    Civil Drawings Link (from Web Order)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={formData.civilDrawingsLink || ""}
                      onChange={(e) =>
                        handleChange("civilDrawingsLink", e.target.value)
                      }
                      onBlur={() => onUpdate(formData)}
                      placeholder="https://dropbox.com/path/to/drawings..."
                      className="flex-1 text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                      disabled={isApproved}
                    />
                    {formData.civilDrawingsLink && (
                      <a
                        href={formData.civilDrawingsLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-300 transition-colors"
                        title="Open link"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                  </div>

                  {/* AI Plan Analysis */}
                  <div className="rounded-lg border border-slate-200 p-4 mt-1 space-y-3">
                      {/* File Upload */}
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-2 px-3 py-2 text-sm border border-dashed border-slate-300 rounded-lg cursor-pointer hover:border-violet-400 hover:text-violet-600 transition-colors">
                          <Upload className="h-4 w-4 text-slate-400" />
                          <span className="text-slate-500">
                            {uploadedFile ? uploadedFile.name : "Upload PDF directly"}
                          </span>
                          <input
                            type="file"
                            accept="application/pdf"
                            className="hidden"
                            onChange={(e) => setUploadedFile(e.target.files?.[0] ?? null)}
                            disabled={isApproved}
                          />
                        </label>
                        {uploadedFile && (
                          <button
                            onClick={() => setUploadedFile(null)}
                            className="p-1.5 rounded text-slate-400 hover:text-red-500 transition-colors"
                            title="Remove file"
                          >
                            <XCircle className="h-4 w-4" />
                          </button>
                        )}
                      </div>

                      {/* Analyze Button */}
                      <button
                        onClick={handleAnalyzePlans}
                        disabled={isAnalyzing || isApproved || (!formData.civilDrawingsLink && !uploadedFile)}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-violet-600/20 transition-colors"
                      >
                        {isAnalyzing ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Analyzing... (may take ~30s)
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-4 w-4" />
                            Analyze Civil Plans
                          </>
                        )}
                      </button>

                      {/* Analysis Result */}
                      {formData.planAnalysisSummary ? (
                        <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-4 space-y-2">
                          <h5 className="text-xs font-bold text-violet-700 uppercase tracking-wider flex items-center gap-1.5">
                            <Sparkles className="h-3.5 w-3.5" />
                            AI Plan Analysis
                            {formData.planAnalysisDate && (
                              <span className="ml-auto text-[10px] font-normal text-violet-400 normal-case tracking-normal">
                                {new Date(formData.planAnalysisDate).toLocaleDateString()}
                              </span>
                            )}
                          </h5>
                          <p className="text-sm text-slate-600 leading-relaxed">
                            {formData.planAnalysisSummary}
                          </p>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-4 space-y-2">
                          <h5 className="text-xs font-bold text-violet-700 uppercase tracking-wider flex items-center gap-1.5">
                            <Sparkles className="h-3.5 w-3.5" />
                            AI Plan Analysis
                          </h5>
                          <p className="text-sm text-slate-500">
                            Gemini will analyze civil drawings and auto-fill disturbed area, coordinates, soil, waterway, project description, activities, owner info, and more.
                          </p>
                        </div>
                      )}
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Project Description
                </label>
                <textarea
                  value={formData.projectDescription || ""}
                  onChange={(e) =>
                    handleChange("projectDescription", e.target.value)
                  }
                  onBlur={() => onUpdate(formData)}
                  rows={3}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  disabled={isApproved}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Sequence of Major Activities
                </label>
                <textarea
                  value={formData.sequenceActivities || ""}
                  onChange={(e) =>
                    handleChange("sequenceActivities", e.target.value)
                  }
                  onBlur={() => onUpdate(formData)}
                  rows={6}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 font-mono"
                  placeholder="e.g., Site prep, utilities, paving, construction, landscaping..."
                  disabled={isApproved}
                />
              </div>

              <div className="space-y-2 pt-4 border-t border-slate-100">
                <label className="text-sm font-medium text-slate-700 flex items-center gap-2">
                  <ClipboardList className="h-4 w-4 text-slate-400" />
                  Notes / Special Requirements
                </label>
                <textarea
                  value={formData.specialRequirements || ""}
                  onChange={(e) =>
                    handleChange("specialRequirements", e.target.value)
                  }
                  onBlur={() => onUpdate(formData)}
                  rows={4}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 bg-slate-50/50"
                  placeholder="Additional notes from job order..."
                  disabled={isApproved}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Est. Acres Disturbed
                </label>
                <input
                  type="number"
                  value={formData.landDisturbanceArea ?? ""}
                  onChange={(e) =>
                    handleChange(
                      "landDisturbanceArea",
                      parseFloat(e.target.value),
                    )
                  }
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  placeholder="e.g., 2.5"
                  disabled={isApproved}
                />
              </div>
            </div>
          </div>

          {/* Location & Environmental */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-6 flex items-center gap-2">
              <Map className="h-4 w-4" /> Location & Environmental
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-700">
                    Coordinates
                  </label>
                  <a
                    href={`https://www.google.com/maps?q=${parseCoordinate(
                      formData.latitude,
                    )},${parseCoordinate(formData.longitude)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center hover:underline"
                  >
                    View on Map <ExternalLink className="h-3 w-3 ml-1" />
                  </a>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={formData.latitude || ""}
                    onChange={(e) => handleChange("latitude", e.target.value)}
                    onBlur={() => onUpdate(formData)}
                    className="flex-1 text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    placeholder="Lat"
                    disabled={isApproved}
                  />
                  <input
                    type="text"
                    value={formData.longitude || ""}
                    onChange={(e) => handleChange("longitude", e.target.value)}
                    onBlur={() => onUpdate(formData)}
                    className="flex-1 text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    placeholder="Long"
                    disabled={isApproved}
                  />
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">
                  State (full name)
                </label>
                <input
                  type="text"
                  value={formData.state || ""}
                  onChange={(e) => handleChange("state", e.target.value)}
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  placeholder="e.g., Arkansas, Texas, Florida"
                  disabled={isApproved}
                />
              </div>

              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">
                  County
                </label>
                <input
                  type="text"
                  value={formData.county || ""}
                  onChange={(e) => handleChange("county", e.target.value)}
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>

              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">
                  City
                </label>
                <input
                  type="text"
                  value={formData.city || ""}
                  onChange={(e) => handleChange("city", e.target.value)}
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  placeholder="e.g., Chalmette"
                  disabled={isApproved}
                />
              </div>

              {getTemplateName(
                project.stateTemplateId || project.stateTemplateName,
              )?.includes("Texas") && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    TCEQ Segment
                  </label>
                  <input
                    type="text"
                    value={formData.tceqSegment || ""}
                    onChange={(e) =>
                      handleChange("tceqSegment", e.target.value)
                    }
                    onBlur={() => onUpdate(formData)}
                    className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    disabled={isApproved}
                  />
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  MS4 Operator
                </label>
                <input
                  type="text"
                  value={formData.ms4Operator || ""}
                  onChange={(e) => handleChange("ms4Operator", e.target.value)}
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>

              <div className="md:col-span-2 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-700">
                    Contributing Waterbodies
                  </label>
                  <a
                    href={formatWaterwayUrl(formData.projectAddress || "")}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center hover:underline"
                  >
                    View Source <ExternalLink className="h-3 w-3 ml-1" />
                  </a>
                </div>
                <input
                  type="text"
                  value={formData.waterway || ""}
                  onChange={(e) => handleChange("waterway", e.target.value)}
                  onBlur={() => onUpdate(formData)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>

              <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-slate-700">
                      Soil Data
                    </label>
                    <a
                      href="https://websoilsurvey.nrcs.usda.gov/app/WebSoilSurvey.aspx"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center hover:underline"
                    >
                      View Source <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </div>
                  <textarea
                    value={formData.soilData || ""}
                    onChange={(e) => handleChange("soilData", e.target.value)}
                    onBlur={() => onUpdate(formData)}
                    className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 min-h-[80px]"
                    disabled={isApproved}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-slate-700">
                      Endangered Species
                    </label>
                    <a
                      href={`https://ecos.fws.gov/ecp/report/species-listings-by-current-range-county?fips=${
                        formData.countyFips || ""
                      }`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center hover:underline"
                    >
                      View Source <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </div>
                  <textarea
                    value={formData.endangeredSpecies || ""}
                    onChange={(e) =>
                      handleChange("endangeredSpecies", e.target.value)
                    }
                    onBlur={() => onUpdate(formData)}
                    className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 min-h-[80px]"
                    disabled={isApproved}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* SWPPP Specifics */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm relative overflow-hidden group/swppp">
            <div className="absolute inset-0 bg-slate-50/40 backdrop-blur-[1px] z-10 flex items-center justify-center opacity-0 group-hover/swppp:opacity-100 transition-opacity">
              <span className="bg-slate-900 text-white text-[10px] font-bold px-2 py-1 rounded uppercase tracking-widest shadow-xl">
                Coming Soon
              </span>
            </div>
            <div className="opacity-40 pointer-events-none grayscale">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-6 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" /> SWPPP Specifics
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    NOI Acknowledgement
                  </label>
                  <div className="flex flex-col gap-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="noiType"
                        checked={formData.noiType === "Large"}
                        onChange={() => handleChange("noiType", "Large")}
                        className="text-indigo-600 focus:ring-indigo-500"
                        disabled={isApproved}
                      />
                      <span className="text-sm text-slate-600">
                        Large Construction Site
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="noiType"
                        checked={formData.noiType === "Small"}
                        onChange={() => handleChange("noiType", "Small")}
                        className="text-indigo-600 focus:ring-indigo-500"
                        disabled={isApproved}
                      />
                      <span className="text-sm text-slate-600">
                        Small Construction Site
                      </span>
                    </label>
                  </div>
                </div>

                <div className="md:col-span-2 space-y-4 pt-4 border-t border-slate-100">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-slate-700">
                      SWPPP Document Description
                    </label>
                    <textarea
                      value={formData.swpppProjectDescription || ""}
                      onChange={(e) =>
                        handleChange("swpppProjectDescription", e.target.value)
                      }
                      rows={3}
                      className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 bg-slate-50/30"
                      placeholder="This description will appear in the SWPPP document..."
                      disabled={isApproved}
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-slate-700">
                      Sequence of Major Activities
                    </label>
                    <textarea
                      value={formData.sequenceActivities || ""}
                      onChange={(e) =>
                        handleChange("sequenceActivities", e.target.value)
                      }
                      rows={6}
                      className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 font-mono bg-slate-50/30"
                      disabled={isApproved}
                    />
                  </div>
                </div>

                <div className="md:col-span-2 space-y-3">
                  <label className="text-sm font-medium text-slate-700 flex items-center gap-2">
                    <ClipboardList className="h-4 w-4 text-slate-400" /> Best
                    Management Practices
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {bmps.map((bmp) => (
                      <label
                        key={bmp}
                        className="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-slate-50 border border-transparent hover:border-slate-100"
                      >
                        <input
                          type="checkbox"
                          checked={
                            formData.bestManagementPractices?.includes(bmp) ||
                            false
                          }
                          onChange={() => toggleBMP(bmp)}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          disabled={true}
                        />
                        <span className="text-sm text-slate-600">{bmp}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar Column */}
        <div className="space-y-6">
          {/* Quick Resources */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                Quick Links
              </h4>
              <div className="flex items-center gap-2">
                <a
                  href={project.folderLink || "#"}
                  target={project.folderLink ? "_blank" : undefined}
                  className={cn(
                    "p-2 rounded-xl transition-all border",
                    project.folderLink
                      ? "text-indigo-600 bg-indigo-50 border-indigo-100 hover:bg-indigo-100"
                      : "text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed",
                  )}
                  title="Dropbox Folder"
                  onClick={(e) => !project.folderLink && e.preventDefault()}
                >
                  <FolderOpen className="h-4 w-4" />
                </a>
                <a
                  href={project.trelloLink || "#"}
                  target={project.trelloLink ? "_blank" : undefined}
                  className={cn(
                    "p-2 rounded-xl transition-all border",
                    project.trelloLink
                      ? "text-[#0079BF] bg-blue-50 border-blue-100 hover:bg-blue-100"
                      : "text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed",
                  )}
                  title="Trello Card"
                  onClick={(e) => !project.trelloLink && e.preventDefault()}
                >
                  <Trello className="h-4 w-4" />
                </a>
              </div>
            </div>
          </div>

          {/* Actions Card */}
          <div
            className={cn(
              "rounded-xl border p-6 shadow-sm transition-all relative overflow-hidden",
              isApproved
                ? "bg-white border-green-200 ring-1 ring-green-500/10"
                : isManual
                  ? "bg-white border-orange-200 ring-1 ring-orange-500/10"
                  : isNew
                    ? "bg-white border-slate-200"
                    : "bg-white border-indigo-200 ring-1 ring-indigo-500/10",
            )}
          >
            {/* Status Indicator Bar */}
            <div
              className={cn(
                "absolute top-0 left-0 w-full h-1",
                isApproved
                  ? "bg-green-500"
                  : isManual
                    ? "bg-orange-500"
                    : isNew
                      ? "bg-slate-500"
                      : "bg-indigo-500",
              )}
            />

            <h4 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-2">
              Status & Actions
            </h4>
            <p className="text-sm text-slate-500 mb-6 leading-relaxed">
              {isApproved
                ? "Documents queued for generation. Downloads available below."
                : isManual
                  ? "Marked for manual processing. Handled outside system."
                  : isNew
                    ? "Review request details. Accept to process or delete if invalid."
                    : "Review accuracy. Approve to trigger generation."}
            </p>

            <div className="space-y-4">
              {!isApproved && !isManual && (
                <div className="space-y-3">
                  <label className="flex items-center p-3 rounded-lg border border-slate-200 bg-slate-50 cursor-pointer hover:border-indigo-300 transition-colors">
                    <input
                      type="checkbox"
                      checked={formData.plansUploaded || false}
                      onChange={(e) =>
                        handleChange("plansUploaded", e.target.checked)
                      }
                      className="h-4 w-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                    />
                    <span className="ml-3 text-sm font-medium text-slate-700 leading-tight">
                      I have verified civil plans are in the dropbox folder
                    </span>
                  </label>

                  <label className="flex items-center p-3 rounded-lg border border-slate-200 bg-slate-50 cursor-pointer hover:border-indigo-300 transition-colors">
                    <input
                      type="checkbox"
                      checked={formData.isIndustrial || false}
                      onChange={(e) =>
                        handleChange("isIndustrial", e.target.checked)
                      }
                      className="h-4 w-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                    />
                    <span className="ml-3 text-sm font-medium text-slate-700">
                      Is Industrial Project?
                    </span>
                  </label>
                </div>
              )}

              {isNew && (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={handleDelete}
                    className="flex items-center justify-center px-4 py-2.5 border border-red-200 text-sm font-medium rounded-lg text-red-700 bg-white hover:bg-red-50 hover:border-red-300 transition-all shadow-sm"
                  >
                    Delete
                  </button>
                  <button
                    onClick={handleAccept}
                    className="flex items-center justify-center px-4 py-2.5 border border-transparent text-sm font-medium rounded-lg text-white bg-slate-900 hover:bg-slate-800 transition-all shadow-sm shadow-slate-900/10"
                  >
                    Accept
                  </button>
                </div>
              )}

              {canApprove && !isApproved && !isNew && (
                <>
                  <button
                    onClick={handleRetrigger}
                    disabled={isRetriggering}
                    className="w-full flex items-center justify-center px-4 py-2.5 border border-amber-300 text-sm font-medium rounded-lg text-amber-900 bg-amber-50 hover:bg-amber-100 hover:border-amber-400 disabled:opacity-70 disabled:cursor-not-allowed transition-all shadow-sm"
                  >
                    {isRetriggering ? (
                      <>
                        <Loader2 className="animate-spin -ml-1 mr-2 h-4 w-4" />
                        Regenerating Data...
                      </>
                    ) : (
                      <>
                        <Loader2 className="-ml-1 mr-2 h-4 w-4" />
                        Re-trigger with Corrected Data
                      </>
                    )}
                  </button>

                  <button
                    onClick={handleApprove}
                    disabled={
                      isGenerating ||
                      (!formData.plansUploaded && !formData.isIndustrial)
                    }
                    className="w-full flex items-center justify-center px-4 py-2.5 border border-transparent text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 focus:ring-4 focus:ring-indigo-500/20 disabled:opacity-70 disabled:cursor-not-allowed transition-all shadow-md shadow-indigo-600/20"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="animate-spin -ml-1 mr-2 h-4 w-4" />
                        Processing...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="-ml-1 mr-2 h-4 w-4" />
                        {formData.isIndustrial
                          ? "Confirm Manual Processing"
                          : "Approve & Generate"}
                      </>
                    )}
                  </button>
                </>
              )}

              {(isApproved || isManual) && (
                <>
                  <div
                    className={cn(
                      "flex items-center justify-center p-3 rounded-lg border font-medium text-sm",
                      isManual
                        ? "bg-orange-50 text-orange-700 border-orange-200"
                        : "bg-green-50 text-green-700 border-green-200",
                    )}
                  >
                    {isManual ? (
                      <>
                        <AlertTriangle className="h-4 w-4 mr-2" /> Manual
                        Processing
                      </>
                    ) : (
                      <>
                        <CheckCircle className="h-4 w-4 mr-2" /> Approved
                      </>
                    )}
                  </div>

                  <button
                    onClick={handleRetrigger}
                    disabled={isRetriggering}
                    className="w-full flex items-center justify-center px-4 py-2.5 border border-amber-300 text-sm font-medium rounded-lg text-amber-900 bg-amber-50 hover:bg-amber-100 hover:border-amber-400 disabled:opacity-70 disabled:cursor-not-allowed transition-all shadow-sm"
                  >
                    {isRetriggering ? (
                      <>
                        <Loader2 className="animate-spin -ml-1 mr-2 h-4 w-4" />
                        Regenerating Data...
                      </>
                    ) : (
                      <>
                        <Loader2 className="-ml-1 mr-2 h-4 w-4" />
                        Re-trigger Generation
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Generated Documents Links */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
              <FileText className="h-4 w-4" /> Documents to be Generated
            </h4>
            <div className="space-y-2">
              {[
                ...getDocumentsForTemplate(
                  project.stateTemplateId || project.stateTemplateName,
                ),
                "Job Order PDF",
              ].map((doc) => {
                const automated =
                  isAutomatedDocument(doc) || doc === "Job Order PDF";
                const isManualTarget = !automated;
                const isProjectReady = project.status === "Ready";

                // Links are ONLY active if status is "Ready" OR it's a Job Order PDF that exists
                const docLink =
                  doc === "Job Order PDF"
                    ? project.jobOrderLink
                    : isProjectReady
                      ? "#" // Placeholder for ready documents
                      : null;

                const isClickable = !!docLink;
                const templateLink = getTemplateDocLink(
                  project.stateTemplateId || project.stateTemplateName,
                  doc,
                );

                return (
                  <div
                    key={doc}
                    className={cn(
                      "flex flex-col border rounded-xl transition-all overflow-hidden",
                      isClickable
                        ? "bg-white border-slate-200 shadow-sm"
                        : "bg-slate-50 border-slate-200 opacity-80",
                    )}
                  >
                    <a
                      href={docLink || undefined}
                      target={docLink ? "_blank" : undefined}
                      rel={docLink ? "noopener noreferrer" : undefined}
                      className={cn(
                        "flex items-center p-3 group relative",
                        isClickable ? "cursor-pointer" : "cursor-default",
                      )}
                      onClick={(e) => !isClickable && e.preventDefault()}
                    >
                      <div
                        className={cn(
                          "h-8 w-8 rounded-lg flex items-center justify-center mr-3 transition-colors",
                          isClickable
                            ? "bg-indigo-50 text-indigo-600 group-hover:bg-indigo-100"
                            : "bg-slate-200 text-slate-500",
                        )}
                      >
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="flex flex-col">
                        <span
                          className={cn(
                            "text-sm font-medium transition-colors",
                            isClickable
                              ? "text-slate-700 group-hover:text-indigo-600"
                              : "text-slate-500",
                          )}
                        >
                          {doc}{" "}
                          {automated &&
                            !isManualTarget &&
                            doc !== "Job Order PDF" &&
                            "(Automated)"}
                        </span>
                        {isManualTarget && (
                          <span className="text-[10px] text-orange-600 font-bold uppercase tracking-tight">
                            Manual - Pending Automation
                          </span>
                        )}
                        {automated && !isProjectReady && isApproved && (
                          <span className="text-[10px] text-indigo-600 font-bold uppercase tracking-tight animate-pulse">
                            Generating...
                          </span>
                        )}
                        {automated && !isApproved && !isClickable && (
                          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">
                            Awaiting Approval
                          </span>
                        )}
                      </div>
                      {isClickable && (
                        <ExternalLink className="h-3 w-3 ml-auto text-slate-400 group-hover:text-indigo-400" />
                      )}
                    </a>

                    {templateLink && (
                      <div className="px-3 pb-2 flex justify-end">
                        <a
                          href={templateLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] font-bold text-indigo-500 hover:text-indigo-700 flex items-center gap-1 bg-indigo-50/50 px-2 py-0.5 rounded-full transition-colors"
                        >
                          View Template Doc
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Financials */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-6 shadow-sm relative overflow-hidden group">
            <div className="absolute inset-0 bg-slate-50/40 backdrop-blur-[1px] z-10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="bg-slate-900 text-white text-[10px] font-bold px-2 py-1 rounded uppercase tracking-widest shadow-xl">
                Coming Soon
              </span>
            </div>
            <div className="opacity-40 pointer-events-none grayscale">
              <h4 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-4 flex items-center gap-2">
                <DollarSign className="h-4 w-4" /> Financials
              </h4>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    Invoice Total
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <span className="text-slate-500 sm:text-sm">$</span>
                    </div>
                    <input
                      type="number"
                      value={formData.invoiceTotal || ""}
                      className="pl-7 w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm"
                      placeholder="0.00"
                      readOnly
                    />
                  </div>
                </div>
                {project.invoiceLink ? (
                  <a
                    href={project.invoiceLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full flex items-center justify-center px-4 py-2.5 border border-slate-200 text-sm font-medium rounded-lg text-slate-700 bg-white shadow-sm hover:bg-slate-50 transition-colors"
                  >
                    <CreditCard className="-ml-1 mr-2 h-4 w-4" />
                    View Invoice
                  </a>
                ) : (
                  <button className="w-full flex items-center justify-center px-4 py-2.5 border border-slate-200 text-sm font-medium rounded-lg text-slate-700 bg-white shadow-sm">
                    <CreditCard className="-ml-1 mr-2 h-4 w-4" />
                    Generate on QuickBooks
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
