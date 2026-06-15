// Nurture (Brevo) read client. Reuses sdrFetch for JWT auth + 401 handling.
import { sdrFetch } from "./sdrApi";

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
};
