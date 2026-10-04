import { sdrReadRequest } from './sdrReadRequest';

export type LiveOverviewAction = {
  id: string;
  title: string;
  description: string;
  count: number | null;
  target: string;
  severity: string;
};

export type SdrLiveOverview = {
  collectedAt: string;
  preview: boolean;
  queue: { pending: number; failed: number; ready: number; failedDays?: number };
  leads: { total: number; eligible?: number };
  senders: { active: number; total: number };
  recentEnrollments: { count: number; days: number };
  actions: LiveOverviewAction[];
  trend: Array<{ date: string; count: number }>;
  note: string;
};

export function getLiveOverview(signal?: AbortSignal): Promise<SdrLiveOverview> {
  return sdrReadRequest<SdrLiveOverview>('/api/sdr/live-overview', signal);
}
