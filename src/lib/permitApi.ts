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
};

export type PoolResponse = { rows: PermitFacility[]; total: number; page: number; pageSize: number };

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

export const permitApi = {
  getPool: (params: { page?: number; pageSize?: number; city?: string; search?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== "") q.set(k, String(v)); });
    return j<PoolResponse>(`/api/permits/pool?${q.toString()}`);
  },
  promote: (body: { ids?: string[]; topN?: number }) =>
    j<{ promoted: number }>(`/api/permits/promote`, { method: "POST", body: JSON.stringify(body) }),
};
