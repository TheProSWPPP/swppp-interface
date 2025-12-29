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
} from "lucide-react";
import { cn } from "../utils";

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
  const [isGeneratingInvoice, setIsGeneratingInvoice] = useState(false);
  const [formData, setFormData] = useState<Project>(project);

  useEffect(() => {
    setFormData({
      ...project,
      sequenceActivities:
        project.sequenceActivities ||
        `i. Implement SWPPP, Site Prep & Mobilization
ii. Site Work & Utilities
iii. Paving & Foundations
iv. Building Construction
v. Landscaping, Drainage & Final Stabilization`,
      projectDescription:
        project.projectDescription ||
        `This project consists of the construction of a ${project.projectName} facility located in <city>, <county>, <state>.`,
    });
  }, [project]);

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

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete this project?")) {
      onDelete();
    }
  };

  const handleGenerateInvoice = () => {
    setIsGeneratingInvoice(true);
    // Mock API call
    setTimeout(() => {
      window.open(project.invoiceLink || "#", "_blank");
      setIsGeneratingInvoice(false);
    }, 1500);
  };

  const isApproved =
    project.status === "Approved for Generation" ||
    project.status === "Complete";
  const isManual = project.status === "Manual Processing";
  const isNew = project.status === "New";

  const canApprove =
    project.status === "Pending Review" ||
    project.status === "Processing" ||
    project.status === "";

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
              <h3 className="text-xl font-bold text-slate-900 leading-tight">
                {project.projectName}
              </h3>
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border",
                  project.status === "Approved for Generation"
                    ? "bg-purple-50 text-purple-700 border-purple-200"
                    : project.status === "Complete"
                    ? "bg-green-50 text-green-700 border-green-200"
                    : project.status === "Manual Processing"
                    ? "bg-orange-50 text-orange-700 border-orange-200"
                    : project.status === "New"
                    ? "bg-slate-100 text-slate-700 border-slate-200"
                    : "bg-indigo-50 text-indigo-700 border-indigo-200"
                )}
              >
                {project.status || "Draft"}
              </span>
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
          {/* Project Details */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-6 flex items-center gap-2">
              <Building className="h-4 w-4" /> Project Details
            </h4>
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    Project Name
                  </label>
                  <input
                    type="text"
                    value={formData.projectName}
                    onChange={(e) =>
                      handleChange("projectName", e.target.value)
                    }
                    className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    disabled={isApproved}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    Project Address
                  </label>
                  <input
                    type="text"
                    value={formData.projectAddress || ""}
                    onChange={(e) =>
                      handleChange("projectAddress", e.target.value)
                    }
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
                    value={formData.startDate || ""}
                    onChange={(e) => handleChange("startDate", e.target.value)}
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
                    value={formData.finishDate || ""}
                    onChange={(e) => handleChange("finishDate", e.target.value)}
                    className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    disabled={isApproved}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Project Description
                </label>
                <textarea
                  value={formData.projectDescription}
                  onChange={(e) =>
                    handleChange("projectDescription", e.target.value)
                  }
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
                  value={formData.sequenceActivities}
                  onChange={(e) =>
                    handleChange("sequenceActivities", e.target.value)
                  }
                  rows={6}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 font-mono"
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-700">
                    Coordinates
                  </label>
                  <a
                    href={`https://www.google.com/maps?q=${formData.latitude.replace(
                      /[^\d.-]/g,
                      ""
                    )},${formData.longitude.replace(/[^\d.-]/g, "")}`}
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
                    value={formData.latitude}
                    onChange={(e) => handleChange("latitude", e.target.value)}
                    className="flex-1 text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    placeholder="Lat"
                    disabled={isApproved}
                  />
                  <input
                    type="text"
                    value={formData.longitude}
                    onChange={(e) => handleChange("longitude", e.target.value)}
                    className="flex-1 text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    placeholder="Long"
                    disabled={isApproved}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  County
                </label>
                <input
                  type="text"
                  value={formData.county || ""}
                  onChange={(e) => handleChange("county", e.target.value)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  TCEQ Segment
                </label>
                <input
                  type="text"
                  value={formData.tceqSegment || ""}
                  onChange={(e) => handleChange("tceqSegment", e.target.value)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  MS4 Operator
                </label>
                <input
                  type="text"
                  value={formData.ms4Operator || ""}
                  onChange={(e) => handleChange("ms4Operator", e.target.value)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>

              <div className="md:col-span-2 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-700">
                    Contributing Waterbody
                  </label>
                  <a
                    href="https://mywaterway.epa.gov/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center hover:underline"
                  >
                    View Source <ExternalLink className="h-3 w-3 ml-1" />
                  </a>
                </div>
                <input
                  type="text"
                  value={formData.waterway}
                  onChange={(e) => handleChange("waterway", e.target.value)}
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
                <div className="flex gap-4 mt-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="waterbodyImpaired"
                      checked={formData.waterbodyImpaired === true}
                      onChange={() => handleChange("waterbodyImpaired", true)}
                      className="text-indigo-600 focus:ring-indigo-500"
                      disabled={isApproved}
                    />
                    <span className="text-sm text-slate-600">Impaired</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="waterbodyImpaired"
                      checked={formData.waterbodyImpaired === false}
                      onChange={() => handleChange("waterbodyImpaired", false)}
                      className="text-indigo-600 focus:ring-indigo-500"
                      disabled={isApproved}
                    />
                    <span className="text-sm text-slate-600">Not Impaired</span>
                  </label>
                </div>
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
                    value={formData.soilData}
                    onChange={(e) => handleChange("soilData", e.target.value)}
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
                      href="#"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center hover:underline"
                    >
                      View Source <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </div>
                  <textarea
                    value={formData.endangeredSpecies}
                    onChange={(e) =>
                      handleChange("endangeredSpecies", e.target.value)
                    }
                    className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 min-h-[80px]"
                    disabled={isApproved}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* SWPPP Specifics */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-6 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" /> SWPPP Specifics
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Est. Acres Disturbed
                </label>
                <input
                  type="number"
                  value={formData.landDisturbanceArea}
                  onChange={(e) =>
                    handleChange(
                      "landDisturbanceArea",
                      parseFloat(e.target.value)
                    )
                  }
                  className="w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                  disabled={isApproved}
                />
              </div>

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

              <div className="md:col-span-2 space-y-3">
                <label className="text-sm font-medium text-slate-700 flex items-center gap-2">
                  <ClipboardList className="h-4 w-4" /> Best Management
                  Practices
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
                        disabled={isApproved}
                      />
                      <span className="text-sm text-slate-600">{bmp}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar Column */}
        <div className="space-y-6">
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
                : "bg-white border-indigo-200 ring-1 ring-indigo-500/10"
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
                  : "bg-indigo-500"
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

            <div className="space-y-3">
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
                <div className="space-y-4">
                  <label className="flex items-center p-3 rounded-lg border border-slate-200 bg-slate-50 cursor-pointer hover:border-indigo-300 transition-colors">
                    <input
                      type="checkbox"
                      checked={formData.plansUploaded || false}
                      onChange={(e) =>
                        handleChange("plansUploaded", e.target.checked)
                      }
                      className="h-4 w-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                    />
                    <span className="ml-3 text-sm font-medium text-slate-700">
                      Project plans uploaded to Dropbox?
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
                </div>
              )}

              {(isApproved || isManual) && (
                <div
                  className={cn(
                    "flex items-center justify-center p-3 rounded-lg border font-medium text-sm",
                    isManual
                      ? "bg-orange-50 text-orange-700 border-orange-200"
                      : "bg-green-50 text-green-700 border-green-200"
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
              )}
            </div>
          </div>

          {/* Financials */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
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
                    onChange={(e) =>
                      handleChange("invoiceTotal", parseFloat(e.target.value))
                    }
                    className="pl-7 w-full text-sm border-slate-200 rounded-lg px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all"
                    placeholder="0.00"
                    step="0.01"
                  />
                </div>
              </div>
              <button
                onClick={handleGenerateInvoice}
                disabled={isGeneratingInvoice || !formData.invoiceTotal}
                className="w-full flex items-center justify-center px-4 py-2.5 border border-slate-200 text-sm font-medium rounded-lg text-slate-700 bg-white hover:bg-slate-50 hover:border-slate-300 focus:ring-4 focus:ring-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
              >
                {isGeneratingInvoice ? (
                  <>
                    <Loader2 className="animate-spin -ml-1 mr-2 h-4 w-4" />
                    Generating...
                  </>
                ) : (
                  <>
                    <CreditCard className="-ml-1 mr-2 h-4 w-4" />
                    Generate on QuickBooks
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Generated Documents Links */}
          {isApproved && (
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <FileText className="h-4 w-4" /> Generated Documents
              </h4>
              <div className="space-y-2">
                {["Cover Letter", "CSN", "NOI", "NOT", "SWPPP DOC"].map(
                  (doc) => (
                    <a
                      key={doc}
                      href="#"
                      className="flex items-center p-3 bg-white border border-slate-200 rounded-xl hover:border-indigo-300 hover:shadow-sm transition-all group"
                    >
                      <div className="h-8 w-8 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600 group-hover:bg-indigo-100 transition-colors mr-3">
                        <FileText className="h-4 w-4" />
                      </div>
                      <span className="text-sm font-medium text-slate-700 group-hover:text-indigo-600 transition-colors">
                        {doc}
                      </span>
                      <ExternalLink className="h-3 w-3 ml-auto text-slate-400 group-hover:text-indigo-400" />
                    </a>
                  )
                )}
              </div>
            </div>
          )}

          {/* Resources */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
              <ExternalLink className="h-4 w-4" /> External Resources
            </h4>
            <div className="space-y-2">
              {[
                { name: "Job Order PDF", href: project.jobOrderLink },
                { name: "Project Folder", href: project.folderLink },
                { name: "Trello Card", href: project.trelloLink },
                { name: "Invoice", href: project.invoiceLink },
              ].map((link) => (
                <a
                  key={link.name}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center p-3 bg-white border border-slate-200 rounded-xl hover:border-indigo-300 hover:shadow-sm transition-all group"
                >
                  <span className="text-sm font-medium text-slate-700 group-hover:text-indigo-600 transition-colors">
                    {link.name}
                  </span>
                  <ExternalLink className="h-3 w-3 ml-auto text-slate-400 group-hover:text-indigo-400" />
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
