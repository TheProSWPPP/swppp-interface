import { useState, useEffect, useCallback } from "react";
import { cn } from "../utils";
import {
  Plus,
  Loader2,
  ChevronDown,
  ChevronRight,
  Trash2,
  ArrowUp,
  ArrowDown,
  MessageSquarePlus,
  ListChecks,
} from "lucide-react";

type TaskStatus = "planned" | "in_progress" | "blocked" | "done";

interface TaskUpdate {
  id: string;
  author: string;
  body: string;
  created_at: string;
}

interface AutomationTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  sortOrder: number;
  updates: TaskUpdate[];
  createdAt: string;
  updatedAt: string;
}

const STATUS_META: Record<TaskStatus, { label: string; badge: string }> = {
  planned: { label: "Planned", badge: "bg-slate-100 text-slate-600 border-slate-200" },
  in_progress: { label: "In Progress", badge: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  blocked: { label: "Blocked", badge: "bg-amber-100 text-amber-700 border-amber-200" },
  done: { label: "Done", badge: "bg-emerald-100 text-emerald-700 border-emerald-200" },
};
const STATUS_ORDER: TaskStatus[] = ["planned", "in_progress", "blocked", "done"];

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export default function AutomationRoadmap() {
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const fetchTasks = useCallback(() => {
    setLoading(true);
    fetch("/api/automation-tasks", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        setTasks(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch automation tasks:", err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Optimistic patch with rollback (mirrors handleUpdateProject in App.tsx)
  const patchTask = (id: string, fields: Partial<AutomationTask>) => {
    const prev = tasks;
    setTasks((cur) => cur.map((t) => (t.id === id ? { ...t, ...fields } : t)));
    fetch(`/api/automation-tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(fields),
    }).catch((err) => {
      console.error("Failed to update task:", err);
      setTasks(prev);
    });
  };

  const addTask = async () => {
    const title = newTitle.trim();
    if (!title) return;
    try {
      const res = await fetch("/api/automation-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title }),
      });
      const created = await res.json();
      if (res.ok) {
        setTasks((cur) => [...cur, created]);
        setNewTitle("");
        setAdding(false);
      }
    } catch (err) {
      console.error("Failed to create task:", err);
    }
  };

  const deleteTask = (id: string) => {
    if (!window.confirm("Delete this task?")) return;
    const prev = tasks;
    setTasks((cur) => cur.filter((t) => t.id !== id));
    fetch(`/api/automation-tasks/${id}`, { method: "DELETE", credentials: "include" }).catch((err) => {
      console.error("Failed to delete task:", err);
      setTasks(prev);
    });
  };

  // Reorder: swap with neighbor by writing a sort_order between its new neighbors.
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= tasks.length) return;
    const moving = tasks[index];
    // Neighbors at the destination after removal of `moving`
    const without = tasks.filter((_, i) => i !== index);
    const before = without[target - 1];
    const after = without[target];
    let newOrder: number;
    if (!before) newOrder = (after?.sortOrder ?? 1000) - 1000;
    else if (!after) newOrder = before.sortOrder + 1000;
    else newOrder = (before.sortOrder + after.sortOrder) / 2;
    patchTask(moving.id, { sortOrder: newOrder });
    setTasks((cur) =>
      [...cur.map((t) => (t.id === moving.id ? { ...t, sortOrder: newOrder } : t))].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      ),
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading roadmap...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <ListChecks className="h-6 w-6 text-indigo-600" />
            Automation Roadmap
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Shared list of automation work. Edit, reorder, and post updates.
          </p>
        </div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
          >
            <Plus className="h-4 w-4" /> Add task
          </button>
        )}
      </div>

      {adding && (
        <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addTask();
              if (e.key === "Escape") { setAdding(false); setNewTitle(""); }
            }}
            placeholder="New task title…"
            className="flex-1 text-sm px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
          <button onClick={addTask} className="text-sm font-semibold px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">
            Add
          </button>
          <button onClick={() => { setAdding(false); setNewTitle(""); }} className="text-sm font-semibold px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100">
            Cancel
          </button>
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="text-center py-20 text-slate-400 bg-white border border-dashed border-slate-200 rounded-xl">
          No tasks yet. Add the first one.
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task, i) => {
            const isOpen = expanded.has(task.id);
            return (
              <div key={task.id} className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                <div className="flex items-center gap-3 p-4">
                  <div className="flex flex-col">
                    <button
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      className="text-slate-300 hover:text-slate-600 disabled:opacity-30 disabled:hover:text-slate-300"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => move(i, 1)}
                      disabled={i === tasks.length - 1}
                      className="text-slate-300 hover:text-slate-600 disabled:opacity-30 disabled:hover:text-slate-300"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <button onClick={() => toggleExpand(task.id)} className="text-slate-400 hover:text-slate-600">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>

                  <button onClick={() => toggleExpand(task.id)} className="flex-1 text-left">
                    <span className="font-semibold text-slate-800">{task.title}</span>
                  </button>

                  {task.updates.length > 0 && (
                    <span className="text-xs text-slate-400">
                      {task.updates.length} update{task.updates.length > 1 ? "s" : ""} · {fmtDate(task.updatedAt)}
                    </span>
                  )}

                  <select
                    value={task.status}
                    onChange={(e) => patchTask(task.id, { status: e.target.value as TaskStatus })}
                    className={cn(
                      "text-xs font-semibold px-2.5 py-1 rounded-full border cursor-pointer focus:outline-none",
                      STATUS_META[task.status].badge,
                    )}
                  >
                    {STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>{STATUS_META[s].label}</option>
                    ))}
                  </select>
                </div>

                {isOpen && (
                  <div className="border-t border-slate-100 p-4 space-y-4 bg-slate-50/50">
                    <EditableTitle task={task} onSave={(title) => patchTask(task.id, { title })} />
                    <EditableDescription task={task} onSave={(description) => patchTask(task.id, { description })} />
                    <UpdatesLog task={task} onPosted={(updated) => setTasks((cur) => cur.map((t) => (t.id === updated.id ? updated : t)))} />
                    <div className="flex justify-end">
                      <button
                        onClick={() => deleteTask(task.id)}
                        className="flex items-center gap-1.5 text-xs font-semibold text-red-500 hover:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete task
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EditableTitle({ task, onSave }: { task: AutomationTask; onSave: (v: string) => void }) {
  const [value, setValue] = useState(task.title);
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Title</label>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (value.trim() && value !== task.title) onSave(value.trim()); }}
        className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200"
      />
    </div>
  );
}

function EditableDescription({ task, onSave }: { task: AutomationTask; onSave: (v: string) => void }) {
  const [value, setValue] = useState(task.description);
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Description</label>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (value !== task.description) onSave(value); }}
        rows={Math.min(12, Math.max(3, value.split("\n").length))}
        placeholder="Technical details…"
        className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 bg-white font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-200 whitespace-pre-wrap"
      />
    </div>
  );
}

function UpdatesLog({ task, onPosted }: { task: AutomationTask; onPosted: (t: AutomationTask) => void }) {
  const [author, setAuthor] = useState("Pro SWPPP");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);

  const post = async () => {
    if (!body.trim()) return;
    setPosting(true);
    try {
      const res = await fetch(`/api/automation-tasks/${task.id}/updates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ author, body }),
      });
      const updated = await res.json();
      if (res.ok) {
        onPosted(updated);
        setBody("");
      }
    } catch (err) {
      console.error("Failed to post update:", err);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Updates</label>
      {task.updates.length > 0 && (
        <ul className="space-y-2 mb-3">
          {task.updates.map((u) => (
            <li key={u.id} className="text-sm bg-white border border-slate-200 rounded-lg px-3 py-2">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-0.5">
                <span className="font-semibold text-slate-600">{u.author}</span>
                <span>{fmtDate(u.created_at)}</span>
              </div>
              <p className="text-slate-700 whitespace-pre-wrap">{u.body}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-start gap-2">
        <input
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          className="w-28 text-xs px-2 py-2 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200"
          placeholder="Author"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={1}
          placeholder="Post an update…"
          className="flex-1 text-sm px-3 py-2 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
        <button
          onClick={post}
          disabled={posting || !body.trim()}
          className="flex items-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-lg bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40"
        >
          {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}
          Post
        </button>
      </div>
    </div>
  );
}
