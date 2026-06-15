import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Flame,
  Inbox,
  LayoutGrid,
  LogOut,
  Mail,
  MousePointerClick,
  RefreshCw,
  Reply,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Sprout,
  X,
  XCircle,
  Eye,
} from "lucide-react";
import {
  clearSession,
  getToken,
  getUser,
  pipedriveLeadUrl,
  sdrApi,
  setSession,
  type SdrDraft,
  type SdrEngagementLead,
  type SdrEngagementSummary,
  type SdrMailbox,
  type SdrTemplate,
  type SdrTriggerType,
  type SdrUser,
  type SdrUserPublic,
} from "../lib/sdrApi";
import { cn } from "../utils";
import CampaignsView from "./nurture/CampaignsView";
import ListsView from "./nurture/ListsView";
import ContactsView from "./nurture/ContactsView";
import AutomationsView from "./nurture/AutomationsView";

type SdrTab = "queue" | "engaged" | "dashboard" | "mailboxes" | "templates";
type OutreachLane = "cold" | "nurture";
type NurtureTab = "campaigns" | "lists" | "contacts" | "automations";

const LANE_KEY = "swppp_outreach_lane";
function getLane(): OutreachLane {
  return localStorage.getItem(LANE_KEY) === "nurture" ? "nurture" : "cold";
}
function setLaneStored(l: OutreachLane) {
  localStorage.setItem(LANE_KEY, l);
}

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

const SEND_STATUS_COLORS: Record<string, string> = {
  enrolled: "bg-indigo-100 text-indigo-700",
  sent: "bg-emerald-100 text-emerald-700",
  replied: "bg-emerald-100 text-emerald-800",
  bounced: "bg-rose-100 text-rose-700",
  unsubscribed: "bg-slate-200 text-slate-600",
  failed: "bg-rose-100 text-rose-700",
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

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "—";
}

// --------------------------------------------------------------------------
// Toasts (lightweight, local)
// --------------------------------------------------------------------------

interface Toast {
  id: number;
  kind: "success" | "error";
  text: string;
}

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  return { toasts, push, dismiss };
}

function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "flex items-start gap-2 rounded-xl px-4 py-3 text-sm shadow-lg border",
            t.kind === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-rose-50 border-rose-200 text-rose-800",
          )}
        >
          {t.kind === "success" ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          )}
          <span className="flex-1">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="text-current opacity-50 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------
// Root
// --------------------------------------------------------------------------

export default function SdrInterface() {
  const [user, setUser] = useState<SdrUser | null>(() => getUser());
  const isSignedIn = !!user && !!getToken();

  // JWT expired mid-session (12h TTL) → bounce back to the picker cleanly
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener("sdr-session-expired", onExpired);
    return () => window.removeEventListener("sdr-session-expired", onExpired);
  }, []);

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
  const [lane, setLane] = useState<OutreachLane>(() => getLane());
  const [tab, setTab] = useState<SdrTab>("queue");
  const [nurtureTab, setNurtureTab] = useState<NurtureTab>("campaigns");
  const [drillListId, setDrillListId] = useState<number | null>(null);

  // Mailbox lookup shared by Queue (resolve UUID → email in draft detail)
  const [mailboxById, setMailboxById] = useState<Record<string, SdrMailbox>>({});
  useEffect(() => {
    sdrApi
      .listMailboxes()
      .then((d) => {
        const map: Record<string, SdrMailbox> = {};
        for (const m of d.mailboxes) map[m.id] = m;
        setMailboxById(map);
      })
      .catch(() => {});
  }, []);

  const { toasts, push, dismiss } = useToasts();

  function switchLane(l: OutreachLane) {
    setLane(l);
    setLaneStored(l);
    // re-entering a lane should start fresh — no stale drill-down
    setNurtureTab("campaigns");
    setDrillListId(null);
  }

  return (
    <div>
      <ToastStack toasts={toasts} dismiss={dismiss} />
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-xs uppercase tracking-wide font-semibold text-slate-400">SDR</div>
          <h2 className="text-2xl font-semibold text-slate-900">Outreach console</h2>
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

      {/* Lane toggle */}
      <div className="inline-flex rounded-2xl border border-slate-200 bg-slate-50 p-1 mb-5" role="group" aria-label="Outreach lane">
        <button
          onClick={() => switchLane("cold")}
          aria-pressed={lane === "cold"}
          className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors",
            lane === "cold" ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700",
          )}
        >
          <Snowflake className="h-4 w-4" />
          Cold · Apollo
        </button>
        <button
          onClick={() => switchLane("nurture")}
          aria-pressed={lane === "nurture"}
          className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors",
            lane === "nurture" ? "bg-white text-emerald-700 shadow-sm" : "text-slate-500 hover:text-slate-700",
          )}
        >
          <Sprout className="h-4 w-4" />
          Nurture · Brevo
        </button>
      </div>

      {lane === "cold" ? (
        <>
          <div className="flex items-center gap-1 mb-6 border-b border-slate-200">
            <TabButton current={tab} value="queue" onClick={setTab} icon={<Inbox className="h-4 w-4" />}>Queue</TabButton>
            <TabButton current={tab} value="engaged" onClick={setTab} icon={<Flame className="h-4 w-4" />}>Engaged</TabButton>
            <TabButton current={tab} value="dashboard" onClick={setTab} icon={<LayoutGrid className="h-4 w-4" />}>Dashboard</TabButton>
            <TabButton current={tab} value="mailboxes" onClick={setTab} icon={<Mail className="h-4 w-4" />}>Mailboxes</TabButton>
            <TabButton current={tab} value="templates" onClick={setTab} icon={<SettingsIcon className="h-4 w-4" />}>Templates</TabButton>
          </div>
          {tab === "queue" && <QueueView user={user} mailboxById={mailboxById} pushToast={push} />}
          {tab === "engaged" && <EngagedView />}
          {tab === "dashboard" && <DashboardView />}
          {tab === "mailboxes" && <MailboxesView user={user} />}
          {tab === "templates" && <TemplatesView />}
        </>
      ) : (
        <>
          <div className="flex items-center gap-1 mb-6 border-b border-slate-200">
            <NurtureTabButton current={nurtureTab} value="campaigns" onClick={(v) => { setNurtureTab(v); setDrillListId(null); }} icon={<Send className="h-4 w-4" />}>Campaigns</NurtureTabButton>
            <NurtureTabButton current={nurtureTab} value="lists" onClick={(v) => { setNurtureTab(v); setDrillListId(null); }} icon={<LayoutGrid className="h-4 w-4" />}>Lists</NurtureTabButton>
            <NurtureTabButton current={nurtureTab} value="contacts" onClick={(v) => { setNurtureTab(v); setDrillListId(null); }} icon={<Inbox className="h-4 w-4" />}>Contacts</NurtureTabButton>
            <NurtureTabButton current={nurtureTab} value="automations" onClick={(v) => setNurtureTab(v)} icon={<RefreshCw className="h-4 w-4" />}>Automations</NurtureTabButton>
          </div>
          {nurtureTab === "campaigns" && <CampaignsView pushToast={push} />}
          {nurtureTab === "lists" && (
            <ListsView
              onDrill={(id) => { setDrillListId(id); setNurtureTab("contacts"); }}
              pushToast={push}
            />
          )}
          {nurtureTab === "contacts" && <ContactsView listId={drillListId} pushToast={push} />}
          {nurtureTab === "automations" && <AutomationsView />}
        </>
      )}
    </div>
  );
}

function NurtureTabButton({
  current, value, onClick, icon, children,
}: {
  current: NurtureTab; value: NurtureTab; onClick: (v: NurtureTab) => void; icon: React.ReactNode; children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onClick(value)}
      className={cn(
        "flex items-center gap-2 px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors",
        active ? "border-emerald-600 text-emerald-600" : "border-transparent text-slate-500 hover:text-slate-900",
      )}
    >
      {icon}
      {children}
    </button>
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

const QUEUE_POLL_MS = 60_000;

function QueueView({
  user,
  mailboxById,
  pushToast,
}: {
  user: SdrUser;
  mailboxById: Record<string, SdrMailbox>;
  pushToast: (kind: "success" | "error", text: string) => void;
}) {
  const [drafts, setDrafts] = useState<SdrDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"open" | "all">("open");

  const load = useCallback(async () => {
    try {
      const d = await sdrApi.listDrafts();
      setDrafts(d.drafts);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Initial load + poll + refresh when the tab regains focus
  useEffect(() => {
    load();
    const interval = setInterval(load, QUEUE_POLL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const filtered = useMemo(() => {
    if (!drafts) return [];
    if (statusFilter === "open") {
      return drafts.filter((d) => ["pending", "approved", "edited"].includes(d.status));
    }
    return drafts;
  }, [drafts, statusFilter]);

  async function onApprove(id: string) {
    setBusyId(id);
    try {
      const result = await sdrApi.approveAndSendDraft(id);
      const warning = (result as { warning?: string }).warning;
      pushToast(warning ? "error" : "success", warning || "Draft approved — contact enrolled in Apollo.");
      await load();
      setExpandedId(null);
    } catch (e) {
      pushToast("error", `Approve & send failed: ${(e as Error).message}`);
      await load(); // status may have flipped to 'failed'
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(id: string, reason: string) {
    setBusyId(id);
    try {
      await sdrApi.rejectDraft(id, reason);
      pushToast("success", "Draft rejected.");
      await load();
    } catch (e) {
      pushToast("error", `Reject failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function onSaveEdit(id: string, subject: string, body: string) {
    setBusyId(id);
    try {
      await sdrApi.patchDraft(id, { subject, body });
      pushToast("success", "Edits saved.");
      await load();
    } catch (e) {
      pushToast("error", `Save failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function onRefreshFromPipedrive(id: string) {
    setBusyId(id);
    try {
      await sdrApi.refreshDraft(id);
      pushToast("success", "Draft re-rendered from the live Pipedrive lead.");
      await load();
    } catch (e) {
      pushToast("error", `Refresh failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function onSetSequenceId(id: string, sequenceId: string) {
    setBusyId(id);
    try {
      await sdrApi.patchDraft(id, { apollo_sequence_id: sequenceId });
      pushToast("success", "Apollo sequence id set.");
      await load();
    } catch (e) {
      pushToast("error", `Failed to set sequence id: ${(e as Error).message}`);
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
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>Auto-refreshes every minute</span>
          <button
            onClick={load}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 flex items-center gap-2"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
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
            isAdmin={user.role === "admin"}
            mailbox={d.assigned_mailbox_id ? mailboxById[d.assigned_mailbox_id] : undefined}
            expanded={expandedId === d.id}
            onToggle={() => setExpandedId(expandedId === d.id ? null : d.id)}
            busy={busyId === d.id}
            onApprove={() => onApprove(d.id)}
            onReject={(reason) => onReject(d.id, reason)}
            onSaveEdit={(s, b) => onSaveEdit(d.id, s, b)}
            onRefresh={() => onRefreshFromPipedrive(d.id)}
            onSetSequenceId={(seq) => onSetSequenceId(d.id, seq)}
          />
        ))}
      </div>
    </div>
  );
}

function DraftRow({
  draft,
  isAdmin,
  mailbox,
  expanded,
  onToggle,
  busy,
  onApprove,
  onReject,
  onSaveEdit,
  onRefresh,
  onSetSequenceId,
}: {
  draft: SdrDraft;
  isAdmin: boolean;
  mailbox?: SdrMailbox;
  expanded: boolean;
  onToggle: () => void;
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onSaveEdit: (subject: string, body: string) => void;
  onRefresh: () => void;
  onSetSequenceId: (sequenceId: string) => void;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [confirming, setConfirming] = useState<"approve" | "reject" | "refresh" | null>(null);
  const [rejectReason, setRejectReason] = useState("Not a good fit");
  const [seqInput, setSeqInput] = useState("");

  // Re-sync local edit state when the draft itself changes server-side
  useEffect(() => {
    setSubject(draft.subject);
    setBody(draft.body);
  }, [draft.subject, draft.body, draft.updated_at]);

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
        <a
          href={pipedriveLeadUrl(draft.pipedrive_lead_id)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Open lead in Pipedrive"
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-indigo-600 flex-shrink-0"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Pipedrive
        </a>
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
            <div>
              Apollo sequence:{" "}
              {draft.apollo_sequence_id ? (
                <span className="font-mono">{draft.apollo_sequence_id}</span>
              ) : (
                <span className="text-amber-600 font-semibold">none set — required to send</span>
              )}
            </div>
            <div>
              Sender: <span className="font-mono">{mailbox?.email || draft.assigned_mailbox_id || "(none)"}</span>
            </div>
            {draft.reject_reason && <div>Reject reason: <span className="italic">{draft.reject_reason}</span></div>}
            {draft.error_message && (
              <div className="text-rose-600">Error: <span className="italic">{draft.error_message}</span></div>
            )}
          </div>

          {/* Admin: set a missing sequence id inline instead of via SQL */}
          {canSend && !draft.apollo_sequence_id && isAdmin && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={seqInput}
                onChange={(e) => setSeqInput(e.target.value)}
                placeholder="Apollo sequence id (from sequence URL)"
                className="flex-1 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-mono focus:border-amber-400 focus:outline-none"
              />
              <button
                onClick={() => seqInput.trim() && onSetSequenceId(seqInput.trim())}
                disabled={busy || !seqInput.trim()}
                className="rounded-xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
              >
                Set sequence
              </button>
            </div>
          )}

          {canSend && confirming === "approve" && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 flex items-center gap-3">
              <Send className="h-4 w-4 text-indigo-600 flex-shrink-0" />
              <div className="flex-1 text-sm text-indigo-900">
                Enrolls <span className="font-semibold">{draft.contact_email_snapshot}</span> in the Apollo sequence and
                sends the first email from <span className="font-semibold">{mailbox?.email || "the assigned mailbox"}</span>.
              </div>
              <button
                onClick={() => setConfirming(null)}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-white"
              >
                Cancel
              </button>
              <button
                onClick={() => { setConfirming(null); onApprove(); }}
                disabled={busy}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Confirm send
              </button>
            </div>
          )}

          {canSend && confirming === "reject" && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 flex items-center gap-3">
              <XCircle className="h-4 w-4 text-rose-600 flex-shrink-0" />
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Why is this draft being rejected?"
                className="flex-1 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-sm focus:border-rose-400 focus:outline-none"
              />
              <button
                onClick={() => setConfirming(null)}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-white"
              >
                Cancel
              </button>
              <button
                onClick={() => { setConfirming(null); onReject(rejectReason.trim() || "(no reason given)"); }}
                disabled={busy}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              >
                Confirm reject
              </button>
            </div>
          )}

          {canSend && confirming === "refresh" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3">
              <RefreshCw className="h-4 w-4 text-amber-600 flex-shrink-0" />
              <div className="flex-1 text-sm text-amber-900">
                Re-renders this draft from the live Pipedrive lead. {dirty ? "Your unsaved edits will be lost." : "Any manual edits will be overwritten."}
              </div>
              <button
                onClick={() => setConfirming(null)}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-white"
              >
                Cancel
              </button>
              <button
                onClick={() => { setConfirming(null); onRefresh(); }}
                disabled={busy}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
              >
                Confirm refresh
              </button>
            </div>
          )}

          {canSend && !confirming && (
            <div className="flex items-center justify-between gap-2 pt-2">
              <button
                onClick={() => setConfirming("refresh")}
                disabled={busy}
                title="Re-render this draft from the live Pipedrive lead"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 disabled:opacity-50 flex items-center gap-2"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh from Pipedrive
              </button>
              <div className="flex items-center gap-2">
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
                  onClick={() => setConfirming("reject")}
                  disabled={busy}
                  className="rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50 flex items-center gap-2"
                >
                  <XCircle className="h-4 w-4" />
                  Reject
                </button>
                <button
                  onClick={() => setConfirming("approve")}
                  disabled={busy || dirty || !draft.apollo_sequence_id || !draft.assigned_mailbox_id}
                  title={
                    !draft.apollo_sequence_id
                      ? "Set the Apollo sequence id before sending"
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Engaged — sent leads ranked by engagement score (clicks > opens, recent > old)
// --------------------------------------------------------------------------

function isHot(l: SdrEngagementLead): boolean {
  return l.replies > 0 || l.clicks > 0 || l.opens >= 3;
}

function EngagedView() {
  const [summary, setSummary] = useState<SdrEngagementSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    sdrApi
      .engagementSummary()
      .then(setSummary)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, QUEUE_POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  if (error)
    return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  if (!summary) return <div className="text-center text-slate-400 py-12">Loading…</div>;

  const hot = summary.leads.filter(isHot);

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatTile label="Sent leads" value={summary.leads.length} icon={<Send className="h-4 w-4" />} tone="indigo" />
        <StatTile label="Hot leads" value={hot.length} icon={<Flame className="h-4 w-4" />} tone="rose" />
        <StatTile
          label="Total clicks"
          value={summary.leads.reduce((a, l) => a + l.clicks, 0)}
          icon={<MousePointerClick className="h-4 w-4" />}
          tone="emerald"
        />
        <StatTile
          label="Replies"
          value={summary.leads.reduce((a, l) => a + l.replies, 0)}
          icon={<Reply className="h-4 w-4" />}
          tone="emerald"
        />
      </div>

      {summary.leads.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center">
          <Flame className="h-8 w-8 text-slate-300 mx-auto mb-3" />
          <div className="text-sm font-semibold text-slate-700">No sent leads yet</div>
          <p className="text-xs text-slate-500 mt-1">
            Once drafts are approved and Apollo engagement events start flowing, leads will rank here by opens, clicks
            and replies — most engaged first.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900">Prioritized by engagement</div>
            <div className="text-xs text-slate-400">Replies ×10 · Clicks ×5 · Opens ×1 · recent activity weighs more</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {summary.leads.map((l) => (
              <li
                key={l.draft_id}
                className={cn("px-4 py-3 flex items-center gap-3", isHot(l) && "bg-amber-50/50")}
              >
                {isHot(l) ? (
                  <Flame className="h-4 w-4 text-amber-500 flex-shrink-0" />
                ) : (
                  <span className="w-4 flex-shrink-0" />
                )}
                <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset", TRIGGER_COLORS[l.trigger_type])}>
                  {l.trigger_type}
                </span>
                {l.send_status && (
                  <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full", SEND_STATUS_COLORS[l.send_status] || "bg-slate-100 text-slate-600")}>
                    {l.send_status}
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">
                    {l.lead_title || `Lead #${l.pipedrive_lead_id}`}
                  </div>
                  <div className="text-xs text-slate-500 truncate">{l.contact_email_snapshot}</div>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-600 flex-shrink-0">
                  <span className="flex items-center gap-1" title="Opens">
                    <Eye className="h-3.5 w-3.5 text-slate-400" /> {l.opens}
                  </span>
                  <span className="flex items-center gap-1" title="Clicks">
                    <MousePointerClick className="h-3.5 w-3.5 text-slate-400" /> {l.clicks}
                  </span>
                  <span className="flex items-center gap-1" title="Replies">
                    <Reply className="h-3.5 w-3.5 text-slate-400" /> {l.replies}
                  </span>
                  <span className="text-slate-400 w-16 text-right" title="Last activity">
                    {formatRelative(l.last_event_at)}
                  </span>
                  <span className="font-mono font-semibold text-slate-900 w-12 text-right" title="Engagement score">
                    {l.score.toFixed(1)}
                  </span>
                </div>
                <a
                  href={pipedriveLeadUrl(l.pipedrive_lead_id)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open lead in Pipedrive"
                  className="text-slate-400 hover:text-indigo-600 flex-shrink-0"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Dashboard
// --------------------------------------------------------------------------

function DashboardView() {
  const [drafts, setDrafts] = useState<SdrDraft[] | null>(null);
  const [summary, setSummary] = useState<SdrEngagementSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sdrApi
      .listDrafts()
      .then((d) => setDrafts(d.drafts))
      .catch((e) => setError(e.message));
    sdrApi
      .engagementSummary()
      .then(setSummary)
      .catch(() => {}); // rates are additive — dashboard still works without them
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
  const recent = [...drafts]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="In queue" value={counts.pending} icon={<Inbox className="h-4 w-4" />} tone="indigo" />
        <StatTile label="Sent" value={counts.sent} icon={<CheckCircle2 className="h-4 w-4" />} tone="emerald" />
        <StatTile label="Rejected" value={counts.rejected} icon={<XCircle className="h-4 w-4" />} tone="slate" />
        <StatTile label="Failed" value={counts.failed} icon={<AlertCircle className="h-4 w-4" />} tone="rose" />
      </div>

      {summary && summary.by_trigger.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RatesTable
            title="By trigger type"
            rows={summary.by_trigger.map((r) => ({
              label: `${r.trigger_type} — ${TRIGGER_LABELS[r.trigger_type]}`,
              ...r,
            }))}
          />
          <RatesTable
            title="By sender"
            rows={summary.by_sender.map((r) => ({ label: r.display_name || r.username, ...r }))}
          />
        </div>
      )}

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

function RatesTable({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; sent: number; opened: number; clicked: number; replied: number }[];
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-400 uppercase tracking-wide">
            <th className="text-left font-semibold px-4 py-2"></th>
            <th className="text-right font-semibold px-2 py-2">Sent</th>
            <th className="text-right font-semibold px-2 py-2">Open</th>
            <th className="text-right font-semibold px-2 py-2">Click</th>
            <th className="text-right font-semibold px-4 py-2">Reply</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="px-4 py-2 text-slate-700 font-medium">{r.label}</td>
              <td className="px-2 py-2 text-right font-mono text-slate-900">{r.sent}</td>
              <td className="px-2 py-2 text-right font-mono text-slate-700" title={`${r.opened} of ${r.sent}`}>
                {pct(r.opened, r.sent)}
              </td>
              <td className="px-2 py-2 text-right font-mono text-slate-700" title={`${r.clicked} of ${r.sent}`}>
                {pct(r.clicked, r.sent)}
              </td>
              <td className="px-4 py-2 text-right font-mono text-slate-700" title={`${r.replied} of ${r.sent}`}>
                {pct(r.replied, r.sent)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const [syncError, setSyncError] = useState<string | null>(null);

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
    setSyncError(null);
    try {
      await sdrApi.syncMailboxesFromApollo();
      await load();
    } catch (e) {
      setSyncError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  if (error)
    return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;

  return (
    <div>
      {user.role === "admin" && (
        <div className="flex items-center justify-end gap-3 mb-3">
          {syncError && <span className="text-xs text-rose-600">Sync failed: {syncError}</span>}
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
  const [templates, setTemplates] = useState<Record<SdrTriggerType, SdrTemplate> | null>(null);
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
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2 flex-wrap">
            <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset", TRIGGER_COLORS[t])}>{t}</span>
            <span className="text-sm font-semibold text-slate-900">{TRIGGER_LABELS[t]}</span>
            <span className="text-xs text-slate-500">— {templates[t].steps.length} step{templates[t].steps.length === 1 ? "" : "s"}</span>
            <span className="ml-auto text-xs text-slate-500">
              Subject: <span className="font-mono text-slate-700">{templates[t].default_subject}</span>
            </span>
          </div>
          <ul className="divide-y divide-slate-100">
            {templates[t].steps.map((step, i) => (
              <li key={i} className="px-4 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                    Day {step.day}
                  </span>
                  {i === 0 && <span className="text-[10px] text-slate-400">sent as the draft — steps below live in Apollo</span>}
                </div>
                <pre className="text-xs text-slate-700 whitespace-pre-wrap font-mono bg-slate-50 rounded-lg px-3 py-2">{step.body}</pre>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
