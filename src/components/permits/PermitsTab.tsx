import { useEffect, useState } from "react";
import { Building2, Mail, Send } from "lucide-react";
import OperatorWorkspace from "./OperatorWorkspace";
import MsgpCopyView from "./MsgpCopyView";
import PermitSentView from "./PermitSentView";
import PermitsGuide from "./PermitsGuide";
import { getPermitSettings, patchPermitSettings, patchPermitMailbox, type PermitSettings, type PermitMailbox } from "../../lib/permitApi";

type PermitSub = "leads" | "sent" | "email";

export default function PermitsTab({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [sub, setSub] = useState<PermitSub>("leads");
  const [settings, setSettings] = useState<PermitSettings | null>(null);
  const [mailboxes, setMailboxes] = useState<PermitMailbox[]>([]);

  useEffect(() => {
    getPermitSettings()
      .then((d) => { setSettings(d.settings); setMailboxes(d.mailboxes); })
      .catch(() => pushToast?.("Couldn't load permit settings", "error"));
  }, []);

  const patch = async (body: Partial<PermitSettings>, okMsg?: string) => {
    try {
      const { settings: s } = await patchPermitSettings(body);
      setSettings(s);
      if (okMsg) pushToast?.(okMsg, "success");
    } catch { pushToast?.("Failed to update setting", "error"); }
  };

  const toggleActive = async () => {
    if (!settings) return;
    if (!settings.active && !window.confirm(
      "Turn ON permit auto-outreach? It will find emails and send the renewal email automatically, within your daily cap and each inbox's limit.",
    )) return;
    await patch({ active: !settings.active }, `Permit auto-outreach ${!settings.active ? "ON" : "OFF"}`);
  };

  const enabledCount = mailboxes.filter((m) => m.permit_enabled).length;

  const btn = (v: PermitSub, label: string, icon: React.ReactNode) => (
    <button onClick={() => setSub(v)}
      className={"flex items-center gap-1 text-sm font-semibold px-3 py-1.5 rounded-lg " +
        (sub === v ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}>
      {icon}{label}
    </button>
  );

  const renderSub = () => {
    if (sub === "leads") return <OperatorWorkspace pushToast={pushToast} />;
    if (sub === "sent") return <PermitSentView pushToast={pushToast} />;
    return <MsgpCopyView pushToast={pushToast} />;
  };

  return (
    <div className="space-y-4">
      <PermitsGuide />
      {settings && (
        <div className="mb-3 space-y-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          {/* One master switch: find + send, fully automatic */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={settings.active} onChange={toggleActive} />
              <span className="font-medium">Permit auto-outreach {settings.active ? "ON" : "OFF"}</span>
            </label>
            <p className="mt-1 text-xs text-slate-500">
              On = finds emails and sends the renewal email automatically. Off = nothing runs.
              Obviously-wrong matches are skipped, not sent.
            </p>
            <label className="mt-2 flex items-center gap-1.5 text-xs text-slate-600">
              Max emails per day
              <input type="number" min={1} max={500} defaultValue={settings.auto_find_daily_cap ?? 50}
                onBlur={(e) => patch({ auto_find_daily_cap: Number(e.target.value) })}
                className="w-16 rounded border border-slate-300 px-1.5 py-0.5" />
              <span className="text-slate-400">(stays under each inbox's own limit)</span>
            </label>
          </div>

          <details className="border-t border-slate-200 pt-2">
            <summary className="cursor-pointer text-slate-600">Sending inboxes ({enabledCount} on)</summary>
            {mailboxes.map((m) => (
              <label key={m.id} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input type="checkbox" checked={m.permit_enabled}
                  onChange={async () => {
                    try {
                      const { mailbox } = await patchPermitMailbox(m.id, !m.permit_enabled);
                      setMailboxes((xs) => xs.map((x) => x.id === mailbox.id ? { ...x, permit_enabled: mailbox.permit_enabled } : x));
                    } catch { pushToast?.("Failed to update mailbox", "error"); }
                  }} />
                <span>{m.email}</span>
                <span className="text-xs text-slate-400">up to {m.daily_send_limit ?? "—"}/day</span>
              </label>
            ))}
            <p className="mt-1 text-xs text-slate-400">Each inbox obeys its own daily limit (set in SDR → Mailboxes).</p>
          </details>
        </div>
      )}
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {btn("leads", "Leads", <Building2 className="h-4 w-4" />)}
        {btn("sent", "Sent", <Send className="h-4 w-4" />)}
        {btn("email", "Email Copy", <Mail className="h-4 w-4" />)}
      </div>
      {renderSub()}
    </div>
  );
}
