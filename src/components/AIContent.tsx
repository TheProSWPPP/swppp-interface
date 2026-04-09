import { useState, useEffect, useCallback } from "react";
import type { AIContentItem } from "../data";
import AIContentList from "./AIContentList";
import AIContentDetail from "./AIContentDetail";
import {
  ListOrdered,
  Loader2,
  FileEdit,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
} from "lucide-react";

interface Stats {
  queued: number;
  generating: number;
  draft: number;
  published: number;
  failed: number;
  spoke: number;
  pillar: number;
  comparison: number;
}

export default function AIContent() {
  const [items, setItems] = useState<AIContentItem[]>([]);
  const [stats, setStats] = useState<Stats>({
    queued: 0, generating: 0, draft: 0, published: 0, failed: 0,
    spoke: 0, pillar: 0, comparison: 0,
  });
  const [selectedItem, setSelectedItem] = useState<AIContentItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
      // Update selected item if it changed
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
    fetchData();
  }, []);

  // Poll when items are generating
  useEffect(() => {
    const hasGenerating = items.some((i) => i.status === "generating");
    if (!hasGenerating) return;

    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [items, fetchData]);

  const handleCreate = async (data: { type: string; keyword: string; state?: string; pillarId?: string }) => {
    try {
      const res = await fetch("/api/ai-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
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
      console.error("Failed to bulk delete content:", err);
    }
  };

  const handleGenerate = async (id: string) => {
    try {
      await fetch(`/api/ai-content/${id}/generate`, {
        method: "POST",
        credentials: "include",
      });
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
      console.error("Failed to trigger bulk generation:", err);
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
      console.error("Failed to update content:", err);
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

  return (
    <div className="space-y-8">
      {!selectedItem && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="bg-white overflow-hidden rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
              <ListOrdered className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Queued</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.queued}</p>
            </div>
          </div>
          <div className="bg-white overflow-hidden rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Generating</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.generating}</p>
            </div>
          </div>
          <div className="bg-white overflow-hidden rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-amber-50 flex items-center justify-center text-amber-600">
              <FileEdit className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Drafts</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.draft}</p>
            </div>
          </div>
          <div className="bg-white overflow-hidden rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-green-50 flex items-center justify-center text-green-600">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Published</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.published}</p>
            </div>
          </div>
          <div className="bg-white overflow-hidden rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-red-50 flex items-center justify-center text-red-600">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Failed</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.failed}</p>
            </div>
          </div>
        </div>
      )}

      {selectedItem ? (
        <AIContentDetail
          item={selectedItem}
          allItems={items}
          onBack={() => setSelectedItem(null)}
          onGenerate={handleGenerate}
          onDelete={handleDelete}
          onUpdate={handleUpdate}
        />
      ) : (
        <AIContentList
          items={items}
          pillars={pillars}
          onSelect={setSelectedItem}
          onCreate={handleCreate}
          onDelete={handleDelete}
          onBulkDelete={handleBulkDelete}
          onGenerate={handleGenerate}
          onBulkGenerate={handleBulkGenerate}
        />
      )}
    </div>
  );
}
