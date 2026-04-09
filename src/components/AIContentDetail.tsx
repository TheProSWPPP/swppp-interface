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

  // Find pillar for this spoke
  const pillar = item.pillarId
    ? allItems.find((i) => i.id === item.pillarId)
    : null;

  // Find spokes for this pillar
  const spokes = item.type === "pillar"
    ? allItems.filter((i) => i.pillarId === item.id)
    : [];

  const handleSave = () => {
    const updates: Partial<AIContentItem> = {};
    if (editKeyword !== item.keyword) updates.keyword = editKeyword;
    if (editState !== (item.state || "")) updates.state = editState || undefined;
    if (Object.keys(updates).length > 0) {
      onUpdate(item.id, updates);
      setHasChanges(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-sm font-semibold text-slate-500 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to list
        </button>
        <div className="flex items-center gap-3">
          {(item.status === "queued" || item.status === "failed") && (
            <button
              onClick={() => onGenerate(item.id)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm"
            >
              <Zap className="h-4 w-4" />
              {item.status === "failed" ? "Retry Generation" : "Generate Article"}
            </button>
          )}
          <button
            onClick={() => {
              onDelete(item.id);
              onBack();
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      </div>

      {/* Main Card */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-8 space-y-8">
          {/* Title + Badges */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <span className={cn(
                "inline-flex items-center rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider border",
                typeColors[item.type]
              )}>
                {item.type}
              </span>
              <span className={cn(
                "inline-flex items-center rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider border",
                statusColors[item.status]
              )}>
                {item.status === "generating" && (
                  <span className="inline-block h-2 w-2 rounded-full bg-indigo-500 animate-pulse mr-1.5" />
                )}
                {item.status}
              </span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">
              {item.title || item.keyword}
            </h1>
            {item.title && (
              <p className="text-slate-500 mt-1">Keyword: {item.keyword}</p>
            )}
          </div>

          {/* Editable Fields */}
          {isEditable ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Keyword</label>
                <input
                  type="text"
                  value={editKeyword}
                  onChange={(e) => { setEditKeyword(e.target.value); setHasChanges(true); }}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State</label>
                <select
                  value={editState}
                  onChange={(e) => { setEditState(e.target.value); setHasChanges(true); }}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                >
                  <option value="">Select state...</option>
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              {hasChanges && (
                <div className="sm:col-span-2 flex justify-end">
                  <button
                    onClick={handleSave}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
                  >
                    <Save className="h-4 w-4" />
                    Save Changes
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              {item.state && (
                <div>
                  <p className="text-sm font-medium text-slate-500">State</p>
                  <p className="text-sm font-semibold text-slate-900 mt-0.5">{item.state}</p>
                </div>
              )}
              {item.wordCount && (
                <div>
                  <p className="text-sm font-medium text-slate-500">Word Count</p>
                  <p className="text-sm font-semibold text-slate-900 mt-0.5">{item.wordCount.toLocaleString()}</p>
                </div>
              )}
              {item.wordpressPostId && (
                <div>
                  <p className="text-sm font-medium text-slate-500">WordPress Post ID</p>
                  <p className="text-sm font-semibold text-slate-900 mt-0.5">#{item.wordpressPostId}</p>
                </div>
              )}
            </div>
          )}

          {/* WordPress Link */}
          {item.wordpressUrl && (
            <div className="flex items-center gap-3 p-4 bg-indigo-50 rounded-xl border border-indigo-100">
              <ExternalLink className="h-5 w-5 text-indigo-600 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-indigo-900">WordPress Draft</p>
                <a
                  href={item.wordpressUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-indigo-600 hover:text-indigo-800 underline truncate block"
                >
                  {item.wordpressUrl}
                </a>
              </div>
            </div>
          )}

          {/* Error Message */}
          {item.errorMessage && (
            <div className="flex items-start gap-3 p-4 bg-red-50 rounded-xl border border-red-100">
              <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-900">Generation Failed</p>
                <p className="text-sm text-red-700 mt-0.5">{item.errorMessage}</p>
              </div>
            </div>
          )}

          {/* Generating spinner */}
          {item.status === "generating" && (
            <div className="flex items-center gap-3 p-4 bg-indigo-50 rounded-xl border border-indigo-100">
              <div className="h-5 w-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-indigo-900">Generating Article</p>
                <p className="text-sm text-indigo-700 mt-0.5">
                  Perplexity research + Claude writing + Gemini images + WordPress upload. This takes 2-5 minutes.
                </p>
              </div>
            </div>
          )}

          {/* Pillar Relationship */}
          {pillar && (
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="flex items-center gap-2 mb-2">
                <Link2 className="h-4 w-4 text-indigo-600" />
                <p className="text-sm font-semibold text-slate-900">Linked to Pillar</p>
              </div>
              <p className="text-sm text-slate-700">{pillar.keyword}</p>
              {pillar.wordpressUrl && (
                <a
                  href={pillar.wordpressUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-indigo-600 hover:underline mt-1 inline-block"
                >
                  View pillar on WordPress
                </a>
              )}
            </div>
          )}

          {/* Spoke Children (for pillars) */}
          {spokes.length > 0 && (
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-4 w-4 text-indigo-600" />
                <p className="text-sm font-semibold text-slate-900">
                  Linked Spoke Articles ({spokes.length})
                </p>
              </div>
              <div className="space-y-2">
                {spokes.map((spoke) => (
                  <div key={spoke.id} className="flex items-center justify-between text-sm">
                    <span className="text-slate-700">{spoke.keyword}</span>
                    <span className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
                      statusColors[spoke.status]
                    )}>
                      {spoke.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div className="border-t border-slate-100 pt-6 flex flex-wrap gap-6">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Clock className="h-3.5 w-3.5" />
              Created {new Date(item.createdAt).toLocaleString()}
            </div>
            {item.generatedAt && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Sparkles className="h-3.5 w-3.5" />
                Generated {new Date(item.generatedAt).toLocaleString()}
              </div>
            )}
            {item.publishedAt && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <ExternalLink className="h-3.5 w-3.5" />
                Published {new Date(item.publishedAt).toLocaleString()}
              </div>
            )}
            {item.n8nExecutionId && (
              <div className="text-xs text-slate-400">
                n8n: {item.n8nExecutionId}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
