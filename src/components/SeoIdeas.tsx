import { useState, useEffect, useCallback, useMemo } from "react";
import { cn } from "../utils";
import {
  Check,
  X,
  Sparkles,
  Filter,
  Loader2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  List,
  Zap,
  Target,
  Square,
  CheckSquare,
} from "lucide-react";

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

type ViewMode = "cluster" | "table";

// Opportunity score: higher is better. Combines volume × (1 - comp/100) × intent multiplier.
function opportunityScore(idea: SeoIdea): number {
  const vol = idea.monthlyVolume || 0;
  const comp = idea.competitionIndex == null ? 50 : idea.competitionIndex;
  const compMult = Math.max(0.05, 1 - comp / 100);
  const intentMult =
    idea.intent === "commercial" ? 1.4 :
    idea.intent === "local" ? 1.2 :
    1.0;
  return Math.round(vol * compMult * intentMult);
}

function scoreColor(score: number): string {
  if (score >= 500) return "bg-emerald-100 text-emerald-700 border-emerald-200";
  if (score >= 200) return "bg-amber-100 text-amber-700 border-amber-200";
  if (score >= 50) return "bg-blue-50 text-blue-700 border-blue-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
}

export default function SeoIdeas({ onConverted }: { onConverted?: () => void }) {
  const [ideas, setIdeas] = useState<SeoIdea[]>([]);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected" | "converted" | "all">("pending");
  const [batchFilter, setBatchFilter] = useState<string>("");
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("cluster");
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());
  const [expandedWhy, setExpandedWhy] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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

  // Group ideas by cluster, sorted by best opportunity per cluster
  const clusterGroups = useMemo(() => {
    const groups = new Map<string, SeoIdea[]>();
    for (const i of ideas) {
      const k = i.clusterName || "(uncategorized)";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(i);
    }
    // Sort ideas within each cluster by opportunity desc
    for (const arr of groups.values()) {
      arr.sort((a, b) => opportunityScore(b) - opportunityScore(a));
    }
    // Sort clusters by max opportunity inside
    return Array.from(groups.entries()).sort(([, a], [, b]) =>
      opportunityScore(b[0]) - opportunityScore(a[0])
    );
  }, [ideas]);

  const flatSorted = useMemo(
    () => [...ideas].sort((a, b) => opportunityScore(b) - opportunityScore(a)),
    [ideas]
  );

  const toggleCluster = (name: string) => {
    setCollapsedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleWhy = (id: string) => {
    setExpandedWhy((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const approveOne = async (idea: SeoIdea, kickoffNow: boolean) => {
    setBusy(idea.id, true);
    try {
      let stateOverride: string | undefined;
      if (idea.suggestedType === "pillar" && !idea.state) {
        const choice = window.prompt("This pillar has no state. Enter a US state:");
        if (!choice) { setBusy(idea.id, false); return; }
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
        alert(`Approve failed for "${idea.targetKeyword}": ${err.error || res.status}`);
      } else if (onConverted) {
        onConverted();
      }
    } finally {
      setBusy(idea.id, false);
    }
  };

  const rejectOne = async (idea: SeoIdea) => {
    setBusy(idea.id, true);
    try {
      await fetch(`/api/seo-ideas/${idea.id}/reject`, { method: "POST", credentials: "include" });
    } finally {
      setBusy(idea.id, false);
    }
  };

  const bulkApproveCluster = async (clusterIdeas: SeoIdea[]) => {
    if (!window.confirm(`Queue ${clusterIdeas.length} ideas for generation? (will not auto-fire)`)) return;
    for (const i of clusterIdeas) {
      if (i.status !== "pending") continue;
      // Sequential to avoid race + state-prompt repetition
      // eslint-disable-next-line no-await-in-loop
      await approveOne(i, false);
    }
    fetchIdeas();
  };

  const bulkRejectCluster = async (clusterIdeas: SeoIdea[]) => {
    if (!window.confirm(`Reject ${clusterIdeas.length} ideas? They won't be suggested again.`)) return;
    await Promise.all(clusterIdeas.filter((i) => i.status === "pending").map((i) => rejectOne(i)));
    fetchIdeas();
  };

  const pendingIdeas = ideas.filter((i) => i.status === "pending");
  const allSelected = pendingIdeas.length > 0 && pendingIdeas.every((i) => selectedIds.has(i.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(pendingIdeas.map((i) => i.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const bulkApproveSelected = async () => {
    const toApprove = pendingIdeas.filter((i) => selectedIds.has(i.id));
    if (!toApprove.length) return;
    if (!window.confirm(`Queue ${toApprove.length} selected ideas for generation?`)) return;
    for (const i of toApprove) await approveOne(i, false);
    clearSelection();
    fetchIdeas();
  };

  const bulkRejectSelected = async () => {
    const toReject = pendingIdeas.filter((i) => selectedIds.has(i.id));
    if (!toReject.length) return;
    if (!window.confirm(`Reject ${toReject.length} selected ideas?`)) return;
    await Promise.all(toReject.map((i) => rejectOne(i)));
    clearSelection();
    fetchIdeas();
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
  const totalScore = ideas.reduce((acc, i) => acc + opportunityScore(i), 0);

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="bg-gradient-to-br from-brand-50 to-purple-50 rounded-xl border border-brand-200 p-5">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-brand-600 text-white flex items-center justify-center flex-shrink-0">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-slate-900">Weekly Content Ideas</h2>
            <p className="text-sm text-slate-600 mt-1">
              AI-ranked SEO opportunities. <b>Opportunity Score</b> = monthly search volume × low-competition bonus × intent multiplier. Higher = bigger SEO win for less effort.
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px]">
              <span className="text-slate-400">Score:</span>
              <span className="px-2 py-0.5 rounded-full border font-semibold bg-emerald-100 text-emerald-700 border-emerald-200">≥500 High</span>
              <span className="px-2 py-0.5 rounded-full border font-semibold bg-amber-100 text-amber-700 border-amber-200">≥200 Medium</span>
              <span className="px-2 py-0.5 rounded-full border font-semibold bg-blue-50 text-blue-700 border-blue-200">≥50 Low</span>
              <span className="px-2 py-0.5 rounded-full border font-semibold bg-slate-100 text-slate-500 border-slate-200">&lt;50 Minimal</span>
              <span className="text-slate-300 mx-1">·</span>
              <span className="text-slate-400">Stats: <b className="text-slate-600">vol</b> = searches/mo · <b className="text-slate-600">comp</b> = competition 0–100 (lower = easier) · <b className="text-slate-600">diff</b> = keyword difficulty 0–10 · <b className="text-slate-600">cpc</b> = ad value</span>
            </div>
            {latestBatch && (
              <p className="text-xs text-slate-500 mt-2">
                Latest batch {new Date(latestBatch.createdAt).toLocaleDateString()} ·{" "}
                <b>{latestBatch.pending}</b> pending · <b>{latestBatch.converted}</b> converted ·{" "}
                <b>{latestBatch.rejected}</b> rejected
                {ideas.length > 0 && <> · current view total opportunity: <b>{totalScore.toLocaleString()}</b></>}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Sticky filter bar */}
      <div className="sticky top-0 z-10 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/70 rounded-xl border border-slate-200 p-3 flex flex-wrap items-center gap-3">
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
                ? "bg-brand-600 text-white border-brand-600"
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

        {statusFilter === "pending" && pendingIdeas.length > 0 && (
          <button
            onClick={allSelected ? clearSelection : selectAll}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full border transition",
              allSelected
                ? "bg-brand-600 text-white border-brand-600"
                : "bg-white text-slate-600 border-slate-200 hover:border-brand-300 hover:text-brand-600"
            )}
          >
            {allSelected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
            {allSelected ? "Deselect all" : `Select all (${pendingIdeas.length})`}
          </button>
        )}

        <div className="flex-1" />

        {/* View mode toggle */}
        <div className="flex bg-slate-100 rounded-lg p-0.5">
          <button
            onClick={() => setViewMode("cluster")}
            className={cn(
              "px-2.5 py-1 text-xs font-medium rounded-md flex items-center gap-1.5 transition",
              viewMode === "cluster" ? "bg-white shadow-sm text-slate-900" : "text-slate-500"
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Clusters
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={cn(
              "px-2.5 py-1 text-xs font-medium rounded-md flex items-center gap-1.5 transition",
              viewMode === "table" ? "bg-white shadow-sm text-slate-900" : "text-slate-500"
            )}
          >
            <List className="h-3.5 w-3.5" />
            Table
          </button>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-brand-50 border border-brand-200 rounded-xl">
          <CheckSquare className="h-4 w-4 text-brand-600 flex-shrink-0" />
          <span className="text-sm font-medium text-brand-900">{selectedIds.size} idea{selectedIds.size !== 1 ? "s" : ""} selected</span>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={bulkApproveSelected}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-brand-600 text-white hover:bg-brand-700"
            >
              <Check className="h-3.5 w-3.5" />
              Queue selected
            </button>
            <button
              onClick={bulkRejectSelected}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              <X className="h-3.5 w-3.5" />
              Reject selected
            </button>
            <button onClick={clearSelection} className="text-xs text-slate-400 hover:text-slate-600 px-1">
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Body */}
      {ideas.length === 0 ? (
        <EmptyState statusFilter={statusFilter} />
      ) : viewMode === "cluster" ? (
        <div className="space-y-3">
          {clusterGroups.map(([name, clusterIdeas]) => (
            <ClusterCard
              key={name}
              name={name}
              ideas={clusterIdeas}
              collapsed={collapsedClusters.has(name)}
              onToggle={() => toggleCluster(name)}
              onApprove={(idea, kickoff) => approveOne(idea, kickoff)}
              onReject={(idea) => rejectOne(idea).then(fetchIdeas)}
              onBulkApprove={() => bulkApproveCluster(clusterIdeas)}
              onBulkReject={() => bulkRejectCluster(clusterIdeas)}
              busyIds={busyIds}
              expandedWhy={expandedWhy}
              onToggleWhy={toggleWhy}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      ) : (
        <TableView
          ideas={flatSorted}
          busyIds={busyIds}
          onApprove={(idea, kickoff) => approveOne(idea, kickoff)}
          onReject={(idea) => rejectOne(idea).then(fetchIdeas)}
        />
      )}
    </div>
  );
}

// ===== Cluster Card =====
function ClusterCard({
  name,
  ideas,
  collapsed,
  onToggle,
  onApprove,
  onReject,
  onBulkApprove,
  onBulkReject,
  busyIds,
  expandedWhy,
  onToggleWhy,
  selectedIds,
  onToggleSelect,
}: {
  name: string;
  ideas: SeoIdea[];
  collapsed: boolean;
  onToggle: () => void;
  onApprove: (idea: SeoIdea, kickoff: boolean) => void;
  onReject: (idea: SeoIdea) => void;
  onBulkApprove: () => void;
  onBulkReject: () => void;
  busyIds: Set<string>;
  expandedWhy: Set<string>;
  onToggleWhy: (id: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const pendingCount = ideas.filter((i) => i.status === "pending").length;
  const totalScore = ideas.reduce((acc, i) => acc + opportunityScore(i), 0);
  const top = ideas[0];

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 bg-slate-50/50">
        <button onClick={onToggle} className="flex items-center gap-2 text-slate-700 hover:text-slate-900 flex-1 text-left">
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          <span className="font-semibold">{name}</span>
          <span className="text-xs text-slate-500">·</span>
          <span className="text-xs text-slate-500">{ideas.length} {ideas.length === 1 ? "idea" : "ideas"}</span>
          {pendingCount > 0 && pendingCount !== ideas.length && (
            <span className="text-xs text-brand-600">· {pendingCount} pending</span>
          )}
          <span className={cn("ml-2 px-2 py-0.5 text-[10px] font-semibold rounded-full border uppercase", scoreColor(opportunityScore(top)))}>
            top {opportunityScore(top).toLocaleString()}
          </span>
          <span className="text-xs text-slate-400">total {totalScore.toLocaleString()}</span>
        </button>
        {pendingCount > 0 && (
          <div className="flex gap-1.5">
            <button
              onClick={onBulkApprove}
              className="text-xs px-2.5 py-1 rounded-md bg-brand-50 text-brand-700 hover:bg-brand-100 font-medium"
            >
              Queue all ({pendingCount})
            </button>
            <button
              onClick={onBulkReject}
              className="text-xs px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 font-medium"
            >
              Reject all
            </button>
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="divide-y divide-slate-100">
          {ideas.map((idea) => (
            <IdeaRow
              key={idea.id}
              idea={idea}
              busy={busyIds.has(idea.id)}
              expandedWhy={expandedWhy.has(idea.id)}
              onToggleWhy={() => onToggleWhy(idea.id)}
              onApprove={(kickoff) => onApprove(idea, kickoff)}
              onReject={() => onReject(idea)}
              selected={selectedIds.has(idea.id)}
              onToggleSelect={() => onToggleSelect(idea.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Single Idea Row =====
function IdeaRow({
  idea,
  busy,
  expandedWhy,
  onToggleWhy,
  onApprove,
  onReject,
  selected,
  onToggleSelect,
}: {
  idea: SeoIdea;
  busy: boolean;
  expandedWhy: boolean;
  onToggleWhy: () => void;
  onApprove: (kickoff: boolean) => void;
  onReject: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const score = opportunityScore(idea);
  const isPending = idea.status === "pending";
  const typeColor =
    idea.suggestedType === "pillar" ? "bg-brand-50 text-brand-700 border-brand-200" :
    idea.suggestedType === "comparison" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
    "bg-slate-100 text-slate-700 border-slate-200";

  return (
    <div className={cn(
      "px-4 py-3 transition",
      idea.status === "converted" && "bg-green-50/30",
      idea.status === "rejected" && "opacity-50",
      selected && "bg-brand-50/40",
      "hover:bg-slate-50/50"
    )}>
      <div className="flex items-start gap-3">
        {/* Checkbox (pending only) */}
        {idea.status === "pending" && onToggleSelect && (
          <button onClick={onToggleSelect} className="mt-1 text-slate-400 hover:text-brand-600 flex-shrink-0">
            {selected ? <CheckSquare className="h-4 w-4 text-brand-600" /> : <Square className="h-4 w-4" />}
          </button>
        )}
        {/* Score chip */}
        <div className={cn("px-2 py-1 rounded-md border font-mono text-xs font-semibold flex flex-col items-center min-w-[48px]", scoreColor(score))}>
          <Zap className="h-3 w-3 mb-0.5" />
          {score.toLocaleString()}
        </div>

        {/* Title + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold rounded-full border uppercase tracking-wide", typeColor)}>
              {idea.suggestedType}
            </span>
            {idea.state && (
              <span className="text-[11px] font-medium text-slate-500">{idea.state}</span>
            )}
            {idea.intent && (
              <span className="text-[11px] text-slate-400 capitalize">· {idea.intent}</span>
            )}
          </div>
          <div className="font-medium text-slate-900 text-sm leading-tight">
            {idea.suggestedTitle}
          </div>
          <div className="text-xs text-slate-500 mt-0.5 font-mono truncate">
            {idea.targetKeyword}
            {idea.parentPillarKeyword && (
              <span className="text-slate-400 italic"> · under {idea.parentPillarKeyword}</span>
            )}
          </div>

          {/* Stats row */}
          <div className="flex flex-wrap gap-1.5 mt-2 text-[11px]">
            {idea.monthlyVolume != null && (
              <Stat label="vol" value={`${idea.monthlyVolume.toLocaleString()}/mo`} />
            )}
            {idea.competitionIndex != null && (
              <Stat
                label="comp"
                value={String(idea.competitionIndex)}
                tone={idea.competitionIndex <= 30 ? "green" : idea.competitionIndex <= 60 ? "amber" : "red"}
              />
            )}
            {idea.difficultyScore != null && (
              <Stat
                label="diff"
                value={`${idea.difficultyScore}/10`}
                tone={idea.difficultyScore <= 3 ? "green" : idea.difficultyScore <= 6 ? "amber" : "red"}
              />
            )}
            {idea.cpcUsd != null && idea.cpcUsd > 0 && (
              <Stat label="cpc" value={`$${idea.cpcUsd.toFixed(2)}`} tone="emerald" />
            )}
          </div>

          {/* Why-write (collapsed by default) */}
          {idea.whyWrite && (
            <div className="mt-2">
              <button onClick={onToggleWhy} className="text-[11px] text-slate-500 hover:text-slate-700 flex items-center gap-1">
                <Target className="h-3 w-3" />
                {expandedWhy ? "Hide why" : "Why write?"}
              </button>
              {expandedWhy && (
                <p className="text-xs text-slate-600 italic mt-1 leading-relaxed">{idea.whyWrite}</p>
              )}
            </div>
          )}

          {idea.status === "converted" && idea.convertedToContentId && (
            <a
              href={`#/ai-content?content=${idea.convertedToContentId}`}
              className="text-xs text-green-700 font-medium inline-flex items-center gap-1 hover:underline mt-1"
            >
              <ExternalLink className="h-3 w-3" />
              View article
            </a>
          )}
        </div>

        {/* Actions */}
        {isPending && (
          <div className="flex flex-col gap-1.5 flex-shrink-0">
            <button
              onClick={() => onApprove(true)}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              title="Queue + immediately start generating"
            >
              <Sparkles className="h-3 w-3" />
              Generate
            </button>
            <button
              onClick={() => onApprove(false)}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              Queue
            </button>
            <button
              onClick={onReject}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-slate-100 text-slate-500 hover:bg-slate-200 disabled:opacity-50"
              title="Never suggest this again"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== Compact Table View =====
function TableView({
  ideas,
  busyIds,
  onApprove,
  onReject,
}: {
  ideas: SeoIdea[];
  busyIds: Set<string>;
  onApprove: (idea: SeoIdea, kickoff: boolean) => void;
  onReject: (idea: SeoIdea) => void;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            <th className="text-left text-[11px] uppercase tracking-wider font-semibold text-slate-600 px-3 py-2">Score</th>
            <th className="text-left text-[11px] uppercase tracking-wider font-semibold text-slate-600 px-3 py-2">Title</th>
            <th className="text-left text-[11px] uppercase tracking-wider font-semibold text-slate-600 px-3 py-2">Type</th>
            <th className="text-left text-[11px] uppercase tracking-wider font-semibold text-slate-600 px-3 py-2">State</th>
            <th className="text-right text-[11px] uppercase tracking-wider font-semibold text-slate-600 px-3 py-2">Vol</th>
            <th className="text-right text-[11px] uppercase tracking-wider font-semibold text-slate-600 px-3 py-2">Comp</th>
            <th className="text-right text-[11px] uppercase tracking-wider font-semibold text-slate-600 px-3 py-2">CPC</th>
            <th className="text-left text-[11px] uppercase tracking-wider font-semibold text-slate-600 px-3 py-2">Cluster</th>
            <th className="text-right text-[11px] uppercase tracking-wider font-semibold text-slate-600 px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {ideas.map((idea) => {
            const score = opportunityScore(idea);
            const busy = busyIds.has(idea.id);
            return (
              <tr key={idea.id} className={cn("hover:bg-slate-50", idea.status === "rejected" && "opacity-50")}>
                <td className="px-3 py-2">
                  <span className={cn("inline-block px-2 py-0.5 rounded-md font-mono text-xs font-semibold border", scoreColor(score))}>
                    {score.toLocaleString()}
                  </span>
                </td>
                <td className="px-3 py-2 max-w-md">
                  <div className="font-medium text-slate-900 text-sm leading-tight truncate">{idea.suggestedTitle}</div>
                  <div className="text-[11px] text-slate-500 font-mono truncate">{idea.targetKeyword}</div>
                </td>
                <td className="px-3 py-2 text-xs text-slate-600 capitalize">{idea.suggestedType}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{idea.state || "—"}</td>
                <td className="px-3 py-2 text-right text-xs text-slate-700">{idea.monthlyVolume?.toLocaleString() || "—"}</td>
                <td className="px-3 py-2 text-right text-xs text-slate-700">{idea.competitionIndex ?? "—"}</td>
                <td className="px-3 py-2 text-right text-xs text-slate-700">{idea.cpcUsd != null ? `$${idea.cpcUsd.toFixed(2)}` : "—"}</td>
                <td className="px-3 py-2 text-xs text-slate-500 max-w-[160px] truncate">{idea.clusterName || "—"}</td>
                <td className="px-3 py-2 text-right">
                  {idea.status === "pending" ? (
                    <div className="inline-flex gap-1">
                      <button onClick={() => onApprove(idea, true)} disabled={busy} className="px-2 py-0.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50" title="Generate">
                        <Sparkles className="h-3 w-3" />
                      </button>
                      <button onClick={() => onApprove(idea, false)} disabled={busy} className="px-2 py-0.5 text-xs rounded bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-50" title="Queue">
                        <Check className="h-3 w-3" />
                      </button>
                      <button onClick={() => onReject(idea)} disabled={busy} className="px-2 py-0.5 text-xs rounded bg-slate-100 text-slate-500 hover:bg-slate-200 disabled:opacity-50" title="Reject">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400 capitalize">{idea.status}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ===== Helpers =====
const STAT_TITLES: Record<string, string> = {
  vol: "Monthly search volume — how many people search this keyword per month",
  comp: "Competition index 0–100 — lower means fewer advertisers competing, easier to rank",
  diff: "Keyword difficulty 0–10 — lower means easier to get on page 1",
  cpc: "Cost-per-click — what advertisers pay per click, signals commercial value",
};

function Stat({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "green" | "amber" | "red" | "emerald" }) {
  const cls =
    tone === "green" ? "bg-green-100 text-green-700" :
    tone === "amber" ? "bg-amber-100 text-amber-700" :
    tone === "red" ? "bg-red-100 text-red-700" :
    tone === "emerald" ? "bg-emerald-100 text-emerald-700" :
    "bg-slate-100 text-slate-600";
  return (
    <span title={STAT_TITLES[label]} className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium cursor-help", cls)}>
      <span className="opacity-60">{label}</span>
      <span>{value}</span>
    </span>
  );
}

function EmptyState({ statusFilter }: { statusFilter: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-500">
      <Sparkles className="h-8 w-8 mx-auto mb-2 text-slate-300" />
      <p className="text-sm">No {statusFilter === "all" ? "" : statusFilter} ideas yet.</p>
      <p className="text-xs mt-1 text-slate-400">New ideas land every Monday from the weekly DataForSEO research run.</p>
    </div>
  );
}
