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
  stage: "pool" | "promoted" | "enriched" | "mailed";
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
  counts: { pool: number; promoted: number; enriched: number; mailed: number };
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
  outreach: OutreachEvent[];
}

export interface PermitSettings { active: boolean; }
export interface PermitMailbox { id: string; email: string; display_name: string | null; permit_enabled: boolean; daily_send_limit?: number; }

export async function getPermitSettings(): Promise<{ settings: PermitSettings; mailboxes: PermitMailbox[] }> {
  return j<{ settings: PermitSettings; mailboxes: PermitMailbox[] }>(`/api/permits/settings`);
}
export async function patchPermitSettings(body: { active: boolean }): Promise<{ settings: PermitSettings }> {
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

// ── Operator-centric API functions ─────────────────────────────────────────

export function getOperatorsList(params: {
  stage?: string;
  compliance?: string;
  hideContacted?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<OperatorsListResponse> {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "" && v !== false) q.set(k, String(v));
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
  note?: string,
): Promise<{ outreach: OutreachEvent }> {
  return j<{ outreach: OutreachEvent }>(
    `/api/permits/operator/${encodeURIComponent(operatorKey)}/outreach`,
    { method: "POST", body: JSON.stringify({ status, ...(note ? { note } : {}) }) },
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
  getEnriched: (params: { page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)); });
    return j<EnrichedResponse>(`/api/permits/enriched?${q.toString()}`);
  },
  directMailCsvUrl: () => `/api/permits/export/direct-mail.csv`,
};
