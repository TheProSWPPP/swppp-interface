import {
  Workflow,
  Sparkles,
  Tag,
  Zap,
  Clock,
  GitBranch,
  Lightbulb,
} from "lucide-react";

export default function SystemDocs() {
  return (
    <div className="max-w-5xl mx-auto space-y-10 pb-20">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 lg:p-12">
        <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-3">
          How the System Works
        </h1>
        <p className="text-slate-500 leading-relaxed mb-8 max-w-3xl">
          A plain-English guide to what's running in the background — how leads flow
          in, how CMD data stays fresh, how SEO articles get generated, and which
          Pipedrive flags change behavior. For SWPPP data-sourcing methodology see
          the Methodology page.
        </p>

        {/* ============= 1. LEAD PIPELINE ============= */}
        <Section
          icon={<Workflow className="h-6 w-6" />}
          color="blue"
          title="Lead Pipeline (CSV upload → SDR outreach)"
        >
          <p>
            New construction leads flow through this pipeline whenever Derek uploads a CSV:
          </p>
          <ol className="list-decimal list-inside space-y-2 ml-2">
            <li><b>Lead Upload</b> — Derek drops the CSV in the Lead Import section of this app</li>
            <li><b>Cleaning</b> — Claude AI abbreviates project titles using the same rules every time (cached so identical raw titles produce identical clean titles)</li>
            <li><b>Pipedrive push</b> — cleaned leads are created in Pipedrive with all custom fields set</li>
            <li><b>Auto CMD refresh</b> — as soon as the import finishes, all newly-imported lead IDs are sent to the CMD Refresh On-Demand workflow which scrapes bidder + contact data for each lead, paced 30s apart</li>
            <li><b>SDR queue</b> — once a lead has fresh CMD data (<code className="bg-slate-100 px-1.5 rounded">Last Refresh &lt; 24h</code>), it becomes eligible for the daily Pipedrive sequence drip</li>
          </ol>
          <Box>
            <b>Freshness gate:</b> the SDR queue refuses to release a sequence email
            unless the lead's CMD data was scraped within the last 24 hours. This
            prevents stale or wrong contact info from going out to prospects.
          </Box>
        </Section>

        {/* ============= 2. CMD REFRESH CYCLES ============= */}
        <Section
          icon={<Clock className="h-6 w-6" />}
          color="indigo"
          title="CMD Refresh — keeping bidder data fresh"
        >
          <p>
            CMD Insight (Construction Market Data) is where we get bidder names, contacts, and project status.
            Three workflows keep this data fresh:
          </p>
          <Table headers={["Workflow", "Runs", "Cap", "What it does"]}>
            <Row cells={[
              "CMD Smart Refresh - AM",
              "Weekdays 5 AM",
              "100 leads",
              "Picks new leads (added in last 48h) + leads with project Start date in last 14 days OR future. Oldest-refreshed-first.",
            ]}/>
            <Row cells={[
              "CMD Smart Refresh - PM",
              "Weekdays 5 PM",
              "100 leads",
              "Same logic — second pass to catch afternoon bid postings and any leads missed by AM cycle.",
            ]}/>
            <Row cells={[
              "CMD Refresh On-Demand",
              "Triggered after every lead import",
              "Whatever was just imported",
              "Webhook-fired by the import workflow. New leads go from CSV to refreshed CMD data within minutes, not hours.",
            ]}/>
          </Table>
          <p>
            Each refresh logs into CMD once, scrapes the project's winning bidder, then reuses
            the same browser session to scrape the contractor's contacts. That session-reuse
            cuts our scraping cost by 70-90% vs logging in from scratch for every step.
          </p>
        </Section>

        {/* ============= 3. AI CONTENT (PILLARS / SPOKES / COMPARISONS) ============= */}
        <Section
          icon={<Sparkles className="h-6 w-6" />}
          color="purple"
          title="AI Content — Pillars, Spokes, Comparisons"
        >
          <p>
            Three article types power ProSWPPP's SEO strategy:
          </p>
          <Table headers={["Type", "Purpose", "Length", "Example"]}>
            <Row cells={[
              "Pillar",
              "Definitive state-level guide. One per state.",
              "~3,500 words",
              "\"Construction & Industrial SWPPP Requirements in Texas\""
            ]}/>
            <Row cells={[
              "Spoke",
              "Focused topic, often tied to a state pillar.",
              "1,000-1,500 words",
              "\"SWPPP Inspection Requirements: Frequency & Documentation\""
            ]}/>
            <Row cells={[
              "Comparison",
              "Vendor comparison with 1-2 real local competitors. ProSWPPP always #1.",
              "1,500-2,000 words",
              "\"Best SWPPP Services in Travis County (2026)\""
            ]}/>
          </Table>
          <p><b>Pillar versioning:</b> when Derek wants to refresh a pillar, the system creates a new draft on a separate WordPress slug. The original keeps working. When Derek hits "Set Current", the new content is copied into the live URL atomically — SEO juice is preserved.</p>
          <p><b>Quality rules baked into every prompt:</b> proper H2/H3 styling, descriptive anchor text (no naked URLs), short paragraphs, emoji-free, plus a long list of words to avoid that make AI content feel obviously AI-written.</p>
        </Section>

        {/* ============= 4. SEO CONTENT IDEAS (PHASE 5) ============= */}
        <Section
          icon={<Zap className="h-6 w-6" />}
          color="emerald"
          title="SEO Content Ideas (the Ideas tab)"
        >
          <p>
            Every Monday morning the system finds new SEO opportunities Derek isn't already targeting.
            Ideas land in the AI Content → Ideas tab for review.
          </p>
          <ol className="list-decimal list-inside space-y-2 ml-2">
            <li><b>Pulls keyword data</b> from DataForSEO (Google Ads source) using a SWPPP-relevant seed list — gets ~300 related keywords with monthly search volume + competition + CPC</li>
            <li><b>Filters out</b> keywords with no real volume, high competition, or that ProSWPPP is already targeting</li>
            <li><b>Gets the list of every existing ProSWPPP article</b> so Claude knows what NOT to overlap with</li>
            <li><b>Claude clusters</b> the remaining keywords into topic groups and proposes one article per cluster — title, target keyword, type (pillar/spoke/comparison), why-write angle</li>
            <li><b>Validation layer</b> rejects any idea that didn't come from the real DataForSEO data, that overlaps with existing articles, or that's a duplicate state pillar</li>
            <li><b>Surviving ideas</b> land in the Ideas tab with their real volume/competition/opportunity score</li>
          </ol>
          <p>
            <b>Opportunity Score</b> = monthly volume × (1 − competition/100) × intent multiplier (1.4 for commercial, 1.2 for local, 1.0 for informational). Higher = bigger SEO win for less effort.
          </p>
          <Box>
            <b>What to do in the Ideas tab:</b> ideas are grouped by topic cluster.
            For each cluster you can "Queue all" or "Reject all" with one click, or
            review individual ideas and Generate (queues + starts writing immediately)
            / Queue (saves for later) / Reject (never suggest again).
          </Box>
          <p className="text-xs text-slate-400 italic">
            Costs: ~$0.30/month DataForSEO + ~$0.10/month Claude tokens.
          </p>
        </Section>

        {/* ============= 5. CANNIBALIZATION GUARDS ============= */}
        <Section
          icon={<Lightbulb className="h-6 w-6" />}
          color="cyan"
          title="How the system avoids cannibalization"
        >
          <p>
            Two ProSWPPP articles competing for the same Google ranking is bad — they
            both rank lower than one strong article would. The Ideas system has three
            guards to prevent this:
          </p>
          <ol className="list-decimal list-inside space-y-2 ml-2">
            <li><b>Claude knows the existing catalog.</b> Before clustering, Claude sees a list of every live ProSWPPP article (title + state + type) and is told to skip anything that overlaps topically.</li>
            <li><b>State pillar guard.</b> If a state already has a pillar, the system rejects any new "pillar" idea for that state at insert time — even if Claude proposes one.</li>
            <li><b>Keyword overlap guard.</b> The backend rejects any idea whose target keyword is contained in (or contains) an existing live article's keyword — catches things like "swppp inspection requirements" if "swppp inspection" already exists.</li>
          </ol>
          <p>
            On top of that, every keyword Claude proposes must be in the original
            DataForSEO results — Claude can't invent fake state-specific or composite
            keywords with made-up volume numbers. The numeric metadata that lands in
            the database always comes from the real DataForSEO row.
          </p>
        </Section>

        {/* ============= 6. PIPEDRIVE TAGS / FIELDS ============= */}
        <Section
          icon={<Tag className="h-6 w-6" />}
          color="amber"
          title="Pipedrive Custom Fields & Tags"
        >
          <p>
            These Pipedrive lead fields control how the system treats each lead:
          </p>
          <Table headers={["Field", "What it does"]}>
            <Row cells={[
              "Skip CMD Updates",
              <>The lead's CMD project URL. If empty, missing, or set to the literal text <code className="bg-slate-100 px-1.5 rounded">Skip</code>, all refresh workflows skip this lead silently — no notes, no scraping.</>
            ]}/>
            <Row cells={[
              "Ignore Bidders Update?",
              <>Set to value <code className="bg-slate-100 px-1.5 rounded">37</code> (the "yes" enum value) to flag the lead as "do not auto-scrape". Refresh cycles skip it.</>
            ]}/>
            <Row cells={[
              "Last Refresh",
              "Auto-stamped after a successful CMD refresh. The SDR queue requires this < 24h before releasing a sequence email."
            ]}/>
            <Row cells={[
              "Start",
              "Project start date. The Smart Refresh cycles include leads where this is in the last 14 days OR future."
            ]}/>
            <Row cells={[
              "Bid",
              "Original bid date. Informational only — not used for refresh filtering anymore."
            ]}/>
            <Row cells={[
              "Sequence_Started",
              "Tracks which Pipedrive sequence (PB / AGC / LBA / CM) the lead is enrolled in."
            ]}/>
            <Row cells={[
              "Scheduled_Enrollment_Date",
              "When the sequence drip should begin. The SDR Queue Processor uses this."
            ]}/>
            <Row cells={[
              "Short_Geo_Term / Long_Geo_Term",
              <>Set per state by SDR Automation. Most states use <code className="bg-slate-100 px-1.5 rounded">SWPPP</code>; Alabama uses <code className="bg-slate-100 px-1.5 rounded">CBMPP</code>, Georgia <code className="bg-slate-100 px-1.5 rounded">ES&PC Plan</code>, North Carolina <code className="bg-slate-100 px-1.5 rounded">E&SC PLAN</code>. These get inserted into sequence email subject lines + body.</>
            ]}/>
          </Table>
        </Section>

        {/* ============= 7. APOLLO VERIFY V2 ============= */}
        <Section
          icon={<GitBranch className="h-6 w-6" />}
          color="rose"
          title="Apollo Verify — picking the best contact"
        >
          <p>
            After the CMD refresh pulls bidder + contact data, the system runs an Apollo
            verification step to make sure Derek is reaching out to the right person —
            never a generic <code className="bg-slate-100 px-1.5 rounded">info@</code> address if a real human exists.
          </p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><b>If the contractor's org is already in Pipedrive</b> with persons, score by closed-deals count + recent activity, prefer non-generic emails over <code className="bg-slate-100 px-1.5 rounded">info@</code>/<code className="bg-slate-100 px-1.5 rounded">bids@</code></li>
            <li><b>If not</b>, query Apollo for people at the org's domain. Score by seniority (C-suite / VP / Director / Manager) + role keywords (estimator, project manager, civil engineer, SWPPP). Threshold for swap is score ≥ 5.</li>
            <li><b>Mid-sequence guard</b> — if the lead is already enrolled in a sequence, swapping the contact mid-flight would be disruptive. The system defers the swap and writes a note.</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}

// ===== Helpers =====
function Section({ icon, color, title, children }: { icon: React.ReactNode; color: string; title: string; children: React.ReactNode }) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-50 text-blue-600 border-blue-100",
    indigo: "bg-indigo-50 text-indigo-600 border-indigo-100",
    purple: "bg-purple-50 text-purple-600 border-purple-100",
    emerald: "bg-emerald-50 text-emerald-600 border-emerald-100",
    amber: "bg-amber-50 text-amber-600 border-amber-100",
    rose: "bg-rose-50 text-rose-600 border-rose-100",
    cyan: "bg-cyan-50 text-cyan-600 border-cyan-100",
  };
  return (
    <section className="space-y-4 mt-12 first:mt-0">
      <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
        <div className={`h-10 w-10 rounded-xl flex items-center justify-center border ${colorMap[color] || colorMap.cyan}`}>
          {icon}
        </div>
        {title}
      </h2>
      <div className="pl-13 space-y-3 text-sm text-slate-600 leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border bg-slate-50 border-slate-200 text-slate-700 p-3 text-sm">
      {children}
    </div>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 mt-2">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="text-left font-semibold text-slate-700 px-4 py-2.5 text-xs uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {children}
        </tbody>
      </table>
    </div>
  );
}

function Row({ cells }: { cells: React.ReactNode[] }) {
  return (
    <tr className="hover:bg-slate-50">
      {cells.map((c, i) => (
        <td key={i} className="px-4 py-2.5 text-slate-600 align-top">{c}</td>
      ))}
    </tr>
  );
}
