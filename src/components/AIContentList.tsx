import { useState, useMemo } from "react";
import type { AIContentItem, ContentType } from "../data";
import { US_STATES } from "../data";
import { cn } from "../utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Plus,
  Trash2,
  ExternalLink,
  X,
  PlayCircle,
  ArrowUpDown,
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
  allItems: AIContentItem[];
  statesWithPillar: Set<string | undefined>;
  statusFilter: string;
  onSelect: (item: AIContentItem) => void;
  onCreate: (data: { type: string; keyword?: string; state?: string; pillarId?: string }) => void;
  onBulkDelete: (ids: string[]) => void;
  onGenerate: (id: string) => void;
  onBulkGenerate: (ids: string[]) => void;
}

type SortKey = "keyword" | "type" | "state" | "status" | "wordCount" | "createdAt";
type SortDir = "asc" | "desc";

export default function AIContentList({
  items,
  allItems,
  statesWithPillar,
  statusFilter,
  onSelect,
  onCreate,
  onBulkDelete,
  onGenerate,
  onBulkGenerate,
}: AIContentListProps) {
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterState, setFilterState] = useState<string>(
    statusFilter.startsWith("state:") ? statusFilter.slice(6) : ""
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Add form
  const [newType, setNewType] = useState<ContentType>("spoke");
  const [newKeyword, setNewKeyword] = useState("");
  const [newState, setNewState] = useState("");

  const filtered = useMemo(() => {
    let result = items.filter((item) => {
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

    // Sort
    result.sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortKey) {
        case "keyword": aVal = (a.title || a.keyword).toLowerCase(); bVal = (b.title || b.keyword).toLowerCase(); break;
        case "type": aVal = a.type; bVal = b.type; break;
        case "state": aVal = a.state || ""; bVal = b.state || ""; break;
        case "status": aVal = a.status; bVal = b.status; break;
        case "wordCount": aVal = a.wordCount || 0; bVal = b.wordCount || 0; break;
        case "createdAt": aVal = a.createdAt; bVal = b.createdAt; break;
      }
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return result;
  }, [items, search, filterType, filterStatus, filterState, sortKey, sortDir]);

  const uniqueStates = useMemo(() => {
    const states = new Set(allItems.map((i) => i.state).filter(Boolean));
    return Array.from(states).sort();
  }, [allItems]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((i) => selectedIds.includes(i.id));
  const toggleAll = () => {
    const ids = filtered.map((i) => i.id);
    setSelectedIds(allFilteredSelected ? selectedIds.filter((id) => !ids.includes(id)) : [...new Set([...selectedIds, ...ids])]);
  };

  const handleAdd = () => {
    if (newType === "pillar") {
      if (!newState) return;
      onCreate({ type: "pillar", state: newState });
    } else {
      if (!newKeyword.trim()) return;
      onCreate({ type: newType, keyword: newKeyword.trim(), state: newState || undefined });
    }
    setNewKeyword("");
    setNewState("");
    setShowAddForm(false);
  };

  const queuedSelected = selectedIds.filter((id) => {
    const item = allItems.find((i) => i.id === id);
    return item && (item.status === "queued" || item.status === "failed");
  });

  const SortHeader = ({ label, field }: { label: string; field: SortKey }) => (
    <button onClick={() => toggleSort(field)} className="flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700 uppercase tracking-wider">
      {label}
      {sortKey === field && <ArrowUpDown className="h-3 w-3 text-indigo-500" />}
    </button>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {filtered.length} article{filtered.length !== 1 ? "s" : ""}
          {filterState && ` in ${filterState}`}
          {statusFilter && !statusFilter.startsWith("state:") && ` — ${statusFilter}`}
        </p>
        <div className="flex items-center gap-2">
          {queuedSelected.length > 0 && (
            <button
              onClick={() => { onBulkGenerate(queuedSelected); setSelectedIds([]); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
            >
              <PlayCircle className="h-4 w-4" />
              Generate {queuedSelected.length} {queuedSelected.length === 1 ? "article" : "articles"}
            </button>
          )}
          {selectedIds.length > 0 && (
            <button
              onClick={() => { onBulkDelete(selectedIds); setSelectedIds([]); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete {selectedIds.length}
            </button>
          )}
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
        </div>
      </div>

      {/* Add Form */}
      <AnimatePresence>
        {showAddForm && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <div className="flex items-end gap-3">
                <div className="w-36">
                  <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
                  <select value={newType} onChange={(e) => setNewType(e.target.value as ContentType)} className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white">
                    <option value="spoke">Spoke</option>
                    <option value="pillar">Pillar</option>
                    <option value="comparison">Comparison</option>
                  </select>
                </div>
                {newType !== "pillar" && (
                  <div className="flex-1">
                    <label className="block text-xs font-medium text-slate-600 mb-1">Keyword</label>
                    <input
                      type="text" value={newKeyword} onChange={(e) => setNewKeyword(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                      placeholder={newType === "comparison" ? "Best SWPPP Services in Texas 2026" : "SWPPP requirements for..."}
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm"
                    />
                  </div>
                )}
                <div className="w-40">
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    State{newType === "pillar" ? " *" : ""}
                  </label>
                  <select value={newState} onChange={(e) => setNewState(e.target.value)} className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white">
                    <option value="">Select...</option>
                    {US_STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}{newType === "pillar" && statesWithPillar.has(s) ? " (has pillar)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <button onClick={handleAdd} disabled={newType === "pillar" ? !newState : !newKeyword.trim()} className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 transition-colors">
                  Add
                </button>
                <button onClick={() => setShowAddForm(false)} className="text-slate-400 hover:text-slate-600 p-1">
                  <X className="h-4 w-4" />
                </button>
              </div>
              {newType === "pillar" && newState && (
                <p className="text-xs text-slate-400 mt-2">Will create: "Construction & Industrial SWPPP Requirements in {newState}"</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..."
            className="w-full pl-8 pr-7 py-1.5 rounded-lg border border-slate-200 text-sm" />
          {search && <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400"><X className="h-3.5 w-3.5" /></button>}
        </div>
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white">
          <option value="">All Types</option>
          <option value="spoke">Spoke</option>
          <option value="pillar">Pillar</option>
          <option value="comparison">Comparison</option>
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white">
          <option value="">All Status</option>
          <option value="queued">Queued</option>
          <option value="generating">Generating</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="failed">Failed</option>
        </select>
        {uniqueStates.length > 0 && (
          <select value={filterState} onChange={(e) => setFilterState(e.target.value)} className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white">
            <option value="">All States</option>
            {uniqueStates.map((s) => <option key={s} value={s!}>{s}</option>)}
          </select>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="w-10 p-3">
                <input type="checkbox" checked={allFilteredSelected && filtered.length > 0} onChange={toggleAll}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600" />
              </th>
              <th className="text-left p-3"><SortHeader label="Title / Keyword" field="keyword" /></th>
              <th className="text-left p-3 w-24"><SortHeader label="Type" field="type" /></th>
              <th className="text-left p-3 w-32"><SortHeader label="State" field="state" /></th>
              <th className="text-left p-3 w-28"><SortHeader label="Status" field="status" /></th>
              <th className="text-right p-3 w-20"><SortHeader label="Words" field="wordCount" /></th>
              <th className="text-left p-3 w-28"><SortHeader label="Created" field="createdAt" /></th>
              <th className="text-right p-3 w-28">Actions</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence mode="popLayout">
              {filtered.map((item) => (
                <motion.tr
                  key={item.id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => onSelect(item)}
                  className={cn(
                    "border-b border-slate-50 cursor-pointer transition-colors",
                    selectedIds.includes(item.id) ? "bg-indigo-50/50" : "hover:bg-slate-50"
                  )}
                >
                  <td className="p-3" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelect(item.id)}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600" />
                  </td>
                  <td className="p-3">
                    <p className="font-medium text-slate-900 truncate max-w-md">{item.title || item.keyword}</p>
                    {item.title && <p className="text-xs text-slate-400 truncate max-w-md">{item.keyword}</p>}
                  </td>
                  <td className="p-3">
                    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border", typeColors[item.type])}>
                      {item.type}
                    </span>
                  </td>
                  <td className="p-3 text-slate-600">{item.state || "—"}</td>
                  <td className="p-3">
                    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border", statusColors[item.status])}>
                      {item.status === "generating" && <span className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-pulse mr-1" />}
                      {item.status}
                    </span>
                  </td>
                  <td className="p-3 text-right text-slate-500 tabular-nums">
                    {item.wordCount ? item.wordCount.toLocaleString() : "—"}
                  </td>
                  <td className="p-3 text-xs text-slate-400 tabular-nums">
                    {new Date(item.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" })}
                  </td>
                  <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1.5">
                      {(item.status === "queued" || item.status === "failed") && (
                        <button
                          onClick={() => onGenerate(item.id)}
                          title={item.status === "failed" ? "Retry — runs the AI writer again" : "Generate this article — AI writes it and pushes a draft to WordPress (~2-5 min)"}
                          className={cn("flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold text-white transition-colors",
                            item.status === "failed" ? "bg-red-500 hover:bg-red-600" : "bg-indigo-600 hover:bg-indigo-700")}>
                          <PlayCircle className="h-3 w-3" />
                          <span>{item.status === "failed" ? "Retry" : "Generate"}</span>
                        </button>
                      )}
                      {item.wordpressUrl && (
                        <a href={item.wordpressUrl} target="_blank" rel="noopener noreferrer"
                          className="px-2 py-1 rounded text-[10px] font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition-colors">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <p className="text-sm">No articles found</p>
          </div>
        )}
      </div>
    </div>
  );
}
