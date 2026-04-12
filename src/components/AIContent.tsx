import { useState, useEffect, useCallback } from "react";
import type { AIContentItem } from "../data";
import { US_STATES } from "../data";
import AIContentList from "./AIContentList";
import AIContentDetail from "./AIContentDetail";
import {
  ListOrdered,
  Loader2,
  FileEdit,
  CheckCircle2,
  AlertTriangle,
  Map,
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

type ViewMode = "states" | "list";

export default function AIContent() {
  const [items, setItems] = useState<AIContentItem[]>([]);
  const [stats, setStats] = useState<Stats>({
    queued: 0, generating: 0, draft: 0, published: 0, failed: 0,
    spoke: 0, pillar: 0, comparison: 0, states: {},
  });
  const [selectedItem, setSelectedItem] = useState<AIContentItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("states");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [importing, setImporting] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [itemsRes, statsRes] = await Promise.all([
        fetch("/api/ai-content", { credentials: "include" }),
        fetch("/api/ai-content/stats", { credentials: "include" }),
      ]);
      const itemsData = await itemsRes.json();
      const statsData = await statsRes.json();
      setItems(itemsData);
      setStats(statsData);
      if (selectedItem) {
        const updated = itemsData.find((i: AIContentItem) => i.id === selectedItem.id);
        if (updated) setSelectedItem(updated);
      }
    } catch (err) {
      console.error("Failed to fetch AI content:", err);
    } finally {
      setIsLoading(false);
    }
  }, [selectedItem]);

  useEffect(() => {
    fetchData().then(() => {
      // Auto-sync from WP on first load if no published items exist
      fetch("/api/ai-content/stats", { credentials: "include" })
        .then((r) => r.json())
        .then((s) => {
          if (s.published === 0 && !importing) {
            handleImportWP();
          }
        });
    });
  }, []);

  useEffect(() => {
    const hasGenerating = items.some((i) => i.status === "generating");
    if (!hasGenerating) return;
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [items, fetchData]);

  const handleImportWP = async () => {
    setImporting(true);
    try {
      const res = await fetch("/api/ai-content/import-wp", { method: "POST", credentials: "include" });
      const data = await res.json();
      alert(`Imported ${data.imported} articles (${data.skipped} already existed)`);
      await fetchData();
    } catch (err) {
      console.error("Import failed:", err);
    } finally {
      setImporting(false);
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
        alert(err.error);
        return;
      }
      if (res.ok) await fetchData();
    } catch (err) {
      console.error("Failed to create content:", err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/ai-content/${id}`, { method: "DELETE", credentials: "include" });
      if (selectedItem?.id === id) setSelectedItem(null);
      await fetchData();
    } catch (err) {
      console.error("Failed to delete content:", err);
    }
  };

  const handleBulkDelete = async (ids: string[]) => {
    try {
      await fetch("/api/ai-content/delete-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
      if (selectedItem && ids.includes(selectedItem.id)) setSelectedItem(null);
      await fetchData();
    } catch (err) {
      console.error("Failed to bulk delete:", err);
    }
  };

  const handleGenerate = async (id: string) => {
    try {
      await fetch(`/api/ai-content/${id}/generate`, { method: "POST", credentials: "include" });
      await fetchData();
    } catch (err) {
      console.error("Failed to trigger generation:", err);
    }
  };

  const handleBulkGenerate = async (ids: string[]) => {
    try {
      await fetch("/api/ai-content/generate-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
      await fetchData();
    } catch (err) {
      console.error("Failed to bulk generate:", err);
    }
  };

  const handleUpdate = async (id: string, data: Partial<AIContentItem>) => {
    try {
      await fetch(`/api/ai-content/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      await fetchData();
    } catch (err) {
      console.error("Failed to update:", err);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500">
        Loading AI content...
      </div>
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
    indigo: { bg: "bg-indigo-50", text: "text-indigo-600" },
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
                ? "border-indigo-500 ring-1 ring-indigo-500 shadow-indigo-100"
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
      {(viewMode === "list" || statusFilter) && (
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
        <div className="bg-indigo-50 rounded-xl border border-indigo-200 p-4">
          <p className="text-xs font-medium text-indigo-600">Total Articles</p>
          <p className="text-2xl font-bold text-indigo-900">{items.length}</p>
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
