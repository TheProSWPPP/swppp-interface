export type LeadImportStatus =
  | "uploaded"
  | "cleaning"
  | "ready"
  | "uploading"
  | "done"
  | "error";

export interface LeadImportJob {
  id: string;
  filename: string;
  status: LeadImportStatus;
  total_rows: number | null;
  cleaned_rows: number;
  uploaded_rows: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export async function uploadLeadsCsv(file: File): Promise<{ job_id: string; status: LeadImportStatus }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/leads/upload", {
    method: "POST",
    credentials: "include",
    body: fd,
  });
  if (!res.ok) {
    if (res.status === 413) {
      throw new Error(
        "That file is too large to upload. Try splitting it into smaller batches (a few thousand rows each).",
      );
    }
    const text = (await res.text().catch(() => "")).trim();
    // Server error pages come back as HTML — don't dump raw markup at the user.
    const isHtml = text.startsWith("<") || /<html|<!doctype/i.test(text);
    const clean = !text || isHtml ? "" : text;
    throw new Error(clean || `Upload failed (${res.status}). Please try again.`);
  }
  return res.json();
}

export async function getLeadImportStatus(jobId: string): Promise<LeadImportJob> {
  const res = await fetch(`/api/leads/upload/${jobId}/status`, { credentials: "include" });
  if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
  return res.json();
}

export async function listRecentLeadImports(): Promise<LeadImportJob[]> {
  const res = await fetch("/api/leads/upload", { credentials: "include" });
  if (!res.ok) throw new Error(`Recent imports fetch failed: ${res.status}`);
  return res.json();
}

export type LeadImportRowStatus =
  | "pending"
  | "cleaned"
  | "approved"
  | "rejected"
  | "uploaded"
  | "error";

export interface LeadImportRow {
  id: string;
  row_index: number;
  raw_data: Record<string, unknown>;
  cleaned_data: Record<string, unknown> | null;
  status: LeadImportRowStatus;
  pipedrive_lead_id: string | null;
  error_message: string | null;
  updated_at: string;
}

export interface JobRowsResponse {
  rows: LeadImportRow[];
  page: number;
  page_size: number;
  filtered_count: number;
  summary: {
    total: number;
    approved: number;
    rejected: number;
    review: number;
  };
}

export async function getJobRows(
  jobId: string,
  opts: { page?: number; page_size?: number; filter?: "all" | "review" | "rejected"; search?: string } = {},
): Promise<JobRowsResponse> {
  const params = new URLSearchParams();
  if (opts.page != null) params.set("page", String(opts.page));
  if (opts.page_size != null) params.set("page_size", String(opts.page_size));
  if (opts.filter) params.set("filter", opts.filter);
  if (opts.search) params.set("search", opts.search);
  const qs = params.toString();
  const res = await fetch(`/api/leads/upload/${jobId}/rows${qs ? "?" + qs : ""}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Rows fetch failed: ${res.status}`);
  return res.json();
}

export async function patchJobRow(
  jobId: string,
  rowId: string,
  patch: { cleaned_data?: Record<string, unknown>; status?: LeadImportRowStatus },
): Promise<LeadImportRow> {
  const res = await fetch(`/api/leads/upload/${jobId}/rows/${rowId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Patch failed: ${res.status}`);
  return res.json();
}

export async function approveJob(jobId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/leads/upload/${jobId}/approve`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Approve failed: ${res.status}`);
  return res.json();
}

export async function deleteJob(jobId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/leads/upload/${jobId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  return res.json();
}
