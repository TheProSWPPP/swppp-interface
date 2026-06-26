export type PermitFacility = {
  id: string;
  external_permit_nmbr: string;
  operator_name: string | null;
  operator_key: string;
  city: string | null;
  sector_code: string | null;
  expiration_date: string | null;
  original_issue_date: string | null;
  score: number;
  status: string;
  compliance_flags?: { pain?: number; vioLast4Q?: number; cv?: number; sv?: number } | null;
};

export type PoolResponse = { rows: PermitFacility[]; total: number; page: number; pageSize: number };

export type PermitEnrichment = {
  external_permit_nmbr: string;
  operator_name: string | null;
  city: string | null;
  expiration_date: string | null;
  score: number;
  contact_name: string | null;
  mailing_address: string | null;
  sic_code: string | null;
  channel: string;
};

export type EnrichedResponse = { rows: PermitEnrichment[]; total: number; page: number; pageSize: number };

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

/** Like j<T> but on non-OK responses, tries to parse JSON and throws Error with the `error` field if present. */
async function jMsg<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const body = await r.json(); if (body?.error) msg = body.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

// ── Operator-centric types ──────────────────────────────────────────────────

export interface OperatorRow {
  operator_key: string;
  operator_name: string;
  permit_count: number;
  max_pain: number;
  best_score: number;
  earliest_expiry: string | null;
  stage: "todo" | "contacted";
  phone: string | null;
  has_phone: boolean;
  has_email: boolean;
  has_address: boolean;
  has_ehs: boolean;
  compliance_tier: "snc" | "violation" | "inspected" | "clean";
  possible_customer: boolean;
  possible_crm: boolean;
  contacted: boolean;
  last_outreach_at: string | null;
}

export interface OperatorsListResponse {
  operators: OperatorRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: { all: number; todo: number; contacted: number; with_phone: number; with_email: number; with_address: number; with_ehs: number };
  compliance_last_refreshed?: string | null;
}

export interface OperatorPermit {
  external_permit_nmbr: string;
  status: string;
  score: number;
  expiration_date: string | null;
  compliance_flags: { pain?: number; vioLast4Q?: number; sv?: number; insp?: number } | null;
}

export interface OperatorEnrichment {
  contact_name: string | null;
  mailing_address: string | null;
  site_address: string | null;
  sic_code: string | null;
  sector: string | null;
  channel: string;
}

export interface OutreachEvent {
  status: string;
  channel: string | null;
  note: string | null;
  created_at: string;
}

export interface OperatorDetail {
  operator: {
    operator_key: string;
    operator_name: string;
    permit_count: number;
    max_pain: number;
    best_score: number;
    possible_customer: boolean;
    possible_crm: boolean;
  };
  permits: OperatorPermit[];
  enrichment: OperatorEnrichment | null;
  mailable: boolean;
  email: { email: string; contact_name: string | null; title: string | null } | null;
  emailable: boolean;
  phone: { phone: string; source: string | null } | null;
  outreach: OutreachEvent[];
}

export interface PermitSettings {
  active: boolean;
  auto_find_enabled?: boolean;
  auto_find_daily_cap?: number;
  auto_find_backlog_max?: number;
  auto_send_enabled?: boolean;
}
export interface PermitMailbox { id: string; email: string; display_name: string | null; permit_enabled: boolean; daily_send_limit?: number; }

export async function getPermitSettings(): Promise<{ settings: PermitSettings; mailboxes: PermitMailbox[] }> {
  return j<{ settings: PermitSettings; mailboxes: PermitMailbox[] }>(`/api/permits/settings`);
}

export interface PermitSend {
  operator_key: string;
  operator_name: string | null;
  email: string | null;
  status: "emailed" | "skipped";
  note: string | null;
  created_at: string;
}
export interface PermitSentResponse {
  sends: PermitSend[];
  counts: { total_sent: number; sent_today: number; skipped: number };
}
export function getPermitSent(): Promise<PermitSentResponse> {
  return j<PermitSentResponse>(`/api/permits/sent`);
}
export async function patchPermitSettings(body: Partial<PermitSettings>): Promise<{ settings: PermitSettings }> {
  return j<{ settings: PermitSettings }>(`/api/permits/settings`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}
export async function patchPermitMailbox(id: string, permit_enabled: boolean): Promise<{ mailbox: PermitMailbox }> {
  return j<{ mailbox: PermitMailbox }>(`/api/permits/mailboxes/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ permit_enabled }),
  });
}

export interface MsgpTemplate { subject: string; body_html: string; apollo_sequence_id: string | null; updated_at?: string; }

export async function getMsgpTemplate(): Promise<{ template: MsgpTemplate }> {
  return j<{ template: MsgpTemplate }>(`/api/permits/msgp-template`);
}
export async function putMsgpTemplate(subject: string, body_html: string): Promise<{ template: MsgpTemplate }> {
  return j<{ template: MsgpTemplate }>(`/api/permits/msgp-template`, { method: "PUT", body: JSON.stringify({ subject, body_html }) });
}
export async function createMsgpSequence(): Promise<{ apollo_sequence_id: string }> {
  return j<{ apollo_sequence_id: string }>(`/api/permits/msgp-sequence/create`, { method: "POST", body: "{}" });
}

// ── Permit email draft queue ────────────────────────────────────────────────

export interface PermitDraft {
  id: string;
  operator_key: string;
  operator_name: string | null;
  contact_name: string | null;
  email: string;
  subject: string;
  body: string;
  apollo_sequence_id: string | null;
  assigned_mailbox_id: string | null;
  assigned_email: string | null;
  status: "pending" | "approved" | "sent" | "rejected";
  reject_reason: string | null;
  error_message: string | null;
  approved_at: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface PermitDraftsResponse {
  drafts: PermitDraft[];
  counts: { pending: number; approved: number; sent: number; rejected: number };
}

export interface GenerateDraftsResult {
  created: number;
  eligible: number;
  mailboxesEnabled: number;
  sequenceLinked: boolean;
}

export function generatePermitDrafts(
  opts: { cap?: number; operatorKeys?: string[] } = {},
): Promise<GenerateDraftsResult> {
  const body: Record<string, unknown> = {};
  if (opts.cap) body.cap = opts.cap;
  if (opts.operatorKeys?.length) body.operator_keys = opts.operatorKeys;
  return jMsg<GenerateDraftsResult>(`/api/permits/drafts/generate`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Bulk discard selected companies (multi-select).
export function discardOperators(operatorKeys: string[]): Promise<{ discarded: number }> {
  return jMsg<{ discarded: number }>(`/api/permits/operators/discard`, {
    method: "POST",
    body: JSON.stringify({ operator_keys: operatorKeys }),
  });
}

export function getPermitDrafts(status = "pending"): Promise<PermitDraftsResponse> {
  return j<PermitDraftsResponse>(`/api/permits/drafts?status=${encodeURIComponent(status)}`);
}

export function editPermitDraft(
  id: string,
  body: { subject?: string; body?: string },
): Promise<{ draft: PermitDraft }> {
  return jMsg<{ draft: PermitDraft }>(`/api/permits/drafts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function rejectPermitDraft(id: string, reason?: string): Promise<{ draft: PermitDraft }> {
  return jMsg<{ draft: PermitDraft }>(`/api/permits/drafts/${id}/reject`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

// Approve = queue for the auto-sender (status 'approved').
export function approvePermitDraft(id: string): Promise<{ draft: PermitDraft }> {
  return jMsg<{ draft: PermitDraft }>(`/api/permits/drafts/${id}/approve`, { method: "POST", body: "{}" });
}

// Bulk-approve: all pending, or a specific set of ids.
export function approveAllPermitDrafts(ids?: string[]): Promise<{ approved: number }> {
  return jMsg<{ approved: number }>(`/api/permits/drafts/approve`, {
    method: "POST",
    body: JSON.stringify(ids && ids.length ? { ids } : {}),
  });
}

// Send now = immediate enroll (bypasses the auto-send queue).
export function sendPermitDraftNow(
  id: string,
): Promise<{ id: string; status: string; apollo_contact_id: string; enrolled: number }> {
  return jMsg(`/api/permits/drafts/${id}/approve-and-send`, { method: "POST", body: "{}" });
}

// ── Operator-centric API functions ─────────────────────────────────────────

export function getOperatorsList(params: {
  stage?: string;
  channel?: string;
  ehs?: string;
  compliance?: string;
  search?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<OperatorsListResponse> {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "") q.set(k, String(v));
  });
  return j<OperatorsListResponse>(`/api/permits/operators-list?${q.toString()}`);
}

export function getOperatorDetail(operatorKey: string): Promise<OperatorDetail> {
  return j<OperatorDetail>(`/api/permits/operator/${encodeURIComponent(operatorKey)}`);
}

export function promoteOperator(operatorKey: string): Promise<{ promoted: number }> {
  return j<{ promoted: number }>(
    `/api/permits/operator/${encodeURIComponent(operatorKey)}/promote`,
    { method: "POST", body: "{}" },
  );
}

export function logOutreach(
  operatorKey: string,
  status: string,
  channel?: string,
  note?: string,
): Promise<{ outreach: OutreachEvent }> {
  return j<{ outreach: OutreachEvent }>(
    `/api/permits/operator/${encodeURIComponent(operatorKey)}/outreach`,
    { method: "POST", body: JSON.stringify({ status, ...(channel ? { channel } : {}), ...(note ? { note } : {}) }) },
  );
}

export const permitApi = {
  getPool: (params: { page?: number; pageSize?: number; city?: string; search?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== "") q.set(k, String(v)); });
    return j<PoolResponse>(`/api/permits/pool?${q.toString()}`);
  },
  promote: (body: { ids?: string[]; topN?: number }) =>
    j<{ promoted: number }>(`/api/permits/promote`, { method: "POST", body: JSON.stringify(body) }),
  enrich: (cap = 50) =>
    jMsg<{ processed: number; ok: number; fail: number }>(`/api/permits/enrich`, { method: "POST", body: JSON.stringify({ cap }) }),
  findEmails: (opts: { cap?: number; operatorKeys?: string[] } = {}) => {
    const body: Record<string, unknown> = {};
    if (opts.cap) body.cap = opts.cap;
    if (opts.operatorKeys?.length) body.operator_keys = opts.operatorKeys;
    return jMsg<{ probed: number; found: number; discarded: number; hadDomain: number }>(
      `/api/permits/find-emails`, { method: "POST", body: JSON.stringify(body) });
  },
  getEnriched: (params: { page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)); });
    return j<EnrichedResponse>(`/api/permits/enriched?${q.toString()}`);
  },
};
