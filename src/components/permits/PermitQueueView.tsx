import { useEffect, useState } from "react";
import { Send, Pencil, X, Check, RefreshCw, Building2, CheckCheck } from "lucide-react";
import {
  generatePermitDrafts,
  getPermitDrafts,
  editPermitDraft,
  rejectPermitDraft,
  approvePermitDraft,
  approveAllPermitDrafts,
  sendPermitDraftNow,
  type PermitDraft,
} from "../../lib/permitApi";

type Tab = "pending" | "approved" | "sent" | "rejected";
type Toast = (m: string, k?: "success" | "error") => void;

export default function PermitQueueView({ pushToast }: { pushToast?: Toast }) {
  const [tab, setTab] = useState<Tab>("pending");
  const [drafts, setDrafts] = useState<PermitDraft[]>([]);
  const [counts, setCounts] = useState({ pending: 0, approved: 0, sent: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = async (t: Tab = tab) => {
    setLoading(true);
    try {
      const { drafts, counts } = await getPermitDrafts(t);
      setDrafts(drafts);
      setCounts(counts);
    } catch {
      pushToast?.("Couldn't load the queue", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(tab); /* eslint-disable-next-line */ }, [tab]);

  const generate = async () => {
    setBusy(true);
    try {
      const r = await generatePermitDrafts();
      if (r.created > 0) pushToast?.(`Drafted ${r.created} email${r.created === 1 ? "" : "s"} — review below`, "success");
      else if (r.eligible === 0) pushToast?.("No new companies to draft — all email-able ones are queued or contacted", "success");
      else pushToast?.("Nothing new to draft", "success");
      if (r.mailboxesEnabled === 0) pushToast?.("Heads up: no sending mailbox is enabled for permits yet", "error");
      setTab("pending");
      await load("pending");
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : "Couldn't generate drafts", "error");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (d: PermitDraft) => {
    setBusy(true);
    try {
      await approvePermitDraft(d.id);
      pushToast?.(`Approved ${d.operator_name || d.email}`, "success");
      await load(tab);
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : "Couldn't approve", "error");
    } finally { setBusy(false); }
  };

  const approveAll = async () => {
    if (!window.confirm(`Approve all ${counts.pending} drafts to review? They'll send within each inbox's daily cap once the master switch is on.`)) return;
    setBusy(true);
    try {
      const { approved } = await approveAllPermitDrafts();
      pushToast?.(`Approved ${approved} draft${approved === 1 ? "" : "s"}`, "success");
      await load("pending");
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : "Couldn't approve all", "error");
    } finally { setBusy(false); }
  };

  const sendNow = async (d: PermitDraft) => {
    if (!window.confirm(`Send this email to ${d.operator_name || d.email} right now?`)) return;
    setBusy(true);
    try {
      await sendPermitDraftNow(d.id);
      pushToast?.(`Sent to ${d.operator_name || d.email}`, "success");
      await load(tab);
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : "Send failed", "error");
    } finally { setBusy(false); }
  };

  const reject = async (d: PermitDraft) => {
    if (!window.confirm(`Remove the draft for ${d.operator_name || d.email}? It won't be sent.`)) return;
    setBusy(true);
    try {
      await rejectPermitDraft(d.id);
      await load(tab);
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : "Couldn't remove draft", "error");
    } finally { setBusy(false); }
  };

  const saveEdit = async (id: string, subject: string, body: string) => {
    setBusy(true);
    try {
      const { draft } = await editPermitDraft(id, { subject, body });
      setDrafts((xs) => xs.map((x) => (x.id === id ? draft : x)));
      setEditing(null);
      pushToast?.("Saved", "success");
    } catch (e) {
      pushToast?.(e instanceof Error ? e.message : "Couldn't save", "error");
    } finally { setBusy(false); }
  };

  const tabBtn = (v: Tab, label: string, n: number) => (
    <button
      onClick={() => setTab(v)}
      className={"rounded-lg px-3 py-1.5 text-sm font-semibold " +
        (tab === v ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}
    >
      {label} <span className="text-xs text-slate-400">({n})</span>
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        <strong>Approve</strong> queues a draft for auto-send (within each inbox's daily cap, when auto-send + the
        master switch are on). <strong>Send now</strong> fires one immediately. Nothing leaves without one of those.
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
          {tabBtn("pending", "To review", counts.pending)}
          {tabBtn("approved", "Approved", counts.approved)}
          {tabBtn("sent", "Sent", counts.sent)}
          {tabBtn("rejected", "Removed", counts.rejected)}
        </div>
        <div className="flex items-center gap-2">
          {tab === "pending" && counts.pending > 0 && (
            <button
              onClick={approveAll}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 px-3 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              <CheckCheck className="h-4 w-4" /> Approve all ({counts.pending})
            </button>
          )}
          <button
            onClick={generate}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" /> Draft emails
          </button>
        </div>
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
      ) : drafts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500">
          {tab === "pending" ? "Nothing to review. Hit “Draft emails” to queue the email-able companies."
            : tab === "approved" ? "No approved drafts waiting."
            : tab === "sent" ? "No emails sent yet."
            : "No removed drafts."}
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              tab={tab}
              busy={busy}
              editing={editing === d.id}
              onEdit={() => setEditing(d.id)}
              onCancelEdit={() => setEditing(null)}
              onSave={saveEdit}
              onApprove={() => approve(d)}
              onSendNow={() => sendNow(d)}
              onReject={() => reject(d)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DraftCard({
  draft, tab, busy, editing, onEdit, onCancelEdit, onSave, onApprove, onSendNow, onReject,
}: {
  draft: PermitDraft;
  tab: Tab;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (id: string, subject: string, body: string) => void;
  onApprove: () => void;
  onSendNow: () => void;
  onReject: () => void;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);

  useEffect(() => { setSubject(draft.subject); setBody(draft.body); }, [draft.subject, draft.body]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 font-semibold text-slate-800">
            <Building2 className="h-4 w-4 text-slate-400" />
            {draft.operator_name || "Unknown company"}
          </div>
          <div className="text-xs text-slate-500">
            {draft.contact_name ? `${draft.contact_name} · ` : ""}{draft.email}
          </div>
        </div>
        <div className="text-right text-xs text-slate-400">
          {draft.assigned_email ? <>from {draft.assigned_email}</> : <span className="text-amber-600">no sender set</span>}
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs focus:border-indigo-400 focus:outline-none"
          />
          <div className="flex gap-2">
            <button onClick={() => onSave(draft.id, subject, body)} disabled={busy}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              <Check className="h-3.5 w-3.5" /> Save
            </button>
            <button onClick={onCancelEdit} disabled={busy}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-1 text-sm font-semibold text-slate-700">{draft.subject}</div>
          {/* Faithful preview: Apollo wraps the body in this same blue Georgia style */}
          <div className="whitespace-pre-wrap rounded-lg border border-slate-100 bg-slate-50 p-3 text-sm"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif", color: "#1a5276", lineHeight: 1.55 }}>
            {draft.body}
          </div>

          {tab === "pending" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={onApprove} disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                <Check className="h-3.5 w-3.5" /> Approve
              </button>
              <button onClick={onSendNow} disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                <Send className="h-3.5 w-3.5" /> Send now
              </button>
              <button onClick={onEdit} disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
              <button onClick={onReject} disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-400 hover:text-rose-600 disabled:opacity-50">
                <X className="h-3.5 w-3.5" /> Remove
              </button>
            </div>
          )}

          {tab === "approved" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-emerald-600">✓ Approved — waiting for auto-send (or send it now)</span>
              <button onClick={onSendNow} disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                <Send className="h-3.5 w-3.5" /> Send now
              </button>
              <button onClick={onReject} disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-400 hover:text-rose-600 disabled:opacity-50">
                <X className="h-3.5 w-3.5" /> Remove
              </button>
            </div>
          )}

          {tab === "sent" && (
            <div className="mt-2 text-xs text-emerald-600">
              Sent{draft.sent_at ? ` ${new Date(draft.sent_at).toLocaleDateString()}` : ""}
            </div>
          )}
          {tab === "rejected" && draft.reject_reason && (
            <div className="mt-2 text-xs text-slate-400">Removed: {draft.reject_reason}</div>
          )}
        </>
      )}
    </div>
  );
}
