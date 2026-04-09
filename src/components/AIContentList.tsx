import { useState, useMemo } from "react";
import type { AIContentItem, ContentType } from "../data";
import { US_STATES } from "../data";
import { cn } from "../utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Plus,
  Sparkles,
  Trash2,
  ExternalLink,
  X,
  ChevronRight,
  Zap,
} from "lucide-react";

const statusColors: Record<string, string> = {
  queued: "bg-blue-50 text-blue-700 border-blue-200",
  generating: "bg-indigo-50 text-indigo-700 border-indigo-200",
  draft: "bg-amber-50 text-amber-700 border-amber-200",
  published: "bg-green-50 text-green-700 border-green-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

const typeColors: Record<string, string> = {
  spoke: "bg-slate-100 text-slate-700 border-slate-200",
  pillar: "bg-indigo-50 text-indigo-700 border-indigo-200",
  comparison: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

interface AIContentListProps {
  items: AIContentItem[];
  pillars: AIContentItem[];
  onSelect: (item: AIContentItem) => void;
  onCreate: (data: { type: string; keyword: string; state?: string; pillarId?: string }) => void;
  onDelete: (id: string) => void;
  onBulkDelete: (ids: string[]) => void;
  onGenerate: (id: string) => void;
  onBulkGenerate: (ids: string[]) => void;
}

export default function AIContentList({
  items,
  pillars,
  onSelect,
  onCreate,
  onDelete,
  onBulkDelete,
  onGenerate,
  onBulkGenerate,
}: AIContentListProps) {
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterState, setFilterState] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);

  // Add form state
  const [newType, setNewType] = useState<ContentType>("spoke");
  const [newKeyword, setNewKeyword] = useState("");
  const [newState, setNewState] = useState("");
  const [newPillarId, setNewPillarId] = useState("");

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (search) {
        const q = search.toLowerCase();
        const matches =
          item.keyword.toLowerCase().includes(q) ||
          item.title?.toLowerCase().includes(q) ||
          item.state?.toLowerCase().includes(q);
        if (!matches) return false;
      }
      if (filterType && item.type !== filterType) return false;
      if (filterStatus && item.status !== filterStatus) return false;
      if (filterState && item.state !== filterState) return false;
      return true;
    });
  }, [items, search, filterType, filterStatus, filterState]);

  const uniqueStates = useMemo(() => {
    const states = new Set(items.map((i) => i.state).filter(Boolean));
    return Array.from(states).sort();
  }, [items]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleAdd = () => {
    if (!newKeyword.trim()) return;
    onCreate({
      type: newType,
      keyword: newKeyword.trim(),
      state: newState || undefined,
      pillarId: newPillarId || undefined,
    });
    setNewKeyword("");
    setNewState("");
    setNewPillarId("");
    setShowAddForm(false);
  };

  const queuedSelected = selectedIds.filter((id) => {
    const item = items.find((i) => i.id === id);
    return item && (item.status === "queued" || item.status === "failed");
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">
            AI Content
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            {items.length} article{items.length !== 1 ? "s" : ""} total
          </p>
        </div>
        <div className="flex items-center gap-3">
          {queuedSelected.length > 0 && (
            <motion.button
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={() => {
                onBulkGenerate(queuedSelected);
                setSelectedIds([]);
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm"
            >
              <Zap className="h-4 w-4" />
              Generate {queuedSelected.length} Selected
            </motion.button>
          )}
          {selectedIds.length > 0 && (
            <motion.button
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={() => {
                onBulkDelete(selectedIds);
                setSelectedIds([]);
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
              Delete {selectedIds.length}
            </motion.button>
          )}
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <Plus className="h-4 w-4" />
            Add Keyword
          </button>
        </div>
      </div>

      {/* Add Form */}
      <AnimatePresence>
        {showAddForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-900">Add New Keyword</h3>
                <button onClick={() => setShowAddForm(false)} className="text-slate-400 hover:text-slate-600">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Keyword *</label>
                  <input
                    type="text"
                    value={newKeyword}
                    onChange={(e) => setNewKeyword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                    placeholder="SWPPP requirements Texas"
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Type *</label>
                  <select
                    value={newType}
                    onChange={(e) => setNewType(e.target.value as ContentType)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                  >
                    <option value="spoke">Spoke (1,000-1,500 words)</option>
                    <option value="pillar">Pillar (~3,500 words)</option>
                    <option value="comparison">Comparison (1,500-2,000 words)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    State {newType === "pillar" ? "*" : ""}
                  </label>
                  <select
                    value={newState}
                    onChange={(e) => setNewState(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                  >
                    <option value="">Select state...</option>
                    {US_STATES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                {newType === "spoke" && (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Pillar Article</label>
                    <select
                      value={newPillarId}
                      onChange={(e) => setNewPillarId(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                    >
                      <option value="">No pillar (standalone)</option>
                      {pillars.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.state ? `${p.state} — ` : ""}{p.keyword}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleAdd}
                  disabled={!newKeyword.trim() || (newType === "pillar" && !newState)}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                  <Plus className="h-4 w-4" />
                  Add to Queue
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {filtered.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filtered.length > 0 && filtered.every((i) => selectedIds.includes(i.id))}
              onChange={() => {
                const allFilteredIds = filtered.map((i) => i.id);
                const allSelected = allFilteredIds.every((id) => selectedIds.includes(id));
                setSelectedIds(allSelected ? selectedIds.filter((id) => !allFilteredIds.includes(id)) : [...new Set([...selectedIds, ...allFilteredIds])]);
              }}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            All
          </label>
        )}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search keywords, titles..."
            className="w-full pl-9 pr-8 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All Types</option>
          <option value="spoke">Spoke</option>
          <option value="pillar">Pillar</option>
          <option value="comparison">Comparison</option>
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All Statuses</option>
          <option value="queued">Queued</option>
          <option value="generating">Generating</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="failed">Failed</option>
        </select>
        {uniqueStates.length > 0 && (
          <select
            value={filterState}
            onChange={(e) => setFilterState(e.target.value)}
            className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">All States</option>
            {uniqueStates.map((s) => (
              <option key={s} value={s!}>{s}</option>
            ))}
          </select>
        )}
      </div>

      {/* List */}
      <div className="grid grid-cols-1 gap-4">
        <AnimatePresence mode="popLayout">
          {filtered.map((item) => (
            <motion.div
              layout
              key={item.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
              className={cn(
                "group relative bg-white rounded-3xl border transition-all duration-300 cursor-pointer overflow-hidden p-1",
                selectedIds.includes(item.id)
                  ? "border-indigo-500 shadow-indigo-100 shadow-lg ring-1 ring-indigo-500"
                  : "border-slate-200 shadow-sm hover:shadow-xl hover:shadow-indigo-500/5 hover:-translate-y-0.5"
              )}
            >
              {/* Selection checkbox */}
              <div
                className={cn(
                  "absolute top-4 left-4 z-10 transition-opacity duration-200",
                  selectedIds.includes(item.id) ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(item.id)}
                  onChange={(e) => {
                    e.stopPropagation();
                    toggleSelect(item.id);
                  }}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
              </div>

              <div
                className="bg-white rounded-[1.4rem] p-6"
                onClick={() => onSelect(item)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4 pl-6">
                    <div className={cn(
                      "h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0",
                      item.type === "pillar" ? "bg-indigo-100 text-indigo-600" :
                      item.type === "comparison" ? "bg-emerald-100 text-emerald-600" :
                      "bg-slate-100 text-slate-600"
                    )}>
                      <Sparkles className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base font-bold text-slate-900 truncate">
                        {item.title || item.keyword}
                      </h3>
                      {item.title && (
                        <p className="text-sm text-slate-500 mt-0.5 truncate">{item.keyword}</p>
                      )}
                      <div className="flex items-center gap-2 mt-2">
                        <span className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                          typeColors[item.type]
                        )}>
                          {item.type}
                        </span>
                        <span className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                          statusColors[item.status]
                        )}>
                          {item.status === "generating" && (
                            <span className="inline-block h-2 w-2 rounded-full bg-indigo-500 animate-pulse mr-1.5" />
                          )}
                          {item.status}
                        </span>
                        {item.state && (
                          <span className="text-xs text-slate-500">{item.state}</span>
                        )}
                        {item.wordCount && (
                          <span className="text-xs text-slate-400">{item.wordCount.toLocaleString()} words</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.status === "queued" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onGenerate(item.id); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <Zap className="h-3 w-3" />
                        Generate
                      </button>
                    )}
                    {item.status === "failed" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onGenerate(item.id); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors"
                      >
                        <Zap className="h-3 w-3" />
                        Retry
                      </button>
                    )}
                    {item.wordpressUrl && (
                      <a
                        href={item.wordpressUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition-colors"
                      >
                        <ExternalLink className="h-3 w-3" />
                        WP Draft
                      </a>
                    )}
                    <ChevronRight className="h-5 w-5 text-slate-300 group-hover:text-slate-500 transition-colors" />
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-slate-50 flex items-center justify-between text-sm">
                  <span className="text-slate-400 text-xs">
                    Added {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                  {item.generatedAt && (
                    <span className="text-slate-400 text-xs">
                      Generated {new Date(item.generatedAt).toLocaleDateString()}
                    </span>
                  )}
                  {item.errorMessage && (
                    <span className="text-red-500 text-xs truncate max-w-[300px]">
                      {item.errorMessage}
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {filtered.length === 0 && (
          <div className="text-center py-16 text-slate-400">
            <Sparkles className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p className="text-lg font-medium">No content items yet</p>
            <p className="text-sm mt-1">Click "Add Keyword" to queue your first article</p>
          </div>
        )}
      </div>
    </div>
  );
}
