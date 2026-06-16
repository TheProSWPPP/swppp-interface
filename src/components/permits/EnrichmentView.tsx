import { useEffect, useState, useCallback } from "react";
import { Sparkles, Download, RefreshCw } from "lucide-react";
import { permitApi, type PermitEnrichment } from "../../lib/permitApi";

export default function EnrichmentView({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [rows, setRows] = useState<PermitEnrichment[]>([]);
  const [total, setTotal] = useState(0);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    permitApi.getEnriched({ pageSize: 100 })
      .then((r) => { setRows(r.rows); setTotal(r.total); })
      .catch((e) => pushToast?.(`Load failed: ${e.message}`, "error"))
      .finally(() => setLoading(false));
  }, [pushToast]);

  useEffect(() => { load(); }, [load]);

  async function runEnrich() {
    setRunning(true);
    try {
      const r = await permitApi.enrich(50);
      pushToast?.(`Enriched ${r.ok}/${r.processed} (${r.fail} failed)`, "success");
      load();
    } catch (e) { pushToast?.(`Enrich failed: ${(e as Error).message}`, "error"); }
    finally { setRunning(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-500">{total.toLocaleString()} enriched</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={runEnrich} disabled={running}
            className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
            <Sparkles className="h-4 w-4" /> {running ? "Enriching…" : "Run enrichment (50)"}
          </button>
          <a href={permitApi.directMailCsvUrl()}
            className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50">
            <Download className="h-4 w-4" /> Download direct-mail CSV
          </a>
          <button onClick={load} className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50" aria-label="Refresh">
            <RefreshCw className="h-4 w-4 text-slate-500" />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left p-2">Contact</th>
              <th className="text-left p-2">Operator</th>
              <th className="text-left p-2">Mailing address</th>
              <th className="text-left p-2">City</th>
              <th className="text-left p-2">Channel</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.external_permit_nmbr} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="p-2 font-medium text-slate-800">{r.contact_name || "—"}</td>
                <td className="p-2 text-slate-600">{r.operator_name || "—"}</td>
                <td className="p-2 text-slate-500">{r.mailing_address || "—"}</td>
                <td className="p-2 text-slate-500">{r.city || "—"}</td>
                <td className="p-2"><span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-semibold">{r.channel}</span></td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td colSpan={5} className="p-6 text-center text-slate-400">Nothing enriched yet. Promote a batch in the Pool tab, then Run enrichment.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
