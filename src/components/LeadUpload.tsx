import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, CheckCircle2, AlertCircle, Loader2, FileText, Trash2 } from "lucide-react";
import {
  uploadLeadsCsv,
  type UploadResult,
  getLeadImportStatus,
  listRecentLeadImports,
  deleteJob,
  notUploadedNote,
  type LeadImportJob,
  type LeadImportStatus,
  type LeadUploadKind,
} from "../lib/leadUploadApi";
import LeadImportPreview from "./LeadImportPreview";
import LeadImportHistory from "./LeadImportHistory";
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
  ready: "text-brand-700 bg-brand-50",
  uploading: "text-amber-700 bg-amber-50",
  done: "text-emerald-700 bg-emerald-50",
  error: "text-red-700 bg-red-50",
};

const KIND_LABEL: Record<LeadUploadKind, string> = {
  bid_sheet: "Bid sheet",
  project_list: "Project list",
};

const UPLOAD_ZONES: { kind: LeadUploadKind; title: string; hint: string }[] = [
  {
    kind: "project_list",
    title: "Upload project list",
    hint: "Monthly CMD project list exported as CSV. Drop it here or click to browse.",
  },
  {
    kind: "bid_sheet",
    title: "Upload bid sheet",
    hint: "Estimator's bid tracker (BuildingConnected, ConstructConnect, iSQFT tabs exported as CSV). These contacts never get cold emails.",
  },
];

function isTerminal(s: LeadImportStatus) {
  return s === "done" || s === "error";
}

export function ProgressRow({ job, onDelete, onOpen, onHistory }: { job: LeadImportJob; onDelete?: () => void; onOpen?: () => void; onHistory?: () => void }) {
  const pctCleaned = job.total_rows ? Math.round((job.cleaned_rows / job.total_rows) * 100) : 0;
  const pctUploaded = job.total_rows ? Math.round((job.uploaded_rows / job.total_rows) * 100) : 0;
  return (
    <div
      className={cn(
        "border border-slate-200 rounded-xl p-4 bg-white",
        onOpen && "cursor-pointer hover:border-brand-300 hover:bg-brand-50/30 transition"
      )}
      onClick={onOpen}
    >
      <div className={cn("flex items-start justify-between gap-3", onHistory && "flex-wrap")}>
        <div className="flex items-start gap-3 min-w-0">
          <FileText className="h-5 w-5 text-slate-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-slate-900 truncate">{job.filename}</div>
            <div className="text-xs text-slate-500 mt-0.5">
              {new Date(job.created_at).toLocaleString()}
              {job.kind && KIND_LABEL[job.kind] ? ` · ${KIND_LABEL[job.kind]}` : ""}
            </div>
          </div>
        </div>
        <div className={cn("flex items-center gap-2", onHistory && "flex-wrap")}>
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
          {onHistory && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onHistory(); }}
              className="min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              View recorded rows
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
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
          {notUploadedNote(job) && <p className="text-xs text-slate-600">{notUploadedNote(job)}</p>}
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

const ACTIVE_JOB_KEY = "lead_import_active_job_id";

export default function LeadUpload() {
  const [activeJob, setActiveJob] = useState<LeadImportJob | null>(null);
  const [selectedHistoryJob, setSelectedHistoryJob] = useState<LeadImportJob | null>(null);
  const [recent, setRecent] = useState<LeadImportJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<LeadUploadKind | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [mapping, setMapping] = useState<UploadResult | null>(null);
  const fileInputRefs = useRef<Record<LeadUploadKind, HTMLInputElement | null>>({ project_list: null, bid_sheet: null });

  // Restore active job from localStorage on mount (survive tab navigation)
  useEffect(() => {
    const saved = localStorage.getItem(ACTIVE_JOB_KEY);
    if (saved) {
      getLeadImportStatus(saved)
        .then((job) => setActiveJob(job))
        .catch(() => localStorage.removeItem(ACTIVE_JOB_KEY));
    }
  }, []);

  // Persist active job id whenever it changes
  useEffect(() => {
    if (activeJob) localStorage.setItem(ACTIVE_JOB_KEY, activeJob.id);
    else localStorage.removeItem(ACTIVE_JOB_KEY);
  }, [activeJob]);

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

  const startUpload = useCallback(async (file: File, kind: LeadUploadKind) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Only CSV files accepted");
      return;
    }
    setIsUploading(true);
    try {
      const result = await uploadLeadsCsv(file, kind);
      setMapping(result.source && result.source !== "cmd" ? result : null);
      const job = await getLeadImportStatus(result.job_id);
      setActiveJob(job);
      refreshRecent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsUploading(false);
    }
  }, [refreshRecent]);

  const onDrop = (e: React.DragEvent, kind: LeadUploadKind) => {
    e.preventDefault();
    setDragOver(null);
    const file = e.dataTransfer.files[0];
    if (file) startUpload(file, kind);
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
          Upload a CSV to prepare construction leads for Pipedrive.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {UPLOAD_ZONES.map((zone) => (
          <div
            key={zone.kind}
            data-upload-kind={zone.kind}
            onDrop={(e) => onDrop(e, zone.kind)}
            onDragOver={(e) => { e.preventDefault(); setDragOver(zone.kind); }}
            onDragLeave={() => setDragOver(null)}
            onClick={() => fileInputRefs.current[zone.kind]?.click()}
            className={cn(
              "border-2 border-dashed rounded-2xl p-8 text-center transition cursor-pointer",
              dragOver === zone.kind ? "border-brand-500 bg-brand-50" : "border-slate-300 hover:border-slate-400 bg-white",
              isUploading && "pointer-events-none opacity-60",
            )}
          >
            <input
              ref={(el) => { fileInputRefs.current[zone.kind] = el; }}
              type="file"
              accept=".csv"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) startUpload(file, zone.kind);
              }}
              className="hidden"
            />
            <Upload className="h-10 w-10 text-slate-400 mx-auto mb-3" />
            <div className="text-base font-medium text-slate-700">
              {isUploading ? "Uploading..." : zone.title}
            </div>
            <div className="text-sm text-slate-500 mt-1">{zone.hint}</div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-800 text-sm rounded">
          {error}
        </div>
      )}

      {activeJob && (
        <div className="mt-6">
          {mapping?.source === "bid-aggregator" && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-semibold">Read as a bid aggregator sheet</div>
              <div className="mt-1">
                Renamed {mapping.renamed?.join(", ") || "nothing"}. Filled in{" "}
                {mapping.injected?.join(", ") || "nothing"}. Every row is set to Stage CM, which is
                the bidding sequence rather than a congratulations one. Check the rows below before
                approving.
              </div>
            </div>
          )}
          {mapping?.source === "unknown" && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <div className="font-semibold">Column names not recognised</div>
              <div className="mt-1">
                The file went through untouched, so nothing was mangled, but the importer may not
                find the columns it needs. Expected either the MBT layout or Milo's aggregator
                layout.
              </div>
            </div>
          )}
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Current import</h2>
          <ProgressRow job={activeJob} onDelete={() => handleDelete(activeJob.id)} onHistory={isTerminal(activeJob.status) ? () => setSelectedHistoryJob(activeJob) : undefined} />
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

      {selectedHistoryJob && (
        <div className="mt-6">
          <div className="mb-2 flex justify-end">
            <button type="button" onClick={() => setSelectedHistoryJob(null)} className="min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500">Close recorded rows</button>
          </div>
          <LeadImportHistory key={selectedHistoryJob.id} job={selectedHistoryJob} />
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Recent imports</h2>
          <div className="space-y-2">
            {recent.filter((j) => !activeJob || j.id !== activeJob.id).slice(0, 10).map((job) => (
              <ProgressRow
                key={job.id}
                job={job}
                onDelete={isTerminal(job.status) ? undefined : () => handleDelete(job.id)}
                onOpen={isTerminal(job.status) ? undefined : () => setActiveJob(job)}
                onHistory={isTerminal(job.status) ? () => setSelectedHistoryJob(job) : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
