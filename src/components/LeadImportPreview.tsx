import { useEffect, useState, useCallback, useMemo } from "react";
import { CheckCircle2, XCircle, Edit3, Save, X, AlertTriangle, Send, Search } from "lucide-react";
import {
  getJobRows,
  patchJobRow,
  approveJob,
  type LeadImportRow,
  type LeadImportJob,
} from "../lib/leadUploadApi";
import { cn } from "../utils";

interface Props {
  job: LeadImportJob;
  onApproved?: () => void;
}

function getDisplay(row: LeadImportRow, col: string): string {
  const val = row.cleaned_data?.[col] ?? row.raw_data[col];
  return val == null ? "" : String(val);
}

const PAGE_SIZE = 50;

export default function LeadImportPreview({ job, onApproved }: Props) {
  const [rows, setRows] = useState<LeadImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "review" | "rejected">("all");
  const [page, setPage] = useState(0);

  const loadRows = useCallback(async () => {
    try {
      setRows(await getJobRows(job.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [job.id]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  const startEdit = (row: LeadImportRow) => {
    setEditingId(row.id);
    setEditValue(getDisplay(row, "Project Title"));
  };

  const saveEdit = async (row: LeadImportRow) => {
    try {
      const cleaned = { ...(row.cleaned_data || {}), "Project Title": editValue };
      await patchJobRow(job.id, row.id, { cleaned_data: cleaned });
      setEditingId(null);
      loadRows();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const reject = async (row: LeadImportRow) => {
    try {
      await patchJobRow(job.id, row.id, { status: "rejected" });
      loadRows();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const restore = async (row: LeadImportRow) => {
    try {
      await patchJobRow(job.id, row.id, { status: "cleaned" });
      loadRows();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const approve = async () => {
    setApproving(true);
    setError(null);
    try {
      await approveJob(job.id);
      onApproved?.();
    } catch (e) {
      setError((e as Error).message);
      setApproving(false);
    }
  };

  const approvedCount = rows.filter((r) => r.status === "cleaned" || r.status === "approved").length;
  const rejectedCount = rows.filter((r) => r.status === "rejected").length;
  const fallbackCount = rows.filter((r) => {
    const c = r.cleaned_data as Record<string, unknown> | null;
    return c?.abbreviation_fallback === true;
  }).length;

  // Sort: review-flagged first, then by row_index
  // Filter: search + status filter
  const visible = useMemo(() => {
    let list = [...rows];
    list.sort((a, b) => {
      const aFb = a.cleaned_data?.abbreviation_fallback === true ? 0 : 1;
      const bFb = b.cleaned_data?.abbreviation_fallback === true ? 0 : 1;
      if (aFb !== bFb) return aFb - bFb;
      return a.row_index - b.row_index;
    });
    if (filter === "review") list = list.filter((r) => r.cleaned_data?.abbreviation_fallback === true);
    if (filter === "rejected") list = list.filter((r) => r.status === "rejected");
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((r) => {
        const cleaned = String(r.cleaned_data?.["Project Title"] || "").toLowerCase();
        const raw = String(r.raw_data["Project Title"] || "").toLowerCase();
        const city = String(r.raw_data["City"] || r.raw_data["city"] || "").toLowerCase();
        const state = String(r.raw_data["State"] || r.raw_data["state"] || "").toLowerCase();
        return cleaned.includes(q) || raw.includes(q) || city.includes(q) || state.includes(q);
      });
    }
    return list;
  }, [rows, search, filter]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (loading) return <div className="p-6 text-sm text-slate-500">Loading rows...</div>;
  if (!rows.length) return <div className="p-6 text-sm text-slate-500">No rows yet — wait for cleaning to complete.</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Review &amp; approve</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {approvedCount} ready · {rejectedCount} rejected
            {fallbackCount > 0 && (
              <span className="ml-2 text-amber-700">· {fallbackCount} flagged for review</span>
            )}
          </p>
        </div>
        <button
          onClick={approve}
          disabled={approving || approvedCount === 0}
          className={cn(
            "inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition",
            approving || approvedCount === 0
              ? "bg-slate-100 text-slate-400 cursor-not-allowed"
              : "bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm"
          )}
        >
          <Send className="h-4 w-4" />
          {approving ? "Pushing..." : `Upload ${approvedCount} to Pipedrive`}
        </button>
      </div>

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 text-sm rounded">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search title, city, state..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none bg-white"
          />
        </div>
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
          {(["all", "review", "rejected"] as const).map((f) => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(0); }}
              className={cn(
                "text-xs font-semibold px-3 py-1.5 rounded transition capitalize",
                filter === f ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              {f === "review" && fallbackCount > 0 ? `Review (${fallbackCount})` : f}
            </button>
          ))}
        </div>
        <div className="text-xs text-slate-500 ml-auto">
          {visible.length} of {rows.length}
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-slate-700 w-12">#</th>
              <th className="text-left px-3 py-2 font-semibold text-slate-700">Cleaned Title</th>
              <th className="text-left px-3 py-2 font-semibold text-slate-700">Original</th>
              <th className="text-left px-3 py-2 font-semibold text-slate-700">City, State</th>
              <th className="text-left px-3 py-2 font-semibold text-slate-700 w-32">Status</th>
              <th className="text-right px-3 py-2 font-semibold text-slate-700 w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const cleanedTitle = getDisplay(row, "Project Title");
              const rawTitle = String(row.raw_data["Project Title"] || row.cleaned_data?.["Raw Project Title"] || "");
              const city = String(row.raw_data["City"] || "");
              const state = String(row.raw_data["State"] || "");
              const isFallback = row.cleaned_data?.abbreviation_fallback === true;
              const isRejected = row.status === "rejected";
              const isUploaded = row.status === "uploaded";
              const isError = row.status === "error";

              return (
                <tr
                  key={row.id}
                  className={cn(
                    "border-b border-slate-100 last:border-b-0",
                    isRejected && "opacity-50 bg-slate-50",
                    isUploaded && "bg-emerald-50/40",
                    isError && "bg-red-50/40",
                  )}
                >
                  <td className="px-3 py-2 text-slate-500">{row.row_index + 1}</td>
                  <td className="px-3 py-2">
                    {editingId === row.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(row);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="w-full px-2 py-1 border border-indigo-300 rounded text-sm focus:ring-1 focus:ring-indigo-500 outline-none"
                        />
                        <button onClick={() => saveEdit(row)} className="text-indigo-600 hover:text-indigo-800 p-1">
                          <Save className="h-4 w-4" />
                        </button>
                        <button onClick={() => setEditingId(null)} className="text-slate-400 hover:text-slate-600 p-1">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className={cn("font-medium", isFallback && "text-amber-700")}>{cleanedTitle}</span>
                        {isFallback && (
                          <span title="AI fell back to raw — review manually">
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{rawTitle}</td>
                  <td className="px-3 py-2 text-slate-600 text-xs">{[city, state].filter(Boolean).join(", ")}</td>
                  <td className="px-3 py-2">
                    <StatusPill status={row.status} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!isUploaded && editingId !== row.id && (
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => startEdit(row)}
                          className="text-slate-400 hover:text-indigo-600 p-1"
                          title="Edit"
                        >
                          <Edit3 className="h-4 w-4" />
                        </button>
                        {isRejected ? (
                          <button
                            onClick={() => restore(row)}
                            className="text-slate-400 hover:text-emerald-600 p-1"
                            title="Restore"
                          >
                            <CheckCircle2 className="h-4 w-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => reject(row)}
                            className="text-slate-400 hover:text-red-600 p-1"
                            title="Reject"
                          >
                            <XCircle className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-sm">
          <span className="text-slate-500">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-3 py-1 rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
            >
              Prev
            </button>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="px-3 py-1 rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: LeadImportRow["status"] }) {
  const map: Record<LeadImportRow["status"], { label: string; cls: string }> = {
    pending: { label: "Pending", cls: "bg-slate-100 text-slate-600" },
    cleaned: { label: "Ready", cls: "bg-blue-50 text-blue-700" },
    approved: { label: "Approved", cls: "bg-indigo-50 text-indigo-700" },
    rejected: { label: "Rejected", cls: "bg-slate-100 text-slate-500" },
    uploaded: { label: "Uploaded", cls: "bg-emerald-50 text-emerald-700" },
    error: { label: "Error", cls: "bg-red-50 text-red-700" },
  };
  const m = map[status];
  return <span className={cn("text-xs font-medium px-2 py-0.5 rounded", m.cls)}>{m.label}</span>;
}
