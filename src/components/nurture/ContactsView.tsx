import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { nurtureApi, type NurtureContact } from "../../lib/nurtureApi";

const PAGE = 50;

export default function ContactsView({ listId }: { listId: number | null }) {
  const [contacts, setContacts] = useState<NurtureContact[] | null>(null);
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (id: number, off: number) => {
      setContacts(null);
      nurtureApi
        .listContacts(id, off)
        .then((d) => { setContacts(d.contacts); setCount(d.count); })
        .catch((e) => setError(e.message));
    },
    [],
  );

  useEffect(() => {
    if (listId == null) return;
    setOffset(0);
    load(listId, 0);
  }, [listId, load]);

  if (listId == null) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center">
        <div className="text-sm font-semibold text-slate-700">Pick a list first</div>
        <p className="text-xs text-slate-500 mt-1">Open the Lists tab and click an audience to see its contacts here.</p>
      </div>
    );
  }
  if (error) return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  if (!contacts) return <div className="text-center text-slate-400 py-12">Loading…</div>;

  const attrName = (c: NurtureContact, key: string) => (c.attributes?.[key] as string) || "";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600">{count.toLocaleString()} contacts</div>
        <div className="flex items-center gap-2">
          <button
            disabled={offset === 0}
            onClick={() => { const o = Math.max(0, offset - PAGE); setOffset(o); load(listId, o); }}
            className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 disabled:opacity-40 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-slate-500">{offset + 1}–{Math.min(offset + PAGE, count)}</span>
          <button
            disabled={offset + PAGE >= count}
            onClick={() => { const o = offset + PAGE; setOffset(o); load(listId, o); }}
            className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 disabled:opacity-40 hover:bg-slate-50"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100">
              <th className="text-left font-semibold px-4 py-2">Email</th>
              <th className="text-left font-semibold px-4 py-2">Name</th>
              <th className="text-left font-semibold px-4 py-2">Company</th>
              <th className="text-right font-semibold px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {contacts.map((c) => (
              <tr key={c.email}>
                <td className="px-4 py-2 text-slate-900">{c.email}</td>
                <td className="px-4 py-2 text-slate-600">{`${attrName(c, "FIRSTNAME")} ${attrName(c, "LASTNAME")}`.trim() || "—"}</td>
                <td className="px-4 py-2 text-slate-600">{attrName(c, "COMPANY") || "—"}</td>
                <td className="px-4 py-2 text-right">
                  {c.emailBlacklisted ? (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">unsubscribed</span>
                  ) : (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">subscribed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
