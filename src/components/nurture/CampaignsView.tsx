import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Send } from "lucide-react";
import { brevoUrl, campaignOpenRate, campaignRate, formatNurtureDate, isAdmin, nurtureApi, type NurtureAccount, type NurtureCampaign, type NurtureList } from "../../lib/nurtureApi";
import { cn } from "../../utils";

type Toast = (kind: "success" | "error", text: string) => void;

const STATUS_COLORS: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-700", queued: "bg-sky-100 text-sky-700", draft: "bg-slate-100 text-slate-600",
  suspended: "bg-amber-100 text-amber-700", in_process: "bg-brand-100 text-brand-700", archive: "bg-slate-100 text-slate-500",
};

export default function CampaignsView({ pushToast }: { pushToast?: Toast }) {
  const [campaigns, setCampaigns] = useState<NurtureCampaign[] | null>(null);
  const [account, setAccount] = useState<NurtureAccount | null>(null);
  const [lists, setLists] = useState<NurtureList[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const request = useRef(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const admin = isAdmin();
  const toast: Toast = (k, t) => pushToast?.(k, t);

  const invalidate = useCallback(() => { request.current++; }, []);
  const load = useCallback(() => {
    const current = ++request.current;
    setError(null);
    setDetailsError(null);
    nurtureApi.campaigns().then((d) => { if (current === request.current) setCampaigns(d.campaigns); }).catch((e) => { if (current === request.current) setError(e.message); });
    nurtureApi.account().then((d) => { if (current === request.current) setAccount(d); }).catch(() => { if (current === request.current) { setAccount(null); setDetailsError((previous) => [previous, "Email credits could not be loaded."].filter(Boolean).join(" ")); } });
    nurtureApi.lists().then((d) => { if (current === request.current) setLists(d.lists); }).catch(() => { if (current === request.current) { setLists([]); setDetailsError((previous) => [previous, "Recipient lists could not be loaded."].filter(Boolean).join(" ")); } });
  }, []);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; invalidate(); };
  }, [load, invalidate]);

  if (error) return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">Campaigns could not be loaded. {error}<button onClick={load} className="ml-3 min-h-11 font-semibold underline">Try again</button></div>;
  if (!campaigns) return <div className="text-center text-slate-400 py-12">Loading…</div>;

  const sent = campaigns.filter((c) => c.status === "sent");
  const scheduled = campaigns.filter((c) => c.status === "queued" || c.status === "in_process");
  const avgOpen = campaignOpenRate(campaigns);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Email credits" value={account?.credits != null ? account.credits.toLocaleString() : "—"} />
        <Tile label="Sent campaigns" value={String(sent.length)} />
        <Tile label="Queued or sending" value={String(scheduled.length)} />
        <Tile label="Tracked open rate" value={avgOpen} />
      </div>
      <p className="text-xs text-slate-500">All Brevo campaigns. Statistics cover the last 6 months. Open and click rates use delivered emails. Privacy features and security scanners can inflate tracking; missing statistics appear as —.</p>
      {detailsError && <div role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{detailsError}<button onClick={load} className="ml-3 min-h-11 font-semibold underline">Try again</button></div>}
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Campaigns</h3>
        <a href={brevoUrl("campaigns")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 min-h-11 text-sm font-semibold text-emerald-700 hover:bg-emerald-100">
          <Send className="h-3.5 w-3.5" /> Design in Brevo <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      {campaigns.length === 0 && <p className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">No campaigns found in Brevo.</p>}
      <div className="space-y-2">
        {campaigns.map((c) => (
          <CampaignRow key={c.id} c={c} admin={admin} lists={lists} busy={busyId === c.id}
            expanded={expandedId === c.id} onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
            setBusy={(v) => setBusyId(v ? c.id : null)} reload={load} toast={toast} />
        ))}
      </div>
    </div>
  );
}

function CampaignRow({ c, admin, lists, busy, expanded, onToggle, setBusy, reload, toast }: {
  c: NurtureCampaign; admin: boolean; lists: NurtureList[]; busy: boolean; expanded: boolean;
  onToggle: () => void; setBusy: (v: boolean) => void; reload: () => void; toast: (k: "success" | "error", t: string) => void;
}) {
  const [confirm, setConfirm] = useState<null | "send" | "delete" | "suspend">(null);
  const [testEmail, setTestEmail] = useState("");
  const [dupName, setDupName] = useState(`${c.name} (copy)`);
  const [dupList, setDupList] = useState<string>(""); // string so the controlled <select> matches its option values
  const [showDup, setShowDup] = useState(false);

  // Don't leave a stale confirm bar / duplicate panel open when the row is collapsed
  useEffect(() => { if (!expanded) { setConfirm(null); setShowDup(false); } }, [expanded]);

  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try { await fn(); toast("success", okMsg); reload(); }
    catch (e) { toast("error", (e as Error).message); }
    finally { setBusy(false); setConfirm(null); setShowDup(false); }
  };

  const isDraft = c.status === "draft";
  const isQueued = c.status === "queued" || c.status === "in_process";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <button aria-expanded={expanded} onClick={onToggle} className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left">
        <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full", STATUS_COLORS[c.status] || "bg-slate-100 text-slate-600")}>{c.status}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-900 truncate">{c.name}</div>
          <div className="text-xs text-slate-500 truncate">{c.subject || "(no subject)"} · {c.status === "sent" ? `sent ${formatNurtureDate(c.sentDate)}` : c.scheduledAt ? `scheduled ${formatNurtureDate(c.scheduledAt)}` : "draft"}</div>
        </div>
        {c.status === "sent" && (
          <div className="hidden sm:flex items-center gap-4 text-xs text-slate-600">
            <Stat label="sent" value={c.stats?.sent == null ? "—" : c.stats.sent.toLocaleString()} /><Stat label="open" value={campaignRate(c.stats?.uniqueViews, c.stats?.delivered)} />
            <Stat label="click" value={campaignRate(c.stats?.uniqueClicks, c.stats?.delivered)} /><Stat label="unsub" value={c.stats?.unsubscriptions == null ? "—" : c.stats.unsubscriptions.toLocaleString()} />
          </div>
        )}
      </button>
      {expanded && (
        <div className="border-t border-slate-100 px-4 py-3 bg-slate-50/50 space-y-3">
          {c.status === "sent" && <div className="grid grid-cols-2 sm:hidden gap-3 text-xs text-slate-600">
            <Stat label="sent" value={c.stats?.sent == null ? "—" : c.stats.sent.toLocaleString()} />
            <Stat label="tracked opens" value={campaignRate(c.stats?.uniqueViews, c.stats?.delivered)} />
            <Stat label="tracked clicks" value={campaignRate(c.stats?.uniqueClicks, c.stats?.delivered)} />
            <Stat label="unsubscribed" value={c.stats?.unsubscriptions == null ? "—" : c.stats.unsubscriptions.toLocaleString()} />
          </div>}
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Test recipient email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="test@ (must be an existing Brevo contact)"
              className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-1.5 min-h-11 text-sm focus:border-emerald-400 focus:outline-none" />
            <button disabled={busy || !testEmail.trim()} onClick={() => run(() => nurtureApi.campaignTest(c.id, [testEmail.trim()]), "Test email sent.")}
              className="rounded-lg bg-slate-900 px-3 py-1.5 min-h-11 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50">Send test</button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a href={brevoUrl("campaign", c.id)} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 min-h-11 text-sm text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5">Edit design <ExternalLink className="h-3.5 w-3.5" /></a>
            <button disabled={busy} onClick={() => setShowDup((v) => !v)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 min-h-11 text-sm text-slate-600 hover:bg-slate-50">Duplicate</button>
            {admin && isQueued && <button disabled={busy} onClick={() => setConfirm("suspend")} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 min-h-11 text-sm font-semibold text-amber-700 hover:bg-amber-100">Cancel send</button>}
            {admin && isDraft && <button disabled={busy} onClick={() => setConfirm("send")} className="rounded-lg bg-emerald-600 px-3 py-1.5 min-h-11 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">Send now</button>}
            {admin && isDraft && <button disabled={busy} onClick={() => setConfirm("delete")} className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 min-h-11 text-sm font-semibold text-rose-700 hover:bg-rose-50">Delete</button>}
          </div>
          {showDup && (
            <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
              <input aria-label="New campaign name" value={dupName} onChange={(e) => setDupName(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-1.5 min-h-11 text-sm" placeholder="New campaign name" />
              <select aria-label="Recipient list" value={dupList} onChange={(e) => setDupList(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-1.5 min-h-11 text-sm">
                <option value="">Recipient list (optional)</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.count ?? "?"})</option>)}
              </select>
              <button disabled={busy || !dupName.trim()} onClick={() => run(() => nurtureApi.campaignDuplicate(c.id, dupName.trim(), dupList ? [Number(dupList)] : []), "Duplicated as a new draft.")}
                className="rounded-lg bg-slate-900 px-3 py-1.5 min-h-11 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50">Create draft copy</button>
            </div>
          )}
          {confirm === "send" && (
            <ConfirmBar tone="emerald" busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => run(() => nurtureApi.campaignSend(c.id), "Campaign sending now.")}
              text={`Send "${c.name}" now to its recipient lists? This emails real contacts immediately and cannot be undone.`} confirmLabel="Send now" />
          )}
          {confirm === "suspend" && (
            <ConfirmBar tone="amber" busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => run(() => nurtureApi.campaignSuspend(c.id), "Campaign cancelled.")}
              text={`Cancel the scheduled send of "${c.name}"? (Brevo can't move it back to draft afterward.)`} confirmLabel="Cancel send" />
          )}
          {confirm === "delete" && (
            <ConfirmBar tone="rose" busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => run(() => nurtureApi.campaignDelete(c.id), "Draft deleted.")}
              text={`Delete the draft "${c.name}"? This can't be undone.`} confirmLabel="Delete draft" />
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmBar({ tone, text, confirmLabel, busy, onCancel, onConfirm }: { tone: "emerald" | "amber" | "rose"; text: string; confirmLabel: string; busy: boolean; onCancel: () => void; onConfirm: () => void; }) {
  const tones = { emerald: "border-emerald-200 bg-emerald-50 text-emerald-900", amber: "border-amber-200 bg-amber-50 text-amber-900", rose: "border-rose-200 bg-rose-50 text-rose-900" };
  const btn = { emerald: "bg-emerald-600 hover:bg-emerald-500", amber: "bg-amber-600 hover:bg-amber-500", rose: "bg-rose-600 hover:bg-rose-500" };
  return (
    <div className={cn("rounded-xl border px-4 py-3 flex flex-wrap items-center gap-3", tones[tone])}>
      <div className="flex-1 text-sm">{text}</div>
      <button onClick={onCancel} disabled={busy} className="rounded-lg px-3 py-1.5 min-h-11 text-sm text-slate-600 hover:bg-white">Cancel</button>
      <button onClick={onConfirm} disabled={busy} className={cn("rounded-lg px-3 py-1.5 min-h-11 text-sm font-semibold text-white disabled:opacity-50", btn[tone])}>{confirmLabel}</button>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (<div className="rounded-2xl border border-slate-200 bg-white px-4 py-3"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="text-2xl font-semibold text-slate-900 mt-1">{value}</div></div>);
}
function Stat({ label, value }: { label: string; value: string }) {
  return (<span className="flex flex-col items-end leading-tight"><span className="font-mono font-semibold text-slate-900">{value}</span><span className="text-[10px] uppercase text-slate-400">{label}</span></span>);
}
