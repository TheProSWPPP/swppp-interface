import { useState } from "react";
import type { AIContentItem } from "../data";
import { US_STATES } from "../data";
import { cn } from "../utils";
import {
  ArrowLeft,
  Zap,
  ExternalLink,
  Trash2,
  Save,
  Link2,
  AlertTriangle,
  Clock,
  Sparkles,
  CheckCircle2,
  RefreshCw,
  FileEdit,
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

interface AIContentDetailProps {
  item: AIContentItem;
  allItems: AIContentItem[];
  onBack: () => void;
  onGenerate: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, data: Partial<AIContentItem>) => void;
}

export default function AIContentDetail({
  item,
  allItems,
  onBack,
  onGenerate,
  onDelete,
  onUpdate,
}: AIContentDetailProps) {
  const [editKeyword, setEditKeyword] = useState(item.keyword);
  const [editState, setEditState] = useState(item.state || "");
  const [hasChanges, setHasChanges] = useState(false);

  const isEditable = item.status === "queued" || item.status === "failed";

  const pillar = item.pillarId ? allItems.find((i) => i.id === item.pillarId) : null;
  const spokes = item.type === "pillar" ? allItems.filter((i) => i.pillarId === item.id) : [];

  const handleSave = () => {
    const updates: Partial<AIContentItem> = {};
    if (editKeyword !== item.keyword) updates.keyword = editKeyword;
    if (editState !== (item.state || "")) updates.state = editState || undefined;
    if (Object.keys(updates).length > 0) {
      onUpdate(item.id, updates);
      setHasChanges(false);
    }
  };

  const handleMarkPublished = () => {
    onUpdate(item.id, { status: "published" } as any);
  };

  const handleRegenerate = () => {
    onGenerate(item.id);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-900 transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <div className="flex items-center gap-2">
          {item.status === "draft" && (
            <>
              <button onClick={handleRegenerate}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition-colors">
                <RefreshCw className="h-3.5 w-3.5" /> Regenerate
              </button>
              <button onClick={handleMarkPublished}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-green-600 hover:bg-green-700 transition-colors">
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark Published
              </button>
            </>
          )}
          {(item.status === "queued" || item.status === "failed") && (
            <button onClick={() => onGenerate(item.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors">
              <Zap className="h-3.5 w-3.5" /> {item.status === "failed" ? "Retry" : "Generate"}
            </button>
          )}
          {item.wordpressUrl && (
            <a href={item.wordpressUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition-colors">
              <ExternalLink className="h-3.5 w-3.5" /> Open in WP
            </a>
          )}
          <button onClick={() => { onDelete(item.id); onBack(); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 transition-colors">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Info Panel */}
        <div className="space-y-4">
          {/* Main info card */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
            <div className="flex items-center gap-2">
              <span className={cn("rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border", typeColors[item.type])}>
                {item.type}
              </span>
              <span className={cn("rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border", statusColors[item.status])}>
                {item.status === "generating" && <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-500 animate-pulse mr-1" />}
                {item.status}
              </span>
            </div>

            <h2 className="text-lg font-bold text-slate-900">{item.title || item.keyword}</h2>
            {item.title && <p className="text-sm text-slate-500">{item.keyword}</p>}

            {/* Editable fields */}
            {isEditable ? (
              <div className="space-y-3 pt-2 border-t border-slate-100">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Keyword</label>
                  <input type="text" value={editKeyword} onChange={(e) => { setEditKeyword(e.target.value); setHasChanges(true); }}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">State</label>
                  <select value={editState} onChange={(e) => { setEditState(e.target.value); setHasChanges(true); }}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white">
                    <option value="">Select...</option>
                    {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {hasChanges && (
                  <button onClick={handleSave} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 w-full justify-center">
                    <Save className="h-3.5 w-3.5" /> Save
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                {item.state && (
                  <div>
                    <p className="text-xs text-slate-500">State</p>
                    <p className="text-sm font-medium text-slate-900">{item.state}</p>
                  </div>
                )}
                {item.wordCount && (
                  <div>
                    <p className="text-xs text-slate-500">Words</p>
                    <p className="text-sm font-medium text-slate-900">{item.wordCount.toLocaleString()}</p>
                  </div>
                )}
                {item.wordpressPostId && (
                  <div>
                    <p className="text-xs text-slate-500">WP ID</p>
                    <p className="text-sm font-medium text-slate-900">#{item.wordpressPostId}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Error */}
          {item.errorMessage && (
            <div className="flex items-start gap-2 p-3 bg-red-50 rounded-xl border border-red-100">
              <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-red-900">Failed</p>
                <p className="text-xs text-red-700">{item.errorMessage}</p>
              </div>
            </div>
          )}

          {/* Generating */}
          {item.status === "generating" && (
            <div className="flex items-center gap-2 p-3 bg-indigo-50 rounded-xl border border-indigo-100">
              <div className="h-4 w-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              <p className="text-xs text-indigo-700">Generating... 2-5 min</p>
            </div>
          )}

          {/* Pillar link */}
          {pillar && (
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="flex items-center gap-1.5 mb-1">
                <Link2 className="h-3.5 w-3.5 text-indigo-600" />
                <p className="text-xs font-semibold text-slate-900">Linked Pillar</p>
              </div>
              <p className="text-xs text-slate-700">{pillar.keyword}</p>
              {pillar.wordpressUrl && (
                <a href={pillar.wordpressUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-indigo-600 hover:underline">View in WP</a>
              )}
            </div>
          )}

          {/* Spokes */}
          {spokes.length > 0 && (
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="h-3.5 w-3.5 text-indigo-600" />
                <p className="text-xs font-semibold text-slate-900">Spokes ({spokes.length})</p>
              </div>
              <div className="space-y-1">
                {spokes.map((s) => (
                  <div key={s.id} className="flex items-center justify-between">
                    <span className="text-xs text-slate-700 truncate">{s.keyword}</span>
                    <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase border", statusColors[s.status])}>{s.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div className="space-y-1 text-[10px] text-slate-400">
            <div className="flex items-center gap-1"><Clock className="h-3 w-3" /> Created {new Date(item.createdAt).toLocaleString()}</div>
            {item.generatedAt && <div className="flex items-center gap-1"><Sparkles className="h-3 w-3" /> Generated {new Date(item.generatedAt).toLocaleString()}</div>}
            {item.publishedAt && <div className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Published {new Date(item.publishedAt).toLocaleString()}</div>}
            {item.n8nExecutionId && <div>n8n: {item.n8nExecutionId}</div>}
          </div>
        </div>

        {/* Right: Content Preview (2/3 width) */}
        <div className="lg:col-span-2">
          {item.wordpressUrl && item.wordpressPostId ? (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-full">
              <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 bg-slate-50">
                <p className="text-xs font-semibold text-slate-600">Content Preview</p>
                <a href={item.wordpressUrl} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[10px] text-indigo-600 hover:underline">
                  <ExternalLink className="h-3 w-3" /> Edit in WordPress
                </a>
              </div>
              <iframe
                src={`https://proswppp.com/?p=${item.wordpressPostId}&preview=true`}
                className="w-full border-0"
                style={{ height: "calc(100vh - 280px)", minHeight: 500 }}
                title="Content Preview"
              />
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex items-center justify-center h-64 lg:h-full">
              <div className="text-center text-slate-400">
                <FileEdit className="h-8 w-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No content yet</p>
                <p className="text-xs mt-1">Generate the article to see a preview</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

