import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getJobRows, type JobRowsResponse, type LeadImportJob, type LeadImportRow } from "../lib/leadUploadApi";

const PAGE_SIZE = 25;
type HistoryFilter = "all" | "rejected";

function storedValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Missing";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function sourceValue(row: LeadImportRow, names: string[]): string {
  const entries = Object.entries(row.raw_data || {});
  for (const name of names) {
    const found = entries.find(([key]) => key.toLowerCase().replace(/[\s_-]/g, "") === name.toLowerCase().replace(/[\s_-]/g, ""));
    if (found && found[1] !== null && found[1] !== undefined && found[1] !== "") return storedValue(found[1]);
  }
  return "Missing";
}

function StoredFields({ title, values }: { title: string; values: Record<string, unknown> | null }) {
  const entries = Object.entries(values || {});
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <h4 className="mb-2 text-xs font-semibold text-slate-700">{title}</h4>
      {entries.length === 0 ? <p className="text-sm text-slate-500">Missing</p> : (
        <dl className="space-y-2 text-sm">
          {entries.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="font-medium text-slate-600 break-words">{key}</dt>
              <dd className="text-slate-900 break-all whitespace-pre-wrap">{storedValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function StoredRow({ row, expanded, onToggle }: { row: LeadImportRow; expanded: boolean; onToggle: () => void }) {
  return (
    <li className="min-w-0 rounded-lg border border-slate-200 p-3">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 text-sm text-slate-900">
          <p className="font-semibold break-words">Row {row.row_index + 1} · {sourceValue(row, ["Project Title", "Project Name", "Project"])}</p>
          <p className="mt-1 break-words">Stored source name: {sourceValue(row, ["Name", "Contact Name", "Contact"])}</p>
          <p className="break-all">Stored source email: {sourceValue(row, ["Email", "Contact Email"])}</p>
          <p className="break-words">Stored source company: {sourceValue(row, ["Winning Bidder", "Company", "Company Name", "Organization", "Org"])}</p>
          <p className="mt-1 break-all">Recorded result: {row.status} · Recorded lead ID: {storedValue(row.pipedrive_lead_id)}</p>
          {row.error_message && <p className="mt-1 text-red-700 break-words">Recorded row error: {row.error_message}</p>}
        </div>
        <button type="button" aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} stored fields for row ${row.row_index + 1}`}
          onClick={onToggle} className="inline-flex min-h-11 shrink-0 items-center gap-1 self-start rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{expanded ? "Hide fields" : "Show fields"}
        </button>
      </div>
      {expanded && (
        <div className="mt-3 grid min-w-0 gap-3 md:grid-cols-2">
          <StoredFields title="Stored source fields" values={row.raw_data} />
          <StoredFields title="Stored cleaned values" values={row.cleaned_data} />
        </div>
      )}
    </li>
  );
}

export default function LeadImportHistory({ job }: { job: LeadImportJob }) {
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; data: JobRowsResponse } | null>(null);
  const [requestError, setRequestError] = useState<{ key: string; message: string } | null>(null);
  const requestKey = JSON.stringify([job.id, page, filter, search, attempt]);
  const data = result?.key === requestKey ? result.data : null;
  const error = requestError?.key === requestKey ? requestError.message : null;

  useEffect(() => {
    let current = true;
    getJobRows(job.id, { page, page_size: PAGE_SIZE, filter, search })
      .then((response) => { if (current) setResult({ key: requestKey, data: response }); })
      .catch((cause: unknown) => { if (current) setRequestError({ key: requestKey, message: cause instanceof Error ? cause.message : "Rows unavailable" }); });
    return () => { current = false; };
  }, [job.id, page, filter, search, attempt, requestKey]);

  const changeFilter = (next: HistoryFilter) => {
    setFilter(next);
    setPage(0);
    setExpandedId(null);
  };
  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setSearch(searchInput.trim());
    setPage(0);
    setExpandedId(null);
  };
  const totalPages = data ? Math.max(1, Math.ceil(data.filtered_count / PAGE_SIZE)) : 1;

  return (
    <section aria-label="Recorded import history" className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <h2 className="text-lg font-semibold text-slate-900">
        {job.status === "error" ? "Failed or partial import" : "Recorded import results"}
      </h2>
      <p className="mt-1 text-sm text-slate-700 break-all">{job.filename} · {job.status}</p>
      {job.error_message && <p className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800 break-words">{job.error_message}</p>}
      <p className="mt-3 text-sm text-slate-600">
        Stored rows may have been updated. CRM contact selected at import and selection reason are unavailable.
        Counts reflect stored import records and do not verify current Pipedrive data. Uploaded is a recorded row result, not current CRM verification.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <form onSubmit={submitSearch} className="flex min-w-0 flex-1 flex-wrap gap-2">
          <label className="min-w-0 flex-1 text-sm text-slate-700">
            Search stored rows
            <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Project title, city, state" className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </label>
          <button type="submit" className="min-h-11 self-end rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500">Search</button>
        </form>
        <div className="flex gap-2" role="group" aria-label="Recorded row filter">
          {(["all", "rejected"] as const).map((option) => (
            <button key={option} type="button" aria-pressed={filter === option} onClick={() => changeFilter(option)}
              className={`min-h-11 rounded-lg border px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand-500 ${filter === option ? "border-brand-600 bg-brand-50 text-brand-800" : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}>
              {option === "all" ? "All" : "Rejected"}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p>{/\b(401|403)\b/.test(error) ? "Access to stored rows was denied." : "Stored rows could not be loaded."}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-2 min-h-11 rounded-lg border border-red-300 px-3 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-brand-500">Retry rows</button>
        </div>
      ) : !data ? (
        <p role="status" className="mt-4 text-sm text-slate-600">Loading stored rows…</p>
      ) : (
        <>
          <p className="mt-4 text-sm text-slate-600">{data.summary.total} stored rows · {data.filtered_count} match this view</p>
          {data.summary.total === 0 ? (
            <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">No stored rows for this import.</p>
          ) : data.filtered_count === 0 ? (
            <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">No rows match this filter or search.</p>
          ) : data.rows.length === 0 ? (
            <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">No rows on this page. Go to a previous page.</p>
          ) : (
            <ol className="mt-3 space-y-2">
              {data.rows.map((row) => (
                <StoredRow key={row.id} row={row} expanded={expandedId === row.id} onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)} />
              ))}
            </ol>
          )}
          <div className="mt-4 flex items-center justify-between gap-3 text-sm text-slate-600">
            <button type="button" disabled={page === 0} onClick={() => { setPage((value) => Math.max(0, value - 1)); setExpandedId(null); }}
              className="min-h-11 rounded-lg border border-slate-300 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-brand-500">Previous</button>
            <span>Page {page + 1} of {totalPages}</span>
            <button type="button" disabled={page + 1 >= totalPages || data.rows.length === 0} onClick={() => { setPage((value) => value + 1); setExpandedId(null); }}
              className="min-h-11 rounded-lg border border-slate-300 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-brand-500">Next</button>
          </div>
        </>
      )}
    </section>
  );
}
