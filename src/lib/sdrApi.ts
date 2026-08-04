// Frontend SDR API helpers — JWT auth, localStorage persistence, typed responses.

const TOKEN_KEY = "swppp_sdr_jwt";
const USER_KEY = "swppp_sdr_user";

export type SdrRole = "sdr" | "admin";

export interface SdrUserPublic {
  username: string;
  display_name: string;
  /**
   * Optional on purpose. `GET /api/sdr/auth/users` is unauthenticated (it fuels the login
   * picker) and no longer publishes `role`, so an anonymous caller cannot see which seat is
   * the admin. The authenticated login response still carries it — see SdrUser below.
   */
  role?: SdrRole;
}

export interface SdrUser extends SdrUserPublic {
  id: string;
  email: string;
  role: SdrRole; // always present once authenticated
}

export interface SdrMailbox {
  id: string;
  email: string;
  display_name: string | null;
  apollo_mailbox_id: string | null;
  owner_user_id: string | null;
  daily_send_limit: number;
  warmup_status: "pending" | "warming" | "ready" | "paused" | "disabled";
  warmup_current_cap: number;
  warmup_started_at: string | null;
  deliverability_score: number | null;
  last_health_check_at: string | null;
  active: boolean;
  signature_html: string | null;
  created_at: string;
  updated_at: string;
  sent_today: number;
  daily_cap: number;
  warmup_day: number;
}

// --- Team admin (admin-only surface, added 2026-07-28) -----------------------
export interface SdrTeamMailboxSummary {
  id: string;
  email: string;
  active: boolean;
  permit_enabled: boolean;
  pipedrive_sender_id: number | null;
  permit_daily_cap: number | null;
}

export interface SdrTeamUser {
  id: string;
  username: string;
  email: string;
  display_name: string | null;
  role: SdrRole;
  active: boolean;
  has_password: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  mailboxes?: SdrTeamMailboxSummary[];
}

export interface SdrTeamUserCreate {
  username: string;
  email: string;
  display_name?: string;
  role?: SdrRole;
  active?: boolean;
  password?: string;
}

export interface SdrTeamUserPatch {
  display_name?: string;
  email?: string;
  role?: SdrRole;
  active?: boolean;
  password?: string;
  generate_password?: boolean;
}

export interface SdrTeamMailboxCreate {
  email: string;
  display_name?: string;
  owner_user_id?: string | null;
  apollo_mailbox_id?: string | null;
  pipedrive_sender_id?: number | null;
  daily_send_limit?: number | null;
  permit_daily_cap?: number | null;
  active?: boolean;
  permit_enabled?: boolean;
}

export interface SdrMailboxRoutingPatch {
  active?: boolean;
  owner_user_id?: string | null;
  pipedrive_sender_id?: number | null;
  permit_daily_cap?: number | null;
  daily_send_limit?: number;
}

export interface SdrMailboxRouting {
  id: string;
  email: string;
  active: boolean;
  owner_user_id: string | null;
  pipedrive_sender_id: number | null;
  permit_daily_cap: number | null;
  daily_send_limit: number;
  permit_enabled: boolean;
}

export type SdrTriggerType = "AGC" | "LBA" | "CM" | "PB";
export type SdrDraftStatus =
  | "pending"
  | "approved"
  | "edited"
  | "rejected"
  | "sent"
  | "failed"
  | "cancelled";

export interface SdrDraft {
  id: string;
  pipedrive_lead_id: string;
  pipedrive_contact_id: string | null;
  pipedrive_org_id: string | null;
  contact_id_snapshot: string;
  contact_email_snapshot: string;
  org_id_snapshot: string | null;
  trigger_type: SdrTriggerType;
  apollo_sequence_id: string | null;
  apollo_template_id: string | null;
  subject: string;
  body: string;
  assigned_mailbox_id: string | null;
  assigned_user_id: string | null;
  status: SdrDraftStatus;
  reject_reason: string | null;
  scheduled_for: string | null;
  approved_at: string | null;
  approved_by: string | null;
  sent_at: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Joined from sdr_lead_state (dedup) — present on list responses, may be null/absent.
  outreach_status?: SdrOutreachStatus | null;
  last_outgoing_mail_time?: string | null;
  lead_person_name?: string | null;
  days_since_outgoing?: number | null;
}

export type SdrOutreachStatus = "clear" | "contacted_recent" | "contacted_stale" | "sequenced";

export interface SdrLead {
  pipedrive_lead_id: string;
  pipedrive_person_id: string | null;
  person_name: string | null;
  person_email: string | null;
  last_outgoing_mail_time: string | null;
  email_messages_count: number | null;
  last_activity_date: string | null;
  lowbid_flag: boolean | null;
  sequence_started: boolean | null;
  project_stage: string | null;
  trigger_type: SdrTriggerType | null;
  lead_title: string | null;
  outreach_status: SdrOutreachStatus;
  synced_at: string | null;
  days_since_outgoing: number | null;
  outreached_by: string | null;
  outreached_status: string | null;
  initiated_by: string | null;
  // Per-lead outreach ledger (sdr_outreach_log): the latest real send for THIS lead,
  // by source. Replaces the person-level last_outgoing_mail_time as the outreach signal.
  outreach_sent_at: string | null;
  outreach_source: "pipedrive" | "interface" | null;
  outreach_sender_name: string | null;
  outreach_sender_email: string | null;
  bid_date: string | null;
  start_date: string | null;
  trigger_override: string | null;
  owner_name: string | null;
  lead_score: number | null;
  project_value: number | null;
  send_status: string | null;
  send_sequence_id: string | null;
  send_sent_at: string | null;
  send_current_step: number | null;
  send_total_steps: number | null;
  send_next_at: string | null;
  email_verify_status?: string | null;
  email_flag?: string | null;
  resolved_email?: string | null;
}

export interface SdrLeadDetail {
  lead: SdrLead;
  drafts: {
    id: string;
    trigger_type: SdrTriggerType;
    status: string;
    subject: string | null;
    body: string | null;
    created_at: string;
    sent_at: string | null;
    assigned_to: string | null;
    sent_from: string | null;
    sender_signature: string | null;
  }[];
  sends: { id: string; apollo_sequence_id: string | null; status: string; sent_at: string | null }[];
  events: { event_type: string; occurred_at: string; mailbox_email: string | null }[];
  pd_lead: Record<string, unknown> | null;
  pd_person: Record<string, unknown> | null;
  pd_activities?: SdrPdActivity[];
}

// A Pipedrive activity (call/meeting/task/email) normalized server-side for the timeline.
export interface SdrPdActivity {
  id: number;
  type: string; // call | meeting | task | email | contact_attempt | deadline | lunch | ...
  typeName: string;
  subject: string;
  done: boolean;
  at: string | null;
  duration: string | null;
  who: string | null;
  note: string | null;
  outcome: string | null;
}

export interface SdrLeadsResponse {
  leads: SdrLead[];
  count: number;
  total: number;
  page: number;
  limit: number;
  pages: number;
  facets: { byStatus: Record<string, number>; grandTotal: number };
}

export interface SdrLeadFilters {
  stages: { v: string; n: number }[];
  triggers: { v: string; n: number }[];
}

export interface SdrLeadsQuery {
  status?: string;
  trigger?: string;
  stage?: string;
  source?: string; // outreach source: pipedrive | interface | none
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface SdrTemplateStep {
  day: number;
  body: string;
}

export interface SdrTemplate {
  steps: SdrTemplateStep[];
  default_subject: string;
}

export interface SdrSequenceStep {
  position: number | null;
  step_type: string | null;
  template_id: string;
  subject: string;
  body_html: string;
}

export interface SdrSequence {
  id: string;
  name: string;
  active: boolean;
  num_steps: number;
  steps: SdrSequenceStep[];
}

export interface SdrFirstTouchTemplate {
  trigger_type: SdrTriggerType;
  body: string;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface SdrSettings {
  auto_outreach_enabled: boolean;
  auto_outreach_mode: "queue" | "send";
  auto_min_score: number | null;
  contact_cooldown_days: number;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface SdrEngagementLead {
  draft_id: string;
  pipedrive_lead_id: string;
  trigger_type: SdrTriggerType;
  assigned_user_id: string | null;
  contact_email_snapshot: string;
  lead_title: string | null;
  sent_at: string | null;
  send_status: "enrolled" | "sent" | "bounced" | "replied" | "unsubscribed" | "failed" | null;
  opens: number;
  clicks: number;
  replies: number;
  last_event_at: string | null;
  last_intent_at: string | null; // most recent OPEN/CLICK only (drives the 96h priority window)
  score: number;
}

export interface SdrEngagementRate {
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
}

export interface SdrEngagementSummary {
  leads: SdrEngagementLead[];
  by_trigger: (SdrEngagementRate & { trigger_type: SdrTriggerType })[];
  by_sender: (SdrEngagementRate & { username: string; display_name: string })[];
}

// Pipedrive deep link for a lead (proswpppllc = Pipedrive company domain)
export function pipedriveLeadUrl(leadId: string): string {
  return `https://proswpppllc.pipedrive.com/leads/inbox/${leadId}`;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): SdrUser | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as SdrUser) : null;
}

export function setSession(token: string, user: SdrUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function sdrFetch<T>(path: string, opts: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const { auth = true, headers, ...rest } = opts;
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...(headers as Record<string, string> | undefined),
  };
  if (auth) {
    const token = getToken();
    if (token) h["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(path, { credentials: "include", headers: h, ...rest });
  if (res.status === 401 && auth) {
    clearSession();
    // Tell the UI to bounce back to the user picker (JWT expired mid-session)
    window.dispatchEvent(new Event("sdr-session-expired"));
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(((data as { error?: string })?.error) || `Request failed (${res.status})`);
    (err as Error & { status?: number; data?: unknown }).status = res.status;
    (err as Error & { status?: number; data?: unknown }).data = data;
    throw err;
  }
  return data as T;
}

export interface SdrInboxAccount {
  email: string;
  connected: boolean;
  connected_at: string | null;
  owner_name: string | null;
}
export interface SdrInboxThread {
  id: string;
  subject: string | null;
  from: string | null;
  date: string | null;
  snippet: string;
  messageCount: number;
  unread: boolean;
  lead: { lead_id: string; lead_title: string | null } | null;
}
export interface SdrInboxMessage {
  id: string;
  from: string | null;
  to: string | null;
  cc?: string | null;
  subject: string | null;
  date: string | null;
  messageId: string | null;
  references: string | null;
  unread: boolean;
  body: string;
  html?: string | null;
}

export const sdrApi = {
  getUser,

  // `require_password` mirrors the server's REQUIRE_PASSWORD env flag, which is
  // off by default. When it's off the picker stays one-click, exactly as before.
  listUsers: () =>
    sdrFetch<{ users: SdrUserPublic[]; require_password?: boolean }>("/api/sdr/auth/users", { auth: false }),

  // Priority dismissed/seen state, per user, server-side. The caller treats every one of
  // these as best-effort: localStorage remains the synchronous cache the UI renders from.
  priorityState: () =>
    sdrFetch<{ dismissed: string[]; seen: string[] }>("/api/sdr/priority/state"),
  setPriorityState: (draftId: string, state: "dismissed" | "seen") =>
    sdrFetch<{ ok: true }>("/api/sdr/priority/state", {
      method: "POST",
      body: JSON.stringify({ draft_id: draftId, state }),
    }),
  clearPriorityState: (state: "dismissed" | "seen" = "dismissed") =>
    sdrFetch<{ ok: true; cleared: number }>("/api/sdr/priority/state", {
      method: "DELETE",
      body: JSON.stringify({ state }),
    }),

  login: (username: string, password?: string) =>
    sdrFetch<{ token: string; expires_in: number; user: SdrUser }>("/api/sdr/auth/login", {
      method: "POST",
      auth: false,
      // Omit the key entirely when there's no password so the request body is
      // byte-identical to the pre-2026-07-28 passwordless call.
      body: JSON.stringify(password ? { username, password } : { username }),
    }),

  me: () => sdrFetch<{ user: { sub: string; username: string; role: SdrRole } }>("/api/sdr/auth/me"),

  listMailboxes: () => sdrFetch<{ mailboxes: SdrMailbox[] }>("/api/sdr/mailboxes"),

  syncMailboxesFromApollo: () =>
    sdrFetch<{ synced_count: number; synced: { email: string; apollo_id: string }[] }>(
      "/api/sdr/mailboxes/sync",
      { method: "POST" },
    ),

  updateMailboxSignature: (id: string, signature_html: string) =>
    sdrFetch<{ mailbox: { id: string; email: string; signature_html: string | null } }>(
      `/api/sdr/mailboxes/${id}/signature`,
      { method: "PUT", body: JSON.stringify({ signature_html }) },
    ),

  // Unified inbox (Gmail per .co mailbox)
  getInboxAccounts: () =>
    sdrFetch<{ accounts: SdrInboxAccount[]; isAdmin: boolean; configured: boolean }>("/api/sdr/inbox/accounts"),
  startInboxOAuth: (mailbox?: string) =>
    sdrFetch<{ url: string }>(`/api/sdr/inbox/oauth/start${mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : ""}`),
  getInboxThreads: (mailbox?: string, q?: string) => {
    const p = new URLSearchParams();
    if (mailbox) p.set("mailbox", mailbox);
    if (q) p.set("q", q);
    const qs = p.toString();
    return sdrFetch<{ mailbox: string | null; threads: SdrInboxThread[]; note?: string }>(
      `/api/sdr/inbox/threads${qs ? `?${qs}` : ""}`,
    );
  },
  getInboxOverview: () =>
    sdrFetch<{
      threads: (SdrInboxThread & {
        mailbox: string;
        to?: string | null;
        openable?: boolean;
        outreached?: boolean;
        direction?: "in" | "out";
        lastOutbound?: boolean;
        kind?: "sdr" | "permit";
        permit?: { operator_key: string; contact_name: string | null };
      })[];
      mailboxes: string[];
    }>("/api/sdr/inbox/overview"),
  getInboxThread: (id: string, mailbox?: string) =>
    sdrFetch<{ mailbox: string; id: string; messages: SdrInboxMessage[] }>(
      `/api/sdr/inbox/threads/${id}${mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : ""}`,
    ),
  // Resolve a lead to its inbox thread (searches the sending mailbox by contact address).
  findLeadThread: (leadId: string) =>
    sdrFetch<{ mailbox: string | null; threadId: string | null }>(`/api/sdr/leads/${leadId}/thread`),
  replyInboxThread: (
    id: string,
    payload: { mailbox?: string; to: string; subject?: string; body: string; inReplyTo?: string | null; references?: string | null },
  ) =>
    sdrFetch<{ ok: boolean; id: string }>(`/api/sdr/inbox/threads/${id}/reply`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // Mark a thread handled / not-needing-reply (or un-mark it). Drops it off the needs-reply
  // badge + count and marks it read in Gmail. handled: false reverses it.
  setInboxHandled: (id: string, handled: boolean, mailbox?: string) =>
    sdrFetch<{ ok: boolean; thread_id: string; handled: boolean }>(`/api/sdr/inbox/threads/${id}/handled`, {
      method: "POST",
      body: JSON.stringify({ handled, mailbox }),
    }),

  // Gmail-style compose: reply / reply-all / forward. The server quotes/forwards the
  // original and sets threading; the client supplies the final recipients + note.
  composeInboxThread: (
    id: string,
    payload: {
      mailbox?: string;
      mode: "reply" | "replyAll" | "forward";
      to: string;
      cc?: string;
      bcc?: string;
      subject?: string;
      body: string;
    },
  ) =>
    sdrFetch<{ ok: boolean; id: string }>(`/api/sdr/inbox/threads/${id}/compose`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  setMailboxActive: (id: string, active: boolean) =>
    sdrFetch<{ mailbox: { id: string; email: string; active: boolean } }>(
      `/api/sdr/mailboxes/${id}`,
      { method: "PATCH", body: JSON.stringify({ active }) },
    ),

  // Team admin (admin-only). owner_user_id / pipedrive_sender_id / permit_daily_cap
  // had no writer at all before 2026-07-28 — see lib/sdrTeamRoutes.js.
  updateMailboxRouting: (id: string, patch: SdrMailboxRoutingPatch) =>
    sdrFetch<{ mailbox: SdrMailboxRouting }>(`/api/sdr/mailboxes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  listTeamUsers: () =>
    sdrFetch<{ users: SdrTeamUser[]; require_password: boolean }>("/api/sdr/admin/users"),

  createTeamUser: (payload: SdrTeamUserCreate) =>
    sdrFetch<{ user: SdrTeamUser; generated_password?: string; next_steps?: string[] }>(
      "/api/sdr/admin/users",
      { method: "POST", body: JSON.stringify(payload) },
    ),

  updateTeamUser: (id: string, patch: SdrTeamUserPatch) =>
    sdrFetch<{ user: SdrTeamUser; generated_password?: string }>(`/api/sdr/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteTeamUser: (id: string) =>
    sdrFetch<{ deleted: boolean }>(`/api/sdr/admin/users/${id}`, { method: "DELETE" }),

  createTeamMailbox: (payload: SdrTeamMailboxCreate) =>
    sdrFetch<{ mailbox: SdrMailboxRouting; next_steps?: string[] }>("/api/sdr/admin/mailboxes", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  deleteTeamMailbox: (id: string) =>
    sdrFetch<{ deleted: boolean }>(`/api/sdr/admin/mailboxes/${id}`, { method: "DELETE" }),

  getFirstTouchTemplates: () =>
    sdrFetch<{ templates: Record<SdrTriggerType, SdrFirstTouchTemplate> }>("/api/sdr/first-touch-templates"),

  updateFirstTouchTemplate: (trigger: SdrTriggerType, body: string) =>
    sdrFetch<{ template: SdrFirstTouchTemplate }>(`/api/sdr/first-touch-templates/${trigger}`, {
      method: "PUT",
      body: JSON.stringify({ body }),
    }),

  getSettings: () => sdrFetch<{ settings: SdrSettings }>("/api/sdr/settings"),

  updateSettings: (patch: Partial<Pick<SdrSettings, "auto_outreach_enabled" | "auto_outreach_mode" | "auto_min_score" | "contact_cooldown_days">>) =>
    sdrFetch<{ settings: SdrSettings }>("/api/sdr/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  listTemplates: () =>
    sdrFetch<{ templates: Record<SdrTriggerType, SdrTemplate> }>("/api/sdr/templates"),

  getOutbox: () =>
    sdrFetch<{
      scheduled: {
        to_email: string | null;
        from_email: string | null;
        due_at: string | null;
        step: number | null;
        sequence: string | null;
        lead: { lead_id: string; lead_title: string | null; trigger_type: SdrTriggerType | null } | null;
      }[];
    }>("/api/sdr/outbox"),

  listDrafts: (status?: SdrDraftStatus) => {
    const q = status ? `?status=${status}` : "";
    return sdrFetch<{ drafts: SdrDraft[] }>(`/api/sdr/drafts${q}`);
  },

  getDraft: (id: string) => sdrFetch<{ draft: SdrDraft }>(`/api/sdr/drafts/${id}`),

  engagementSummary: () => sdrFetch<SdrEngagementSummary>("/api/sdr/engagement/summary"),

  listSequences: () => sdrFetch<{ sequences: SdrSequence[] }>("/api/sdr/sequences"),

  updateSequenceTemplate: (templateId: string, fields: { subject?: string; body_html?: string }) =>
    sdrFetch<{ ok: boolean }>("/api/sdr/sequences/templates/" + templateId, {
      method: "PUT",
      body: JSON.stringify(fields),
    }),

  refreshDraft: (id: string) =>
    sdrFetch<{ draft: SdrDraft }>(`/api/sdr/drafts/${id}/refresh`, { method: "POST" }),

  patchDraft: (
    id: string,
    fields: Partial<Pick<SdrDraft, "subject" | "body" | "scheduled_for" | "assigned_mailbox_id" | "apollo_sequence_id">>,
  ) =>
    sdrFetch<{ draft: SdrDraft }>(`/api/sdr/drafts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    }),

  rejectDraft: (id: string, reason: string) =>
    sdrFetch<{ draft: SdrDraft }>(`/api/sdr/drafts/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  // `override: true` lets an admin send to an already-contacted lead (server returns
  // 409 {code:"already_outreached"} otherwise). The thrown error's `.data` carries
  // { code, daysAgo, personName, lastOutgoing } for the UI to surface. The server can also
  // return 429 {code:"daily_cap_reached", mailbox, sentToday, cap, rampDay} or 409
  // {code:"mailbox_inactive", mailbox} — see onApprove()'s error branches in SdrInterface.tsx.
  approveAndSendDraft: (id: string, override = false) =>
    sdrFetch<{ draft: SdrDraft; send: Record<string, unknown>; apollo_response: unknown }>(
      `/api/sdr/drafts/${id}/approve-and-send`,
      { method: "POST", body: JSON.stringify(override ? { override: true } : {}) },
    ),

  listLeads: (params?: SdrLeadsQuery) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.trigger) qs.set("trigger", params.trigger);
    if (params?.stage) qs.set("stage", params.stage);
    if (params?.source) qs.set("source", params.source);
    if (params?.q) qs.set("q", params.q);
    if (params?.sort) qs.set("sort", params.sort);
    if (params?.dir) qs.set("dir", params.dir);
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return sdrFetch<SdrLeadsResponse>(`/api/sdr/leads${suffix}`);
  },

  leadFilters: () => sdrFetch<SdrLeadFilters>("/api/sdr/leads/filters"),

  leadDetail: (leadId: string) => sdrFetch<SdrLeadDetail>(`/api/sdr/leads/${leadId}/detail`),

  updateLeadStage: (leadId: string, projectStage: string) =>
    sdrFetch<{ ok: boolean; project_stage: string; trigger_type: string | null }>(`/api/sdr/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify({ project_stage: projectStage }),
    }),

  // Manual trigger override (Postgres-only; "" or "clear" reverts to stage-derived).
  setLeadTrigger: (leadId: string, triggerOverride: string) =>
    sdrFetch<{ ok: boolean; trigger_type: string | null; trigger_override: string | null }>(`/api/sdr/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify({ trigger_override: triggerOverride }),
    }),

  logActivity: (
    leadId: string,
    a: { subject: string; type: string; due_date?: string | null; done?: boolean },
  ) =>
    sdrFetch<{ ok: boolean; activity_id: number | null }>(`/api/sdr/leads/${leadId}/activity`, {
      method: "POST",
      body: JSON.stringify(a),
    }),

  addLeadNote: (leadId: string, content: string) =>
    sdrFetch<{ ok: boolean; note_id: number | null }>(`/api/sdr/leads/${leadId}/note`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  syncLeads: () => sdrFetch<{ started: boolean }>("/api/sdr/sync/leads", { method: "POST" }),

  generateDraftFromLead: (params: {
    pipedrive_lead_id: string;
    trigger_type: SdrTriggerType;
    apollo_sequence_id?: string;
    assigned_user_id?: string;
    override?: boolean;
  }) =>
    sdrFetch<{ draft: SdrDraft }>(`/api/sdr/drafts/generate`, {
      method: "POST",
      body: JSON.stringify(params),
    }),
};
