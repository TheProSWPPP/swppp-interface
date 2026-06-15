import { useEffect, useState } from "react";
import { ExternalLink, Send } from "lucide-react";
import { brevoUrl, nurtureApi, type NurtureAccount, type NurtureCampaign } from "../../lib/nurtureApi";
import { cn } from "../../utils";

const STATUS_COLORS: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-700",
  queued: "bg-sky-100 text-sky-700",
  draft: "bg-slate-100 text-slate-600",
  suspended: "bg-amber-100 text-amber-700",
  in_process: "bg-indigo-100 text-indigo-700",
  archive: "bg-slate-100 text-slate-500",
};

function rate(n: number | undefined, d: number | undefined): string {
  if (!d) return "—";
  return `${Math.round(((n || 0) / d) * 100)}%`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function CampaignsView() {
  const [campaigns, setCampaigns] = useState<NurtureCampaign[] | null>(null);
  const [account, setAccount] = useState<NurtureAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    nurtureApi.campaigns().then((d) => setCampaigns(d.campaigns)).catch((e) => setError(e.message));
    nurtureApi.account().then(setAccount).catch(() => {});
  }, []);

  if (error) return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  if (!campaigns) return <div className="text-center text-slate-400 py-12">Loading…</div>;

  const sent = campaigns.filter((c) => c.status === "sent");
  const scheduled = campaigns.filter((c) => c.status === "queued" || c.status === "in_process");
  const avgOpen = sent.length
    ? Math.round(
        (sent.reduce((a, c) => a + (c.stats?.uniqueViews || 0), 0) /
          Math.max(sent.reduce((a, c) => a + (c.stats?.sent || 0), 0), 1)) * 100,
      )
    : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Email credits" value={account?.credits != null ? account.credits.toLocaleString() : "—"} />
        <Tile label="Sent campaigns" value={String(sent.length)} />
        <Tile label="Scheduled" value={String(scheduled.length)} />
        <Tile label="Avg open rate" value={sent.length ? `${avgOpen}%` : "—"} />
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Campaigns</h3>
        <a
          href={brevoUrl("campaigns")}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
        >
          <Send className="h-3.5 w-3.5" /> Design in Brevo <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {campaigns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center text-sm text-slate-500">
          No campaigns yet.
        </div>
      ) : (
        <div className="space-y-2">
          {campaigns.map((c) => (
            <div key={c.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <div className="flex items-center gap-3">
                <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full", STATUS_COLORS[c.status] || "bg-slate-100 text-slate-600")}>
                  {c.status}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">{c.name}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {c.subject || "(no subject)"} · {c.status === "sent" ? `sent ${fmtDate(c.sentDate)}` : c.scheduledAt ? `scheduled ${fmtDate(c.scheduledAt)}` : "draft"}
                  </div>
                </div>
                {c.stats && c.status === "sent" && (
                  <div className="hidden sm:flex items-center gap-4 text-xs text-slate-600">
                    <Stat label="sent" value={String(c.stats.sent)} />
                    <Stat label="open" value={rate(c.stats.uniqueViews, c.stats.sent)} />
                    <Stat label="click" value={rate(c.stats.uniqueClicks, c.stats.sent)} />
                    <Stat label="unsub" value={String(c.stats.unsubscriptions)} />
                  </div>
                )}
                <a
                  href={brevoUrl("campaign", c.id)}
                  target="_blank"
                  rel="noreferrer"
                  title="Edit design in Brevo"
                  className="text-slate-400 hover:text-emerald-600 flex-shrink-0"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-slate-900 mt-1">{value}</div>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col items-end leading-tight">
      <span className="font-mono font-semibold text-slate-900">{value}</span>
      <span className="text-[10px] uppercase text-slate-400">{label}</span>
    </span>
  );
}
