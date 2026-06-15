// Nurture (Brevo) read client. Reuses sdrFetch for JWT auth + 401 handling.
import { getUser, sdrFetch } from "./sdrApi";

export interface NurtureAccount {
  email: string | null;
  companyName: string | null;
  credits: number | null;
  creditsType: string | null;
  planType: string | null;
}

export interface CampaignStats {
  sent: number;
  delivered: number;
  uniqueViews: number;
  uniqueClicks: number;
  softBounces: number;
  hardBounces: number;
  unsubscriptions: number;
}

export interface NurtureCampaign {
  id: number;
  name: string;
  subject: string | null;
  status: "draft" | "sent" | "queued" | "suspended" | "in_process" | "archive" | string;
  scheduledAt: string | null;
  sentDate: string | null;
  recipientsLists: number[];
  stats: CampaignStats | null;
}

export interface NurtureList {
  id: number;
  name: string;
  folderId: number | null;
  count: number | null;
}

export interface NurtureContact {
  id?: number;
  email: string;
  attributes?: Record<string, unknown>;
  emailBlacklisted?: boolean;
  listIds?: number[];
}

export interface NurtureSender {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export interface AutomationEngine {
  configured: boolean;
  name?: string;
  active?: boolean;
  lastRun?: { status: string; startedAt: string | null } | null;
  error?: string;
}

export function isAdmin(): boolean {
  return getUser()?.role === "admin";
}

// Deep links for capabilities the Brevo API can't do. Exact paths verified at build;
// any unknown kind falls back to the Brevo home app.
export function brevoUrl(kind: "campaigns" | "campaign" | "automations" | "senders" | "lists" | "templates" | "home", id?: number | string): string {
  const base = "https://app.brevo.com";
  switch (kind) {
    case "campaigns": return `${base}/marketing-campaigns/email`;
    case "campaign": return `${base}/marketing-campaigns/email/edit/${id}`;
    case "automations": return `${base}/automation/list`;
    case "senders": return `${base}/senders/list`;
    case "lists": return `${base}/contact/list-listing`;
    case "templates": return `${base}/marketing-templates/list`;
    default: return base;
  }
}

export const nurtureApi = {
  account: () => sdrFetch<NurtureAccount>("/api/sdr/nurture/account"),
  campaigns: () => sdrFetch<{ campaigns: NurtureCampaign[] }>("/api/sdr/nurture/campaigns"),
  lists: () => sdrFetch<{ lists: NurtureList[] }>("/api/sdr/nurture/lists"),
  listContacts: (listId: number, offset = 0) =>
    sdrFetch<{ contacts: NurtureContact[]; count: number }>(`/api/sdr/nurture/lists/${listId}/contacts?limit=50&offset=${offset}`),
  contact: (id: string) => sdrFetch<{ contact: NurtureContact }>(`/api/sdr/nurture/contacts/${encodeURIComponent(id)}`),
  senders: () => sdrFetch<{ senders: NurtureSender[] }>("/api/sdr/nurture/senders"),
  automationEngine: () => sdrFetch<AutomationEngine>("/api/sdr/nurture/automation-engine"),

  folders: () => sdrFetch<{ folders: { id: number; name: string }[] }>("/api/sdr/nurture/folders"),

  // campaign actions
  campaignTest: (id: number, emailTo: string[]) =>
    sdrFetch(`/api/sdr/nurture/campaigns/${id}/test`, { method: "POST", body: JSON.stringify({ emailTo }) }),
  campaignSend: (id: number) =>
    sdrFetch(`/api/sdr/nurture/campaigns/${id}/send`, { method: "POST" }),
  campaignSchedule: (id: number, scheduledAt: string) =>
    sdrFetch(`/api/sdr/nurture/campaigns/${id}/schedule`, { method: "PATCH", body: JSON.stringify({ scheduledAt }) }),
  campaignSuspend: (id: number) =>
    sdrFetch(`/api/sdr/nurture/campaigns/${id}/suspend`, { method: "POST" }),
  campaignDuplicate: (id: number, name: string, listIds: number[], scheduledAt?: string) =>
    sdrFetch<{ id: number }>(`/api/sdr/nurture/campaigns/${id}/duplicate`, { method: "POST", body: JSON.stringify({ name, listIds, scheduledAt }) }),
  campaignDelete: (id: number) =>
    sdrFetch(`/api/sdr/nurture/campaigns/${id}`, { method: "DELETE" }),

  // list actions
  listCreate: (name: string, folderId?: number) =>
    sdrFetch<{ id: number }>("/api/sdr/nurture/lists", { method: "POST", body: JSON.stringify({ name, folderId }) }),
  listRename: (id: number, name: string) =>
    sdrFetch(`/api/sdr/nurture/lists/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  listDelete: (id: number) =>
    sdrFetch(`/api/sdr/nurture/lists/${id}`, { method: "DELETE" }),
  listAddContacts: (id: number, emails: string[]) =>
    sdrFetch(`/api/sdr/nurture/lists/${id}/contacts/add`, { method: "POST", body: JSON.stringify({ emails }) }),
  listRemoveContacts: (id: number, emails: string[]) =>
    sdrFetch(`/api/sdr/nurture/lists/${id}/contacts/remove`, { method: "POST", body: JSON.stringify({ emails }) }),

  // contact actions
  contactCreate: (email: string, attributes: Record<string, unknown>, listIds: number[]) =>
    sdrFetch(`/api/sdr/nurture/contacts`, { method: "POST", body: JSON.stringify({ email, attributes, listIds }) }),
  contactUpdate: (id: string, attributes: Record<string, unknown>) =>
    sdrFetch(`/api/sdr/nurture/contacts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ attributes }) }),
  contactBlocklist: (id: string, blocked = true) =>
    sdrFetch(`/api/sdr/nurture/contacts/${encodeURIComponent(id)}/blocklist`, { method: "POST", body: JSON.stringify({ blocked }) }),
  contactDelete: (id: string) =>
    sdrFetch(`/api/sdr/nurture/contacts/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
