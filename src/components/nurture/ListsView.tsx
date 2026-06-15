import { useEffect, useState } from "react";
import { ChevronRight, ExternalLink, Plus, Trash2, Users } from "lucide-react";
import { brevoUrl, isAdmin, nurtureApi, type NurtureList } from "../../lib/nurtureApi";

type Toast = (kind: "success" | "error", text: string) => void;

export default function ListsView({ onDrill, pushToast }: { onDrill: (listId: number) => void; pushToast?: Toast }) {
  const [lists, setLists] = useState<NurtureList[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const admin = isAdmin();
  const toast: Toast = (k, t) => pushToast?.(k, t);

  const load = () => { nurtureApi.lists().then((d) => setLists(d.lists)).catch((e) => setError(e.message)); };
  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast("success", ok); load(); } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };

  if (error) return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  if (!lists) return <div className="text-center text-slate-400 py-12">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Audiences</h3>
        <a href={brevoUrl("lists")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700 hover:text-emerald-800">Manage in Brevo <ExternalLink className="h-3.5 w-3.5" /></a>
      </div>
      <div className="flex items-center gap-2">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New list name…" className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none" />
        <button disabled={busy || !newName.trim()} onClick={() => run(async () => { await nurtureApi.listCreate(newName.trim()); setNewName(""); }, "List created.")}
          className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 inline-flex items-center gap-1.5"><Plus className="h-4 w-4" /> Create</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {lists.map((l) => (
          <div key={l.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center"><Users className="h-5 w-5" /></span>
              <button onClick={() => onDrill(l.id)} className="flex-1 min-w-0 text-left group">
                {renaming === l.id ? (
                  <input autoFocus value={renameVal} onClick={(e) => e.stopPropagation()} onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") run(async () => { await nurtureApi.listRename(l.id, renameVal.trim()); setRenaming(null); }, "Renamed."); }}
                    className="w-full rounded border border-slate-200 px-2 py-1 text-sm" />
                ) : (
                  <div className="text-sm font-semibold text-slate-900 truncate group-hover:text-emerald-700">{l.name}</div>
                )}
                <div className="text-xs text-slate-500">{l.count != null ? `${l.count.toLocaleString()} contacts` : "count unavailable"}</div>
              </button>
              <button onClick={() => { setRenaming(l.id); setRenameVal(l.name); }} className="text-xs text-slate-400 hover:text-slate-700">rename</button>
              {admin && <button disabled={busy} onClick={() => { if (confirm(`Delete list "${l.name}"? This removes the list (contacts are not deleted).`)) run(() => nurtureApi.listDelete(l.id), "List deleted."); }} className="text-rose-400 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>}
              <button onClick={() => onDrill(l.id)} className="text-slate-300 hover:text-emerald-500"><ChevronRight className="h-4 w-4" /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
