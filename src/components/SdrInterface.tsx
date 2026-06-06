import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Inbox,
  LayoutGrid,
  LogOut,
  Mail,
  RefreshCw,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import {
  clearSession,
  getToken,
  getUser,
  sdrApi,
  setSession,
  type SdrDraft,
  type SdrMailbox,
  type SdrTemplateStep,
  type SdrTriggerType,
  type SdrUser,
  type SdrUserPublic,
} from "../lib/sdrApi";
import { cn } from "../utils";

type SdrTab = "queue" | "dashboard" | "mailboxes" | "templates";

const TRIGGER_LABELS: Record<SdrTriggerType, string> = {
  AGC: "Awarded GC",
  LBA: "Low Bid Apparent",
  CM: "Customer Match",
  PB: "Project Bid",
};

const TRIGGER_COLORS: Record<SdrTriggerType, string> = {
  AGC: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  LBA: "bg-sky-50 text-sky-700 ring-sky-200",
  CM: "bg-violet-50 text-violet-700 ring-violet-200",
  PB: "bg-amber-50 text-amber-700 ring-amber-200",
};

const STATUS_COLORS: Record<SdrDraft["status"], string> = {
  pending: "bg-slate-100 text-slate-700",
  edited: "bg-indigo-100 text-indigo-700",
  approved: "bg-indigo-100 text-indigo-700",
  sent: "bg-emerald-100 text-emerald-700",
  rejected: "bg-rose-100 text-rose-700",
  failed: "bg-rose-100 text-rose-700",
  cancelled: "bg-slate-100 text-slate-500",
};

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const tense = diff < 0 ? "ago" : "from now";
  if (abs < 60) return `${Math.round(abs)}s ${tense}`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ${tense}`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h ${tense}`;
  return `${Math.round(abs / 86400)}d ${tense}`;
}

function initials(name: string): string {
  return name.split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase();
}

export default function SdrInterface() {
  const [user, setUser] = useState<SdrUser | null>(() => getUser());
  const isSignedIn = !!user && !!getToken();

  if (!isSignedIn) {
    return <UserPicker onSignIn={setUser} />;
  }

  return <SdrSignedIn user={user!} onSignOut={() => { clearSession(); setUser(null); }} />;
}

// --------------------------------------------------------------------------
// User picker (passwordless)
// --------------------------------------------------------------------------

function UserPicker({ onSignIn }: { onSignIn: (u: SdrUser) => void }) {
  const [users, setUsers] = useState<SdrUserPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    sdrApi
      .listUsers()
      .then((d) => setUsers(d.users))
      .catch((e) => setError(e.message));
  }, []);

  async function pick(username: string) {
    setBusy(username);
    setError(null);
    try {
      const { token, user } = await sdrApi.login(username);
      setSession(token, user);
      onSignIn(user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-xl mx-auto py-12">
      <div className="text-center mb-8">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-700 mb-3">
          <Sparkles className="h-6 w-6" />
        </div>
        <h2 className="text-2xl font-semibold text-slate-900">Who's working?</h2>
        <p className="text-sm text-slate-500 mt-1">
          Pick your name to see your draft queue. No password — the dashboard already gates access.
        </p>
      </div>
      {error && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}
      {!users && !error && (
        <div className="text-center text-slate-400 text-sm">Loading users…</div>
      )}
      {users && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {users.map((u) => (
            <button
              key={u.username}
              onClick={() => pick(u.username)}
              disabled={!!busy}
              className={cn(
                "group flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition-all duration-200 hover:border-indigo-300 hover:shadow-sm",
                busy === u.username && "opacity-50",
              )}
            >
              <div className="h-10 w-10 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold">
                {initials(u.display_name)}
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-slate-900">{u.display_name}</div>
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  {u.role === "admin" && <ShieldCheck className="h-3 w-3 text-indigo-600" />}
                  {u.role}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-indigo-500" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Signed-in container with tabs
// --------------------------------------------------------------------------

function SdrSignedIn({ user, onSignOut }: { user: SdrUser; onSignOut: () => void }) {
  const [tab, setTab] = useState<SdrTab>("queue");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="text-xs uppercase tracking-wide font-semibold text-slate-400">SDR</div>
          <h2 className="text-2xl font-semibold text-slate-900">Apollo outreach console</h2>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-sm font-medium text-slate-900">{user.display_name}</div>
            <div className="text-xs text-slate-500 flex items-center justify-end gap-1">
              {user.role === "admin" && <ShieldCheck className="h-3 w-3 text-indigo-600" />}
              {user.role}
            </div>
          </div>
          <button
            onClick={onSignOut}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 flex items-center gap-2"
          >
            <LogOut className="h-4 w-4" />
            Switch user
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 mb-6 border-b border-slate-200">
        <TabButton current={tab} value="queue" onClick={setTab} icon={<Inbox className="h-4 w-4" />}>
          Queue
        </TabButton>
        <TabButton current={tab} value="dashboard" onClick={setTab} icon={<LayoutGrid className="h-4 w-4" />}>
          Dashboard
        </TabButton>
        <TabButton current={tab} value="mailboxes" onClick={setTab} icon={<Mail className="h-4 w-4" />}>
          Mailboxes
        </TabButton>
        <TabButton current={tab} value="templates" onClick={setTab} icon={<SettingsIcon className="h-4 w-4" />}>
          Templates
        </TabButton>
      </div>

      {tab === "queue" && <QueueView user={user} />}
      {tab === "dashboard" && <DashboardView user={user} />}
      {tab === "mailboxes" && <MailboxesView user={user} />}
      {tab === "templates" && <TemplatesView />}
    </div>
  );
}

function TabButton({
  current,
  value,
  onClick,
  icon,
  children,
}: {
  current: SdrTab;
  value: SdrTab;
  onClick: (v: SdrTab) => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onClick(value)}
      className={cn(
        "flex items-center gap-2 px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors",
        active
          ? "border-indigo-600 text-indigo-600"
          : "border-transparent text-slate-500 hover:text-slate-900",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// --------------------------------------------------------------------------
// Queue
// --------------------------------------------------------------------------

function QueueView({ user: _user }: { user: SdrUser }) {
  const [drafts, setDrafts] = useState<SdrDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"open" | "all">("open");

  const load = useCallback(async () => {
    try {
      const d = await sdrApi.listDrafts();
      setDrafts(d.drafts);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!drafts) return [];
    if (statusFilter === "open") {
      return drafts.filter((d) => ["pending", "approved", "edited"].includes(d.status));
    }
    return drafts;
  }, [drafts, statusFilter]);

  async function onApprove(id: string) {
    if (!confirm("Approve this draft and send to Apollo? This enrolls the contact in the sequence and triggers the first email.")) return;
    setBusyId(id);
    try {
      await sdrApi.approveAndSendDraft(id);
      await load();
      setExpandedId(null);
    } catch (e) {
      alert(`Failed to approve and send: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(id: string) {
    const reason = prompt("Why are you rejecting this draft?", "Not a good fit");
    if (!reason) return;
    setBusyId(id);
    try {
      await sdrApi.rejectDraft(id, reason);
      await load();
    } catch (e) {
      alert(`Failed to reject: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function onSaveEdit(id: string, subject: string, body: string) {
    setBusyId(id);
    try {
      await sdrApi.patchDraft(id, { subject, body });
      await load();
    } catch (e) {
      alert(`Failed to save edit: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setStatusFilter("open")}
            className={cn(
              "rounded-xl px-3 py-1.5 text-sm font-semibold",
              statusFilter === "open" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
            )}
          >
            Open
          </button>
          <button
            onClick={() => setStatusFilter("all")}
            className={cn(
              "rounded-xl px-3 py-1.5 text-sm font-semibold",
              statusFilter === "all" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
            )}
          >
            All
          </button>
        </div>
        <button
          onClick={load}
          className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 flex items-center gap-2"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {!drafts && !error && <div className="text-center text-slate-400 py-12">Loading…</div>}

      {drafts && filtered.length === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center">
          <Inbox className="h-8 w-8 text-slate-300 mx-auto mb-3" />
          <div className="text-sm font-semibold text-slate-700">No drafts to review</div>
          <p className="text-xs text-slate-500 mt-1">
            New drafts will appear here as n8n detects qualifying Pipedrive leads.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((d) => (
          <DraftRow
            key={d.id}
            draft={d}
            expanded={expandedId === d.id}
            onToggle={() => setExpandedId(expandedId === d.id ? null : d.id)}
            busy={busyId === d.id}
            onApprove={() => onApprove(d.id)}
            onReject={() => onReject(d.id)}
            onSaveEdit={(s, b) => onSaveEdit(d.id, s, b)}
          />
        ))}
      </div>
    </div>
  );
}

function DraftRow({
  draft,
  expanded,
  onToggle,
  busy,
  onApprove,
  onReject,
  onSaveEdit,
}: {
  draft: SdrDraft;
  expanded: boolean;
  onToggle: () => void;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onSaveEdit: (subject: string, body: string) => void;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const dirty = subject !== draft.subject || body !== draft.body;
  const canSend = ["pending", "approved", "edited"].includes(draft.status);
  const leadTitle = (draft.metadata as { pipedrive_lead_title?: string })?.pipedrive_lead_title;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <button onClick={onToggle} className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left">
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-slate-400 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-slate-400 flex-shrink-0" />
        )}
        <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset", TRIGGER_COLORS[draft.trigger_type])}>
          {draft.trigger_type}
        </span>
        <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full", STATUS_COLORS[draft.status])}>
          {draft.status}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-900 truncate">
            {leadTitle || `Lead #${draft.pipedrive_lead_id}`}
          </div>
          <div className="text-xs text-slate-500 truncate">
            {draft.contact_email_snapshot} · {TRIGGER_LABELS[draft.trigger_type]} · {formatRelative(draft.created_at)}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-100 px-4 py-4 bg-slate-50/50 space-y-3">
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={!canSend || busy}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Body</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={!canSend || busy}
              rows={12}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-mono focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <div className="text-xs text-slate-500 space-y-1">
            <div>Apollo sequence: <span className="font-mono">{draft.apollo_sequence_id || "(none set — required to send)"}</span></div>
            <div>Mailbox: <span className="font-mono">{draft.assigned_mailbox_id || "(none)"}</span></div>
            {draft.reject_reason && <div>Reject reason: <span className="italic">{draft.reject_reason}</span></div>}
            {draft.error_message && (
              <div className="text-rose-600">Error: <span className="italic">{draft.error_message}</span></div>
            )}
          </div>

          {canSend && (
            <div className="flex items-center justify-end gap-2 pt-2">
              {dirty && (
                <button
                  onClick={() => onSaveEdit(subject, body)}
                  disabled={busy}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  Save edits
                </button>
              )}
              <button
                onClick={onReject}
                disabled={busy}
                className="rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50 flex items-center gap-2"
              >
                <XCircle className="h-4 w-4" />
                Reject
              </button>
              <button
                onClick={onApprove}
                disabled={busy || dirty || !draft.apollo_sequence_id || !draft.assigned_mailbox_id}
                title={
                  !draft.apollo_sequence_id
                    ? "Set apollo_sequence_id before sending"
                    : !draft.assigned_mailbox_id
                    ? "No mailbox assigned"
                    : dirty
                    ? "Save edits first"
                    : "Enroll in Apollo sequence + send first email"
                }
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 flex items-center gap-2"
              >
                <Send className="h-4 w-4" />
                Approve & send
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Dashboard
// --------------------------------------------------------------------------

function DashboardView({ user: _user }: { user: SdrUser }) {
  const [drafts, setDrafts] = useState<SdrDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sdrApi
      .listDrafts()
      .then((d) => setDrafts(d.drafts))
      .catch((e) => setError(e.message));
  }, []);

  if (error)
    return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  if (!drafts) return <div className="text-center text-slate-400 py-12">Loading…</div>;

  const counts = {
    pending: drafts.filter((d) => d.status === "pending" || d.status === "edited").length,
    sent: drafts.filter((d) => d.status === "sent").length,
    rejected: drafts.filter((d) => d.status === "rejected").length,
    failed: drafts.filter((d) => d.status === "failed").length,
  };
  const recent = drafts.slice(0, 10);

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatTile label="In queue" value={counts.pending} icon={<Inbox className="h-4 w-4" />} tone="indigo" />
        <StatTile label="Sent" value={counts.sent} icon={<CheckCircle2 className="h-4 w-4" />} tone="emerald" />
        <StatTile label="Rejected" value={counts.rejected} icon={<XCircle className="h-4 w-4" />} tone="slate" />
        <StatTile label="Failed" value={counts.failed} icon={<AlertCircle className="h-4 w-4" />} tone="rose" />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100">
          <div className="text-sm font-semibold text-slate-900">Recent activity</div>
        </div>
        {recent.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">Nothing yet.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recent.map((d) => (
              <li key={d.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded ring-1 ring-inset", TRIGGER_COLORS[d.trigger_type])}>
                  {d.trigger_type}
                </span>
                <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded", STATUS_COLORS[d.status])}>
                  {d.status}
                </span>
                <span className="flex-1 truncate text-slate-700">
                  {(d.metadata as { pipedrive_lead_title?: string })?.pipedrive_lead_title || `Lead #${d.pipedrive_lead_id}`}
                </span>
                <span className="text-xs text-slate-400">{formatRelative(d.sent_at || d.updated_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: "indigo" | "emerald" | "slate" | "rose";
}) {
  const tones: Record<string, string> = {
    indigo: "bg-indigo-50 text-indigo-700",
    emerald: "bg-emerald-50 text-emerald-700",
    slate: "bg-slate-50 text-slate-700",
    rose: "bg-rose-50 text-rose-700",
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
        <span className={cn("h-7 w-7 rounded-lg inline-flex items-center justify-center", tones[tone])}>{icon}</span>
      </div>
      <div className="text-2xl font-semibold text-slate-900 mt-1">{value}</div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Mailboxes
// --------------------------------------------------------------------------

function MailboxesView({ user }: { user: SdrUser }) {
  const [mailboxes, setMailboxes] = useState<SdrMailbox[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await sdrApi.listMailboxes();
      setMailboxes(d.mailboxes);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function sync() {
    setSyncing(true);
    try {
      await sdrApi.syncMailboxesFromApollo();
      await load();
    } catch (e) {
      alert(`Sync failed: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  if (error)
    return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;

  return (
    <div>
      {user.role === "admin" && (
        <div className="flex items-center justify-end mb-3">
          <button
            onClick={sync}
            disabled={syncing}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 flex items-center gap-2 disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
            Re-sync from Apollo
          </button>
        </div>
      )}

      {!mailboxes && <div className="text-center text-slate-400 py-12">Loading…</div>}

      {mailboxes && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {mailboxes.map((m) => (
            <div key={m.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-slate-900 text-sm">{m.email}</div>
                <span
                  className={cn(
                    "text-xs font-semibold px-2 py-0.5 rounded-full",
                    m.warmup_status === "warming"
                      ? "bg-amber-100 text-amber-700"
                      : m.warmup_status === "ready"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-100 text-slate-600",
                  )}
                >
                  {m.warmup_status}
                </span>
              </div>
              <dl className="text-xs text-slate-500 space-y-0.5">
                <div className="flex justify-between"><dt>Daily cap</dt><dd className="font-mono text-slate-700">{m.daily_send_limit}</dd></div>
                <div className="flex justify-between"><dt>Warmup target</dt><dd className="font-mono text-slate-700">{m.warmup_current_cap}/day</dd></div>
                <div className="flex justify-between"><dt>Deliverability</dt><dd className="font-mono text-slate-700">{m.deliverability_score ?? "—"}</dd></div>
                <div className="flex justify-between"><dt>Apollo ID</dt><dd className="font-mono text-slate-700 truncate ml-2">{m.apollo_mailbox_id?.slice(0, 12) || "(unlinked)"}</dd></div>
              </dl>
            </div>
          ))}
          {mailboxes.length === 0 && (
            <div className="col-span-full rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              No mailboxes visible.
              {user.role === "admin"
                ? " Try clicking 'Re-sync from Apollo'."
                : " You may not have a mailbox connected yet — ask Derek to set one up."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Templates (read-only preview)
// --------------------------------------------------------------------------

function TemplatesView() {
  const [templates, setTemplates] = useState<Record<SdrTriggerType, SdrTemplateStep[]> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sdrApi
      .listTemplates()
      .then((d) => setTemplates(d.templates))
      .catch((e) => setError(e.message));
  }, []);

  if (error)
    return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  if (!templates) return <div className="text-center text-slate-400 py-12">Loading…</div>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Read-only view of the templates that get rendered as Day-0 drafts. Apollo sequences (configured in Apollo's UI) handle Day 3 / Day 6 follow-ups for the AGC, LBA, CM triggers — PB is single-touch.
      </p>
      {(Object.keys(templates) as SdrTriggerType[]).map((t) => (
        <div key={t} className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset", TRIGGER_COLORS[t])}>{t}</span>
            <span className="text-sm font-semibold text-slate-900">{TRIGGER_LABELS[t]}</span>
            <span className="text-xs text-slate-500">— {templates[t].length} step{templates[t].length === 1 ? "" : "s"}</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {templates[t].map((step, i) => (
              <li key={i} className="px-4 py-3">
                <div className="text-xs font-semibold text-slate-500 mb-1">Day {step.day}</div>
                <pre className="text-xs text-slate-700 whitespace-pre-wrap font-mono bg-slate-50 rounded-lg px-3 py-2">{step.body}</pre>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
