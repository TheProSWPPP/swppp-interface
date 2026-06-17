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

export interface PermitSettings { active: boolean; daily_enroll_cap: number; }
export interface PermitMailbox { id: string; email: string; display_name: string | null; permit_enabled: boolean; }

export async function getPermitSettings(): Promise<{ settings: PermitSettings; mailboxes: PermitMailbox[] }> {
  return j<{ settings: PermitSettings; mailboxes: PermitMailbox[] }>(`/api/permits/settings`);
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

export const permitApi = {
  getPool: (params: { page?: number; pageSize?: number; city?: string; search?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== "") q.set(k, String(v)); });
    return j<PoolResponse>(`/api/permits/pool?${q.toString()}`);
  },
  promote: (body: { ids?: string[]; topN?: number }) =>
    j<{ promoted: number }>(`/api/permits/promote`, { method: "POST", body: JSON.stringify(body) }),
  enrich: (cap = 50) =>
    j<{ processed: number; ok: number; fail: number }>(`/api/permits/enrich`, { method: "POST", body: JSON.stringify({ cap }) }),
  getEnriched: (params: { page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)); });
    return j<EnrichedResponse>(`/api/permits/enriched?${q.toString()}`);
  },
  directMailCsvUrl: () => `/api/permits/export/direct-mail.csv`,
};
