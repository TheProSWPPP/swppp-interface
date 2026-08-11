import { useState, useEffect, useCallback } from "react";
import type { AIContentItem } from "../data";
import { US_STATES, NATIONWIDE } from "../data";
import AIContentList from "./AIContentList";
import AIContentDetail from "./AIContentDetail";
import SeoIdeas from "./SeoIdeas";
import { useToasts, ToastStack } from "./Toast";
import { StatCardsSkeleton, ListRowsSkeleton, Skeleton } from "./Skeleton";
import {
  AlertCircle,
  RotateCcw,
  ListOrdered,
  Loader2,
  FileEdit,
  CheckCircle2,
  AlertTriangle,
  Map,
  Sparkles,
} from "lucide-react";
import { cn } from "../utils";

interface Stats {
  queued: number;
  generating: number;
  draft: number;
  published: number;
  failed: number;
  spoke: number;
  pillar: number;
  comparison: number;
  states: Record<string, { pillar: number; spoke: number; comparison: number; total: number }>;
}

type ViewMode = "states" | "list" | "ideas";

export default function AIContent() {
  const [items, setItems] = useState<AIContentItem[]>([]);
  const [stats, setStats] = useState<Stats>({
    queued: 0, generating: 0, draft: 0, published: 0, failed: 0,
    spoke: 0, pillar: 0, comparison: 0, states: {},
  });
  const [selectedItem, setSelectedItem] = useState<AIContentItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const { toasts, push, dismiss } = useToasts();

  const fetchData = useCallback(async () => {
    try {
      const [itemsRes, statsRes] = await Promise.all([
        fetch("/api/ai-content", { credentials: "include" }),
        fetch("/api/ai-content/stats", { credentials: "include" }),
      ]);
      if (!itemsRes.ok || !statsRes.ok)
        throw new Error(`HTTP ${itemsRes.status}/${statsRes.status}`);
      const itemsData = await itemsRes.json();
      const statsData = await statsRes.json();
      setItems(Array.isArray(itemsData) ? itemsData : []);
      setStats(statsData);
      setLoadError(false);
      if (selectedItem) {
        const updated = itemsData.find((i: AIContentItem) => i.id === selectedItem.id);
        if (updated) setSelectedItem(updated);
      }
    } catch (err) {
      console.error("Failed to fetch AI content:", err);
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, [selectedItem]);

  useEffect(() => {
    fetchData().then(() => {
      // Sync from WP on load — catches new publishes, status changes, trashed posts
      handleImportWP();
    });
    // Re-sync every 5 minutes to catch WP changes
    const syncInterval = setInterval(handleImportWP, 5 * 60 * 1000);
    return () => clearInterval(syncInterval);
  }, []);

  useEffect(() => {
    const hasGenerating = items.some((i) => i.status === "generating");
    if (!hasGenerating) return;
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [items, fetchData]);

  const handleImportWP = async () => {
    try {
      await fetch("/api/ai-content/import-wp", { method: "POST", credentials: "include" });
      await fetchData();
    } catch (err) {
      console.error("WP sync failed:", err);
    }
  };

  const handleCreate = async (data: { type: string; keyword?: string; state?: string; pillarId?: string }) => {
    try {
      const res = await fetch("/api/ai-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (res.status === 409) {
        const err = await res.json();
        const existing = items.find((i) => i.id === err.existingId);
        const existingLabel = existing ? `"${existing.title || existing.keyword}" (${existing.status})` : "an existing pillar";
        const confirmed = window.confirm(
          `${data.state} already has a pillar: ${existingLabel}.\n\nCreate another pillar anyway? You can clean up the old one later.`
        );
        if (!confirmed) return;
        const retry = await fetch("/api/ai-content", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ...data, force: true }),
        });
        if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
        await fetchData();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchData();
    } catch (err) {
      console.error("Failed to create content:", err);
      push("error", "Couldn't create that content item. Please try again.");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/ai-content/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (selectedItem?.id === id) setSelectedItem(null);
      await fetchData();
    } catch (err) {
      console.error("Failed to delete content:", err);
      push("error", "Couldn't delete that article. Please try again.");
    }
  };

  const handleBulkDelete = async (ids: string[]) => {
    try {
      const res = await fetch("/api/ai-content/delete-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (selectedItem && ids.includes(selectedItem.id)) setSelectedItem(null);
      await fetchData();
    } catch (err) {
      console.error("Failed to bulk delete:", err);
      push("error", `Couldn't delete the selected article${ids.length === 1 ? "" : "s"}. Please try again.`);
    }
  };

  const handleGenerate = async (id: string) => {
    try {
      const res = await fetch(`/api/ai-content/${id}/generate`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      push("success", "Generation started — this can take a few minutes.");
      await fetchData();
    } catch (err) {
      console.error("Failed to trigger generation:", err);
      push("error", "Couldn't start generation. Check your connection and try again.");
    }
  };

  const handleBulkGenerate = async (ids: string[]) => {
    try {
      const res = await fetch("/api/ai-content/generate-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      push("success", `Generation started for ${ids.length} article${ids.length === 1 ? "" : "s"} — this can take a few minutes.`);
      await fetchData();
    } catch (err) {
      console.error("Failed to bulk generate:", err);
      push("error", "Couldn't start generation for the selected articles. Please try again.");
    }
  };

  const handleUpdate = async (id: string, data: Partial<AIContentItem>) => {
    try {
      const res = await fetch(`/api/ai-content/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchData();
    } catch (err) {
      console.error("Failed to update:", err);
      push("error", "Couldn't save your changes — they may not have persisted. Please try again.");
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <StatCardsSkeleton count={5} />
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-64 rounded-xl" />
          <Skeleton className="h-8 w-20 rounded-lg" />
        </div>
        <ListRowsSkeleton rows={4} />
      </div>
    );
  }

  if (loadError && items.length === 0 && !selectedItem) {
    return (
      <>
        <div className="flex flex-col items-center justify-center text-center py-20">
          <div className="h-12 w-12 rounded-full bg-red-50 flex items-center justify-center text-red-500 mb-4">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-bold text-slate-900">
            Couldn't load AI content
          </h3>
          <p className="mt-1 max-w-sm text-sm text-slate-500">
            The content library didn't come back from the server. This is a
            connection issue, not lost data.
          </p>
          <button
            onClick={() => {
              setIsLoading(true);
              fetchData();
            }}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1 transition-colors"
          >
            <RotateCcw className="h-4 w-4" />
            Retry
          </button>
        </div>
        <ToastStack toasts={toasts} dismiss={dismiss} />
      </>
    );
  }

  const pillars = items.filter((i) => i.type === "pillar");
  const statesWithPillar = new Set(pillars.map((p) => p.state).filter(Boolean));

  // Filter items by status or state
  const filteredItems = statusFilter
    ? statusFilter.startsWith("state:")
      ? items.filter((i) => i.state === statusFilter.slice(6))
      : items.filter((i) => i.status === statusFilter)
    : items;

  if (selectedItem) {
    return (
      <div className="space-y-8">
        <AIContentDetail
          item={selectedItem}
          allItems={items}
          onBack={() => setSelectedItem(null)}
          onGenerate={handleGenerate}
          onDelete={handleDelete}
          onUpdate={handleUpdate}
        />
        <ToastStack toasts={toasts} dismiss={dismiss} />
      </div>
    );
  }

  const statCards = [
    { key: "queued", label: "Queued", icon: ListOrdered, color: "blue", count: stats.queued, spin: false },
    { key: "generating", label: "Generating", icon: Loader2, color: "indigo", count: stats.generating, spin: true },
    { key: "draft", label: "Drafts", icon: FileEdit, color: "amber", count: stats.draft, spin: false },
    { key: "published", label: "Published", icon: CheckCircle2, color: "green", count: stats.published, spin: false },
    { key: "failed", label: "Failed", icon: AlertTriangle, color: "red", count: stats.failed, spin: false },
  ] as const;

  const colorMap: Record<string, { bg: string; text: string }> = {
    blue: { bg: "bg-blue-50", text: "text-blue-600" },
    indigo: { bg: "bg-brand-50", text: "text-brand-600" },
    amber: { bg: "bg-amber-50", text: "text-amber-600" },
    green: { bg: "bg-green-50", text: "text-green-600" },
    red: { bg: "bg-red-50", text: "text-red-600" },
  };

  return (
    <div className="space-y-6">
      {/* Stat Cards — clickable */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {statCards.map((card) => (
          <button
            key={card.key}
            onClick={() => {
              if (statusFilter === card.key) {
                setStatusFilter("");
              } else {
                setStatusFilter(card.key);
                setViewMode("list");
              }
            }}
            className={cn(
              "bg-white overflow-hidden rounded-xl border shadow-sm p-4 flex items-center gap-3 transition-all duration-200 text-left",
              statusFilter === card.key
                ? "border-brand-500 ring-1 ring-brand-500 shadow-brand-100"
                : "border-gray-200 hover:shadow-md hover:-translate-y-0.5"
            )}
          >
            <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center", colorMap[card.color].bg, colorMap[card.color].text)}>
              <card.icon className={cn("h-5 w-5", card.spin && card.count > 0 && "animate-spin")} />
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500">{card.label}</p>
              <p className="text-xl font-semibold text-gray-900">{card.count}</p>
            </div>
          </button>
        ))}
      </div>

      {/* View Toggle + Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
          <button
            onClick={() => { setViewMode("states"); setStatusFilter(""); }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all",
              viewMode === "states" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            )}
          >
            <Map className="h-4 w-4" />
            States
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all",
              viewMode === "list" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            )}
          >
            <ListOrdered className="h-4 w-4" />
            All Articles
          </button>
          <button
            onClick={() => { setViewMode("ideas"); setStatusFilter(""); }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all",
              viewMode === "ideas" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            )}
          >
            <Sparkles className="h-4 w-4" />
            Ideas
          </button>
        </div>

        <div className="flex items-center gap-2">
          {statusFilter && (
            <button
              onClick={() => setStatusFilter("")}
              className="text-xs text-slate-500 hover:text-slate-700 underline"
            >
              Clear filter
            </button>
          )}
        </div>
      </div>

      {/* State Dashboard */}
      {viewMode === "states" && !statusFilter && (
        <StatesDashboard
          stats={stats}
          items={items}
          statesWithPillar={statesWithPillar}
          onSelectState={(state) => {
            setViewMode("list");
            // The list will filter by state
            setStatusFilter(`state:${state}`);
          }}
          onCreate={handleCreate}
          onGenerate={handleGenerate}
        />
      )}

      {/* Article List */}
      {viewMode !== "ideas" && (viewMode === "list" || statusFilter) && (
        <AIContentList
          items={filteredItems}
          allItems={items}
          statesWithPillar={statesWithPillar}
          statusFilter={statusFilter}
          onSelect={setSelectedItem}
          onCreate={handleCreate}
          onBulkDelete={handleBulkDelete}
          onGenerate={handleGenerate}
          onBulkGenerate={handleBulkGenerate}
        />
      )}

      {/* SEO Ideas (Phase 5) */}
      {viewMode === "ideas" && <SeoIdeas onConverted={fetchData} />}

      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

// ============================================================
// State Dashboard Grid
// ============================================================
function StatesDashboard({
  items,
  onSelectState,
}: {
  stats: Stats;
  items: AIContentItem[];
  statesWithPillar: Set<string | undefined>;
  onSelectState: (state: string) => void;
  onCreate: (data: { type: string; state: string }) => void;
  onGenerate: (id: string) => void;
}) {
  // Group items by state
  const stateData: Record<string, { pillar: AIContentItem | null; spokes: number; comparisons: number; total: number }> = {};

  for (const state of US_STATES) {
    const stateItems = items.filter((i) => i.state === state);
    const pillar = stateItems.find((i) => i.type === "pillar") || null;
    stateData[state] = {
      pillar,
      spokes: stateItems.filter((i) => i.type === "spoke").length,
      comparisons: stateItems.filter((i) => i.type === "comparison").length,
      total: stateItems.length,
    };
  }

  // Nationwide is a scope, not a state — tracked separately so it never skews coverage stats
  const nationwideItems = items.filter((i) => i.state === NATIONWIDE);
  const nationwide = {
    pillar: nationwideItems.find((i) => i.type === "pillar") || null,
    spokes: nationwideItems.filter((i) => i.type === "spoke").length,
    comparisons: nationwideItems.filter((i) => i.type === "comparison").length,
    total: nationwideItems.length,
  };

  const statesWithContent = US_STATES.filter((s) => stateData[s].total > 0);
  const statesWithoutContent = US_STATES.filter((s) => stateData[s].total === 0);
  const statesNeedingPillar = US_STATES.filter((s) => stateData[s].total > 0 && !stateData[s].pillar);

  // Duplicates: states with multiple pillar-like articles
  const duplicateStates = statesWithContent.filter((s) => {
    const stateItems = items.filter((i) => i.state === s && i.type === "pillar");
    return stateItems.length > 1;
  });

  return (
    <div className="space-y-6">
      {/* Summary row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-green-50 rounded-xl border border-green-200 p-4">
          <p className="text-xs font-medium text-green-600">States with Pillar</p>
          <p className="text-2xl font-bold text-green-900">{US_STATES.filter((s) => stateData[s].pillar).length}</p>
        </div>
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-4">
          <p className="text-xs font-medium text-amber-600">Need Pillar</p>
          <p className="text-2xl font-bold text-amber-900">{statesNeedingPillar.length}</p>
        </div>
        <div className="bg-red-50 rounded-xl border border-red-200 p-4">
          <p className="text-xs font-medium text-red-600">No Content</p>
          <p className="text-2xl font-bold text-red-900">{statesWithoutContent.length}</p>
        </div>
        <div className="bg-brand-50 rounded-xl border border-brand-200 p-4">
          <p className="text-xs font-medium text-brand-600">Total Articles</p>
          <p className="text-2xl font-bold text-brand-900">{items.length}</p>
        </div>
      </div>

      {/* Duplicate warning */}
      {duplicateStates.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-900">Duplicate Pillars Detected</p>
            <p className="text-sm text-amber-700 mt-0.5">
              {duplicateStates.join(", ")} — have multiple pillar articles. Consider consolidating.
            </p>
          </div>
        </div>
      )}

      {/* Nationwide (not a state — generalized articles) */}
      <button
        onClick={() => onSelectState(NATIONWIDE)}
        className="w-full rounded-xl border border-brand-200 bg-brand-50 p-4 text-left transition-all duration-200 hover:border-brand-400 hover:shadow-md"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-brand-900">Nationwide</p>
            <p className="text-xs text-brand-600 mt-0.5">Generalized articles — not tied to one state</p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {nationwide.pillar && <span className="font-semibold text-brand-700">Pillar</span>}
            <span className="text-slate-500">{nationwide.spokes} article{nationwide.spokes !== 1 ? "s" : ""}</span>
            {nationwide.comparisons > 0 && (
              <span className="text-emerald-600">{nationwide.comparisons} comparison{nationwide.comparisons !== 1 ? "s" : ""}</span>
            )}
          </div>
        </div>
      </button>

      {/* State Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2">
        {US_STATES.map((state) => {
          const data = stateData[state];
          const hasPillar = !!data.pillar;
          const hasContent = data.total > 0;

          return (
            <button
              key={state}
              onClick={() => onSelectState(state)}
              className={cn(
                "relative rounded-xl border p-3 text-left transition-all duration-200 hover:shadow-md hover:-translate-y-0.5",
                hasPillar
                  ? "bg-green-50 border-green-200 hover:border-green-400"
                  : hasContent
                    ? "bg-amber-50 border-amber-200 hover:border-amber-400"
                    : "bg-white border-slate-200 hover:border-slate-400"
              )}
            >
              <p className={cn(
                "text-xs font-bold truncate",
                hasPillar ? "text-green-900" : hasContent ? "text-amber-900" : "text-slate-400"
              )}>
                {state}
              </p>
              {hasContent ? (
                <div className="mt-1.5 space-y-0.5">
                  {hasPillar && (
                    <p className="text-[10px] font-semibold text-green-600">Pillar</p>
                  )}
                  {data.spokes > 0 && (
                    <p className="text-[10px] text-slate-500">{data.spokes} article{data.spokes !== 1 ? "s" : ""}</p>
                  )}
                  {data.comparisons > 0 && (
                    <p className="text-[10px] text-emerald-600">{data.comparisons} comparison{data.comparisons !== 1 ? "s" : ""}</p>
                  )}
                </div>
              ) : (
                <p className="text-[10px] text-slate-300 mt-1.5">No content</p>
              )}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-green-100 border border-green-300" /> Has Pillar</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-amber-100 border border-amber-300" /> Articles, No Pillar</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-white border border-slate-300" /> No Content</span>
      </div>
    </div>
  );
}
