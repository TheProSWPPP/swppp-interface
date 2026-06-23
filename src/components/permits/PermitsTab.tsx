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

  const patch = async (body: Partial<PermitSettings>, okMsg?: string) => {
    try {
      const { settings: s } = await patchPermitSettings(body);
      setSettings(s);
      if (okMsg) pushToast?.(okMsg, "success");
    } catch { pushToast?.("Failed to update setting", "error"); }
  };

  const toggleActive = async () => {
    if (!settings) return;
    if (!settings.active && !window.confirm("Turn ON permit email sending? Approved drafts can then be sent.")) return;
    await patch({ active: !settings.active }, `Permit email sending ${!settings.active ? "ON" : "OFF"}`);
  };

  const toggleAutoSend = async () => {
    if (!settings) return;
    if (!settings.auto_send_enabled && !window.confirm("Turn ON auto-send? Approved drafts will send on their own within each inbox's daily cap.")) return;
    await patch({ auto_send_enabled: !settings.auto_send_enabled });
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
        <div className="mb-3 space-y-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          {/* Master switch */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={settings.active} onChange={toggleActive} />
              <span className="font-medium">Permit email sending {settings.active ? "ON" : "OFF"}</span>
            </label>
            <p className="mt-1 text-xs text-slate-500">
              Master switch. Off = nothing sends, even approved drafts. Finding emails still works either way.
            </p>
          </div>

          {/* Auto-find emails */}
          <div className="border-t border-slate-200 pt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!settings.auto_find_enabled}
                onChange={() => patch({ auto_find_enabled: !settings.auto_find_enabled })} />
              <span className="font-medium">Auto-find emails</span>
            </label>
            <p className="mt-1 text-xs text-slate-500">
              Checks picked companies for emails on a schedule (~1 credit each).
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
              <label className="flex items-center gap-1.5">
                Max per day
                <input type="number" min={1} max={500} defaultValue={settings.auto_find_daily_cap ?? 50}
                  onBlur={(e) => patch({ auto_find_daily_cap: Number(e.target.value) })}
                  className="w-16 rounded border border-slate-300 px-1.5 py-0.5" />
              </label>
              <label className="flex items-center gap-1.5">
                Pause when backlog over
                <input type="number" min={1} max={5000} defaultValue={settings.auto_find_backlog_max ?? 200}
                  onBlur={(e) => patch({ auto_find_backlog_max: Number(e.target.value) })}
                  className="w-20 rounded border border-slate-300 px-1.5 py-0.5" />
                found-but-unsent
              </label>
            </div>
          </div>

          {/* Auto-send approved */}
          <div className="border-t border-slate-200 pt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!settings.auto_send_enabled} onChange={toggleAutoSend} />
              <span className="font-medium">Auto-send approved drafts</span>
            </label>
            <p className="mt-1 text-xs text-slate-500">
              On = approved drafts send on their own within each inbox's daily cap (needs the master switch on too).
              Off = you send each with “Send now”.
            </p>
          </div>

          <details className="border-t border-slate-200 pt-2">
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
