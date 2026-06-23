import { useEffect, useState } from "react";
import { Building2, Mail, Send } from "lucide-react";
import OperatorWorkspace from "./OperatorWorkspace";
import MsgpCopyView from "./MsgpCopyView";
import PermitQueueView from "./PermitQueueView";
import PermitsGuide from "./PermitsGuide";
import { getPermitSettings, patchPermitSettings, patchPermitMailbox, type PermitSettings, type PermitMailbox } from "../../lib/permitApi";

type PermitSub = "leads" | "queue" | "email";

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
    if (!settings.active && !window.confirm("Turn ON permit email sending? Companies picked for email can then be emailed automatically.")) return;
    try {
      const { settings: s } = await patchPermitSettings({ active: !settings.active });
      setSettings(s);
      pushToast?.(`Auto-send permit emails ${s.active ? "ON" : "OFF"}`, s.active ? "success" : "error");
    } catch { pushToast?.("Failed to update setting", "error"); }
  };

  const btn = (v: PermitSub, label: string, icon: React.ReactNode) => (
    <button onClick={() => setSub(v)}
      className={"flex items-center gap-1 text-sm font-semibold px-3 py-1.5 rounded-lg " +
        (sub === v ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}>
      {icon}{label}
    </button>
  );

  const renderSub = () => {
    if (sub === "leads") return <OperatorWorkspace pushToast={pushToast} />;
    if (sub === "queue") return <PermitQueueView pushToast={pushToast} />;
    return <MsgpCopyView pushToast={pushToast} />;
  };

  return (
    <div className="space-y-4">
      <PermitsGuide />
      {settings && (
        <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={settings.active} onChange={toggleActive} />
            <span className="font-medium">Auto-send permit emails {settings.active ? "ON" : "OFF"}</span>
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Off = no emails sent. Pulling contacts (enrichment) and the direct-mail CSV work either way.
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-slate-600">
              Sending mailboxes ({mailboxes.filter((m) => m.permit_enabled).length} enabled · shares the daily limit with regular outreach)
            </summary>
            {mailboxes.map((m) => (
              <label key={m.id} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input type="checkbox" checked={m.permit_enabled}
                  onChange={async () => {
                    try {
                      const { mailbox } = await patchPermitMailbox(m.id, !m.permit_enabled);
                      setMailboxes((xs) => xs.map((x) => x.id === mailbox.id ? { ...x, permit_enabled: mailbox.permit_enabled } : x));
                    } catch {
                      pushToast?.("Failed to update mailbox", "error");
                    }
                  }} />
                <span>{m.email}</span>
                <span className="text-xs text-slate-400">{m.daily_send_limit ?? "—"}/day shared</span>
              </label>
            ))}
            <p className="mt-1 text-xs text-slate-400">
              Permit emails draw from each mailbox's daily cap (set in SDR → Mailboxes) — not a separate quota.
            </p>
          </details>
        </div>
      )}
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {btn("leads", "Leads", <Building2 className="h-4 w-4" />)}
        {btn("queue", "Email Queue", <Send className="h-4 w-4" />)}
        {btn("email", "Email Copy", <Mail className="h-4 w-4" />)}
      </div>
      {renderSub()}
    </div>
  );
}
