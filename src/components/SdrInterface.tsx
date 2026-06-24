import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  ExternalLink,
  FileSearch,
  Flame,
  Inbox,
  LayoutGrid,
  ListChecks,
  LogOut,
  Mail,
  MousePointerClick,
  Phone,
  RefreshCw,
  Reply,
  Send,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Sprout,
  StickyNote,
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
  type SdrLeadDetail,
  type SdrLeadsResponse,
  type SdrLeadFilters,
  type SdrMailbox,
  type SdrSequence,
  type SdrSequenceStep,
  type SdrSettings,
  type SdrFirstTouchTemplate,
  type SdrTriggerType,
  type SdrUser,
  type SdrUserPublic,
  type SdrInboxAccount,
  type SdrInboxThread,
  type SdrInboxMessage,
} from "../lib/sdrApi";
import { cn } from "../utils";
import CampaignsView from "./nurture/CampaignsView";
import ListsView from "./nurture/ListsView";
import ContactsView from "./nurture/ContactsView";
import AutomationsView from "./nurture/AutomationsView";
import PermitsTab from "./permits/PermitsTab";

type SdrTab = "leads" | "queue" | "engaged" | "inbox" | "dashboard" | "mailboxes" | "templates" | "sequences" | "permits";
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
  CM: "Construction Manager",
  PB: "Project Bidder",
};

const TRIGGER_COLORS: Record<SdrTriggerType, string> = {
  AGC: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  LBA: "bg-sky-50 text-sky-700 ring-sky-200",
  CM: "bg-violet-50 text-violet-700 ring-violet-200",
  PB: "bg-amber-50 text-amber-700 ring-amber-200",
};

const STATUS_COLORS: Record<SdrDraft["status"], string> = {
  pending: "bg-slate-100 text-slate-700",
  edited: "bg-brand-100 text-brand-700",
  approved: "bg-brand-100 text-brand-700",
  sent: "bg-emerald-100 text-emerald-700",
  rejected: "bg-rose-100 text-rose-700",
  failed: "bg-rose-100 text-rose-700",
  cancelled: "bg-slate-100 text-slate-500",
};

// Dedup signal. IMPORTANT: "contacted_*" reflects when the CONTACT (person) was last
// emailed in Pipedrive across ANY project — it is a person-level dedup hint, NOT proof
// this specific lead was outreached. Only "sequenced" (lead-level Sequence_Started) and
// our own sends (outreached_by) mean THIS lead was actually worked.
const OUTREACH_BADGE: Record<string, { label: string; cls: string }> = {
  contacted_recent: { label: "Contact emailed", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  sequenced: { label: "In sequence", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  contacted_stale: { label: "Contact emailed · old", cls: "bg-slate-100 text-slate-500 ring-slate-200" },
  clear: { label: "Not contacted", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
};

function OutreachBadge({ status, days }: { status?: string | null; days?: number | null }) {
  if (!status || !OUTREACH_BADGE[status]) return null;
  const { label, cls } = OUTREACH_BADGE[status];
  const title =
    status === "clear"
      ? "No prior email to this contact found in Pipedrive"
      : status === "sequenced"
        ? "This lead is in an active sequence (Sequence_Started)"
        : `This CONTACT was emailed ${days ?? "?"}d ago in Pipedrive — across any project, not proof this lead was outreached. Dedup hint.`;
  return (
    <span title={title} className={cn("text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset", cls)}>
      {label}
      {typeof days === "number" && status !== "clear" && status !== "sequenced"
        ? ` · ${daysAgoLabel(days)}`
        : ""}
    </span>
  );
}

const SEND_STATUS_COLORS: Record<string, string> = {
  enrolled: "bg-brand-100 text-brand-700",
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

// "days ago" in plain English. days is a floored absolute-time difference, so 0 means
// "earlier today / a few hours ago" — never render the bare "0d ago" (reads like a bug).
function daysAgoLabel(days: number | null | undefined): string {
  if (typeof days !== "number") return "Never";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

// Floored days since an ISO timestamp; null when absent/unparseable.
function daysFromIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// Per-lead outreach attribution (from sdr_outreach_log): who sent + which system.
// Falls back to a sent-draft rep, then to nothing. Never invents a Pipedrive owner.
function outreachAttribution(lead: SdrLead): { who: string; src: string; title: string } | null {
  if (lead.outreach_source === "interface") {
    return {
      who: lead.outreach_sender_email || lead.outreach_sender_name || "Interface",
      src: "Interface",
      title: "Sent from this interface via Apollo",
    };
  }
  if (lead.outreach_source === "pipedrive") {
    return {
      who: lead.outreach_sender_name || lead.outreach_sender_email || "Pipedrive",
      src: "Pipedrive",
      title: "Sent from a Pipedrive-connected mailbox",
    };
  }
  if (lead.outreached_by) {
    return {
      who: lead.outreached_by,
      src: "Interface",
      title: lead.initiated_by === "automatic" ? "Auto-outreached by the engine" : "Outreached manually via this interface",
    };
  }
  return null;
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
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-100 text-brand-700 mb-3">
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
                "group flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition-all duration-200 hover:border-brand-300 hover:shadow-sm",
                busy === u.username && "opacity-50",
              )}
            >
              <div className="h-10 w-10 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-bold">
                {initials(u.display_name)}
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-slate-900">{u.display_name}</div>
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  {u.role === "admin" && <ShieldCheck className="h-3 w-3 text-brand-600" />}
                  {u.role}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-brand-500" />
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

// Read a ?lead=<id> param out of the hash (e.g. #/sdr?lead=abc) — used by the
// Pipedrive note backlink to open a specific lead's detail.
function readLeadParam(): string | null {
  const q = window.location.hash.split("?")[1];
  if (!q) return null;
  return new URLSearchParams(q).get("lead");
}

function SdrSignedIn({ user, onSignOut }: { user: SdrUser; onSignOut: () => void }) {
  const [lane, setLane] = useState<OutreachLane>(() => getLane());
  const [tab, setTab] = useState<SdrTab>("leads");
  const [nurtureTab, setNurtureTab] = useState<NurtureTab>("campaigns");
  const [drillListId, setDrillListId] = useState<number | null>(null);
  // Deep-link from Pipedrive: open this lead's drawer at the console level.
  const [deepLeadId, setDeepLeadId] = useState<string | null>(() => readLeadParam());
  useEffect(() => {
    const onHash = () => setDeepLeadId(readLeadParam());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  function closeDeepLead() {
    setDeepLeadId(null);
    // strip ?lead= from the URL so it doesn't reopen on refresh
    const base = window.location.hash.split("?")[0] || "#/sdr";
    window.history.replaceState(null, "", base);
  }

  // Return trip from the Gmail OAuth consent (#/sdr?tab=inbox&connected=… | &error=…).
  useEffect(() => {
    const hash = window.location.hash;
    const qi = hash.indexOf("?");
    if (qi === -1) return;
    const params = new URLSearchParams(hash.slice(qi + 1));
    if (params.get("tab") === "inbox") setTab("inbox");
    const connected = params.get("connected");
    const error = params.get("error");
    if (connected) push("success", `Inbox connected: ${connected}`);
    if (error) push("error", `Inbox connect failed: ${error}`);
    if (connected || error) window.history.replaceState(null, "", hash.slice(0, qi));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Hot-lead count for the Priority tab badge — surfaces leads someone has been
  // engaging with (clicked, replied, or opened 3+ times) without opening the tab.
  const [hotCount, setHotCount] = useState(0);
  const hotLeadsRef = useRef<SdrEngagementSummary["leads"]>([]);
  useEffect(() => {
    let stop = false;
    // Badge = hot leads not yet dismissed AND not yet seen (clicked into). Recompute
    // from the cached leads whenever a priority is clicked, so the count drops live.
    const recompute = () => {
      const dismissed = loadDismissed();
      const seen = loadSeen();
      setHotCount(hotLeadsRef.current.filter((l) => isHot(l) && !dismissed.has(l.draft_id) && !seen.has(l.draft_id)).length);
    };
    const load = () =>
      sdrApi
        .engagementSummary()
        .then((s) => {
          if (stop) return;
          hotLeadsRef.current = s.leads;
          recompute();
        })
        .catch(() => {});
    load();
    const iv = setInterval(load, 60_000);
    window.addEventListener("sdr:priority-seen", recompute);
    return () => { stop = true; clearInterval(iv); window.removeEventListener("sdr:priority-seen", recompute); };
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
      <div className="flex items-center justify-between mb-5 rounded-2xl bg-gradient-to-r from-brand-800 to-brand-600 px-6 py-5 text-white shadow-sm">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] font-bold text-brand-100">Pro SWPPP · SDR</div>
          <h2 className="text-2xl font-bold text-white">Outreach console</h2>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-sm font-semibold text-white">{user.display_name}</div>
            <div className="text-xs text-brand-100 flex items-center justify-end gap-1">
              {user.role === "admin" && <ShieldCheck className="h-3 w-3 text-brand-100" />}
              {user.role}
            </div>
          </div>
          <button
            onClick={onSignOut}
            className="rounded-xl border border-white/30 bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/20 flex items-center gap-2"
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
            lane === "cold" ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700",
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
          <div className="flex flex-wrap items-center gap-1 mb-6 rounded-xl border border-slate-200 bg-slate-50 p-1.5">
            <TabButton current={tab} value="leads" onClick={setTab} icon={<Target className="h-4 w-4" />}>Leads</TabButton>
            <TabButton current={tab} value="queue" onClick={setTab} icon={<Inbox className="h-4 w-4" />}>Queue</TabButton>
            <TabButton current={tab} value="engaged" onClick={setTab} icon={<Flame className="h-4 w-4" />} badge={hotCount}>Priority</TabButton>
            <TabButton current={tab} value="inbox" onClick={setTab} icon={<Inbox className="h-4 w-4" />}>Inbox</TabButton>
            <TabButton current={tab} value="dashboard" onClick={setTab} icon={<LayoutGrid className="h-4 w-4" />}>Dashboard</TabButton>
            <TabButton current={tab} value="mailboxes" onClick={setTab} icon={<Mail className="h-4 w-4" />}>Mailboxes</TabButton>
            <TabButton current={tab} value="templates" onClick={setTab} icon={<ListChecks className="h-4 w-4" />}>Templates</TabButton>
            <TabButton current={tab} value="permits" onClick={setTab} icon={<FileSearch className="h-4 w-4" />}>Permits</TabButton>
          </div>
          {tab === "leads" && <LeadsView user={user} pushToast={push} onGenerated={() => setTab("queue")} />}
          {tab === "queue" && <QueueView user={user} mailboxById={mailboxById} pushToast={push} />}
          {tab === "engaged" && <EngagedView pushToast={push} />}
          {tab === "inbox" && <InboxView user={user} pushToast={push} />}
          {tab === "dashboard" && <DashboardView />}
          {tab === "mailboxes" && <MailboxesView user={user} />}
          {(tab === "templates" || tab === "sequences") && <MessagingView user={user} pushToast={push} />}
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

      {/* Deep-link from Pipedrive (#/sdr?lead=<id>) → open that lead's detail */}
      {deepLeadId && (
        <LeadDetailDrawer
          leadId={deepLeadId}
          onClose={closeDeepLead}
          pushToast={push}
        />
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
  badge,
}: {
  current: SdrTab;
  value: SdrTab;
  onClick: (v: SdrTab) => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  badge?: number;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onClick(value)}
      className={cn(
        "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
        active
          ? "bg-brand-600 text-white shadow-sm"
          : "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
      )}
    >
      {icon}
      {children}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "ml-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold leading-none",
            active ? "bg-white text-brand-700" : "bg-rose-500 text-white",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// --------------------------------------------------------------------------
// Leads — the front door: spacious pipeline of qualifying Pipedrive leads
// --------------------------------------------------------------------------

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

const LEAD_PAGE_SIZE = 50;

type LeadSortKey =
  | "lead_title"
  | "project_stage"
  | "outreach_status"
  | "trigger_type"
  | "last_contact"
  | "bid_date"
  | "start_date"
  | "lead_score";

// Apollo sequence id → trigger label, for showing which sequence a lead is in.
const SEQUENCE_LABEL: Record<string, string> = {
  "6a2ac17c71c0fc000cecf469": "AGC",
  "6a2ac17eef87e000180cb54a": "LBA",
  "6a2ac18173bec0001018e927": "CM",
  "6a2ac184ac17ea000ce1b28f": "PB",
};

// Apollo enrollment status → human label for the sequence-stage chip.
const SEND_STAGE_LABEL: Record<string, string> = {
  enrolled: "In sequence",
  sent: "Email sent",
  replied: "Replied",
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
  failed: "Send failed",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
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
  const [resp, setResp] = useState<SdrLeadsResponse | null>(null);
  const [filterOpts, setFilterOpts] = useState<SdrLeadFilters | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<LeadStatusFilter>("all");
  const [triggerFilter, setTriggerFilter] = useState<LeadTriggerFilter>("all");
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [sort, setSort] = useState<LeadSortKey>("last_contact");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [genId, setGenId] = useState<string | null>(null);
  const [confirmLead, setConfirmLead] = useState<SdrLead | null>(null);
  const [noteLead, setNoteLead] = useState<SdrLead | null>(null);
  const [detailLeadId, setDetailLeadId] = useState<string | null>(null);

  // Debounce the search box so we don't hit the server on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  // Reset to page 1 whenever a filter/sort changes.
  useEffect(() => {
    setPage(1);
  }, [statusFilter, triggerFilter, stageFilter, sourceFilter, debouncedQ, sort, dir]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    sdrApi
      .listLeads({
        status: statusFilter === "all" ? undefined : statusFilter,
        trigger: triggerFilter === "all" ? undefined : triggerFilter,
        stage: stageFilter === "all" ? undefined : stageFilter,
        source: sourceFilter === "all" ? undefined : sourceFilter,
        q: debouncedQ || undefined,
        sort,
        dir,
        page,
        limit: LEAD_PAGE_SIZE,
      })
      .then((d) => setResp(d))
      .catch((e) => {
        setResp(null);
        setError((e as Error).message || "Failed to load leads");
      })
      .finally(() => setLoading(false));
  }, [statusFilter, triggerFilter, stageFilter, sourceFilter, debouncedQ, sort, dir, page]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    sdrApi.leadFilters().then(setFilterOpts).catch(() => setFilterOpts(null));
  }, []);

  const facets = resp?.facets.byStatus ?? {};
  const counts = {
    fresh: facets.clear ?? 0,
    contacted: (facets.contacted_recent ?? 0) + (facets.contacted_stale ?? 0),
    sequenced: facets.sequenced ?? 0,
    total: resp?.facets.grandTotal ?? 0,
  };

  function toggleSort(key: LeadSortKey) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(key === "last_contact" ? "desc" : "asc");
    }
  }

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

  // Fresh leads outreach immediately; already-contacted/sequenced leads route
  // through a confirmation that points the rep at the Pipedrive record first.
  function requestOutreach(lead: SdrLead) {
    if (!lead.trigger_type) return;
    if (lead.outreach_status === "clear") void doOutreach(lead);
    else setConfirmLead(lead);
  }

  async function doOutreach(lead: SdrLead, override = false) {
    if (!lead.trigger_type) return;
    setConfirmLead(null);
    setGenId(lead.pipedrive_lead_id);
    try {
      await sdrApi.generateDraftFromLead({
        pipedrive_lead_id: lead.pipedrive_lead_id,
        trigger_type: lead.trigger_type,
        assigned_user_id: user.id,
        override,
      });
      pushToast("success", "Draft created — check the Queue tab.");
      onGenerated?.();
    } catch (e) {
      const err = e as Error & { status?: number; data?: { code?: string; daysAgo?: number; personName?: string } };
      // Live freshness check caught an already-contacted lead the mirror missed.
      if (err.status === 409 && err.data?.code === "already_outreached") {
        const who = err.data.personName || lead.lead_title || "This lead";
        const days = err.data.daysAgo ?? "?";
        load(); // refresh — the mirror was just marked contacted
        if (user.role !== "admin") {
          pushToast("error", `Blocked — ${who} was already emailed ${days}d ago in Pipedrive. Admin override required.`);
        } else if (window.confirm(`⚠️ ${who} was already emailed ${days} days ago in Pipedrive (live check).\n\nOutreach anyway? This will email them again.`)) {
          await doOutreach(lead, true);
        } else {
          pushToast("error", "Cancelled — lead already contacted in Pipedrive.");
        }
      } else {
        pushToast("error", `Could not create draft: ${err.message}`);
      }
    } finally {
      setGenId(null);
    }
  }

  const leads = resp?.leads ?? [];
  const total = resp?.total ?? 0;
  const pages = resp?.pages ?? 1;
  const firstRow = total === 0 ? 0 : (page - 1) * LEAD_PAGE_SIZE + 1;
  const lastRow = Math.min(page * LEAD_PAGE_SIZE, total);

  const filtersActive = statusFilter !== "all" || triggerFilter !== "all" || stageFilter !== "all" || sourceFilter !== "all" || !!debouncedQ;

  return (
    <div className="space-y-6">
      {/* Summary header */}
      <div className="flex flex-wrap items-stretch gap-4">
        <StatCard label="Fresh" value={counts.fresh} accent="green" />
        <StatCard label="Contacted" value={counts.contacted} accent="amber" />
        <StatCard label="Sequenced" value={counts.sequenced} accent="blue" />
        <StatCard label="Total leads" value={counts.total} accent="slate" />
        <div className="flex flex-1 min-w-[180px] flex-col items-end justify-center gap-2">
          {(() => {
            const last = resp?.leads[0]?.synced_at;
            const ageH = last ? (Date.now() - new Date(last).getTime()) / 3600000 : Infinity;
            const fresh = ageH < 12;
            return (
              <div
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset",
                  fresh ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200",
                )}
                title="How recently the interface pulled the latest lead state from Pipedrive"
              >
                {fresh ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                {fresh ? "In sync with Pipedrive" : "Sync delayed"}
                <span className="font-normal opacity-70">· {last ? formatRelative(last) : "—"}</span>
              </div>
            );
          })()}
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
                statusFilter === v ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700",
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

        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 max-w-[220px]"
          aria-label="Stage filter"
        >
          <option value="all">All stages</option>
          {(filterOpts?.stages ?? []).map((s) => (
            <option key={s.v} value={s.v}>
              {s.v} ({s.n})
            </option>
          ))}
        </select>

        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700"
          aria-label="Outreach source filter"
          title="Filter by who last outreached this lead"
        >
          <option value="all">Any outreach</option>
          <option value="interface">Outreached · Interface</option>
          <option value="pipedrive">Outreached · Pipedrive</option>
          <option value="none">Not outreached</option>
        </select>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search company, name, or email…"
          className="flex-1 min-w-[220px] rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none"
        />
      </div>

      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>
          {total === 0 ? "No leads" : `Showing ${firstRow}–${lastRow} of ${total.toLocaleString()}`}
          {loading ? " · loading…" : ""}
        </span>
        {filtersActive && (
          <button
            onClick={() => {
              setStatusFilter("all");
              setTriggerFilter("all");
              setStageFilter("all");
              setSourceFilter("all");
              setQuery("");
            }}
            className="font-semibold text-brand-700 hover:text-brand-800"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Error */}
      {error ? (
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
      ) : total === 0 && !loading ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-16 text-center">
          <Target className="h-9 w-9 text-slate-300 mx-auto mb-3" />
          <div className="text-base font-semibold text-slate-700">
            {filtersActive ? "No leads match these filters" : "No leads synced yet"}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {filtersActive
              ? "Try clearing the search or switching filters."
              : isAdmin
                ? "Hit Refresh to pull qualifying leads from Pipedrive."
                : "Qualifying Pipedrive leads will appear here once synced."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1260px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <LeadTh label="Company / Project" sortKey="lead_title" sort={sort} dir={dir} onSort={toggleSort} />
                  <th className="px-4 py-3">Contact</th>
                  <LeadTh label="Stage" sortKey="project_stage" sort={sort} dir={dir} onSort={toggleSort} />
                  <LeadTh label="Score" sortKey="lead_score" sort={sort} dir={dir} onSort={toggleSort} />
                  <LeadTh label="Bid date" sortKey="bid_date" sort={sort} dir={dir} onSort={toggleSort} />
                  <LeadTh label="Start date" sortKey="start_date" sort={sort} dir={dir} onSort={toggleSort} />
                  <LeadTh label="Contact status" sortKey="outreach_status" sort={sort} dir={dir} onSort={toggleSort} />
                  <LeadTh label="Trigger" sortKey="trigger_type" sort={sort} dir={dir} onSort={toggleSort} />
                  <th className="px-4 py-3">Outreached by</th>
                  <th className="px-4 py-3" title="Latest real send for THIS lead (Pipedrive sent folder or our interface). Not the contact's any-deal email.">Last outreach</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {leads.map((lead) => (
                  <LeadRow
                    key={lead.pipedrive_lead_id}
                    lead={lead}
                    busy={genId === lead.pipedrive_lead_id}
                    onOutreach={() => requestOutreach(lead)}
                    onNote={() => setNoteLead(lead)}
                    onOpen={() => setDetailLeadId(lead.pipedrive_lead_id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
            <span className="text-slate-500">
              Page {page} of {pages.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" /> Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page >= pages || loading}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                Next <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmLead && (
        <OutreachConfirmModal
          lead={confirmLead}
          onCancel={() => setConfirmLead(null)}
          onConfirm={() => doOutreach(confirmLead, true)}
        />
      )}

      {noteLead && (
        <PipedriveNoteModal
          lead={noteLead}
          onClose={() => setNoteLead(null)}
          onSaved={() => {
            pushToast("success", "Note added to Pipedrive.");
            setNoteLead(null);
          }}
          onError={(msg) => pushToast("error", msg)}
        />
      )}

      {detailLeadId && (
        <LeadDetailDrawer
          leadId={detailLeadId}
          onClose={() => setDetailLeadId(null)}
          onOutreach={(lead) => requestOutreach(lead)}
          onChanged={load}
          pushToast={pushToast}
        />
      )}
    </div>
  );
}

// Right slide-out with the full picture for one lead: identity, Pipedrive deep
// link, our outreach timeline (drafts/sends/engagement), and quick actions.
function LeadDetailDrawer({
  leadId,
  onClose,
  onOutreach,
  onChanged,
  pushToast,
}: {
  leadId: string;
  onClose: () => void;
  onOutreach?: (lead: SdrLead) => void;
  onChanged?: () => void;
  pushToast: (kind: "success" | "error", text: string) => void;
}) {
  const [detail, setDetail] = useState<SdrLeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [stages, setStages] = useState<{ v: string; n: number }[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [stageEdit, setStageEdit] = useState<string>("");
  const [savingStage, setSavingStage] = useState(false);
  const [savingTrigger, setSavingTrigger] = useState(false);
  const [showActivity, setShowActivity] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    sdrApi
      .leadDetail(leadId)
      .then((d) => { if (!cancelled) { setDetail(d); setStageEdit(d.lead?.project_stage || ""); } })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [leadId, reloadKey]);

  useEffect(() => {
    sdrApi.leadFilters().then((f) => setStages(f.stages)).catch(() => setStages([]));
  }, []);

  const reload = () => { setReloadKey((k) => k + 1); onChanged?.(); };

  async function saveStage() {
    if (!stageEdit || stageEdit === detail?.lead?.project_stage) return;
    setSavingStage(true);
    try {
      const r = await sdrApi.updateLeadStage(leadId, stageEdit);
      pushToast("success", `Stage updated to ${r.project_stage} in Pipedrive${r.trigger_type ? ` (trigger ${r.trigger_type})` : ""}.`);
      reload();
    } catch (e) {
      pushToast("error", `Couldn't update stage: ${(e as Error).message}`);
    } finally {
      setSavingStage(false);
    }
  }

  // Trigger override — Postgres-only, no Pipedrive write. "" reverts to stage-derived.
  async function setTrigger(value: string) {
    setSavingTrigger(true);
    try {
      const r = await sdrApi.setLeadTrigger(leadId, value);
      pushToast("success", value ? `Trigger set to ${r.trigger_type}.` : "Trigger reverted to stage-derived.");
      reload();
    } catch (e) {
      pushToast("error", `Couldn't set trigger: ${(e as Error).message}`);
    } finally {
      setSavingTrigger(false);
    }
  }

  // Merge sends + engagement events into one timeline, newest first.
  const timeline = useMemo(() => {
    if (!detail) return [];
    const items: { kind: string; label: string; at: string | null; tone: string; subject?: string | null; body?: string | null; from?: string | null; signature?: string | null }[] = [];
    for (const d of detail.drafts) {
      const sent = d.status === "sent";
      items.push({
        kind: "draft",
        label: sent ? `Email sent${d.assigned_to ? ` · ${d.assigned_to}` : ""}` : `Draft ${d.status}${d.assigned_to ? ` · ${d.assigned_to}` : ""}`,
        at: sent ? (d.sent_at || d.created_at) : d.created_at,
        tone: sent ? "brand" : "slate",
        subject: d.subject,
        body: sent ? d.body : null, // show the exact email that went out
        from: d.sent_from, // which mailbox it was sent from
        signature: sent ? d.sender_signature : null, // append the real signature in the preview
      });
    }
    for (const s of detail.sends) {
      const seq = s.apollo_sequence_id ? SEQUENCE_LABEL[s.apollo_sequence_id] : null;
      items.push({ kind: "send", label: `${seq ? seq + " · " : ""}${SEND_STAGE_LABEL[s.status] || s.status}`, at: s.sent_at, tone: "brand" });
    }
    for (const e of detail.events) {
      items.push({ kind: "event", label: e.event_type + (e.mailbox_email ? ` · ${e.mailbox_email}` : ""), at: e.occurred_at, tone: "emerald" });
    }
    return items.sort((a, b) => (new Date(b.at || 0).getTime()) - (new Date(a.at || 0).getTime()));
  }, [detail]);

  const lead = detail?.lead;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-[480px] flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 bg-gradient-to-r from-brand-800 to-brand-600 px-5 py-4 text-white">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-brand-100">Lead detail</div>
            <h3 className="truncate text-lg font-bold">{lead?.lead_title || "Loading…"}</h3>
            <a
              href={pipedriveLeadUrl(leadId)}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-100 hover:text-white"
            >
              Open in Pipedrive <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-white/80 hover:bg-white/15 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
          ) : !detail ? (
            <div className="py-12 text-center text-sm text-slate-400">Loading…</div>
          ) : (
            <div className="space-y-5">
              {/* Snapshot */}
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <DrawerField label="Contact" value={lead?.person_name} />
                <DrawerField label="Email" value={lead?.person_email} />
                <DrawerField
                  label="Trigger"
                  value={
                    lead?.trigger_type
                      ? `${lead.trigger_type} — ${TRIGGER_LABELS[lead.trigger_type] ?? ""}`
                      : "—"
                  }
                />
                <DrawerField
                  label="Lead score"
                  value={typeof lead?.lead_score === "number" ? String(Math.round(lead.lead_score)) : "—"}
                />
                <DrawerField
                  label="Contact status"
                  value={lead?.outreach_status ? OUTREACH_BADGE[lead.outreach_status]?.label ?? lead.outreach_status : "—"}
                />
                <DrawerField label="Bid date" value={formatDate(lead?.bid_date ?? null)} />
                <DrawerField label="Start date" value={formatDate(lead?.start_date ?? null)} />
                <DrawerField
                  label="Last outreach (this lead)"
                  value={
                    lead?.outreach_sent_at
                      ? `${formatDate(lead.outreach_sent_at)} · ${lead.outreach_sender_name || lead.outreach_sender_email || lead.outreach_source} · ${lead.outreach_source}`
                      : "Not outreached"
                  }
                />
                <DrawerField
                  label="Contact last emailed (any deal)"
                  value={daysAgoLabel(lead?.days_since_outgoing)}
                />
                {lead?.send_sequence_id && (
                  <DrawerField
                    label="Sequence"
                    value={`${SEQUENCE_LABEL[lead.send_sequence_id] || ""} · ${lead.send_status ? SEND_STAGE_LABEL[lead.send_status] || lead.send_status : ""}`}
                  />
                )}
              </dl>

              {/* Editable stage (writes back to Pipedrive, re-derives trigger) */}
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="text-xs font-medium text-slate-400">Project stage</div>
                <div className="mt-1.5 flex items-center gap-2">
                  <select
                    value={stageEdit}
                    onChange={(e) => setStageEdit(e.target.value)}
                    className="flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800"
                  >
                    {!stages.some((s) => s.v === stageEdit) && stageEdit && <option value={stageEdit}>{stageEdit}</option>}
                    {stages.map((s) => (
                      <option key={s.v} value={s.v}>{s.v}</option>
                    ))}
                  </select>
                  <button
                    onClick={saveStage}
                    disabled={savingStage || !stageEdit || stageEdit === lead?.project_stage}
                    className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
                  >
                    {savingStage ? "Saving…" : "Save"}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-slate-400">Updates Pipedrive and re-derives the outreach trigger.</p>
              </div>

              {/* Trigger override (Postgres-only — does not touch Pipedrive) */}
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-400">Outreach trigger</span>
                  {lead?.trigger_override && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
                      manual override
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <select
                    value={lead?.trigger_override || ""}
                    disabled={savingTrigger}
                    onChange={(e) => setTrigger(e.target.value)}
                    className="flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800"
                  >
                    <option value="">Auto (from stage{lead?.trigger_type && !lead?.trigger_override ? `: ${lead.trigger_type}` : ""})</option>
                    {(["AGC", "LBA", "CM", "PB"] as const).map((t) => (
                      <option key={t} value={t}>{t} — {TRIGGER_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
                <p className="mt-1.5 text-xs text-slate-400">
                  Manual override (stored here, not in Pipedrive). Wins over the stage-derived trigger.
                </p>
              </div>

              {/* Timeline */}
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Activity timeline</div>
                {timeline.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
                    No outreach activity yet.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {timeline.map((t, i) => (
                      <li key={i} className="rounded-xl border border-slate-100 px-3 py-2">
                        <div className="flex items-center gap-3">
                          <span
                            className={cn(
                              "h-2 w-2 flex-shrink-0 rounded-full",
                              t.tone === "brand" ? "bg-brand-500" : t.tone === "emerald" ? "bg-emerald-500" : "bg-slate-300",
                            )}
                          />
                          <span className="flex-1 text-sm text-slate-700">{t.label}</span>
                          <span className="text-xs text-slate-400">{formatRelative(t.at)}</span>
                        </div>
                        {/* Show the exact email that was sent (from, subject + body + signature). */}
                        {t.subject && (
                          <div className="mt-1.5 pl-5">
                            {t.from && <div className="text-xs text-slate-500">From: {t.from}</div>}
                            <div className="text-xs font-medium text-slate-600">Subject: {t.subject}</div>
                            {t.body && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-xs text-brand-600 hover:underline">View email</summary>
                                <div
                                  className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-800"
                                  style={{ fontFamily: 'Georgia, "Times New Roman", serif', color: "#1a5276" }}
                                  dangerouslySetInnerHTML={{ __html: firstTouchPreview(t.body, t.signature || undefined) }}
                                />
                              </details>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions footer */}
        {lead && (
          <div className="border-t border-slate-200 px-5 py-3">
            {showActivity ? (
              <ActivityForm
                leadId={leadId}
                onCancel={() => setShowActivity(false)}
                onDone={() => { setShowActivity(false); reload(); pushToast("success", "Activity logged in Pipedrive."); }}
                onError={(m) => pushToast("error", m)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setNoteOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <StickyNote className="h-4 w-4" /> Note
                </button>
                <button
                  onClick={() => setShowActivity(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Phone className="h-4 w-4" /> Log activity
                </button>
                {onOutreach && lead.trigger_type && (
                  <button
                    onClick={() => { onOutreach(lead); onClose(); }}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-cta-500 px-3 py-2 text-sm font-semibold text-white hover:bg-cta-600"
                  >
                    Outreach <ChevronRight className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {noteOpen && lead && (
        <PipedriveNoteModal
          lead={lead}
          onClose={() => setNoteOpen(false)}
          onSaved={() => { setNoteOpen(false); pushToast("success", "Note added to Pipedrive."); }}
          onError={(msg) => pushToast("error", msg)}
        />
      )}
    </div>
  );
}

function DrawerField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-400">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-slate-800">{value || "—"}</dd>
    </div>
  );
}

function ActivityForm({
  leadId,
  onCancel,
  onDone,
  onError,
}: {
  leadId: string;
  onCancel: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [type, setType] = useState("call");
  const [subject, setSubject] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [done, setDone] = useState(true);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!subject.trim()) return;
    setSaving(true);
    try {
      await sdrApi.logActivity(leadId, { subject: subject.trim(), type, due_date: dueDate || null, done });
      onDone();
    } catch (e) {
      onError(`Couldn't log activity: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800"
        >
          <option value="call">Call</option>
          <option value="task">Task</option>
          <option value="meeting">Meeting</option>
          <option value="email">Email</option>
        </select>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject (e.g. Called re: SWPPP scope)"
          className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm focus:border-brand-400 focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          Due
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} /> Mark done
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-100">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !subject.trim()}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {saving ? "Logging…" : "Log to Pipedrive"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Add a note to a lead in Pipedrive from the interface (two-way sync).
function PipedriveNoteModal({
  lead,
  onClose,
  onSaved,
  onError,
}: {
  lead: SdrLead;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    const text = content.trim();
    if (!text) return;
    setSaving(true);
    try {
      await sdrApi.addLeadNote(lead.pipedrive_lead_id, text);
      onSaved();
    } catch (e) {
      onError(`Could not add note: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
            <StickyNote className="h-5 w-5 text-brand-700" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900">Add note to Pipedrive</h3>
            <p className="text-xs text-slate-500">{lead.lead_title || `Lead #${lead.pipedrive_lead_id}`}</p>
          </div>
        </div>

        <textarea
          autoFocus
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          placeholder="Write a note — it'll be added to this lead in Pipedrive, tagged with your name."
          className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none"
        />

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !content.trim()}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Add note"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LeadTh({
  label,
  sortKey,
  sort,
  dir,
  onSort,
}: {
  label: string;
  sortKey: LeadSortKey;
  sort: LeadSortKey;
  dir: "asc" | "desc";
  onSort: (k: LeadSortKey) => void;
}) {
  const active = sort === sortKey;
  return (
    <th className="px-4 py-3">
      <button
        onClick={() => onSort(sortKey)}
        className={cn("inline-flex items-center gap-1 hover:text-slate-800", active && "text-brand-700")}
      >
        {label}
        {active ? (
          dir === "asc" ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 text-slate-300" />
        )}
      </button>
    </th>
  );
}

function LeadRow({
  lead,
  busy,
  onOutreach,
  onNote,
  onOpen,
}: {
  lead: SdrLead;
  busy: boolean;
  onOutreach: () => void;
  onNote: () => void;
  onOpen: () => void;
}) {
  const fresh = lead.outreach_status === "clear";
  const hasTrigger = !!lead.trigger_type;
  // NOTE: half-wired (Ivan WIP) — declared but not yet referenced in JSX, which fails
  // `tsc -b` (noUnusedLocals) and blocks the build/deploy. Commented to unblock; re-enable
  // when the "contacted manually" indicator is wired in.
  // const contactedManually =
  //   !lead.outreached_by && lead.outreach_status !== "clear" && lead.last_outgoing_mail_time;
  const stageLabel = lead.send_status ? SEND_STAGE_LABEL[lead.send_status] || lead.send_status : null;
  const seqLabel = lead.send_sequence_id ? SEQUENCE_LABEL[lead.send_sequence_id] : null;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <tr className="cursor-pointer text-sm hover:bg-brand-50/40" onClick={onOpen}>
      {/* Company / Project */}
      <td className="px-4 py-3 align-top">
        <div className="font-semibold text-slate-900">{lead.lead_title || "Untitled lead"}</div>
        <a
          href={pipedriveLeadUrl(lead.pipedrive_lead_id)}
          target="_blank"
          rel="noreferrer"
          onClick={stop}
          className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-brand-600"
        >
          Pipedrive <ExternalLink className="h-3 w-3" />
        </a>
      </td>
      {/* Contact */}
      <td className="px-4 py-3 align-top">
        <div className="text-slate-800">{lead.person_name || "—"}</div>
        {lead.person_email && <div className="text-xs text-slate-400">{lead.person_email}</div>}
      </td>
      {/* Stage */}
      <td className="px-4 py-3 align-top text-slate-600">{lead.project_stage || "—"}</td>
      {/* Lead score (Pipedrive) — priority signal */}
      <td className="px-4 py-3 align-top whitespace-nowrap">
        {lead.lead_score == null ? (
          <span className="text-slate-300">—</span>
        ) : (
          <span
            className={`inline-flex min-w-[2.25rem] justify-center rounded px-2 py-0.5 text-xs font-semibold tabular-nums ${
              lead.lead_score >= 40
                ? "bg-emerald-100 text-emerald-700"
                : lead.lead_score >= 20
                  ? "bg-amber-100 text-amber-700"
                  : lead.lead_score >= 0
                    ? "bg-slate-100 text-slate-600"
                    : "bg-slate-50 text-slate-400"
            }`}
            title="Pipedrive Lead Score — 40+ hot · 20+ warm · below 0 cold"
          >
            {Math.round(lead.lead_score)}
          </span>
        )}
      </td>
      {/* Bid date */}
      <td className="px-4 py-3 align-top whitespace-nowrap text-slate-600">{formatDate(lead.bid_date)}</td>
      {/* Start date */}
      <td className="px-4 py-3 align-top whitespace-nowrap text-slate-600">{formatDate(lead.start_date)}</td>
      {/* Contact status (+ sequence stage when enrolled via our system) */}
      <td className="px-4 py-3 align-top">
        <OutreachBadge status={lead.outreach_status} days={lead.days_since_outgoing} />
        {stageLabel && (
          <div className="mt-1 text-xs font-medium text-brand-700">
            {seqLabel ? `${seqLabel} · ` : ""}
            {typeof lead.send_current_step === "number" && lead.send_total_steps
              ? `Step ${lead.send_current_step}/${lead.send_total_steps}`
              : stageLabel}
            {lead.send_next_at
              ? ` · next ${formatRelative(lead.send_next_at)}`
              : lead.send_sent_at
                ? ` · ${formatRelative(lead.send_sent_at)}`
                : ""}
          </div>
        )}
      </td>
      {/* Trigger */}
      <td className="px-4 py-3 align-top">
        {lead.trigger_type ? (
          <span
            title={TRIGGER_LABELS[lead.trigger_type] ?? undefined}
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
              TRIGGER_COLORS[lead.trigger_type],
            )}
          >
            {lead.trigger_type}
          </span>
        ) : (
          <span className="text-xs text-slate-400">none</span>
        )}
      </td>
      {/* Outreach / owner. Only OUR system sending counts as "outreached" (lead-level
          truth). Otherwise we only know the Pipedrive owner — shown clearly as owner,
          never as proof this lead was outreached (the contact-level email lives in the
          status badge + "Contact last emailed" column). */}
      <td className="px-4 py-3 align-top text-slate-600">
        {(() => {
          const a = outreachAttribution(lead);
          if (!a) return <span className="text-slate-300" title="No send recorded for this lead">—</span>;
          return (
            <span title={a.title}>
              {a.who} <span className="text-xs text-slate-400">· {a.src}</span>
            </span>
          );
        })()}
      </td>
      {/* Last outreach — latest real send for THIS lead (sdr_outreach_log), lead-level
          truth. Replaces the person-level "Contact emailed (any deal)" that bled across
          every lead a contact sits on. Person-level signal now lives in the drawer. */}
      <td
        className="px-4 py-3 align-top text-slate-600"
        title={lead.outreach_sent_at ? `${formatDate(lead.outreach_sent_at)} · ${lead.outreach_source}` : "No send recorded for this lead"}
      >
        {lead.outreach_sent_at ? (
          daysAgoLabel(daysFromIso(lead.outreach_sent_at))
        ) : (
          <span className="text-slate-300">Not outreached</span>
        )}
      </td>
      {/* Action */}
      <td className="px-4 py-3 align-top text-right">
        <div className="inline-flex items-center gap-1.5">
          <button
            onClick={(e) => { stop(e); onNote(); }}
            title="Add a note to this lead in Pipedrive"
            className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 hover:text-brand-700"
          >
            <StickyNote className="h-4 w-4" />
          </button>
          <button
            onClick={(e) => { stop(e); onOutreach(); }}
            disabled={!hasTrigger || busy}
            title={hasTrigger ? undefined : "Set a Trigger (AGC/LBA/CM/PB) on this lead in Pipedrive first."}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors",
              !hasTrigger
                ? "cursor-not-allowed bg-slate-100 text-slate-400"
                : fresh
                  ? "bg-cta-500 text-white hover:bg-cta-600"
                  : "border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100",
              busy && "opacity-60",
            )}
          >
            {busy ? "Creating…" : fresh ? "Outreach" : "Review"}
            {!busy && <ChevronRight className="h-4 w-4" />}
          </button>
        </div>
      </td>
    </tr>
  );
}

// Double-confirm before outreaching a lead that's already been contacted /
// sequenced — sends the rep to verify the Pipedrive record first.
function OutreachConfirmModal({
  lead,
  onCancel,
  onConfirm,
}: {
  lead: SdrLead;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const days = lead.days_since_outgoing;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-amber-100">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900">Are you sure?</h3>
            <p className="mt-1 text-sm text-slate-600">
              <span className="font-semibold">{lead.lead_title || "This lead"}</span> is already marked as{" "}
              <span className="font-semibold">
                {lead.outreach_status === "sequenced" ? "in an Apollo sequence" : "outreached"}
              </span>
              {typeof days === "number" ? ` (last emailed ${days}d ago)` : ""}. Check the lead on Pipedrive before
              sending again.
            </p>
          </div>
        </div>

        <a
          href={pipedriveLeadUrl(lead.pipedrive_lead_id)}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-100"
        >
          Check lead on Pipedrive <ExternalLink className="h-4 w-4" />
        </a>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-cta-500 px-4 py-2 text-sm font-semibold text-white hover:bg-cta-600"
          >
            Outreach anyway
          </button>
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

  const counts = useMemo(() => {
    const c = { open: 0, pending: 0, sent: 0, failed: 0 };
    for (const d of drafts || []) {
      if (["pending", "approved", "edited"].includes(d.status)) c.open++;
      if (d.status === "pending") c.pending++;
      if (d.status === "sent") c.sent++;
      if (d.status === "failed") c.failed++;
    }
    return c;
  }, [drafts]);

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
      const err = e as Error & { status?: number; data?: { code?: string; daysAgo?: number; personName?: string; mailbox?: string; sentToday?: number; cap?: number; rampDay?: number } };
      // Warmup ramp: this mailbox hit its daily send cap.
      if (err.status === 429 && err.data?.code === "daily_cap_reached") {
        pushToast("error", `Daily cap reached for ${err.data.mailbox} — ${err.data.sentToday}/${err.data.cap} sent (warmup day ${err.data.rampDay}). Cap rises as the inbox warms; try again tomorrow.`);
        await load();
      } else if (err.status === 409 && err.data?.code === "already_outreached") {
        // Dedup guard: lead already contacted in Pipedrive.
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
      {drafts && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <StatTile label="Open" value={counts.open} icon={<Inbox className="h-4 w-4" />} tone="indigo" />
          <StatTile label="Awaiting review" value={counts.pending} icon={<ListChecks className="h-4 w-4" />} tone="slate" />
          <StatTile label="Sent" value={counts.sent} icon={<Send className="h-4 w-4" />} tone="emerald" />
          <StatTile label="Failed" value={counts.failed} icon={<XCircle className="h-4 w-4" />} tone="rose" />
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setStatusFilter("open")}
            className={cn(
              "rounded-xl px-3 py-1.5 text-sm font-semibold",
              statusFilter === "open" ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
            )}
          >
            Open
          </button>
          <button
            onClick={() => setStatusFilter("all")}
            className={cn(
              "rounded-xl px-3 py-1.5 text-sm font-semibold",
              statusFilter === "all" ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
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
            Drafts appear here for approval when auto-outreach runs in queue mode, or when you queue one from a lead.
            In send mode it enrolls leads directly, so there's nothing to review.
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
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-brand-600 flex-shrink-0"
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
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-400"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Body</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={!canSend || busy}
              rows={12}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-mono focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-400"
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
            <div className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 flex items-center gap-3">
              <Send className="h-4 w-4 text-brand-600 flex-shrink-0" />
              <div className="flex-1 text-sm text-brand-900">
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
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-50"
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
                  className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-50 flex items-center gap-2"
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

// Priority "notifications" the rep has dismissed. Persisted client-side (per browser) so a
// dismissed lead stays hidden from the Priority list AND the tab badge across reloads.
const PRIORITY_DISMISS_KEY = "sdr.priority.dismissed";
function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PRIORITY_DISMISS_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveDismissed(s: Set<string>) {
  try {
    localStorage.setItem(PRIORITY_DISMISS_KEY, JSON.stringify([...s]));
  } catch {
    /* localStorage unavailable — dismissals just won't persist */
  }
}

// Priority items the rep has SEEN (clicked into). Distinct from dismissed: a seen item
// stays in the list, it just stops counting toward the tab's notification badge. Persisted
// per browser so the badge stays cleared across reloads.
const PRIORITY_SEEN_KEY = "sdr.priority.seen";
function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PRIORITY_SEEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
// Mark a priority lead seen and notify the badge to recompute live (no refetch).
function markPrioritySeen(id: string) {
  try {
    const s = loadSeen();
    if (s.has(id)) return;
    s.add(id);
    localStorage.setItem(PRIORITY_SEEN_KEY, JSON.stringify([...s]));
    window.dispatchEvent(new Event("sdr:priority-seen"));
  } catch {
    /* localStorage unavailable — badge just won't persist as cleared */
  }
}

function EngagedView({ pushToast }: { pushToast: (kind: "success" | "error", text: string) => void }) {
  const [summary, setSummary] = useState<SdrEngagementSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailLeadId, setDetailLeadId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);

  function dismiss(id: string) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissed(next);
      return next;
    });
  }
  function restoreDismissed() {
    setDismissed(() => {
      const empty = new Set<string>();
      saveDismissed(empty);
      return empty;
    });
  }

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

  const visible = summary.leads.filter((l) => !dismissed.has(l.draft_id));
  const hiddenCount = summary.leads.length - visible.length;
  const hot = visible.filter(isHot);

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
            <div className="flex items-center gap-3">
              {hiddenCount > 0 && (
                <button
                  onClick={restoreDismissed}
                  className="text-xs font-medium text-slate-400 hover:text-brand-600"
                  title="Restore dismissed priority items"
                >
                  {hiddenCount} dismissed · restore
                </button>
              )}
              <div className="text-xs text-slate-400">Replies ×10 · Clicks ×5 · Opens ×1 · recent activity weighs more</div>
            </div>
          </div>
          {visible.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">
              All caught up — nothing in the priority list right now.
            </div>
          ) : (
          <ul className="divide-y divide-slate-100">
            {visible.map((l) => (
              <li
                key={l.draft_id}
                onClick={() => { markPrioritySeen(l.draft_id); setDetailLeadId(l.pipedrive_lead_id); }}
                className={cn("px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-brand-50/40", isHot(l) && "bg-amber-50/50")}
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
                  onClick={(e) => e.stopPropagation()}
                  title="Open lead in Pipedrive"
                  className="text-slate-400 hover:text-brand-600 flex-shrink-0"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
                <button
                  onClick={(e) => { e.stopPropagation(); dismiss(l.draft_id); }}
                  title="Dismiss from priority"
                  className="text-slate-300 hover:text-rose-500 flex-shrink-0"
                >
                  <XCircle className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
          )}
        </div>
      )}

      {detailLeadId && (
        <LeadDetailDrawer
          leadId={detailLeadId}
          onClose={() => setDetailLeadId(null)}
          onChanged={load}
          pushToast={pushToast}
        />
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
    indigo: "bg-brand-50 text-brand-700",
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
// Inbox (Gmail per .co mailbox)
// --------------------------------------------------------------------------

function emailFromHeader(s: string | null | undefined): string {
  if (!s) return "";
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

type OverviewThread = SdrInboxThread & { mailbox: string; to?: string | null; openable?: boolean; outreached?: boolean; direction?: "in" | "out"; kind?: "sdr" | "permit"; permit?: { operator_key: string; contact_name: string | null } };

function nameFromHeader(s: string | null | undefined): string {
  if (!s) return "";
  const m = s.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m ? m[1] : emailFromHeader(s)).trim();
}

function InboxView({ user, pushToast }: { user: SdrUser; pushToast: (kind: "success" | "error", msg: string) => void }) {
  const [accounts, setAccounts] = useState<SdrInboxAccount[] | null>(null);
  const [view, setView] = useState<"outreach" | "mailbox">("outreach");
  const [mailbox, setMailbox] = useState<string | null>(null);
  const [threads, setThreads] = useState<OverviewThread[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openMailbox, setOpenMailbox] = useState<string | null>(null);
  const [thread, setThread] = useState<SdrInboxMessage[] | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    sdrApi
      .getInboxAccounts()
      .then((d) => {
        setAccounts(d.accounts);
        setMailbox((cur) => cur ?? d.accounts.find((a) => a.connected)?.email ?? null);
      })
      .catch((e) => pushToast("error", e.message));
  }, [pushToast]);

  const loadList = useCallback(() => {
    setLoading(true);
    setOpenId(null);
    setThread(null);
    const p =
      view === "outreach"
        ? sdrApi.getInboxOverview().then((d) => d.threads as OverviewThread[])
        : mailbox
          ? sdrApi.getInboxThreads(mailbox).then((d) => (d.threads as OverviewThread[]).map((t) => ({ ...t, mailbox: mailbox })))
          : Promise.resolve([] as OverviewThread[]);
    p.then(setThreads)
      .catch((e) => pushToast("error", e.message))
      .finally(() => setLoading(false));
  }, [view, mailbox, pushToast]);

  useEffect(() => {
    if (accounts) loadList();
  }, [accounts, loadList]);

  const openThread = (id: string, mb: string) => {
    setOpenId(id);
    setOpenMailbox(mb);
    setThread(null);
    setReply("");
    sdrApi
      .getInboxThread(id, mb)
      .then((d) => {
        setThread(d.messages);
        setThreads((prev) => prev?.map((t) => (t.id === id ? { ...t, unread: false } : t)) ?? prev);
      })
      .catch((e) => pushToast("error", e.message));
  };

  const connect = (mb: string) => {
    sdrApi
      .startInboxOAuth(mb)
      .then((d) => {
        window.location.href = d.url;
      })
      .catch((e) => pushToast("error", e.message));
  };

  const doReply = () => {
    if (!thread || !openId || !openMailbox || !reply.trim()) return;
    const last = thread[thread.length - 1];
    const to = emailFromHeader(last?.from);
    if (!to) {
      pushToast("error", "No recipient address found in the thread");
      return;
    }
    setSending(true);
    sdrApi
      .replyInboxThread(openId, {
        mailbox: openMailbox,
        to,
        subject: last?.subject ?? "",
        body: reply,
        inReplyTo: last?.messageId,
        references: last?.references,
      })
      .then(() => {
        pushToast("success", "Reply sent");
        setReply("");
        openThread(openId, openMailbox);
      })
      .catch((e) => pushToast("error", e.message))
      .finally(() => setSending(false));
  };

  if (!accounts) return <div className="p-8 text-sm text-slate-400">Loading inbox…</div>;
  const connected = accounts.filter((a) => a.connected);
  const unconnected = accounts.filter((a) => !a.connected);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-sm">
          <button
            onClick={() => setView("outreach")}
            className={cn("rounded-md px-3 py-1 font-medium", view === "outreach" ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}
          >
            Outreach
          </button>
          <button
            onClick={() => setView("mailbox")}
            className={cn("rounded-md px-3 py-1 font-medium", view === "mailbox" ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}
          >
            By mailbox
          </button>
        </div>
        {view === "mailbox" && connected.length > 1 && (
          <select
            value={mailbox ?? ""}
            onChange={(e) => setMailbox(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
          >
            {connected.map((a) => (
              <option key={a.email} value={a.email}>
                {a.email}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => loadList()}
          title="Refresh"
          className="rounded-lg border border-slate-300 p-1.5 text-slate-500 hover:bg-slate-50"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <div className="ml-auto flex flex-wrap gap-2">
          {unconnected.map((a) => (
            <button
              key={a.email}
              onClick={() => connect(a.email)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-1 text-sm font-medium text-brand-700 hover:bg-brand-100"
            >
              <Mail className="h-4 w-4" /> Connect {a.email}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {view === "outreach"
          ? "Outreach across every connected mailbox — sends and replies, SDR leads and TX05 permit operators. Open one to see the full thread and reply."
          : "Everything in this mailbox's inbox."}
      </p>

      {connected.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No mailbox connected yet. Connect {user.role === "admin" ? "a mailbox" : "your mailbox"} above to read and reply here.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="min-w-0 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
            {loading ? (
              <div className="p-6 text-sm text-slate-400">Loading…</div>
            ) : !threads?.length ? (
              <div className="p-6 text-sm text-slate-400">
                {view === "outreach" ? "No outreach sends or replies yet." : "No messages."}
              </div>
            ) : (
              threads.map((t) => (
                <button
                  key={`${t.mailbox}:${t.id}`}
                  // Ledger-sourced sends have no Gmail thread to open (openable === false).
                  onClick={() => { if (t.openable !== false && t.id) openThread(t.id, t.mailbox); }}
                  className={cn(
                    "block w-full px-3 py-2.5 text-left",
                    t.openable === false ? "cursor-default" : "hover:bg-slate-50",
                    openId === t.id && "bg-brand-50",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn("truncate text-sm text-slate-800", t.unread && "font-semibold")}>
                      {/* Show the counterparty: their From on a reply, the To on a send. */}
                      {(t.direction === "out" ? nameFromHeader(t.to) : nameFromHeader(t.from)) || "(unknown)"}
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">
                      {t.date ? formatRelative(new Date(t.date).toISOString()) : ""}
                    </span>
                  </div>
                  <div className={cn("truncate text-sm text-slate-600", t.unread && "font-medium text-slate-800")}>
                    {t.subject || "(no subject)"}
                  </div>
                  <div className="truncate text-xs text-slate-400">{t.snippet}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {view === "outreach" && t.direction && (
                      <span className={cn(
                        "inline-block rounded px-1.5 py-0.5 text-[11px] font-medium",
                        t.direction === "in" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500",
                      )}>
                        {t.direction === "in" ? "↩ Reply" : "→ Sent"}
                      </span>
                    )}
                    {t.kind === "permit" && (
                      <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700">
                        Permit{t.permit?.contact_name ? ` · ${t.permit.contact_name}` : ""}
                      </span>
                    )}
                    {t.lead && (
                      <span className="inline-block rounded bg-brand-100 px-1.5 py-0.5 text-[11px] text-brand-700">
                        {t.lead.lead_title || "Linked lead"}
                      </span>
                    )}
                    {view === "outreach" && (
                      <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                        {t.mailbox.split("@")[0]}
                      </span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="min-w-0 overflow-hidden rounded-xl border border-slate-200 p-4">
            {!openId ? (
              <div className="text-sm text-slate-400">Select a conversation to read and reply.</div>
            ) : !thread ? (
              <div className="text-sm text-slate-400">Loading…</div>
            ) : (
              <div className="space-y-3">
                {thread.map((m) => {
                  const mine = !!openMailbox && emailFromHeader(m.from) === openMailbox;
                  return (
                    <div
                      key={m.id}
                      className={cn(
                        "rounded-lg border p-3",
                        mine ? "ml-6 border-brand-200 bg-brand-50/60" : "mr-6 border-slate-100 bg-white",
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-medium text-slate-700">{mine ? "You" : nameFromHeader(m.from)}</span>
                        <span className="shrink-0 text-slate-400">{m.date ? new Date(m.date).toLocaleString() : ""}</span>
                      </div>
                      <div className="overflow-hidden whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{m.body?.trim() || "(no text)"}</div>
                    </div>
                  );
                })}
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    rows={4}
                    placeholder={`Reply as ${openMailbox}…`}
                    className="w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-brand-400 focus:outline-none"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">Sends from {openMailbox}</span>
                    <button
                      onClick={doReply}
                      disabled={sending || !reply.trim()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      <Send className="h-4 w-4" /> {sending ? "Sending…" : "Send reply"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Mailboxes
// --------------------------------------------------------------------------

// Per-mailbox sending signature: rendered preview + admin edit (writes to Apollo + DB).
function MailboxSignature({ mailbox, isAdmin }: { mailbox: SdrMailbox; isAdmin: boolean }) {
  const [editing, setEditing] = useState(false);
  const [html, setHtml] = useState(mailbox.signature_html ?? "");
  const [current, setCurrent] = useState(mailbox.signature_html ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = () => {
    setSaving(true);
    setMsg(null);
    sdrApi
      .updateMailboxSignature(mailbox.id, html)
      .then(() => {
        setCurrent(html);
        setMsg("Saved to Apollo");
        setEditing(false);
      })
      .catch((e) => setMsg(`Failed: ${(e as Error).message}`))
      .finally(() => setSaving(false));
  };

  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Signature</span>
        {isAdmin && !editing && (
          <button
            onClick={() => {
              setHtml(current);
              setEditing(true);
            }}
            className="text-[11px] font-semibold text-brand-700 hover:text-brand-800"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <textarea
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            rows={5}
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-[11px] text-slate-700 focus:border-brand-400 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditing(false)} className="text-xs text-slate-500 hover:text-slate-700">
              Cancel
            </button>
            {msg && <span className="text-[11px] text-slate-500">{msg}</span>}
          </div>
        </div>
      ) : current ? (
        <div
          className="rounded-lg border border-slate-100 bg-white px-2 py-1.5 text-xs text-slate-700"
          dangerouslySetInnerHTML={{ __html: current }}
        />
      ) : (
        <div className="text-[11px] text-slate-400">No signature set{isAdmin ? " — click Edit to add one." : "."}</div>
      )}
      {!editing && msg && <div className="mt-1 text-[11px] text-slate-500">{msg}</div>}
    </div>
  );
}

function MailboxesView({ user }: { user: SdrUser }) {
  const [mailboxes, setMailboxes] = useState<SdrMailbox[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SdrSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await sdrApi.listMailboxes();
      setMailboxes(d.mailboxes);
    } catch (e) {
      setError((e as Error).message);
    }
    try {
      const s = await sdrApi.getSettings();
      setSettings(s.settings);
    } catch {
      /* settings are best-effort */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveSettings(patch: Partial<SdrSettings>) {
    setSavingSettings(true);
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev)); // optimistic
    try {
      const r = await sdrApi.updateSettings(patch);
      setSettings(r.settings);
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setSavingSettings(false);
    }
  }

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

  async function toggleActive(m: SdrMailbox) {
    // optimistic flip, then reconcile
    setMailboxes((prev) => prev?.map((x) => (x.id === m.id ? { ...x, active: !m.active } : x)) ?? prev);
    try {
      await sdrApi.setMailboxActive(m.id, !m.active);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await load();
    }
  }

  if (error)
    return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;

  return (
    <div>
      {user.role === "admin" && settings && (
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-slate-900">Auto-outreach</div>
              <p className="mt-0.5 text-xs text-slate-500 max-w-xl">
                When on, the system fills each active mailbox's daily cap with the highest lead-score leads (fresh, with a
                trigger), rotating senders. {settings.auto_outreach_mode === "send"
                  ? "Sends automatically (still capped by the warmup ramp + dedup)."
                  : "Drafts land in the Queue for approval before anything sends."}{" "}
                Stale queued drafts auto-clear if the contact gets emailed in Pipedrive.
              </p>
            </div>
            <button
              onClick={() => saveSettings({ auto_outreach_enabled: !settings.auto_outreach_enabled })}
              disabled={savingSettings}
              role="switch"
              aria-checked={settings.auto_outreach_enabled}
              className={cn(
                "relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-50",
                settings.auto_outreach_enabled ? "bg-cta-500" : "bg-slate-300",
              )}
              title={settings.auto_outreach_enabled ? "Turn auto-outreach off" : "Turn auto-outreach on"}
            >
              <span
                className={cn(
                  "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
                  settings.auto_outreach_enabled && "translate-x-5",
                )}
              />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className="text-slate-400">Mode:</span>
            {(["queue", "send"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => saveSettings({ auto_outreach_mode: mode })}
                disabled={savingSettings}
                title={mode === "send" ? "Enrolls automatically (no human step), still capped by the warmup ramp + dedup" : "Drafts land in the Queue for approval before sending"}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 font-medium transition-colors disabled:opacity-50",
                  settings.auto_outreach_mode === mode
                    ? mode === "send"
                      ? "border-cta-300 bg-cta-50 text-cta-700"
                      : "border-brand-300 bg-brand-50 text-brand-700"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50",
                )}
              >
                {mode === "queue" ? "Draft to Queue" : "Auto-send"}
              </button>
            ))}
          </div>
          {settings.auto_outreach_enabled && settings.auto_outreach_mode === "send" && (
            <p className="mt-2 text-[11px] text-cta-700">
              Auto-send is on — eligible leads enroll automatically during business hours, capped by each mailbox's warmup ramp.
            </p>
          )}
        </div>
      )}

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
            <div
              key={m.id}
              className={cn(
                "rounded-2xl border bg-white p-4",
                m.active ? "border-slate-200" : "border-slate-200 bg-slate-50 opacity-60",
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-slate-900 text-sm">{m.email}</div>
                <div className="flex items-center gap-2">
                  {!m.active && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">
                      Disabled
                    </span>
                  )}
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
                  {user.role === "admin" && (
                    <button
                      onClick={() => toggleActive(m)}
                      title={m.active ? "Disable this sender" : "Enable this sender"}
                      className={cn(
                        "text-xs font-semibold px-2 py-0.5 rounded-full border transition-colors",
                        m.active
                          ? "border-slate-200 text-slate-500 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200"
                          : "border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100",
                      )}
                    >
                      {m.active ? "Disable" : "Enable"}
                    </button>
                  )}
                </div>
              </div>
              {/* Today's send usage vs the warmup-ramped cap */}
              <div className="mb-2 rounded-lg bg-slate-50 px-3 py-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-600">Today's sends</span>
                  <span className={cn("font-mono font-semibold", (m.sent_today ?? 0) >= (m.daily_cap ?? 0) ? "text-rose-600" : "text-slate-800")}>
                    {m.sent_today ?? 0} / {m.daily_cap ?? 0}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className={cn("h-full rounded-full", (m.sent_today ?? 0) >= (m.daily_cap ?? 0) ? "bg-rose-500" : "bg-brand-500")}
                    style={{ width: `${Math.min(100, ((m.sent_today ?? 0) / Math.max(1, m.daily_cap ?? 1)) * 100)}%` }}
                  />
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  Warmup day {m.warmup_day ?? "—"} · ramping to {m.daily_send_limit}/day
                </div>
              </div>
              <dl className="text-xs text-slate-500 space-y-0.5">
                <div className="flex justify-between"><dt>Today's cap (ramp)</dt><dd className="font-mono text-slate-700">{m.daily_cap ?? "—"}/day</dd></div>
                <div className="flex justify-between"><dt>Warmup target</dt><dd className="font-mono text-slate-700">{m.daily_send_limit}/day</dd></div>
                <div className="flex justify-between"><dt>Deliverability</dt><dd className="font-mono text-slate-700">{m.deliverability_score ?? "—"}</dd></div>
                <div className="flex justify-between"><dt>Apollo ID</dt><dd className="font-mono text-slate-700 truncate ml-2">{m.apollo_mailbox_id?.slice(0, 12) || "(unlinked)"}</dd></div>
              </dl>
              <MailboxSignature mailbox={m} isAdmin={user.role === "admin"} />
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
// Messaging — editable first-touch drafts + the live Apollo sequences in one place.
// --------------------------------------------------------------------------

const TRIGGER_ORDER: SdrTriggerType[] = ["AGC", "LBA", "CM", "PB"];

function MessagingView({ user, pushToast }: { user: SdrUser; pushToast: (k: "success" | "error", t: string) => void }) {
  const [templates, setTemplates] = useState<Record<SdrTriggerType, SdrFirstTouchTemplate> | null>(null);
  const [sequences, setSequences] = useState<SdrSequence[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A representative signature for the preview only. Apollo appends each sender's own
  // signature at send time; we show one (dc@ if present, else the first non-empty) so
  // the preview reads as a full email.
  const [sampleSig, setSampleSig] = useState<string>("");
  const isAdmin = user.role === "admin";

  useEffect(() => {
    Promise.all([
      sdrApi.getFirstTouchTemplates(),
      sdrApi.listSequences().catch(() => ({ sequences: [] as SdrSequence[] })),
      sdrApi.listMailboxes().catch(() => ({ mailboxes: [] as SdrMailbox[] })),
    ])
      .then(([ft, sq, mb]) => {
        setTemplates(ft.templates);
        const init: Record<string, string> = {};
        (Object.keys(ft.templates) as SdrTriggerType[]).forEach((t) => {
          init[t] = ft.templates[t].body;
        });
        setDrafts(init);
        setSequences(sq.sequences || []);
        const boxes = mb.mailboxes || [];
        const withSig = boxes.find((b) => b.email.startsWith("dc@") && b.signature_html) || boxes.find((b) => b.signature_html);
        setSampleSig(withSig?.signature_html || "");
      })
      .catch((e) => setError(e.message));
  }, []);

  const seqByTrigger = useMemo(() => {
    const m: Record<string, SdrSequence> = {};
    for (const s of sequences || []) {
      const tr = SEQUENCE_LABEL[s.id];
      if (tr) m[tr] = s;
    }
    return m;
  }, [sequences]);

  async function save(t: SdrTriggerType) {
    setSaving(t);
    try {
      const r = await sdrApi.updateFirstTouchTemplate(t, drafts[t]);
      setTemplates((prev) => (prev ? { ...prev, [t]: r.template } : prev));
      pushToast("success", `${t} step 1 saved`);
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        One template per trigger. Step 1 is the first-touch email built per lead (merge fields{" "}
        <span className="font-mono text-slate-600">{"{First} {ENV} {SWPPP}"}</span>); the later steps are the live
        Apollo follow-ups. The signature is added by Apollo per sender, so it isn't edited here — it shows in the
        preview only. {isAdmin ? "Edits save immediately." : "Admins edit these."}
      </p>
      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
      {!templates || !sequences ? (
        <div className="py-8 text-center text-slate-400">Loading…</div>
      ) : (
        TRIGGER_ORDER.filter((t) => templates[t]).map((t) => {
          const dirty = drafts[t] !== templates[t].body;
          const seq = seqByTrigger[t];
          const followups = seq
            ? [...seq.steps]
                .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9))
                .slice(1) // step 1 is the wrapper that injects the first-touch draft below
            : [];
          return (
            <div key={t} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
                <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset", TRIGGER_COLORS[t])}>{t}</span>
                <span className="text-sm font-semibold text-slate-900">{TRIGGER_LABELS[t]}</span>
                {seq && (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
                      seq.active ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-slate-100 text-slate-500 ring-slate-200",
                    )}
                  >
                    {seq.active ? "Active" : "Inactive"}
                  </span>
                )}
                <span className="text-xs text-slate-500">
                  — {1 + followups.length} step{1 + followups.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="divide-y divide-slate-100">
                {/* Step 1 — the editable first-touch (day 0) */}
                <li className="px-4 py-3">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">Step 1</span>
                    <span className="text-[11px] text-slate-400">Day 0 · first touch · built per lead, gets the brand styling on send</span>
                    {isAdmin && (
                      <button
                        onClick={() => save(t)}
                        disabled={!dirty || saving === t}
                        className={cn(
                          "ml-auto rounded-lg px-3 py-1 text-xs font-semibold transition-colors",
                          dirty ? "bg-cta-500 text-white hover:bg-cta-600" : "bg-slate-100 text-slate-400",
                        )}
                      >
                        {saving === t ? "Saving…" : dirty ? "Save" : "Saved"}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">Editable text + merge fields</div>
                      <textarea
                        value={drafts[t] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [t]: e.target.value }))}
                        readOnly={!isAdmin}
                        rows={9}
                        className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700 focus:border-brand-400 focus:outline-none"
                      />
                    </div>
                    <div>
                      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">Preview · full email sample (placeholders filled, signature from Apollo)</div>
                      <div
                        className="min-h-[180px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800"
                        style={{ fontFamily: 'Georgia, "Times New Roman", serif', color: "#1a5276" }}
                        dangerouslySetInnerHTML={{ __html: firstTouchPreview(drafts[t] ?? "", sampleSig) }}
                      />
                    </div>
                  </div>
                </li>
                {/* Steps 2+ — the live Apollo follow-ups */}
                {followups.map((step, i) => (
                  <SequenceStepEditor
                    key={step.template_id || i}
                    seqName={seq.name}
                    step={step}
                    stepNumber={i + 2}
                    isAdmin={isAdmin}
                    pushToast={pushToast}
                  />
                ))}
              </ul>
            </div>
          );
        })
      )}
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

// First-touch bodies are plain text + merge fields; on send they get the brand wrapper
// (Georgia, blue). Render that look as a preview so step 1 reads like steps 2+.
// Render a realistic email sample: merge fields replaced with sample values, the
// body HTML-escaped (it sends as plain text wrapped in the brand style), and the
// sender's Apollo signature appended raw at the end. {Sig} is dropped — Apollo
// appends the real signature per sender, so it only shows in this preview.
function firstTouchPreview(body: string, signatureHtml?: string): string {
  const filled = (body || "")
    .replace(/\{First\}/g, "Matt")
    .replace(/\{ENV\}/g, "EPA")
    .replace(/\{SWPPP\}/g, "SWPPP")
    .replace(/\s*\{Sig\}/g, "");
  const esc = filled.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const bodyHtml = esc.replace(/\n/g, "<br>");
  const sig = (signatureHtml || "").trim();
  return sig ? `${bodyHtml}<br><br>${sig}` : bodyHtml;
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
              "focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-400",
            )}
          />
        </div>
      ) : (
        <div
          ref={editorRef}
          contentEditable={!disabled}
          onInput={handleInput}
          suppressContentEditableWarning
          // Default to the brand face (Georgia) so an unstyled template renders the same
          // as a fully-styled one — fixes "one Georgia/blue, one bare white".
          style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
          className={cn(
            "min-h-[180px] w-full overflow-auto border border-slate-200 px-3 py-2 text-sm text-slate-800",
            "focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-400",
            "rounded-b-lg",
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
            "focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-400",
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
                : "bg-brand-600 text-white hover:bg-brand-700",
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
