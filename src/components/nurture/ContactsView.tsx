import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Trash2, UserX } from "lucide-react";
import { isAdmin, nurtureApi, type NurtureContact } from "../../lib/nurtureApi";

type Toast = (kind: "success" | "error", text: string) => void;
const PAGE = 50;

export default function ContactsView({ listId, pushToast }: { listId: number | null; pushToast?: Toast }) {
  const [contacts, setContacts] = useState<NurtureContact[] | null>(null);
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const admin = isAdmin();
  const toast: Toast = (k, t) => pushToast?.(k, t);

  const load = useCallback((id: number, off: number) => {
    setContacts(null);
    nurtureApi.listContacts(id, off).then((d) => { setContacts(d.contacts); setCount(d.count); }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { if (listId == null) return; setOffset(0); load(listId, 0); }, [listId, load]);

  // If a page goes empty after a removal/delete but more contacts exist on earlier pages, step back.
  useEffect(() => {
    if (listId != null && contacts && contacts.length === 0 && count > 0 && offset > 0) {
      const o = Math.max(0, offset - PAGE);
      setOffset(o);
      load(listId, o);
    }
  }, [contacts, count, offset, listId, load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast("success", ok); if (listId != null) load(listId, offset); } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };

  if (listId == null) return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center">
      <div className="text-sm font-semibold text-slate-700">Pick a list first</div>
      <p className="text-xs text-slate-500 mt-1">Open the Lists tab and click an audience to see its contacts here.</p>
    </div>
  );
  if (error) return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  if (!contacts) return <div className="text-center text-slate-400 py-12">Loading…</div>;

  const attrName = (c: NurtureContact, key: string) => (c.attributes?.[key] as string) || "";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Add contact email to this list…" className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none" />
        <button disabled={busy || !newEmail.trim()} onClick={() => run(async () => { await nurtureApi.listAddContacts(listId, [newEmail.trim()]); setNewEmail(""); }, "Contact added to list.")}
          className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 inline-flex items-center gap-1.5"><Plus className="h-4 w-4" /> Add</button>
      </div>
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600">{count.toLocaleString()} contacts</div>
        <div className="flex items-center gap-2">
          <button disabled={offset === 0} onClick={() => { const o = Math.max(0, offset - PAGE); setOffset(o); load(listId, o); }} className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 disabled:opacity-40 hover:bg-slate-50"><ChevronLeft className="h-4 w-4" /></button>
          <span className="text-xs text-slate-500">{count ? offset + 1 : 0}–{Math.min(offset + PAGE, count)}</span>
          <button disabled={offset + PAGE >= count} onClick={() => { const o = offset + PAGE; setOffset(o); load(listId, o); }} className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 disabled:opacity-40 hover:bg-slate-50"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100">
            <th className="text-left font-semibold px-4 py-2">Email</th><th className="text-left font-semibold px-4 py-2">Name</th>
            <th className="text-left font-semibold px-4 py-2">Company</th><th className="text-right font-semibold px-4 py-2">Status</th>
            <th className="text-right font-semibold px-4 py-2">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {contacts.map((c) => (
              <tr key={c.email}>
                <td className="px-4 py-2 text-slate-900">{c.email}</td>
                <td className="px-4 py-2 text-slate-600">{`${attrName(c, "FIRSTNAME")} ${attrName(c, "LASTNAME")}`.trim() || "—"}</td>
                <td className="px-4 py-2 text-slate-600">{attrName(c, "COMPANY") || "—"}</td>
                <td className="px-4 py-2 text-right">{c.emailBlacklisted ? <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">unsubscribed</span> : <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">subscribed</span>}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  <button disabled={busy} onClick={() => run(() => nurtureApi.listRemoveContacts(listId, [c.email]), "Removed from list.")} className="text-xs text-slate-400 hover:text-slate-700 mr-3">remove</button>
                  {admin && !c.emailBlacklisted && <button disabled={busy} title="Unsubscribe" onClick={() => { if (confirm(`Unsubscribe ${c.email}? They won't receive future emails.`)) run(() => nurtureApi.contactBlocklist(c.email, true), "Unsubscribed."); }} className="text-amber-400 hover:text-amber-600 mr-3"><UserX className="h-4 w-4 inline" /></button>}
                  {admin && <button disabled={busy} title="Delete contact" onClick={() => { if (confirm(`Delete ${c.email} from Brevo entirely? This can't be undone.`)) run(() => nurtureApi.contactDelete(c.email), "Contact deleted."); }} className="text-rose-400 hover:text-rose-600"><Trash2 className="h-4 w-4 inline" /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
