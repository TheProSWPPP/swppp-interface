import { useState, useEffect } from "react";
import type { AIContentItem, PillarVersion } from "../data";
import { CONTENT_SCOPES, NATIONWIDE } from "../data";
import { cn } from "../utils";
import {
  ArrowLeft,
  PlayCircle,
  ExternalLink,
  Trash2,
  Save,
  Link2,
  AlertTriangle,
  Clock,
  Sparkles,
  RefreshCw,
  FileEdit,
  GitBranch,
  Check,
  Info,
} from "lucide-react";

const statusColors: Record<string, string> = {
  queued: "bg-blue-50 text-blue-700 border-blue-200",
  generating: "bg-brand-50 text-brand-700 border-brand-200",
  draft: "bg-amber-50 text-amber-700 border-amber-200",
  published: "bg-green-50 text-green-700 border-green-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

const typeColors: Record<string, string> = {
  spoke: "bg-slate-100 text-slate-700 border-slate-200",
  pillar: "bg-brand-50 text-brand-700 border-brand-200",
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
  const [versions, setVersions] = useState<PillarVersion[]>([]);
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionAction, setVersionAction] = useState<string | null>(null);

  const isEditable = item.status === "queued" || item.status === "failed";
  const isPillar = item.type === "pillar";

  const pillar = item.pillarId ? allItems.find((i) => i.id === item.pillarId) : null;
  const spokes = item.type === "pillar" ? allItems.filter((i) => i.pillarId === item.id) : [];

  // Load versions when this is a pillar
  useEffect(() => {
    if (!isPillar || !item.state) { setVersions([]); return; }
    setVersionLoading(true);
    fetch(`/api/ai-content/pillar/${encodeURIComponent(item.state)}/versions`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : [])
      .then((data: PillarVersion[]) => setVersions(Array.isArray(data) ? data : []))
      .catch(() => setVersions([]))
      .finally(() => setVersionLoading(false));
  }, [isPillar, item.state, item.id, item.status]);

  const handleSave = () => {
    const updates: Partial<AIContentItem> = {};
    if (editKeyword !== item.keyword) updates.keyword = editKeyword;
    if (editState !== (item.state || "")) updates.state = editState || undefined;
    if (Object.keys(updates).length > 0) {
      onUpdate(item.id, updates);
      setHasChanges(false);
    }
  };

  const handleRegenerate = () => {
    onGenerate(item.id);
  };

  const handleNewVersion = async () => {
    if (!confirm(`Generate a new version of this pillar?\n\nThe existing v${item.version || 1} stays current until the new version is promoted.`)) return;
    setVersionAction("creating");
    try {
      const res = await fetch(`/api/ai-content/${item.id}/regenerate-as-new-version`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      // refresh versions list
      const refresh = await fetch(`/api/ai-content/pillar/${encodeURIComponent(item.state || "")}/versions`, { credentials: "include" });
      if (refresh.ok) setVersions(await refresh.json());
    } catch (err) {
      alert("Failed to start new version: " + (err as Error).message);
    } finally {
      setVersionAction(null);
    }
  };

  const handleSetCurrent = async (versionId: string) => {
    if (!confirm("Promote this version to current? Spokes will start linking to this version's URL on next generation.")) return;
    setVersionAction(versionId);
    try {
      const res = await fetch(`/api/ai-content/${versionId}/set-current`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      const refresh = await fetch(`/api/ai-content/pillar/${encodeURIComponent(item.state || "")}/versions`, { credentials: "include" });
      if (refresh.ok) setVersions(await refresh.json());
    } catch (err) {
      alert("Failed to promote: " + (err as Error).message);
    } finally {
      setVersionAction(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-900 transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <div className="flex items-center gap-2">
          {item.status === "draft" && !isPillar && (
            <button onClick={handleRegenerate}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-brand-600 bg-brand-50 hover:bg-brand-100 transition-colors">
              <RefreshCw className="h-3.5 w-3.5" /> Regenerate
            </button>
          )}
          {isPillar && (item.status === "draft" || item.status === "published") && (
            <button onClick={handleNewVersion} disabled={versionAction === "creating"}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-brand-600 bg-brand-50 hover:bg-brand-100 transition-colors disabled:opacity-50">
              <GitBranch className="h-3.5 w-3.5" /> {versionAction === "creating" ? "Starting..." : "New Version"}
            </button>
          )}
          {(item.status === "queued" || item.status === "failed") && (
            <button
              onClick={() => onGenerate(item.id)}
              title={item.status === "failed" ? "Retry generation — runs the AI writer again" : "Start AI generation — writes the article and pushes a draft to WordPress (takes 2-5 min)"}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 shadow-sm transition-colors">
              <PlayCircle className="h-4 w-4" /> {item.status === "failed" ? "Retry generation" : "Generate article"}
            </button>
          )}
          {item.wordpressUrl && (
            <a href={item.wordpressUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-brand-600 bg-brand-50 hover:bg-brand-100 transition-colors">
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
                {item.status === "generating" && <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulse mr-1" />}
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
                    {CONTENT_SCOPES.map((s) => (
                      <option key={s} value={s}>{s === NATIONWIDE ? "Nationwide (not state-specific)" : s}</option>
                    ))}
                  </select>
                </div>
                {hasChanges && (
                  <button onClick={handleSave} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 w-full justify-center">
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

          {/* What happens next? — contextual help */}
          {item.status === "queued" && (
            <div className="flex items-start gap-2 p-3 bg-blue-50 rounded-xl border border-blue-100">
              <Info className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-semibold text-blue-900">Ready to generate</p>
                <p className="text-xs text-blue-800">Click <span className="font-semibold">Generate article</span> to start. AI writes the full article (~2-5 min), uploads images, and creates a WordPress draft. You'll see the status change to "Generating" then "Draft" when done.</p>
              </div>
            </div>
          )}
          {item.status === "draft" && !isPillar && (
            <div className="flex items-start gap-2 p-3 bg-blue-50 rounded-xl border border-blue-100">
              <Info className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-semibold text-blue-900">Draft ready in WordPress</p>
                <p className="text-xs text-blue-800">Click <span className="font-semibold">Open in WP</span> to review. If something's off, click <span className="font-semibold">Regenerate</span> — that overwrites the draft with a fresh AI run.</p>
              </div>
            </div>
          )}
          {item.status === "draft" && isPillar && (
            <div className="flex items-start gap-2 p-3 bg-blue-50 rounded-xl border border-blue-100">
              <Info className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-semibold text-blue-900">Pillar draft ready</p>
                <p className="text-xs text-blue-800">Open in WP to review. To replace it, click <span className="font-semibold">New Version</span> — that creates a SECOND draft (separate WP URL). The current pillar URL stays untouched until you click <span className="font-semibold">Set current</span> on the new version below.</p>
              </div>
            </div>
          )}
          {item.status === "published" && isPillar && (
            <div className="flex items-start gap-2 p-3 bg-emerald-50 rounded-xl border border-emerald-100">
              <Info className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-semibold text-emerald-900">Pillar is live</p>
                <p className="text-xs text-emerald-800">
                  This article is published at the SEO URL. To rewrite it without losing rankings, click <span className="font-semibold">New Version</span> — that creates a fresh AI draft at a SEPARATE temporary URL (existing one keeps working). Review the new draft in WordPress, then click <span className="font-semibold">Set current</span> on it to copy its content into this URL. The old version is moved to WP Trash (recoverable).
                </p>
              </div>
            </div>
          )}
          {item.status === "generating" && (
            <div className="flex items-start gap-2 p-3 bg-brand-50 rounded-xl border border-brand-100">
              <Info className="h-4 w-4 text-brand-600 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-semibold text-brand-900">AI is writing</p>
                <p className="text-xs text-brand-800">This typically takes 2-5 minutes. Refresh the page or come back shortly. You'll see the status flip to "Draft" with a WordPress link when ready.</p>
              </div>
            </div>
          )}
          {item.status === "failed" && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 rounded-xl border border-amber-100">
              <Info className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-semibold text-amber-900">Generation failed</p>
                <p className="text-xs text-amber-800">Click <span className="font-semibold">Retry generation</span> to try again. If it keeps failing, the n8n workflow probably hit an error (check the error message below).</p>
              </div>
            </div>
          )}

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
            <div className="flex items-center gap-2 p-3 bg-brand-50 rounded-xl border border-brand-100">
              <div className="h-4 w-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              <p className="text-xs text-brand-700">Generating... 2-5 min</p>
            </div>
          )}

          {/* Pillar link */}
          {pillar && (
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="flex items-center gap-1.5 mb-1">
                <Link2 className="h-3.5 w-3.5 text-brand-600" />
                <p className="text-xs font-semibold text-slate-900">Linked Pillar</p>
              </div>
              <p className="text-xs text-slate-700">{pillar.keyword}</p>
              {pillar.wordpressUrl && (
                <a href={pillar.wordpressUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-brand-600 hover:underline">View in WP</a>
              )}
            </div>
          )}

          {/* Versions (pillars only) */}
          {isPillar && versions.length > 0 && (
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="flex items-center gap-1.5 mb-2">
                <GitBranch className="h-3.5 w-3.5 text-brand-600" />
                <p className="text-xs font-semibold text-slate-900">Versions ({versions.length})</p>
              </div>
              <div className="space-y-1.5">
                {versions.map((v) => (
                  <div key={v.id} className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <span className={cn(
                        "rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase border flex-shrink-0",
                        v.isCurrent ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-100 text-slate-600 border-slate-200"
                      )}>v{v.version}{v.isCurrent ? " · current" : ""}</span>
                      <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase border flex-shrink-0", statusColors[v.status])}>{v.status}</span>
                      {v.generatedAt && <span className="text-[10px] text-slate-400 truncate">{new Date(v.generatedAt).toLocaleDateString()}</span>}
                    </div>
                    {!v.isCurrent && (v.status === "draft" || v.status === "published") && (
                      <button
                        onClick={() => handleSetCurrent(v.id)}
                        disabled={versionAction === v.id}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 flex-shrink-0"
                        title="Promote this version to current">
                        <Check className="h-3 w-3" /> {versionAction === v.id ? "..." : "Set current"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {versionLoading && <p className="text-[10px] text-slate-400 mt-1">Loading…</p>}
            </div>
          )}

          {/* Spokes */}
          {spokes.length > 0 && (
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="h-3.5 w-3.5 text-brand-600" />
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
            {item.publishedAt && <div className="flex items-center gap-1"><Sparkles className="h-3 w-3" /> Published {new Date(item.publishedAt).toLocaleString()}</div>}
            {item.n8nExecutionId && <div>n8n: {item.n8nExecutionId}</div>}
          </div>
        </div>

        {/* Right: Content Preview (2/3 width) */}
        <div className="lg:col-span-2">
          {item.wordpressUrl && item.wordpressPostId ? (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-full flex flex-col items-center justify-center p-8">
              <ExternalLink className="h-10 w-10 text-brand-300 mb-4" />
              <p className="text-sm font-semibold text-slate-700 mb-1">Article ready in WordPress</p>
              <p className="text-xs text-slate-400 mb-5 text-center max-w-xs">
                {item.status === "draft" ? "This draft needs to be previewed in WordPress where you're logged in." : "View the published article on the live site."}
              </p>
              <div className="flex items-center gap-3">
                <a href={item.wordpressUrl} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 transition-colors">
                  <ExternalLink className="h-4 w-4" />
                  {item.status === "draft" ? "Preview in WordPress" : "View Article"}
                </a>
                {item.wordpressPostId && (
                  <a href={`https://proswppp.com/wp-admin/post.php?post=${item.wordpressPostId}&action=edit`} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors">
                    <FileEdit className="h-4 w-4" />
                    Edit in WP
                  </a>
                )}
              </div>
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

