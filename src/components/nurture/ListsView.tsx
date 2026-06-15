import { useEffect, useState } from "react";
import { ChevronRight, ExternalLink, Users } from "lucide-react";
import { brevoUrl, nurtureApi, type NurtureList } from "../../lib/nurtureApi";

export default function ListsView({ onDrill }: { onDrill: (listId: number) => void }) {
  const [lists, setLists] = useState<NurtureList[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    nurtureApi.lists().then((d) => setLists(d.lists)).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  if (!lists) return <div className="text-center text-slate-400 py-12">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Audiences</h3>
        <a
          href={brevoUrl("lists")}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700 hover:text-emerald-800"
        >
          Manage in Brevo <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {lists.map((l) => (
          <button
            key={l.id}
            onClick={() => onDrill(l.id)}
            className="group flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left hover:border-emerald-300 hover:shadow-sm"
          >
            <span className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center">
              <Users className="h-5 w-5" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-900 truncate">{l.name}</div>
              <div className="text-xs text-slate-500">{l.count != null ? `${l.count.toLocaleString()} contacts` : "count unavailable"}</div>
            </div>
            <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-emerald-500" />
          </button>
        ))}
      </div>
    </div>
  );
}
