import { useEffect, useState, useCallback } from "react";
import { CheckCircle2, XCircle, Edit3, Save, X, AlertTriangle, Send, Search, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
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

// Flexible field lookup — handles common CSV column variations
function pick(obj: Record<string, unknown> | null | undefined, candidates: string[]): string {
  if (!obj) return "";
  const keys = Object.keys(obj);
  for (const c of candidates) {
    if (obj[c] != null && obj[c] !== "") return String(obj[c]);
    const ki = keys.find((k) => k.toLowerCase() === c.toLowerCase());
    if (ki && obj[ki] != null && obj[ki] !== "") return String(obj[ki]);
    const ks = keys.find(
      (k) => k.toLowerCase().replace(/[\s_-]/g, "") === c.toLowerCase().replace(/[\s_-]/g, "")
    );
    if (ks && obj[ks] != null && obj[ks] !== "") return String(obj[ks]);
  }
  return "";
}

const STAGE_COLOR: Record<string, string> = {
  AGC: "bg-emerald-50 text-emerald-700",
  LBA: "bg-blue-50 text-blue-700",
  CM: "bg-purple-50 text-purple-700",
  PB: "bg-amber-50 text-amber-700",
  OB: "bg-amber-50 text-amber-700",
};

const PAGE_SIZE = 50;

export default function LeadImportPreview({ job, onApproved }: Props) {
  const [pageRows, setPageRows] = useState<LeadImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "review" | "rejected">("all");
  const [page, setPage] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);
  const [summary, setSummary] = useState({ total: 0, approved: 0, rejected: 0, review: 0 });
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await getJobRows(job.id, { page, page_size: PAGE_SIZE, filter, search: debouncedSearch });
      setPageRows(resp.rows);
      setFilteredCount(resp.filtered_count);
      setSummary(resp.summary);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [job.id, page, filter, debouncedSearch]);

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

  const approvedCount = summary.approved;
  const rejectedCount = summary.rejected;
  const fallbackCount = summary.review;

  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE));

  if (loading && pageRows.length === 0 && summary.total === 0) {
    return <div className="p-6 text-sm text-slate-500">Loading rows...</div>;
  }
  if (summary.total === 0) {
    return <div className="p-6 text-sm text-slate-500">No rows yet — wait for cleaning to complete.</div>;
  }

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
              : "bg-brand-600 text-white hover:bg-brand-700 shadow-sm"
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
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-1 focus:ring-brand-500 outline-none bg-white"
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
          {filteredCount} of {summary.total}
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
        <table className="w-full text-sm table-fixed">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left px-2 py-2 font-semibold text-slate-700 w-8"></th>
              <th className="text-left px-2 py-2 font-semibold text-slate-700 w-10">#</th>
              <th className="text-left px-2 py-2 font-semibold text-slate-700">Cleaned Title</th>
              <th className="text-left px-2 py-2 font-semibold text-slate-700 w-16">Stage</th>
              <th className="text-left px-2 py-2 font-semibold text-slate-700 w-44">Contact</th>
              <th className="text-left px-2 py-2 font-semibold text-slate-700 w-24">Bid Date</th>
              <th className="text-left px-2 py-2 font-semibold text-slate-700 w-40">Winning Bidder</th>
              <th className="text-left px-2 py-2 font-semibold text-slate-700 w-24">Status</th>
              <th className="text-right px-2 py-2 font-semibold text-slate-700 w-20">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const cleanedTitle = getDisplay(row, "Project Title");
              const stage = pick(row.raw_data, ["Stage", "Project Stage"]);
              const contactName = pick(row.raw_data, ["Name", "Contact Name", "Contact"]);
              const contactEmail = pick(row.raw_data, ["Email", "Contact Email"]);
              const contactPhone = pick(row.raw_data, ["Phone", "Contact Phone"]);
              const bidDate = pick(row.raw_data, ["Bid Date", "BidDate", "bid_date"]);
              const startDate = pick(row.raw_data, ["Start", "Start Date"]);
              const winner = pick(row.raw_data, ["Winning Bidder", "Awarded Contractor", "Org", "Organization"]);
              const cityState = pick(row.raw_data, ["City + State", "CityState"]) || [pick(row.raw_data, ["City"]), pick(row.raw_data, ["State"])].filter(Boolean).join(", ");
              const quickLink = pick(row.raw_data, ["Quick Link", "URL", "Link"]);
              const notes = pick(row.raw_data, ["Notes", "Note"]);
              const isFallback = row.cleaned_data?.abbreviation_fallback === true;
              const isRejected = row.status === "rejected";
              const isUploaded = row.status === "uploaded";
              const isError = row.status === "error";
              const isExpanded = expandedRowId === row.id;

              return (
                <FragmentRow key={row.id}>
                  <tr
                    className={cn(
                      "border-b border-slate-100",
                      !isExpanded && "last:border-b-0",
                      isRejected && "opacity-50 bg-slate-50",
                      isUploaded && "bg-emerald-50/40",
                      isError && "bg-red-50/40",
                    )}
                  >
                    <td className="px-2 py-2">
                      <button
                        onClick={() => setExpandedRowId(isExpanded ? null : row.id)}
                        className="text-slate-400 hover:text-slate-700 p-1"
                        title={isExpanded ? "Collapse" : "Expand details"}
                      >
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className="px-2 py-2 text-slate-500">{row.row_index + 1}</td>
                    <td className="px-2 py-2 truncate">
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
                            className="w-full px-2 py-1 border border-brand-300 rounded text-sm focus:ring-1 focus:ring-brand-500 outline-none"
                          />
                          <button onClick={() => saveEdit(row)} className="text-brand-600 hover:text-brand-800 p-1">
                            <Save className="h-4 w-4" />
                          </button>
                          <button onClick={() => setEditingId(null)} className="text-slate-400 hover:text-slate-600 p-1">
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 min-w-0" title={cleanedTitle}>
                          <span className={cn("font-medium truncate", isFallback && "text-amber-700")}>{cleanedTitle}</span>
                          {isFallback && (
                            <span
                              title={String(row.cleaned_data?.abbreviation_review_reason || "AI flagged for review")}
                              className="shrink-0"
                            >
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {stage && (
                        <span className={cn("text-xs font-semibold px-2 py-0.5 rounded uppercase", STAGE_COLOR[stage.toUpperCase()] || "bg-slate-100 text-slate-700")}>
                          {stage}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 truncate" title={`${contactName}\n${contactEmail}`}>
                      {contactName ? (
                        <div className="leading-tight">
                          <div className="text-slate-800 truncate">{contactName}</div>
                          <div className="text-xs text-slate-500 truncate">{contactEmail || "—"}</div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">no contact</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-xs text-slate-600 truncate" title={bidDate}>
                      {bidDate || "—"}
                    </td>
                    <td className="px-2 py-2 text-xs text-slate-700 truncate" title={winner}>
                      {winner || "—"}
                    </td>
                    <td className="px-2 py-2">
                      <StatusPill status={row.status} />
                    </td>
                    <td className="px-2 py-2 text-right">
                      {!isUploaded && editingId !== row.id && (
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={() => startEdit(row)}
                            className="text-slate-400 hover:text-brand-600 p-1"
                            title="Edit title"
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
                  {isExpanded && (
                    <tr className="bg-slate-50/50 border-b border-slate-100 last:border-b-0">
                      <td></td>
                      <td colSpan={8} className="px-4 py-3">
                        {row.cleaned_data?.abbreviation_review_reason ? (
                          <div className="mb-3 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800 flex items-start gap-2">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <div><span className="font-semibold">Flagged for review:</span> {String(row.cleaned_data.abbreviation_review_reason)}</div>
                          </div>
                        ) : null}
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-xs">
                          <Field label="Original Title" value={pick(row.raw_data, ["Project Title"])} />
                          <Field label="City + State" value={cityState} />
                          <Field label="Phone" value={contactPhone} />
                          <Field label="Start Date" value={startDate} />
                          <Field label="Bid Date" value={bidDate} />
                          <Field label="Stage" value={stage} />
                          <Field label="Notes" value={notes} />
                          {quickLink && (
                            <div>
                              <div className="font-semibold text-slate-500 mb-0.5">Quick Link</div>
                              <a
                                href={quickLink}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-brand-600 hover:underline truncate"
                              >
                                CMD <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                          )}
                          {/* Any extra raw_data keys not covered above */}
                          {Object.entries(row.raw_data)
                            .filter(([k]) => k && !["Project Title", "City", "State", "City + State", "Stage", "Name", "Email", "Phone", "Bid Date", "Start", "Notes", "Quick Link", "Winning Bidder"].includes(k))
                            .map(([k, v]) => (
                              <Field key={k} label={k} value={String(v ?? "")} />
                            ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </FragmentRow>
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

// Fragment that holds two <tr> elements (main row + expand row) under a single key
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <div className="font-semibold text-slate-500 mb-0.5">{label}</div>
      <div className="text-slate-800 break-words">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: LeadImportRow["status"] }) {
  const map: Record<LeadImportRow["status"], { label: string; cls: string }> = {
    pending: { label: "Pending", cls: "bg-slate-100 text-slate-600" },
    cleaned: { label: "Ready", cls: "bg-blue-50 text-blue-700" },
    approved: { label: "Approved", cls: "bg-brand-50 text-brand-700" },
    rejected: { label: "Rejected", cls: "bg-slate-100 text-slate-500" },
    uploaded: { label: "Uploaded", cls: "bg-emerald-50 text-emerald-700" },
    error: { label: "Error", cls: "bg-red-50 text-red-700" },
  };
  const m = map[status];
  return <span className={cn("text-xs font-medium px-2 py-0.5 rounded", m.cls)}>{m.label}</span>;
}
