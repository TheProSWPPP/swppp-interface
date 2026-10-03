import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, ExternalLink, Plus, Trash2, Users } from "lucide-react";
import { brevoUrl, isAdmin, nurtureApi, type NurtureList } from "../../lib/nurtureApi";

type Toast = (kind: "success" | "error", text: string) => void;

export default function ListsView({ onDrill, pushToast }: { onDrill: (listId: number) => void; pushToast?: Toast }) {
  const [lists, setLists] = useState<NurtureList[] | null>(null);
  const request = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const admin = isAdmin();
  const toast: Toast = (k, t) => pushToast?.(k, t);

  const invalidate = useCallback(() => { request.current++; }, []);
  const load = useCallback(() => {
    const current = ++request.current;
    setError(null);
    nurtureApi.lists().then((d) => { if (current === request.current) setLists(d.lists); }).catch((e) => { if (current === request.current) setError(e.message); });
  }, []);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; invalidate(); };
  }, [load, invalidate]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast("success", ok); load(); } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };

  if (error) return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">Audiences could not be loaded. {error}<button onClick={load} className="ml-3 min-h-11 font-semibold underline">Try again</button></div>;
  if (!lists) return <div className="text-center text-slate-400 py-12">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Audiences</h3>
        <a href={brevoUrl("lists")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700 hover:text-emerald-800">Manage in Brevo <ExternalLink className="h-3.5 w-3.5" /></a>
      </div>
      <div className="flex items-center gap-2">
        <input aria-label="New audience name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New list name…" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 min-h-11 text-sm focus:border-emerald-400 focus:outline-none" />
        <button disabled={busy || !newName.trim()} onClick={() => run(async () => { await nurtureApi.listCreate(newName.trim()); setNewName(""); }, "List created.")}
          className="rounded-xl bg-emerald-600 px-3 py-2 min-h-11 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 inline-flex items-center gap-1.5"><Plus className="h-4 w-4" /> Create</button>
      </div>
      {lists.length === 0 && <p className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">No audiences found in Brevo.</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {lists.map((l) => (
          <div key={l.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center"><Users className="h-5 w-5" /></span>
              <div className="flex-1 min-w-[160px]">
                {renaming === l.id ? (
                  <input aria-label="Audience name" autoFocus value={renameVal} onClick={(e) => e.stopPropagation()} onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") run(async () => { await nurtureApi.listRename(l.id, renameVal.trim()); setRenaming(null); }, "Renamed."); }}
                    className="w-full rounded border border-slate-200 px-2 py-1 text-sm" />
                ) : (
                  <button onClick={() => onDrill(l.id)} className="w-full min-h-11 text-left text-sm font-semibold text-slate-900 break-words hover:text-emerald-700">{l.name}</button>
                )}
                <div className="text-xs text-slate-500">{l.count != null ? `${l.count.toLocaleString()} contacts` : "count unavailable"}</div>
              </div>
              <button onClick={() => { setRenaming(l.id); setRenameVal(l.name); }} className="min-h-11 text-xs text-slate-400 hover:text-slate-700">rename</button>
              {admin && <button aria-label={`Delete audience ${l.name}`} disabled={busy} onClick={() => { if (confirm(`Delete list "${l.name}"? This removes the list (contacts are not deleted).`)) run(() => nurtureApi.listDelete(l.id), "List deleted."); }} className="min-h-11 min-w-11 inline-flex items-center justify-center text-rose-400 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>}
              <button aria-label={`View contacts in ${l.name}`} onClick={() => onDrill(l.id)} className="min-h-11 min-w-8 text-slate-300 hover:text-emerald-500"><ChevronRight className="h-4 w-4" /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
