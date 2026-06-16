import { useState } from "react";
import { FileSearch, Sparkles } from "lucide-react";
import PoolView from "./PoolView";
import EnrichmentView from "./EnrichmentView";

export default function PermitsTab({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [sub, setSub] = useState<"pool" | "enrichment">("pool");
  const btn = (v: "pool" | "enrichment", label: string, icon: React.ReactNode) => (
    <button onClick={() => setSub(v)}
      className={"flex items-center gap-1 text-sm font-semibold px-3 py-1.5 rounded-lg " +
        (sub === v ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}>
      {icon}{label}
    </button>
  );
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {btn("pool", "Pool", <FileSearch className="h-4 w-4" />)}
        {btn("enrichment", "Enrichment", <Sparkles className="h-4 w-4" />)}
      </div>
      {sub === "pool" ? <PoolView pushToast={pushToast} /> : <EnrichmentView pushToast={pushToast} />}
    </div>
  );
}
