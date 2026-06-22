import { useState } from "react";
import { HelpCircle, ChevronDown, ChevronRight } from "lucide-react";

const KEY = "permits_guide_open";

/** Compact, collapsed-by-default "how it works" panel for the Permits section. */
export default function PermitsGuide() {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
  });
  const toggle = () => {
    setOpen((o) => { const n = !o; try { localStorage.setItem(KEY, n ? "1" : "0"); } catch { /* ignore */ } return n; });
  };

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/60">
      <button onClick={toggle} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <HelpCircle className="h-4 w-4 text-indigo-600" />
        <span className="text-sm font-medium text-indigo-900">Quick guide — how the permit leads work</span>
        <span className="ml-auto text-indigo-500">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-indigo-100 px-3 py-3 text-sm text-slate-700">
          <p>
            ~9,000 Texas businesses whose stormwater permit (TXR050000) <b>expires Aug 13, 2026</b>. Mail them early to win the SWPPP renewal.{" "}
            <span className="text-slate-500">One row = one company (all its permits grouped).</span>
          </p>

          <div>
            <span className="font-semibold text-indigo-700">Steps:</span>{" "}
            Filter to the hottest → click a company → <b>Promote</b> → <b>Enrich</b> → <b>Download CSV</b> → mail it → <b>Mark mailed</b>.
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Compliance (hottest first)</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">⚠ Significant</span>
                <span className="rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700">⚠ In violation</span>
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">Inspected</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500">— clean</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">Flagged = under renewal pressure = likeliest to say yes.</p>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Row flags</div>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                <li><b>★ Customer?</b> / <b>⚑ In CRM?</b> — possible match (double-check before skipping)</li>
                <li><b>✉ Contacted</b> — already mailed/exported</li>
              </ul>
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Direct mail is the channel (email is parked). Compliance flags are an EPA snapshot — the “refreshed” date shows how current they are.
          </p>
        </div>
      )}
    </div>
  );
}
