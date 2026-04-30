import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, CheckCircle2, AlertCircle, Loader2, FileText, Trash2 } from "lucide-react";
import {
  uploadLeadsCsv,
  getLeadImportStatus,
  listRecentLeadImports,
  deleteJob,
  type LeadImportJob,
  type LeadImportStatus,
} from "../lib/leadUploadApi";
import LeadImportPreview from "./LeadImportPreview";
import { cn } from "../utils";

const STATUS_LABEL: Record<LeadImportStatus, string> = {
  uploaded: "Uploaded — queued",
  cleaning: "Cleaning project names with AI",
  ready: "Ready for Pipedrive upload",
  uploading: "Uploading to Pipedrive",
  done: "Done",
  error: "Error",
};

const STATUS_COLOR: Record<LeadImportStatus, string> = {
  uploaded: "text-slate-600 bg-slate-50",
  cleaning: "text-blue-700 bg-blue-50",
  ready: "text-indigo-700 bg-indigo-50",
  uploading: "text-amber-700 bg-amber-50",
  done: "text-emerald-700 bg-emerald-50",
  error: "text-red-700 bg-red-50",
};

function isTerminal(s: LeadImportStatus) {
  return s === "done" || s === "error";
}

function ProgressRow({ job, onDelete }: { job: LeadImportJob; onDelete?: () => void }) {
  const pctCleaned = job.total_rows ? Math.round((job.cleaned_rows / job.total_rows) * 100) : 0;
  const pctUploaded = job.total_rows ? Math.round((job.uploaded_rows / job.total_rows) * 100) : 0;
  return (
    <div className="border border-slate-200 rounded-xl p-4 bg-white">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <FileText className="h-5 w-5 text-slate-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-slate-900 truncate">{job.filename}</div>
            <div className="text-xs text-slate-500 mt-0.5">
              {new Date(job.created_at).toLocaleString()}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap flex items-center gap-1.5",
              STATUS_COLOR[job.status],
            )}
          >
            {!isTerminal(job.status) && <Loader2 className="h-3 w-3 animate-spin" />}
            {job.status === "done" && <CheckCircle2 className="h-3 w-3" />}
            {job.status === "error" && <AlertCircle className="h-3 w-3" />}
            {STATUS_LABEL[job.status]}
          </span>
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1 text-slate-400 hover:text-red-600 transition"
              title="Delete this job"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {job.total_rows !== null && (
        <div className="mt-3 space-y-2">
          <div>
            <div className="flex justify-between text-xs text-slate-600 mb-1">
              <span>Cleaned</span>
              <span>{job.cleaned_rows} / {job.total_rows}</span>
            </div>
            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${pctCleaned}%` }} />
            </div>
          </div>
          <div>
            <div className="flex justify-between text-xs text-slate-600 mb-1">
              <span>Uploaded to Pipedrive</span>
              <span>{job.uploaded_rows} / {job.total_rows}</span>
            </div>
            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pctUploaded}%` }} />
            </div>
          </div>
        </div>
      )}
      {job.error_message && (
        <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {job.error_message}
        </div>
      )}
    </div>
  );
}

export default function LeadUpload() {
  const [activeJob, setActiveJob] = useState<LeadImportJob | null>(null);
  const [recent, setRecent] = useState<LeadImportJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshRecent = useCallback(async () => {
    try {
      setRecent(await listRecentLeadImports());
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  // Poll active job until terminal
  useEffect(() => {
    if (!activeJob || isTerminal(activeJob.status)) return;
    const t = setInterval(async () => {
      try {
        const updated = await getLeadImportStatus(activeJob.id);
        setActiveJob(updated);
        if (isTerminal(updated.status)) {
          refreshRecent();
        }
      } catch (e) {
        console.error("status poll failed:", e);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [activeJob, refreshRecent]);

  const startUpload = useCallback(async (file: File) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Only CSV files accepted");
      return;
    }
    setIsUploading(true);
    try {
      const { job_id } = await uploadLeadsCsv(file);
      const job = await getLeadImportStatus(job_id);
      setActiveJob(job);
      refreshRecent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsUploading(false);
    }
  }, [refreshRecent]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) startUpload(file);
  };

  const handleDelete = useCallback(async (jobId: string) => {
    if (!confirm("Delete this import job? Cannot be undone.")) return;
    try {
      await deleteJob(jobId);
      if (activeJob?.id === jobId) setActiveJob(null);
      refreshRecent();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [activeJob, refreshRecent]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Lead Import</h1>
        <p className="text-sm text-slate-500 mt-1">
          Drop a CSV here. AI cleans the project names, then leads land in Pipedrive automatically.
        </p>
      </div>

      <div
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          "border-2 border-dashed rounded-2xl p-12 text-center transition cursor-pointer",
          dragOver ? "border-indigo-500 bg-indigo-50" : "border-slate-300 hover:border-slate-400 bg-white",
          isUploading && "pointer-events-none opacity-60",
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={(e) => e.target.files?.[0] && startUpload(e.target.files[0])}
          className="hidden"
        />
        <Upload className="h-10 w-10 text-slate-400 mx-auto mb-3" />
        <div className="text-base font-medium text-slate-700">
          {isUploading ? "Uploading..." : "Drop CSV here or click to browse"}
        </div>
        <div className="text-sm text-slate-500 mt-1">
          Replaces the Dropbox folder rotation flow
        </div>
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-800 text-sm rounded">
          {error}
        </div>
      )}

      {activeJob && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Current import</h2>
          <ProgressRow job={activeJob} onDelete={() => handleDelete(activeJob.id)} />
        </div>
      )}

      {activeJob && activeJob.status === "ready" && (
        <div className="mt-6">
          <LeadImportPreview
            job={activeJob}
            onApproved={() => {
              getLeadImportStatus(activeJob.id).then(setActiveJob).catch(console.error);
            }}
          />
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Recent imports</h2>
          <div className="space-y-2">
            {recent.filter((j) => !activeJob || j.id !== activeJob.id).slice(0, 10).map((job) => (
              <ProgressRow key={job.id} job={job} onDelete={() => handleDelete(job.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
