import { useState, useEffect, useCallback, useMemo } from "react";
import { cn } from "../utils";
import { Check, X, Sparkles, TrendingUp, Calendar, Filter, Loader2, ExternalLink } from "lucide-react";

export interface SeoIdea {
  id: string;
  suggestedTitle: string;
  targetKeyword: string;
  suggestedType: "pillar" | "spoke" | "comparison";
  parentPillarKeyword: string | null;
  state: string | null;
  monthlyVolume: number | null;
  competitionIndex: number | null;
  cpcUsd: number | null;
  difficultyScore: number | null;
  intent: string | null;
  whyWrite: string | null;
  clusterName: string | null;
  status: "pending" | "approved" | "rejected" | "converted";
  convertedToContentId: string | null;
  batchId: string;
  createdAt: string;
  reviewedAt: string | null;
}

interface BatchSummary {
  batchId: string;
  createdAt: string;
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  converted: number;
}

export default function SeoIdeas({ onConverted }: { onConverted?: () => void }) {
  const [ideas, setIdeas] = useState<SeoIdea[]>([]);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected" | "converted" | "all">("pending");
  const [batchFilter, setBatchFilter] = useState<string>("");
  const [clusterFilter, setClusterFilter] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchIdeas = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("status", statusFilter);
    if (batchFilter) params.set("batch_id", batchFilter);
    try {
      const [ideasRes, batchesRes] = await Promise.all([
        fetch(`/api/seo-ideas?${params}`, { credentials: "include" }),
        fetch("/api/seo-ideas/batches", { credentials: "include" }),
      ]);
      const ideasData = await ideasRes.json();
      const batchesData = await batchesRes.json();
      setIdeas(Array.isArray(ideasData) ? ideasData : []);
      setBatches(Array.isArray(batchesData) ? batchesData : []);
    } catch (err) {
      console.error("Failed to load SEO ideas:", err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, batchFilter]);

  useEffect(() => {
    fetchIdeas();
  }, [fetchIdeas]);

  const clusters = useMemo(() => {
    const set = new Set<string>();
    for (const i of ideas) if (i.clusterName) set.add(i.clusterName);
    return Array.from(set).sort();
  }, [ideas]);

  const visibleIdeas = useMemo(() => {
    if (!clusterFilter) return ideas;
    return ideas.filter((i) => i.clusterName === clusterFilter);
  }, [ideas, clusterFilter]);

  const handleApprove = async (idea: SeoIdea, kickoffNow: boolean) => {
    setBusyId(idea.id);
    try {
      // Pillar with no state → prompt
      let stateOverride: string | undefined = undefined;
      if (idea.suggestedType === "pillar" && !idea.state) {
        const choice = window.prompt("This pillar has no state. Enter a US state (e.g. Texas):");
        if (!choice) { setBusyId(null); return; }
        stateOverride = choice.trim();
      }
      const res = await fetch(`/api/seo-ideas/${idea.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ kickoffNow, stateOverride }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Approve failed: ${err.error || res.status}`);
      } else {
        await fetchIdeas();
        if (onConverted) onConverted();
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (idea: SeoIdea) => {
    if (!window.confirm(`Reject "${idea.targetKeyword}"? It will be excluded from future suggestions.`)) return;
    setBusyId(idea.id);
    try {
      await fetch(`/api/seo-ideas/${idea.id}/reject`, {
        method: "POST",
        credentials: "include",
      });
      await fetchIdeas();
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading content ideas...
      </div>
    );
  }

  const latestBatch = batches[0];

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl border border-indigo-200 p-5">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-indigo-600 text-white flex items-center justify-center flex-shrink-0">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-slate-900">Weekly Content Ideas</h2>
            <p className="text-sm text-slate-600 mt-1">
              AI-ranked SEO opportunities backed by Google Ads search volume + competition data.
              Approve to queue an article; reject to never see this keyword again.
            </p>
            {latestBatch && (
              <p className="text-xs text-slate-500 mt-2">
                Latest batch: {new Date(latestBatch.createdAt).toLocaleDateString()} —{" "}
                <span className="font-medium">{latestBatch.pending}</span> pending,{" "}
                <span className="font-medium">{latestBatch.converted}</span> converted to articles,{" "}
                <span className="font-medium">{latestBatch.rejected}</span> rejected
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 bg-white rounded-xl border border-slate-200 p-3">
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <Filter className="h-3.5 w-3.5" />
          Status:
        </div>
        {(["pending", "approved", "converted", "rejected", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              "px-3 py-1 text-xs font-medium rounded-full border transition",
              statusFilter === s
                ? "bg-indigo-600 text-white border-indigo-600"
                : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
            )}
          >
            {s}
          </button>
        ))}

        {batches.length > 0 && (
          <>
            <div className="ml-2 text-xs text-slate-500">Batch:</div>
            <select
              value={batchFilter}
              onChange={(e) => setBatchFilter(e.target.value)}
              className="text-xs border border-slate-200 rounded-md px-2 py-1"
            >
              <option value="">All batches</option>
              {batches.map((b) => (
                <option key={b.batchId} value={b.batchId}>
                  {new Date(b.createdAt).toLocaleDateString()} ({b.total})
                </option>
              ))}
            </select>
          </>
        )}

        {clusters.length > 0 && (
          <>
            <div className="ml-2 text-xs text-slate-500">Cluster:</div>
            <select
              value={clusterFilter}
              onChange={(e) => setClusterFilter(e.target.value)}
              className="text-xs border border-slate-200 rounded-md px-2 py-1"
            >
              <option value="">All clusters</option>
              {clusters.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* Ideas grid */}
      {visibleIdeas.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-500">
          <Calendar className="h-8 w-8 mx-auto mb-2 text-slate-300" />
          <p className="text-sm">
            No {statusFilter === "all" ? "" : statusFilter} ideas{clusterFilter ? ` in cluster "${clusterFilter}"` : ""}.
          </p>
          <p className="text-xs mt-1 text-slate-400">
            New ideas land every Monday from the weekly DataForSEO research run.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {visibleIdeas.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              busy={busyId === idea.id}
              onApprove={(kickoff) => handleApprove(idea, kickoff)}
              onReject={() => handleReject(idea)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IdeaCard({
  idea,
  busy,
  onApprove,
  onReject,
}: {
  idea: SeoIdea;
  busy: boolean;
  onApprove: (kickoff: boolean) => void;
  onReject: () => void;
}) {
  const isPending = idea.status === "pending";
  const compColor = (c: number | null) =>
    c == null ? "bg-slate-100 text-slate-600" :
    c <= 30 ? "bg-green-100 text-green-700" :
    c <= 60 ? "bg-amber-100 text-amber-700" :
    "bg-red-100 text-red-700";
  const diffColor = (d: number | null) =>
    d == null ? "bg-slate-100 text-slate-600" :
    d <= 3 ? "bg-green-100 text-green-700" :
    d <= 6 ? "bg-amber-100 text-amber-700" :
    "bg-red-100 text-red-700";
  const typeColor =
    idea.suggestedType === "pillar" ? "bg-indigo-50 text-indigo-700 border-indigo-200" :
    idea.suggestedType === "comparison" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
    "bg-slate-100 text-slate-700 border-slate-200";

  return (
    <div className={cn(
      "bg-white rounded-xl border p-4 transition",
      idea.status === "converted" ? "border-green-200 bg-green-50/30" :
      idea.status === "rejected" ? "border-slate-200 opacity-60" :
      "border-slate-200 hover:shadow-md"
    )}>
      {/* Header: type + cluster */}
      <div className="flex items-center gap-2 mb-2">
        <span className={cn("px-2 py-0.5 text-[10px] font-semibold rounded-full border uppercase tracking-wide", typeColor)}>
          {idea.suggestedType}
        </span>
        {idea.clusterName && (
          <span className="text-[11px] text-slate-500 truncate">· {idea.clusterName}</span>
        )}
        {idea.state && (
          <span className="ml-auto text-[11px] font-medium text-slate-500">{idea.state}</span>
        )}
      </div>

      {/* Title */}
      <h3 className="font-semibold text-slate-900 leading-snug mb-1">
        {idea.suggestedTitle}
      </h3>

      {/* Target keyword */}
      <p className="text-xs text-slate-500 mb-3">
        Target: <span className="font-mono text-slate-700">{idea.targetKeyword}</span>
        {idea.parentPillarKeyword && (
          <> · under <span className="italic">{idea.parentPillarKeyword}</span></>
        )}
      </p>

      {/* Stats row */}
      <div className="flex flex-wrap gap-2 mb-3">
        {idea.monthlyVolume != null && (
          <span className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 px-2 py-0.5 text-[11px] rounded-md">
            <TrendingUp className="h-3 w-3" />
            {idea.monthlyVolume.toLocaleString()}/mo
          </span>
        )}
        {idea.competitionIndex != null && (
          <span className={cn("px-2 py-0.5 text-[11px] rounded-md font-medium", compColor(idea.competitionIndex))}>
            comp {idea.competitionIndex}
          </span>
        )}
        {idea.difficultyScore != null && (
          <span className={cn("px-2 py-0.5 text-[11px] rounded-md font-medium", diffColor(idea.difficultyScore))}>
            difficulty {idea.difficultyScore}/10
          </span>
        )}
        {idea.cpcUsd != null && idea.cpcUsd > 0 && (
          <span className="px-2 py-0.5 text-[11px] rounded-md bg-emerald-50 text-emerald-700 font-medium">
            ${idea.cpcUsd.toFixed(2)} CPC
          </span>
        )}
        {idea.intent && (
          <span className="px-2 py-0.5 text-[11px] rounded-md bg-purple-50 text-purple-700 capitalize">
            {idea.intent}
          </span>
        )}
      </div>

      {/* Why write */}
      {idea.whyWrite && (
        <p className="text-xs text-slate-600 italic mb-3 leading-relaxed">
          {idea.whyWrite}
        </p>
      )}

      {/* Actions */}
      {isPending && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-slate-100">
          <button
            onClick={() => onApprove(false)}
            disabled={busy}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            Queue
          </button>
          <button
            onClick={() => onApprove(true)}
            disabled={busy}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            title="Queue + immediately start generating"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Queue + Generate
          </button>
          <button
            onClick={onReject}
            disabled={busy}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-50"
            title="Reject — never suggest again"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {idea.status === "converted" && idea.convertedToContentId && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <a
            href={`#/ai-content?content=${idea.convertedToContentId}`}
            className="text-xs text-green-700 font-medium inline-flex items-center gap-1 hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            View article
          </a>
        </div>
      )}
      {idea.status === "rejected" && (
        <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-400">
          Rejected {idea.reviewedAt ? new Date(idea.reviewedAt).toLocaleDateString() : ""}
        </div>
      )}

    </div>
  );
}
