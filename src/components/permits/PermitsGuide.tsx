import { useState } from "react";
import { HelpCircle, ChevronDown, ChevronRight } from "lucide-react";

const KEY = "permits_guide_open";

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

/** Plain-language "how this works" panel for the Permits section. Collapsible; remembers state. */
export default function PermitsGuide() {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
  });
  const toggle = () => {
    setOpen((o) => { const n = !o; try { localStorage.setItem(KEY, n ? "1" : "0"); } catch { /* ignore */ } return n; });
  };

  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60">
      <button onClick={toggle} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <HelpCircle className="h-4 w-4 text-indigo-600" />
        <span className="text-sm font-semibold text-indigo-900">How the Permit Leads work</span>
        <span className="ml-auto text-indigo-500">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>

      {open && (
        <div className="space-y-4 px-4 pb-4 text-sm text-slate-700">
          {/* What this is */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">What these leads are</h4>
            <p className="mt-1">
              These are ~9,000 Texas businesses whose stormwater permit (<b>TXR050000</b>) expires{" "}
              <b>August 13, 2026</b>. They all renew on the same date, and most need an updated SWPPP to do it.
              The play: reach them <b>~6 months early</b> so we're first in line when they renew.
            </p>
          </section>

          {/* The 4 stages */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">The 4 stages (the bar up top)</h4>
            <dl className="mt-1 space-y-1">
              <div className="flex gap-2"><dt className="w-24 shrink-0 font-medium">Pool</dt><dd>Every company we pulled from public EPA records. Nothing done yet.</dd></div>
              <div className="flex gap-2"><dt className="w-24 shrink-0 font-medium">Promoted</dt><dd>Companies you picked to work on. (Open a company → <b>Promote</b>.)</dd></div>
              <div className="flex gap-2"><dt className="w-24 shrink-0 font-medium">Enriched</dt><dd>We've pulled their contact name + mailing address from the state (TCEQ). Now they're mailable.</dd></div>
              <div className="flex gap-2"><dt className="w-24 shrink-0 font-medium">Mailed</dt><dd>You've exported/sent them a letter. They drop off the list so you don't double-mail.</dd></div>
            </dl>
          </section>

          {/* Why compliance priority */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Why some are flagged "in violation" (and sorted to the top)</h4>
            <p className="mt-1">
              We rank by how much <b>renewal pressure</b> a company is under. Businesses the EPA has flagged for
              stormwater violations are the <b>hottest leads</b> — already in trouble, on a deadline, and most likely
              to say yes. So they float to the top with a red badge:
            </p>
            <ul className="mt-2 space-y-1">
              <li><Badge className="bg-red-100 text-red-700">⚠ Significant</Badge> <span className="ml-1">Worst offenders — start here.</span></li>
              <li><Badge className="bg-orange-100 text-orange-700">⚠ In violation</Badge> <span className="ml-1">Currently flagged by the EPA.</span></li>
              <li><Badge className="bg-amber-100 text-amber-700">Inspected</Badge> <span className="ml-1">On the regulator's radar (inspected recently).</span></li>
              <li><Badge className="bg-slate-100 text-slate-500">—</Badge> <span className="ml-1">Clean record (still a valid lead, just less urgent).</span></li>
            </ul>
          </section>

          {/* Flags */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">The flags on each row</h4>
            <ul className="mt-1 space-y-1">
              <li><b>★ Customer?</b> — the name looks like one of your existing customers. Maybe skip (don't cold-pitch a current client).</li>
              <li><b>⚑ In CRM?</b> — possible match in your sales pipeline already.</li>
              <li><b>✉ Contacted</b> — you already mailed/exported this company. Use the <b>“Hide already-contacted”</b> filter to clear them out.</li>
            </ul>
            <p className="mt-1 text-xs text-slate-500">Customer / CRM flags are best-guess name matches — worth a quick double-check before skipping.</p>
          </section>

          {/* One company = one row */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">One row = one company</h4>
            <p className="mt-1">
              A company can hold several permits (one per site). We group them into a single row so you mail the
              company <b>once</b>. Click a row to see all of its permits and addresses.
            </p>
          </section>

          {/* Step by step */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">How to work a batch (step by step)</h4>
            <ol className="mt-1 list-decimal space-y-1 pl-5">
              <li>In <b>Leads</b>, set the <b>Compliance</b> filter to “Significant noncompliance” to see the hottest companies.</li>
              <li>Click a company to review its contact, address, permits, and history.</li>
              <li><b>Promote</b> the ones you want to pursue.</li>
              <li>Click <b>Run enrichment</b> to pull their contact + mailing address (free, no credits used).</li>
              <li>Click <b>Download CSV</b> — one letter per company, deadline line included. Send it to print + mail.</li>
              <li>Mark them <b>Mailed</b> so they drop off your list.</li>
            </ol>
          </section>

          {/* Mail vs email + switch */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Mail vs. email, and the switch</h4>
            <p className="mt-1">
              Most of these are small operators who <b>aren't reachable by email</b>, so <b>direct mail is the main play</b>.
              The <b>Email Copy</b> tab is for the few larger companies we can email later — it's off for now.
            </p>
            <p className="mt-1">
              The <b>“Permit email sending”</b> switch only controls emails (currently off). Pulling contacts and
              downloading the mailing list <b>always work</b> — you don't need to flip anything to do direct mail.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
