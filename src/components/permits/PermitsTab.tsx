import { useEffect, useState } from "react";
import { FileSearch, Sparkles } from "lucide-react";
import PoolView from "./PoolView";
import EnrichmentView from "./EnrichmentView";
import { getPermitSettings, patchPermitSettings, patchPermitMailbox, type PermitSettings, type PermitMailbox } from "../../lib/permitApi";

export default function PermitsTab({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [sub, setSub] = useState<"pool" | "enrichment">("pool");
  const [settings, setSettings] = useState<PermitSettings | null>(null);
  const [mailboxes, setMailboxes] = useState<PermitMailbox[]>([]);

  useEffect(() => {
    getPermitSettings().then((d) => { setSettings(d.settings); setMailboxes(d.mailboxes); }).catch(() => {});
  }, []);

  const toggleActive = async () => {
    if (!settings) return;
    try {
      const { settings: s } = await patchPermitSettings({ active: !settings.active });
      setSettings(s);
      pushToast?.(`Permit engine ${s.active ? "ACTIVATED" : "deactivated"}`, s.active ? "success" : "error");
    } catch { pushToast?.("Failed to update engine", "error"); }
  };

  const btn = (v: "pool" | "enrichment", label: string, icon: React.ReactNode) => (
    <button onClick={() => setSub(v)}
      className={"flex items-center gap-1 text-sm font-semibold px-3 py-1.5 rounded-lg " +
        (sub === v ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}>
      {icon}{label}
    </button>
  );
  return (
    <div className="space-y-4">
      {settings && (
        <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={settings.active} onChange={toggleActive} />
            <span className="font-medium text-sm">Permit engine {settings.active ? "ACTIVE" : "OFF"}</span>
          </label>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <span className="text-slate-600">Daily enroll cap</span>
            <input type="number" min={0} max={500} value={settings.daily_enroll_cap}
              onChange={async (e) => {
                const v = parseInt(e.target.value, 10) || 0;
                const { settings: s } = await patchPermitSettings({ daily_enroll_cap: v });
                setSettings(s);
              }} className="w-20 rounded border border-slate-300 px-1 py-0.5 text-sm" />
          </div>
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-slate-600">Mailboxes ({mailboxes.filter((m) => m.permit_enabled).length} enabled)</summary>
            {mailboxes.map((m) => (
              <label key={m.id} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input type="checkbox" checked={m.permit_enabled}
                  onChange={async () => {
                    const { mailbox } = await patchPermitMailbox(m.id, !m.permit_enabled);
                    setMailboxes((xs) => xs.map((x) => x.id === mailbox.id ? { ...x, permit_enabled: mailbox.permit_enabled } : x));
                  }} />
                <span>{m.email}</span>
              </label>
            ))}
          </details>
        </div>
      )}
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {btn("pool", "Pool", <FileSearch className="h-4 w-4" />)}
        {btn("enrichment", "Enrichment", <Sparkles className="h-4 w-4" />)}
      </div>
      {sub === "pool" ? <PoolView pushToast={pushToast} /> : <EnrichmentView pushToast={pushToast} />}
    </div>
  );
}
