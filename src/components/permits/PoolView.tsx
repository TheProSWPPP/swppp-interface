import { useEffect, useState, useCallback } from "react";
import { Flame, Search, CheckSquare, Square, ArrowUpRight } from "lucide-react";
import { permitApi, type PermitFacility } from "../../lib/permitApi";

export default function PoolView({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [rows, setRows] = useState<PermitFacility[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [city, setCity] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const pageSize = 50;

  const load = useCallback(() => {
    setLoading(true);
    permitApi
      .getPool({ page, pageSize, search, city, status: "pool" })
      .then((r) => { setRows(r.rows); setTotal(r.total); })
      .catch((e) => pushToast?.(`Load failed: ${e.message}`, "error"))
      .finally(() => setLoading(false));
  }, [page, search, city, pushToast]);

  useEffect(() => { load(); }, [load]);

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function promoteSelected() {
    if (!selected.size) return;
    try {
      const { promoted } = await permitApi.promote({ ids: [...selected] });
      pushToast?.(`Promoted ${promoted} to enrichment`, "success");
      setSelected(new Set()); load();
    } catch (e) { pushToast?.(`Promote failed: ${(e as Error).message}`, "error"); }
  }

  async function promoteTopN(n: number) {
    try {
      const { promoted } = await permitApi.promote({ topN: n });
      pushToast?.(`Promoted top ${promoted}`, "success"); load();
    } catch (e) { pushToast?.(`Promote failed: ${(e as Error).message}`, "error"); }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
          <input className="pl-8 pr-3 py-2 rounded-xl border border-slate-200 text-sm"
            placeholder="Search operator" value={search}
            onChange={(e) => { setPage(1); setSearch(e.target.value); }} />
        </div>
        <input className="px-3 py-2 rounded-xl border border-slate-200 text-sm" placeholder="City"
          value={city} onChange={(e) => { setPage(1); setCity(e.target.value); }} />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-slate-500">{total.toLocaleString()} in pool</span>
          <button onClick={() => promoteTopN(100)}
            className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">
            <Flame className="h-4 w-4" /> Promote top 100
          </button>
          <button onClick={promoteSelected} disabled={!selected.size}
            className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl border border-slate-200 disabled:opacity-40">
            <ArrowUpRight className="h-4 w-4" /> Promote selected ({selected.size})
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="w-10 p-2"></th>
              <th className="text-left p-2">Operator</th>
              <th className="text-left p-2">Permit #</th>
              <th className="text-left p-2">City</th>
              <th className="text-right p-2">Expires</th>
              <th className="text-right p-2">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.external_permit_nmbr} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="p-2 text-center cursor-pointer" onClick={() => toggle(r.external_permit_nmbr)}>
                  {selected.has(r.external_permit_nmbr)
                    ? <CheckSquare className="h-4 w-4 text-indigo-600" />
                    : <Square className="h-4 w-4 text-slate-300" />}
                </td>
                <td className="p-2 font-medium text-slate-800">{r.operator_name || "—"}</td>
                <td className="p-2 text-slate-500">{r.external_permit_nmbr}</td>
                <td className="p-2 text-slate-500">{r.city || "—"}</td>
                <td className="p-2 text-right text-slate-500">{r.expiration_date || "—"}</td>
                <td className="p-2 text-right font-semibold text-slate-700">
                  {r.score}
                  {(r.compliance_flags?.pain ?? 0) >= 12 && (
                    <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">⚠ in violation</span>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-400">No facilities in pool. Run the ingest script.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>Page {page} / {pages}</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40">Prev</button>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  );
}
