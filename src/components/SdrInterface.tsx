import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileSearch,
  Flame,
  Inbox,
  LayoutGrid,
  ListChecks,
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
  Target,
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
  type SdrLead,
  type SdrMailbox,
  type SdrSequence,
  type SdrSequenceStep,
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
import PermitsTab from "./permits/PermitsTab";

type SdrTab = "leads" | "queue" | "engaged" | "dashboard" | "mailboxes" | "templates" | "sequences" | "permits";
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

// Dedup: how recently the lead was already contacted in Pipedrive. Red = recent /
// already sequenced (don't send), amber = contacted long ago (re-sequence ok), green = fresh.
const OUTREACH_BADGE: Record<string, { label: string; cls: string }> = {
  contacted_recent: { label: "Contacted", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  sequenced: { label: "Sequenced", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  contacted_stale: { label: "Contacted (old)", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  clear: { label: "Fresh", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
};

function OutreachBadge({ status, days }: { status?: string | null; days?: number | null }) {
  if (!status || !OUTREACH_BADGE[status]) return null;
  const { label, cls } = OUTREACH_BADGE[status];
  const title =
    status === "clear"
      ? "No prior outreach found in Pipedrive"
      : status === "sequenced"
        ? "Already in an Apollo sequence"
        : `Already emailed ${days ?? "?"} days ago in Pipedrive`;
  return (
    <span title={title} className={cn("text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset", cls)}>
      {label}
      {typeof days === "number" && status !== "clear" ? ` ${days}d` : ""}
    </span>
  );
}

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
  const [tab, setTab] = useState<SdrTab>("leads");
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
            <TabButton current={tab} value="leads" onClick={setTab} icon={<Target className="h-4 w-4" />}>Leads</TabButton>
            <TabButton current={tab} value="queue" onClick={setTab} icon={<Inbox className="h-4 w-4" />}>Queue</TabButton>
            <TabButton current={tab} value="engaged" onClick={setTab} icon={<Flame className="h-4 w-4" />}>Engaged</TabButton>
            <TabButton current={tab} value="dashboard" onClick={setTab} icon={<LayoutGrid className="h-4 w-4" />}>Dashboard</TabButton>
            <TabButton current={tab} value="mailboxes" onClick={setTab} icon={<Mail className="h-4 w-4" />}>Mailboxes</TabButton>
            <TabButton current={tab} value="templates" onClick={setTab} icon={<SettingsIcon className="h-4 w-4" />}>Templates</TabButton>
            <TabButton current={tab} value="sequences" onClick={setTab} icon={<ListChecks className="h-4 w-4" />}>Sequences</TabButton>
            <TabButton current={tab} value="permits" onClick={setTab} icon={<FileSearch className="h-4 w-4" />}>Permits</TabButton>
          </div>
          {tab === "leads" && <LeadsView user={user} pushToast={push} onGenerated={() => setTab("queue")} />}
          {tab === "queue" && <QueueView user={user} mailboxById={mailboxById} pushToast={push} />}
          {tab === "engaged" && <EngagedView />}
          {tab === "dashboard" && <DashboardView />}
          {tab === "mailboxes" && <MailboxesView user={user} />}
          {tab === "templates" && <TemplatesView />}
          {tab === "sequences" && <SequencesView user={user} pushToast={push} />}
          {tab === "permits" && <PermitsTab pushToast={(m, k) => push(k ?? "success", m)} />}
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
// Leads — the front door: spacious pipeline of qualifying Pipedrive leads
// --------------------------------------------------------------------------

const LEADS_RENDER_CAP = 200;

type LeadStatusFilter = "all" | "fresh" | "contacted" | "sequenced";
type LeadTriggerFilter = "all" | SdrTriggerType;

const STAT_ACCENTS: Record<"green" | "amber" | "blue" | "slate", { ring: string; num: string; chip: string }> = {
  green: { ring: "border-emerald-200", num: "text-emerald-600", chip: "bg-emerald-50" },
  amber: { ring: "border-amber-200", num: "text-amber-600", chip: "bg-amber-50" },
  blue: { ring: "border-sky-200", num: "text-sky-600", chip: "bg-sky-50" },
  slate: { ring: "border-slate-200", num: "text-slate-700", chip: "bg-slate-50" },
};

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: keyof typeof STAT_ACCENTS;
}) {
  const a = STAT_ACCENTS[accent];
  return (
    <div className={cn("flex-1 min-w-[140px] rounded-2xl border bg-white px-5 py-4", a.ring)}>
      <div className={cn("text-3xl font-bold tabular-nums", a.num)}>{value}</div>
      <div className="mt-1 text-sm font-medium text-slate-500">{label}</div>
    </div>
  );
}

function LeadsView({
  user,
  pushToast,
  onGenerated,
}: {
  user: SdrUser;
  pushToast: (kind: "success" | "error", text: string) => void;
  onGenerated?: () => void;
}) {
  const isAdmin = user.role === "admin";
  const [leads, setLeads] = useState<SdrLead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<LeadStatusFilter>("all");
  const [triggerFilter, setTriggerFilter] = useState<LeadTriggerFilter>("all");
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [genId, setGenId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    sdrApi
      .listLeads()
      .then((d) => setLeads(d.leads))
      .catch((e) => {
        setLeads(null);
        setError((e as Error).message || "Failed to load leads");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    const c = { fresh: 0, contacted: 0, sequenced: 0, total: 0 };
    if (!leads) return c;
    for (const l of leads) {
      c.total++;
      if (l.outreach_status === "clear") c.fresh++;
      else if (l.outreach_status === "sequenced") c.sequenced++;
      else c.contacted++; // contacted_recent | contacted_stale
    }
    return c;
  }, [leads]);

  const newestSync = useMemo(() => {
    if (!leads || !leads.length) return null;
    let max = 0;
    for (const l of leads) {
      if (l.synced_at) {
        const t = new Date(l.synced_at).getTime();
        if (t > max) max = t;
      }
    }
    return max ? new Date(max).toISOString() : null;
  }, [leads]);

  const filtered = useMemo(() => {
    if (!leads) return [];
    const q = query.trim().toLowerCase();
    return leads.filter((l) => {
      if (statusFilter === "fresh" && l.outreach_status !== "clear") return false;
      if (statusFilter === "sequenced" && l.outreach_status !== "sequenced") return false;
      if (
        statusFilter === "contacted" &&
        l.outreach_status !== "contacted_recent" &&
        l.outreach_status !== "contacted_stale"
      )
        return false;
      if (triggerFilter !== "all" && l.trigger_type !== triggerFilter) return false;
      if (q) {
        const hay = `${l.lead_title ?? ""} ${l.person_name ?? ""} ${l.person_email ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [leads, statusFilter, triggerFilter, query]);

  const capped = filtered.slice(0, LEADS_RENDER_CAP);

  async function onRefresh() {
    setSyncing(true);
    try {
      await sdrApi.syncLeads();
      pushToast("success", "Resync started — leads update shortly.");
    } catch (e) {
      pushToast("error", `Resync failed: ${(e as Error).message}`);
    } finally {
      setTimeout(() => setSyncing(false), 4000);
    }
  }

  async function onOutreach(lead: SdrLead) {
    if (!lead.trigger_type) return;
    setGenId(lead.pipedrive_lead_id);
    try {
      await sdrApi.generateDraftFromLead({
        pipedrive_lead_id: lead.pipedrive_lead_id,
        trigger_type: lead.trigger_type,
        assigned_user_id: user.id,
      });
      pushToast("success", "Draft created — check the Queue tab.");
      onGenerated?.();
    } catch (e) {
      pushToast("error", `Could not create draft: ${(e as Error).message}`);
    } finally {
      setGenId(null);
    }
  }

  // ---- Loading ----
  if (!leads && !error) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-16 text-center">
        <Target className="h-8 w-8 text-slate-300 mx-auto mb-3 animate-pulse" />
        <div className="text-base font-medium text-slate-500">Loading leads…</div>
      </div>
    );
  }

  // ---- Error ----
  if (error) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-12 text-center">
        <AlertCircle className="h-8 w-8 text-rose-400 mx-auto mb-3" />
        <div className="text-base font-semibold text-rose-800">Couldn’t load leads</div>
        <p className="mt-1 text-sm text-rose-600">{error}</p>
        <button
          onClick={load}
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100"
        >
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary header */}
      <div className="flex flex-wrap items-stretch gap-4">
        <StatCard label="Fresh" value={counts.fresh} accent="green" />
        <StatCard label="Contacted" value={counts.contacted} accent="amber" />
        <StatCard label="Sequenced" value={counts.sequenced} accent="blue" />
        <StatCard label="Total leads" value={counts.total} accent="slate" />
        <div className="flex flex-1 min-w-[180px] flex-col items-end justify-center gap-2">
          <div className="text-sm text-slate-500">
            Synced{" "}
            <span className="font-medium text-slate-700">
              {newestSync ? formatRelative(newestSync) : "—"}
            </span>
          </div>
          {isAdmin && (
            <button
              onClick={onRefresh}
              disabled={syncing}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50",
                syncing && "opacity-60 cursor-not-allowed",
              )}
            >
              <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
              {syncing ? "Resyncing…" : "Refresh"}
            </button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1" role="group" aria-label="Status filter">
          {([
            ["all", "All"],
            ["fresh", "Fresh"],
            ["contacted", "Contacted"],
            ["sequenced", "Sequenced"],
          ] as [LeadStatusFilter, string][]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setStatusFilter(v)}
              aria-pressed={statusFilter === v}
              className={cn(
                "rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors",
                statusFilter === v ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <select
          value={triggerFilter}
          onChange={(e) => setTriggerFilter(e.target.value as LeadTriggerFilter)}
          className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700"
          aria-label="Trigger filter"
        >
          <option value="all">All triggers</option>
          <option value="AGC">AGC</option>
          <option value="LBA">LBA</option>
          <option value="CM">CM</option>
          <option value="PB">PB</option>
        </select>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search company, name, or email…"
          className="flex-1 min-w-[220px] rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none"
        />
      </div>

      <div className="text-sm text-slate-500">
        Showing {capped.length} of {filtered.length}
        {filtered.length !== counts.total ? ` (${counts.total} total)` : ""}
        {filtered.length > LEADS_RENDER_CAP ? ` · capped at ${LEADS_RENDER_CAP}` : ""}
      </div>

      {/* Empty state */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-16 text-center">
          <Target className="h-9 w-9 text-slate-300 mx-auto mb-3" />
          <div className="text-base font-semibold text-slate-700">
            {counts.total === 0 ? "No leads synced yet" : "No leads match these filters"}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {counts.total === 0
              ? isAdmin
                ? "Hit Refresh to pull qualifying leads from Pipedrive."
                : "Qualifying Pipedrive leads will appear here once synced."
              : "Try clearing the search or switching the status / trigger filters."}
          </p>
          {counts.total > 0 && (
            <button
              onClick={() => {
                setStatusFilter("all");
                setTriggerFilter("all");
                setQuery("");
              }}
              className="mt-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {capped.map((lead) => (
            <LeadCard
              key={lead.pipedrive_lead_id}
              lead={lead}
              busy={genId === lead.pipedrive_lead_id}
              onOutreach={() => onOutreach(lead)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LeadCard({
  lead,
  busy,
  onOutreach,
}: {
  lead: SdrLead;
  busy: boolean;
  onOutreach: () => void;
}) {
  const fresh = lead.outreach_status === "clear";
  const hasTrigger = !!lead.trigger_type;

  const contactLine =
    typeof lead.days_since_outgoing === "number"
      ? `Emailed ${lead.days_since_outgoing}d ago`
      : "Never contacted";

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 transition-colors hover:border-slate-300 hover:bg-slate-50/50">
      <div className="flex items-start gap-4">
        {/* Left: identity */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-bold text-slate-900">
            {lead.lead_title || "Untitled lead"}
          </div>
          <div className="mt-1 text-sm text-slate-500">
            {lead.person_name || "Unknown contact"}
            {lead.person_email ? <span className="text-slate-400"> · {lead.person_email}</span> : null}
          </div>
        </div>

        {/* Middle: status */}
        <div className="hidden flex-col items-start gap-2 sm:flex">
          <div className="flex items-center gap-2">
            <OutreachBadge status={lead.outreach_status} days={lead.days_since_outgoing} />
            {lead.trigger_type && (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
                  TRIGGER_COLORS[lead.trigger_type],
                )}
              >
                {lead.trigger_type}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-400">{contactLine}</div>
        </div>

        {/* Right: action */}
        <div className="flex flex-col items-end">
          <button
            onClick={onOutreach}
            disabled={!hasTrigger || busy}
            title={
              hasTrigger
                ? undefined
                : "Set a Trigger (AGC/LBA/CM/PB) on this lead in Pipedrive first."
            }
            className={cn(
              "inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors",
              !hasTrigger
                ? "cursor-not-allowed bg-slate-100 text-slate-400"
                : fresh
                  ? "bg-indigo-600 text-white hover:bg-indigo-700"
                  : "border border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-50",
              busy && "opacity-60",
            )}
          >
            {busy ? "Creating…" : "Outreach"}
            {!busy && <ChevronRight className="h-4 w-4" />}
          </button>
          {!hasTrigger && (
            <span className="mt-1.5 max-w-[180px] text-right text-xs text-slate-400">
              Needs a Trigger in Pipedrive
            </span>
          )}
        </div>
      </div>
    </div>
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
    const send = async (override: boolean) => {
      const result = await sdrApi.approveAndSendDraft(id, override);
      const warning = (result as { warning?: string }).warning;
      pushToast(warning ? "error" : "success", warning || "Draft approved — contact enrolled in Apollo.");
      await load();
      setExpandedId(null);
    };
    setBusyId(id);
    try {
      await send(false);
    } catch (e) {
      const err = e as Error & { status?: number; data?: { code?: string; daysAgo?: number; personName?: string } };
      // Dedup guard: lead already contacted in Pipedrive.
      if (err.status === 409 && err.data?.code === "already_outreached") {
        const who = err.data.personName || "This lead";
        const days = err.data.daysAgo ?? "?";
        if (user.role !== "admin") {
          pushToast("error", `Blocked — ${who} was already emailed ${days}d ago in Pipedrive. Admin override required.`);
        } else if (
          window.confirm(`⚠️ ${who} was already emailed ${days} days ago via Pipedrive.\n\nSend anyway? This will email them again.`)
        ) {
          try {
            await send(true);
          } catch (e2) {
            pushToast("error", `Override send failed: ${(e2 as Error).message}`);
            await load();
          }
        } else {
          pushToast("error", "Send cancelled — lead already contacted.");
        }
      } else {
        pushToast("error", `Approve & send failed: ${err.message}`);
        await load(); // status may have flipped to 'failed'
      }
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
        <OutreachBadge status={draft.outreach_status} days={draft.days_since_outgoing} />
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

// --------------------------------------------------------------------------
// Sequences — live Apollo sequence HTML editor (admin-only edit, instant save)
// --------------------------------------------------------------------------

function SequencesView({
  user,
  pushToast,
}: {
  user: SdrUser;
  pushToast: (kind: "success" | "error", text: string) => void;
}) {
  const isAdmin = user.role === "admin";
  const [sequences, setSequences] = useState<SdrSequence[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    sdrApi
      .listSequences()
      .then((d) => {
        if (!cancelled) setSequences(d.sequences);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error)
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
    );
  if (!sequences) return <div className="text-center text-slate-400 py-12">Loading…</div>;
  if (sequences.length === 0)
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-12 text-center text-sm text-slate-500">
        No Apollo sequences found.
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        These are <span className="font-semibold">LIVE Apollo sequences</span> that email real prospects. Edits
        save straight to Apollo — there is no separate publish step.
        {!isAdmin && <span className="block mt-1 font-semibold">Admins only can edit sequences.</span>}
      </div>
      {sequences.map((seq) => (
        <SequenceCard key={seq.id} seq={seq} isAdmin={isAdmin} pushToast={pushToast} />
      ))}
    </div>
  );
}

function SequenceCard({
  seq,
  isAdmin,
  pushToast,
}: {
  seq: SdrSequence;
  isAdmin: boolean;
  pushToast: (kind: "success" | "error", text: string) => void;
}) {
  const sortedSteps = useMemo(
    () =>
      [...seq.steps].sort((a, b) => {
        const pa = a.position ?? Number.MAX_SAFE_INTEGER;
        const pb = b.position ?? Number.MAX_SAFE_INTEGER;
        return pa - pb;
      }),
    [seq.steps],
  );

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-slate-900">{seq.name}</span>
        <span
          className={cn(
            "text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset",
            seq.active
              ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
              : "bg-slate-100 text-slate-500 ring-slate-200",
          )}
        >
          {seq.active ? "Active" : "Inactive"}
        </span>
        <span className="text-xs text-slate-500">
          — {seq.num_steps} step{seq.num_steps === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="divide-y divide-slate-100">
        {sortedSteps.map((step, i) => (
          <SequenceStepEditor
            key={step.template_id || i}
            seqName={seq.name}
            step={step}
            stepNumber={i + 1}
            isAdmin={isAdmin}
            pushToast={pushToast}
          />
        ))}
      </ul>
    </div>
  );
}

// Re-append the tracking pixel <img> if the visual editor stripped it on edit.
// The pixel is a trailing, display:none <img> pointing at /api/sdr/track/open/...
// If the original had one and the edited HTML lost it, put the original back.
function preservePixel(originalHtml: string, editedHtml: string): string {
  const pixelRe = /<img\b[^>]*\/api\/sdr\/track\/open\/[^>]*>/i;
  const origMatch = originalHtml.match(pixelRe);
  if (!origMatch) return editedHtml; // nothing to preserve
  if (pixelRe.test(editedHtml)) return editedHtml; // pixel survived
  // Re-append the original pixel (and the styled marker comment if it was present).
  const marker = /<!--\s*swppp-styled\s*-->/i.test(originalHtml) ? "<!--swppp-styled-->" : "";
  return editedHtml + marker + origMatch[0];
}

const RTE_COLORS: { label: string; value: string }[] = [
  { label: "Brand blue", value: "#1a5276" },
  { label: "Black", value: "#1f2937" },
  { label: "Slate", value: "#64748b" },
  { label: "Red", value: "#b91c1c" },
  { label: "Green", value: "#15803d" },
];

const RTE_FONTS = ["Georgia", "Arial", "Times New Roman"];

function RichTextEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [showSource, setShowSource] = useState(false);
  // Keep the last known original HTML (with pixel) so preservePixel can restore it.
  const originalRef = useRef(value);

  // Imperatively sync innerHTML only when the incoming value differs from the
  // live DOM — never on every render (that would move the caret).
  useEffect(() => {
    originalRef.current = value;
    const el = editorRef.current;
    if (el && !showSource && el.innerHTML !== value) {
      el.innerHTML = value;
    }
  }, [value, showSource]);

  const exec = (command: string, arg?: string) => {
    if (disabled) return;
    const el = editorRef.current;
    if (el) el.focus();
    document.execCommand(command, false, arg);
    if (el) onChange(preservePixel(originalRef.current, el.innerHTML));
  };

  const handleInput = () => {
    const el = editorRef.current;
    if (el) onChange(preservePixel(originalRef.current, el.innerHTML));
  };

  const btn =
    "px-2 py-1 rounded text-xs font-semibold border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="mt-1">
      {!disabled && !showSource && (
        <div className="flex flex-wrap items-center gap-1 rounded-t-lg border border-b-0 border-slate-200 bg-slate-50 px-2 py-1.5">
          <button type="button" className={cn(btn, "font-bold")} title="Bold" onClick={() => exec("bold")}>
            B
          </button>
          <button type="button" className={cn(btn, "italic")} title="Italic" onClick={() => exec("italic")}>
            I
          </button>
          <button type="button" className={cn(btn, "underline")} title="Underline" onClick={() => exec("underline")}>
            U
          </button>

          <span className="mx-1 h-4 w-px bg-slate-300" />

          {RTE_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              title={`Text color — ${c.label}`}
              onClick={() => exec("foreColor", c.value)}
              className="h-5 w-5 rounded border border-slate-300"
              style={{ backgroundColor: c.value }}
            />
          ))}

          <span className="mx-1 h-4 w-px bg-slate-300" />

          <select
            title="Font family"
            defaultValue={RTE_FONTS[0]}
            onChange={(e) => exec("fontName", e.target.value)}
            className="rounded border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700"
          >
            {RTE_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>

          <span className="mx-1 h-4 w-px bg-slate-300" />

          <button type="button" className={btn} title="Bulleted list" onClick={() => exec("insertUnorderedList")}>
            • List
          </button>
          <button
            type="button"
            className={btn}
            title="Insert link"
            onClick={() => {
              const url = window.prompt("Link URL:");
              if (url) exec("createLink", url);
            }}
          >
            Link
          </button>

          <span className="mx-1 h-4 w-px bg-slate-300" />

          <button
            type="button"
            className={cn(btn, "font-mono")}
            title="Toggle HTML source"
            onClick={() => setShowSource(true)}
          >
            {"</> Source"}
          </button>
        </div>
      )}

      {showSource && !disabled ? (
        <div>
          <div className="flex items-center justify-between rounded-t-lg border border-b-0 border-slate-200 bg-slate-50 px-2 py-1.5">
            <span className="text-[11px] font-semibold text-slate-500">HTML source</span>
            <button
              type="button"
              className={cn(btn, "font-mono")}
              title="Back to visual editor"
              onClick={() => setShowSource(false)}
            >
              Visual
            </button>
          </div>
          <textarea
            value={value}
            onChange={(e) => onChange(preservePixel(originalRef.current, e.target.value))}
            rows={10}
            className={cn(
              "w-full rounded-b-lg border border-slate-200 px-3 py-2 text-xs font-mono text-slate-800",
              "focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400",
            )}
          />
        </div>
      ) : (
        <div
          ref={editorRef}
          contentEditable={!disabled}
          onInput={handleInput}
          suppressContentEditableWarning
          className={cn(
            "min-h-[180px] w-full overflow-auto border border-slate-200 px-3 py-2 text-sm text-slate-800",
            "focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400",
            showSource ? "rounded-b-lg" : "rounded-b-lg",
            disabled
              ? "rounded-lg bg-slate-50 text-slate-500 cursor-not-allowed opacity-70"
              : "bg-white",
          )}
        />
      )}
    </div>
  );
}

function SequenceStepEditor({
  seqName,
  step,
  stepNumber,
  isAdmin,
  pushToast,
}: {
  seqName: string;
  step: SdrSequenceStep;
  stepNumber: number;
  isAdmin: boolean;
  pushToast: (kind: "success" | "error", text: string) => void;
}) {
  // Loaded baseline — updated after a successful save so dirty resets.
  const [baseline, setBaseline] = useState({ subject: step.subject, body_html: step.body_html });
  const [subject, setSubject] = useState(step.subject);
  const [bodyHtml, setBodyHtml] = useState(step.body_html);
  const [saving, setSaving] = useState(false);

  const dirty = subject !== baseline.subject || bodyHtml !== baseline.body_html;
  const readOnly = !isAdmin;

  const handleSave = async () => {
    if (!isAdmin || !dirty || saving) return;

    if (
      !window.confirm(
        "⚠️ You're editing a LIVE Apollo sequence that sends to real prospects. Continue?",
      )
    )
      return;

    const typed = window.prompt(
      'Type SAVE to push this change to the live sequence "' + seqName + '":',
    );
    if (typed !== "SAVE") {
      pushToast("error", "Save cancelled — type SAVE to confirm.");
      return;
    }

    setSaving(true);
    try {
      await sdrApi.updateSequenceTemplate(step.template_id, {
        subject,
        body_html: bodyHtml,
      });
      setBaseline({ subject, body_html: bodyHtml });
      pushToast("success", "Sequence step saved to Apollo");
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 403) {
        pushToast("error", "Forbidden — admins only can edit sequences.");
      } else {
        pushToast("error", err.message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="px-4 py-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
          Step {stepNumber}
        </span>
        {step.step_type && (
          <span className="text-[10px] text-slate-400 font-mono">{step.step_type}</span>
        )}
        {dirty && !readOnly && (
          <span className="text-[10px] font-semibold text-amber-600">unsaved changes</span>
        )}
      </div>

      <label className="block">
        <span className="text-xs font-medium text-slate-500">Subject</span>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={readOnly || saving}
          className={cn(
            "mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800",
            "focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400",
            (readOnly || saving) && "bg-slate-50 text-slate-500 cursor-not-allowed",
          )}
        />
      </label>

      <label className="block">
        <span className="text-xs font-medium text-slate-500">Body</span>
        <RichTextEditor value={bodyHtml} onChange={setBodyHtml} disabled={!isAdmin || saving} />
      </label>

      <p className="text-[11px] text-slate-400">
        Keep the{" "}
        <span className="font-mono text-slate-500">{"{{...}}"}</span> merge fields and the tracking pixel — they
        power personalization &amp; open tracking. Merge fields:{" "}
        <span className="font-mono text-slate-500">{"{{contact.swppp_draft_body}}"}</span> and{" "}
        <span className="font-mono text-slate-500">{"{{contact.swppp_track}}"}</span>.
      </p>

      {!readOnly && (
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors",
              !dirty || saving
                ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                : "bg-indigo-600 text-white hover:bg-indigo-700",
            )}
          >
            {saving && <RefreshCw className="h-4 w-4 animate-spin" />}
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </li>
  );
}
