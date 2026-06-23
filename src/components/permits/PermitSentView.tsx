import { useEffect, useState } from "react";
import { Building2, RefreshCw } from "lucide-react";
import { getPermitSent, type PermitSentResponse } from "../../lib/permitApi";

type Toast = (m: string, k?: "success" | "error") => void;

export default function PermitSentView({ pushToast }: { pushToast?: Toast }) {
  const [data, setData] = useState<PermitSentResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try { setData(await getPermitSent()); }
    catch { pushToast?.("Couldn't load sent activity", "error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const c = data?.counts ?? { total_sent: 0, sent_today: 0, skipped: 0 };
  const sends = data?.sends ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-2 text-sm">
          <span className="rounded-lg bg-emerald-50 px-3 py-1 font-semibold text-emerald-700">{c.sent_today} sent today</span>
          <span className="rounded-lg bg-slate-100 px-3 py-1 font-semibold text-slate-600">{c.total_sent} sent total</span>
          {c.skipped > 0 && <span className="rounded-lg bg-amber-50 px-3 py-1 font-semibold text-amber-700">{c.skipped} skipped (bad match)</span>}
        </div>
        <button onClick={load} disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
      ) : sends.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500">
          Nothing sent yet. Turn on permit auto-outreach (top of this tab) to start.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="p-2 text-left">Company</th>
                <th className="p-2 text-left">Email</th>
                <th className="p-2 text-left">Status</th>
                <th className="p-2 text-right">When</th>
              </tr>
            </thead>
            <tbody>
              {sends.map((s, i) => (
                <tr key={`${s.operator_key}-${i}`} className="border-t border-slate-100">
                  <td className="p-2">
                    <span className="flex items-center gap-1.5 font-medium text-slate-800">
                      <Building2 className="h-3.5 w-3.5 text-slate-400" />{s.operator_name || s.operator_key}
                    </span>
                  </td>
                  <td className="p-2 text-slate-600">{s.email || "—"}</td>
                  <td className="p-2">
                    {s.status === "emailed" ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Sent</span>
                    ) : (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700" title={s.note || ""}>Skipped</span>
                    )}
                  </td>
                  <td className="p-2 text-right text-slate-400">{new Date(s.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
