import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Workflow, Zap } from "lucide-react";
import { brevoUrl, formatNurtureDate, nurtureApi, type AutomationEngine } from "../../lib/nurtureApi";
import { cn } from "../../utils";

// These are documented flows; the API does not verify their current Brevo status.
const BREVO_AUTOMATIONS = [
  { name: "M&A Drip", detail: "5 emails over 30 days (Day 0 / 5 / 12 / 20 / 30) when a contact joins the M&A list." },
  { name: "Project Wrapping Up", detail: "Sends the wrap-up check-in when a contact lands in the Project Wrapping Up list." },
];

export default function AutomationsView() {
  const [engine, setEngine] = useState<AutomationEngine | null>(null);

  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const invalidate = useCallback(() => { request.current++; }, []);
  const load = useCallback(() => {
    const current = ++request.current;
    setError(null);
    setEngine(null);
    nurtureApi.automationEngine().then((d) => { if (current === request.current) setEngine(d); }).catch((e) => { if (current === request.current) setError(e.message); });
  }, []);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; invalidate(); };
  }, [load, invalidate]);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        The cards below describe the documented Brevo flows. Confirm their current status in Brevo. The trigger status below is checked separately.
      </div>

      <div>
        <div className="flex flex-wrap gap-3 items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-900">Brevo automations</h3>
          <a
            href={brevoUrl("automations")}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700 hover:text-emerald-800"
          >
            Manage automations in Brevo <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {BREVO_AUTOMATIONS.map((a) => (
            <div key={a.name} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <Workflow className="h-4 w-4 text-emerald-600" />
                <span className="text-sm font-semibold text-slate-900">{a.name}</span>
                <span className="text-xs text-slate-500">Status unverified</span>
              </div>
              <p className="text-xs text-slate-500">{a.detail}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-900 mb-2">Trigger engine (n8n)</h3>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          {error ? (
            <div role="alert" className="text-sm text-rose-700">Trigger status could not be loaded. {error}<button onClick={load} className="ml-3 min-h-11 font-semibold underline">Try again</button></div>
          ) : !engine ? (
            <div className="text-sm text-slate-400">Loading…</div>
          ) : engine.error ? (
            <div className="text-sm text-rose-600">Couldn't reach the trigger engine: {engine.error}<button onClick={load} className="ml-3 min-h-11 font-semibold underline">Try again</button></div>
          ) : !engine.configured ? (
            <div className="text-sm text-slate-500">Trigger engine is not configured for this environment.</div>
          ) : (
            <div className="flex items-center gap-3">
              <span className={cn("h-9 w-9 rounded-xl flex items-center justify-center", engine.active ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400")}>
                <Zap className="h-5 w-5" />
              </span>
              <div className="flex-1">
                <div className="text-sm font-semibold text-slate-900">{engine.name}</div>
                <div className="text-xs text-slate-500">
                  {engine.active == null ? "Status unavailable" : engine.active ? "Active" : "Inactive"}
                  {engine.lastRun ? ` · last run ${engine.lastRun.status} (${formatNurtureDate(engine.lastRun.startedAt, true)})` : " · no recent run returned"}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
