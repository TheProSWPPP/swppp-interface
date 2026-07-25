import { useEffect, useState } from "react";
import { Building2, Mail } from "lucide-react";
import OperatorWorkspace from "./OperatorWorkspace";
import MsgpCopyView from "./MsgpCopyView";
import {
  getPermitSettings, patchPermitSettings, patchPermitMailbox,
  type PermitSettings, type PermitMailbox,
} from "../../lib/permitApi";

type PermitSub = "leads" | "email";

export default function PermitsTab({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [sub, setSub] = useState<PermitSub>("leads");
  const [settings, setSettings] = useState<PermitSettings | null>(null);
  const [mailboxes, setMailboxes] = useState<PermitMailbox[]>([]);

  useEffect(() => {
    getPermitSettings()
      .then((d) => { setSettings(d.settings); setMailboxes(d.mailboxes); })
      .catch(() => pushToast?.("Couldn't load permit settings", "error"));
  }, []);

  const toggleActive = async () => {
    if (!settings) return;
    if (!settings.active && !window.confirm(
      "Turn ON auto email outreach? It will send the renewal email to companies that have an email, using up to 20% of each inbox's daily limit (your Pipedrive sends keep the rest). Off = nothing sends.",
    )) return;
    try {
      const { settings: s } = await patchPermitSettings({ active: !settings.active });
      setSettings(s);
      pushToast?.(`Auto email outreach ${s.active ? "ON" : "OFF"}`, "success");
    } catch { pushToast?.("Failed to update setting", "error"); }
  };

  const enabledCount = mailboxes.filter((m) => m.permit_enabled).length;

  const btn = (v: PermitSub, label: string, icon: React.ReactNode) => (
    <button onClick={() => setSub(v)}
      className={"flex items-center gap-1 text-sm font-semibold px-3 py-1.5 rounded-lg " +
        (sub === v ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}>
      {icon}{label}
    </button>
  );

  return (
    <div className="space-y-4">
      {settings && (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={settings.active} onChange={toggleActive} />
              <span className="font-medium">Auto email outreach {settings.active ? "ON" : "OFF"}</span>
            </label>
            <p className="mt-1 text-xs text-slate-500">
              On = automatically emails the renewal to companies that have an email, daily.
              Each inbox sends up to its <b>permit cap</b> per day; if no cap is set it falls back to
              20% of the inbox's daily limit. Permits and Pipedrive / SDR share the same inbox budget.
              Obviously-wrong matches are skipped, not sent.
            </p>
          </div>
          <details className="border-t border-slate-200 pt-2">
            <summary className="cursor-pointer text-slate-600">Sending inboxes ({enabledCount} on)</summary>
            {mailboxes.map((m) => {
              // Mirror lib/permitAuto.js: an explicit permit_daily_cap wins, else the legacy 20% share.
              const share = (m.permit_daily_cap ?? 0) > 0
                ? (m.permit_daily_cap as number)
                : Math.max(1, Math.ceil((m.daily_send_limit ?? 25) * 0.2));
              return (
                <label key={m.id} className="flex items-center gap-2 py-0.5 cursor-pointer">
                  <input type="checkbox" checked={m.permit_enabled}
                    onChange={async () => {
                      try {
                        const { mailbox } = await patchPermitMailbox(m.id, !m.permit_enabled);
                        setMailboxes((xs) => xs.map((x) => x.id === mailbox.id ? { ...x, permit_enabled: mailbox.permit_enabled } : x));
                      } catch { pushToast?.("Failed to update mailbox", "error"); }
                    }} />
                  <span>{m.email}</span>
                  <span className="text-xs text-slate-400">up to {share}/day for permits ({m.daily_send_limit ?? "—"} total)</span>
                </label>
              );
            })}
            <p className="mt-1 text-xs text-slate-400">Inbox daily limits are set in SDR → Mailboxes.</p>
          </details>
        </div>
      )}

      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {btn("leads", "Leads", <Building2 className="h-4 w-4" />)}
        {btn("email", "Email Copy", <Mail className="h-4 w-4" />)}
      </div>
      {sub === "leads" ? <OperatorWorkspace pushToast={pushToast} /> : <MsgpCopyView pushToast={pushToast} />}
    </div>
  );
}
