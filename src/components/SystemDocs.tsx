import {
  Workflow,
  Database,
  Sparkles,
  Mail,
  Tag,
  Zap,
  Clock,
  ShieldAlert,
  GitBranch,
  Wrench,
} from "lucide-react";

export default function SystemDocs() {
  return (
    <div className="max-w-5xl mx-auto space-y-10 pb-20">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 lg:p-12">
        <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-3">
          System Documentation
        </h1>
        <p className="text-slate-500 leading-relaxed mb-8 max-w-3xl">
          End-to-end reference for the ProSWPPP automation stack — n8n workflows,
          refresh cycles, AI content pipeline, SEO ideas engine, Pipedrive tags,
          and recent fixes. For SWPPP data-sourcing methodology see the Methodology page.
        </p>

        {/* ============= 1. LEAD PIPELINE ============= */}
        <Section
          icon={<Workflow className="h-6 w-6" />}
          color="blue"
          title="Lead Pipeline (CSV → SDR Outreach)"
        >
          <p>
            New construction leads enter the system via CSV upload. They flow through
            cleaning, Pipedrive creation, immediate CMD refresh, and into the SDR
            email queue. Each step is independently observable and recoverable.
          </p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><b>Lead Upload</b> (UI) → <code className="bg-slate-100 px-1.5 rounded">/api/leads/upload</code> → multer saves CSV → DB row created</li>
            <li><b>Lead Import Unified - Clean Phase</b> (n8n <code className="bg-slate-100 px-1.5 rounded">HcvuSiPWVmmjKs9z</code>) — Claude abbreviates project titles using cached idempotent rules</li>
            <li><b>Lead Import - Pipedrive Push</b> (n8n <code className="bg-slate-100 px-1.5 rounded">7pWIOzeGqcFcv9rS</code>) — pushes cleaned rows to Pipedrive via sub-workflow, then aggregates new lead IDs</li>
            <li><b>CMD Refresh On-Demand</b> (n8n <code className="bg-slate-100 px-1.5 rounded">YqBGOvAGWFwBdzEK</code>) — webhook-triggered immediately after import completes; refreshes each new lead's bidder + contacts data</li>
            <li><b>SDR Queue Processor - Daily Drip</b> (n8n <code className="bg-slate-100 px-1.5 rounded">72JpL2WYZclzR9m1</code>) — releases scheduled emails through Pipedrive sequences once <code className="bg-slate-100 px-1.5 rounded">Last Refresh &lt; 24h</code></li>
          </ul>
          <Box>
            <b>Freshness gate:</b> the SDR queue refuses to release a lead unless its
            <code className="bg-slate-100 px-1.5 rounded mx-1">Last Refresh</code> field is within 24 hours.
            This prevents stale CMD data from going out in cold emails.
          </Box>
        </Section>

        {/* ============= 2. CMD REFRESH CYCLES ============= */}
        <Section
          icon={<Clock className="h-6 w-6" />}
          color="indigo"
          title="CMD Refresh Cycles"
        >
          <p>
            Three workflows keep CMD data fresh — two scheduled, one event-driven:
          </p>
          <Table headers={["Workflow", "Trigger", "Cap", "Scope"]}>
            <Row cells={[
              <>CMD Smart Refresh - AM <Code>JIZMs2AQNHrRAsbt</Code></>,
              "Weekdays 5 AM",
              "100/run",
              "Tier A (new <48h) + Tier B (Start within last 14d OR future)",
            ]}/>
            <Row cells={[
              <>CMD Smart Refresh - PM <Code>hFDNNXejpg4soNnN</Code></>,
              "Weekdays 5 PM",
              "100/run",
              "Same logic — second pass, picks up new bid postings during the day",
            ]}/>
            <Row cells={[
              <>CMD Refresh On-Demand <Code>YqBGOvAGWFwBdzEK</Code></>,
              "Webhook (fires after import completes)",
              "Whatever was just imported",
              "Validated lead_ids only — applies skip-flag, invalid-URL, and 6h freshness filters",
            ]}/>
          </Table>
          <p>
            All three call <b>CMD Per-Lead Processor</b> (<code className="bg-slate-100 px-1.5 rounded">QsTHSvl3LvkpznqW</code>) which does the heavy lifting:
          </p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Skip Gate — bails early on flagged leads or invalid URLs (no spam notes)</li>
            <li>BQL: Bidder — Browserless GraphQL login + extract winning bidder from the project grid; ends with <code className="bg-slate-100 px-1.5 rounded">reconnect(60s)</code> handing back a session endpoint</li>
            <li>BQL: Contacts (Smart Reconnect) — reuses session for fast contact extraction; falls back to fresh login on 404 or missing endpoint</li>
            <li>Org Compare → optional Pipedrive Org create + person attach</li>
            <li>Apollo Verify v2 (sub-workflow) — picks best person at the org, falls back to Apollo search if no match</li>
            <li>Updates <code className="bg-slate-100 px-1.5 rounded">Last Refresh</code> timestamp on success</li>
          </ul>
          <Box variant="green">
            <b>Browserless session reconnect</b> reduces residential proxy units 70-90%.
            Login amortized across multiple navigations within a 60-second window.
            Verified at 100% reuse rate on production traffic.
          </Box>
        </Section>

        {/* ============= 3. AI CONTENT (PILLARS / SPOKES / COMPARISONS) ============= */}
        <Section
          icon={<Sparkles className="h-6 w-6" />}
          color="purple"
          title="AI Content System (Pillars / Spokes / Comparisons)"
        >
          <p>
            SEO content is generated by <b>Pro SWPPP SEO Articles to WP</b>
            (<code className="bg-slate-100 px-1.5 rounded">neUr1nKP9LcLot5C</code>) and stored in <code className="bg-slate-100 px-1.5 rounded">ai_content</code>:
          </p>
          <Table headers={["Type", "Purpose", "Word Count", "Image Placeholders"]}>
            <Row cells={["Pillar", "State-level overview, one current per state", "~3,500", "3-4"]}/>
            <Row cells={["Spoke", "Focused topic, optionally tied to a state pillar", "1,000-1,500", "2-3"]}/>
            <Row cells={["Comparison", "\"Best SWPPP Services in {Area}\" with 1-2 real local competitors", "1,500-2,000", "3"]}/>
          </Table>
          <p><b>Pillar Versioning</b> (Phase 2):</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Each pillar lineage has a <code className="bg-slate-100 px-1.5 rounded">base_pillar_id</code>; only one version is <code className="bg-slate-100 px-1.5 rounded">is_current=TRUE</code> at a time</li>
            <li>"New Version" button creates a fresh draft on a versioned WP slug — original stays live</li>
            <li>"Set Current" performs an atomic Postgres transaction: copies new content into the live WP post (preserves SEO URL), trashes the staging draft, flips <code className="bg-slate-100 px-1.5 rounded">is_current</code></li>
          </ul>
          <p><b>Comparison articles</b> use real local competitors from Perplexity research, never invented names. ProSWPPP always row 1 with highlight styling.</p>
          <Box>
            <b>Quality rules baked into Comparison + Pillar prompts:</b> <code className="bg-slate-100 px-1.5 rounded">{'<h2 style="margin-top:50px">'}</code> and <code className="bg-slate-100 px-1.5 rounded">{'<h3 style="margin-top:35px">'}</code> inline margins,
            descriptive anchor text (no naked URL links), mandatory final CTA, &lt;3-sentence paragraphs, em-dash limit, full negative-words list to prevent AI tells.
          </Box>
        </Section>

        {/* ============= 4. SEO CONTENT IDEAS (PHASE 5) ============= */}
        <Section
          icon={<Zap className="h-6 w-6" />}
          color="emerald"
          title="SEO Content Ideas (Phase 5)"
        >
          <p>
            Weekly opportunity discovery — ranks low-competition / high-volume keywords ProSWPPP isn't already targeting.
          </p>
          <ol className="list-decimal list-inside space-y-1.5 ml-2">
            <li><b>Weekly SEO Content Ideas</b> (n8n <code className="bg-slate-100 px-1.5 rounded">U8QCpEGRS1vD1bfV</code>) fires Mondays 7 AM</li>
            <li>Pulls seed list + already-targeted keyword set from <code className="bg-slate-100 px-1.5 rounded">/api/seo-ideas/seeds</code> + <code className="bg-slate-100 px-1.5 rounded">/api/seo-ideas/known-keywords</code></li>
            <li>POSTs seeds to DataForSEO Google Ads <code className="bg-slate-100 px-1.5 rounded">keywords_for_keywords/live</code> ($0.075/run, returns ~300 keywords with monthly volume + competition + CPC)</li>
            <li>Filters: volume ≥ 30, competition ≤ 70, not in known set</li>
            <li>Claude (sonnet-4.5) clusters into 5-15 topic groups; for each cluster picks one best opportunity, proposes article (title, target keyword, type, intent, difficulty 1-10, why-write angle)</li>
            <li>HMAC-signed POST to <code className="bg-slate-100 px-1.5 rounded">/api/seo-ideas/batch</code> → ideas land as <code className="bg-slate-100 px-1.5 rounded">status='pending'</code> rows</li>
            <li>Derek reviews in <b>AI Content → Ideas tab</b>; approve creates an <code className="bg-slate-100 px-1.5 rounded">ai_content</code> draft (with optional kickoff-now), reject flags as never-suggest-again</li>
          </ol>
          <Box>
            <b>Costs:</b> ~$0.30/month DataForSEO + ~$0.10/month Claude tokens.
            Effectively free SEO research that compounds weekly.
          </Box>
        </Section>

        {/* ============= 5. PIPEDRIVE TAGS / FIELDS ============= */}
        <Section
          icon={<Tag className="h-6 w-6" />}
          color="amber"
          title="Pipedrive Custom Fields & Operational Tags"
        >
          <p>
            Several Pipedrive lead fields drive automation behavior — flag them on a lead to change how the system treats it.
          </p>
          <Table headers={["Field", "Type", "Used by", "Effect"]}>
            <Row cells={[
              "Skip CMD Updates",
              "URL/varchar",
              "All refresh workflows",
              <>The lead's CMD project URL. Set to literal <code className="bg-slate-100 px-1.5 rounded">Skip</code> or leave invalid → workflows skip without writing notes</>
            ]}/>
            <Row cells={[
              "Ignore Bidders Update?",
              "enum",
              "Skip Gate",
              <>Value <code className="bg-slate-100 px-1.5 rounded">37</code> = skip CMD refresh entirely; lead stays as-is</>
            ]}/>
            <Row cells={[
              "Last Refresh",
              "date",
              "All refresh + SDR queue",
              "Auto-stamped after a successful CMD refresh. SDR queue requires this < 24h to release a sequence email"
            ]}/>
            <Row cells={[
              "Start",
              "date",
              "Smart Refresh tier_b filter",
              "Project start date. Eligible window: last 14 days OR future"
            ]}/>
            <Row cells={[
              "Bid",
              "date",
              "Reference only",
              "Original bid date — informational, not used for refresh filtering"
            ]}/>
            <Row cells={[
              "Sequence_Started",
              "varchar",
              "SDR Automation",
              "Tracks which sequence (PB/AGC/LBA/CM) is enrolled"
            ]}/>
            <Row cells={[
              "Scheduled_Enrollment_Date",
              "date",
              "SDR Queue Processor",
              "When the sequence drip should begin"
            ]}/>
            <Row cells={[
              "Short_Geo_Term / Long_Geo_Term",
              "varchar",
              "Sequence templates",
              <>Set per state by SDR Automation (<code className="bg-slate-100 px-1.5 rounded">SWPPP</code> for most, <code className="bg-slate-100 px-1.5 rounded">CBMPP</code> AL, <code className="bg-slate-100 px-1.5 rounded">ES&PC Plan</code> GA, <code className="bg-slate-100 px-1.5 rounded">E&SC PLAN</code> NC)</>
            ]}/>
          </Table>
        </Section>

        {/* ============= 6. APOLLO VERIFY V2 ============= */}
        <Section
          icon={<GitBranch className="h-6 w-6" />}
          color="rose"
          title="Apollo Verify v2 (Contact Quality)"
        >
          <p>
            Sub-workflow (<code className="bg-slate-100 px-1.5 rounded">1p8GG5KWLIT5dEw9</code>) called inline by CMD Per-Lead Processor.
            Picks the best contact for outreach — never a generic
            <code className="bg-slate-100 px-1.5 rounded mx-1">info@</code>/<code className="bg-slate-100 px-1.5 rounded">bids@</code> address if a real person exists.
          </p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><b>Customer path</b> — if the org is already in Pipedrive with persons, score by closed-deals count + last-activity recency, prefer non-generic emails</li>
            <li><b>Standard path</b> — query Apollo for people at the org's domain, score by seniority + role keywords (estimator, PM, civil/SWPPP), validate email status, threshold ≥ 5</li>
            <li><b>Mid-sequence guard</b> — if the lead is already in a sequence and a contact swap would interrupt it, defers the swap and writes a note</li>
          </ul>
        </Section>

        {/* ============= 7. SECURITY & AUTH ============= */}
        <Section
          icon={<ShieldAlert className="h-6 w-6" />}
          color="slate"
          title="Auth & Security"
        >
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><b>App-level Basic auth</b> — user <code className="bg-slate-100 px-1.5 rounded">derek</code> on the swppp-interface site (Express middleware)</li>
            <li><b>HMAC SHA-256</b> on n8n → backend callbacks: <code className="bg-slate-100 px-1.5 rounded">/api/leads/upload/callback</code>, <code className="bg-slate-100 px-1.5 rounded">/api/ai-content/callback</code> (transition mode), <code className="bg-slate-100 px-1.5 rounded">/api/seo-ideas/batch</code></li>
            <li><b>Callback secret query param</b> bypass for n8n GET endpoints — <code className="bg-slate-100 px-1.5 rounded">/api/leads/upload/:id/rows</code>, <code className="bg-slate-100 px-1.5 rounded">/api/seo-ideas/seeds</code>, <code className="bg-slate-100 px-1.5 rounded">/api/seo-ideas/known-keywords</code></li>
            <li><b>Centralized credentials</b> in n8n: CMD Insight Login, Pipedrive API, Anthropic API (Claude KEY), DataForSEO API, Browserless</li>
          </ul>
        </Section>

        {/* ============= 8. RECENT FIXES & PATCHES ============= */}
        <Section
          icon={<Wrench className="h-6 w-6" />}
          color="orange"
          title="Recent Fixes (May 2026)"
        >
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><b>Skip Gate hardening</b> — short-circuits on invalid/missing/<code className="bg-slate-100 px-1.5 rounded">"Skip"</code> URLs. Was timing out 5 min on Browserless trying to navigate to literal "Skip"</li>
            <li><b>Apollo paired-item bug</b> — <code className="bg-slate-100 px-1.5 rounded">Score Customer Persons</code> + <code className="bg-slate-100 px-1.5 rounded">Score Apollo Candidates</code> aggregator code nodes now propagate <code className="bg-slate-100 px-1.5 rounded">pairedItem</code> to fix downstream <code className="bg-slate-100 px-1.5 rounded">$('NodeName').item.json</code> resolution</li>
            <li><b>Comparison Writer prompt parity</b> — added image-placeholder block, h2/h3 inline margins, naked-URL ban, full negative-words list to match Pillar quality</li>
            <li><b>Smart Refresh skip-flag pre-filter</b> — Build Candidates excludes flag=37 + non-http URLs at source, killing the daily auto-skip note spam</li>
            <li><b>Browserless session reconnect</b> — refactored CMD Per-Lead Processor BQL: Bidder + Contacts to reuse session within a single lead refresh</li>
            <li><b>Highland Paving Set-node bug</b> — Attach Created Org now explicitly carries Parse Contacts data forward (was wiping when Create Org branch ran)</li>
          </ul>
        </Section>

        {/* ============= 9. ROADMAP ============= */}
        <Section
          icon={<Database className="h-6 w-6" />}
          color="teal"
          title="Roadmap (Plan: 2026-04-30 Pro SWPPP Data Platform)"
        >
          <Table headers={["Phase", "Status", "Description"]}>
            <Row cells={["Phase 1 — Data Quality + Lead Import", "Done", "Unified import flow, AI abbreviations, smart CMD scraper, freshness gate"]}/>
            <Row cells={["Phase 2 — Pillar Versioning", "Done", "Atomic publish-swap, atomic transactions, versions UI"]}/>
            <Row cells={["Phase 5 — SEO Content Ideas", "Done", "Weekly DataForSEO + Claude clustering pipeline"]}/>
            <Row cells={["Phase 4 — Warm Leads Digest", "Deferred", "Pipedrive's binary signal too coarse — wait for Apollo data via Phase 3"]}/>
            <Row cells={["Phase 3 — Custom SDR Interface (Apollo)", "Pending", "Hybrid Pipedrive + Apollo period; sender ownership via Sequence_Started + Apollo_Sequence_ID; bidirectional pause; Slack engagement alerts"]}/>
            <Row cells={["Phase 6 — Brevo Nurture Connect", "Gated", "Wire existing Brevo lists/templates to new WordPress site forms when launched"]}/>
            <Row cells={["FINAL PHASE swap", "Pending", "Migrate TvhcCnj90KzUyIBs + cC8crJHuYpbwF9E0 to new processor + Apollo v2"]}/>
            <Row cells={["FINAL — winner-change automation", "Pending", "Auto webhook on bidder change → SDR sequence rotation cleanup"]}/>
          </Table>
          <p className="text-xs text-slate-400 italic">Plan doc: <code className="bg-slate-100 px-1.5 rounded">docs/superpowers/plans/2026-04-30-pro-swppp-data-platform.md</code></p>
        </Section>

        {/* ============= 10. EXTERNAL DEPENDENCIES ============= */}
        <Section
          icon={<Mail className="h-6 w-6" />}
          color="cyan"
          title="External Dependencies"
        >
          <Table headers={["Service", "Purpose", "Cost", "Notes"]}>
            <Row cells={["Pipedrive", "Lead CRM, persons, sequences, notes", "Subscription", "API token in n8n credentials"]}/>
            <Row cells={["Browserless (BQL)", "CMD scraping (login + grid extraction)", "Starter $140/mo, 180k units", "Session reconnect cuts unit usage 70-90%"]}/>
            <Row cells={["Anthropic Claude", "Article generation, idea clustering, abbreviations", "Pay-as-you-go", "claude-sonnet-4.5"]}/>
            <Row cells={["Perplexity", "Real competitor research for comparison articles", "Pay-as-you-go", ""]}/>
            <Row cells={["DataForSEO", "Google Ads keyword volume + competition", "$0.075/task, $50 min deposit", "Weekly batch ≈ $0.30/mo"]}/>
            <Row cells={["Apollo.io", "Person enrichment + email verification", "Subscription", "Used by Apollo Verify v2"]}/>
            <Row cells={["WordPress (proswppp.com)", "Article publishing target", "Self-hosted", "REST API + custom slug for versioned drafts"]}/>
            <Row cells={["Railway", "App + Postgres hosting", "Subscription", "Auto-deploys on push to main"]}/>
            <Row cells={["Brevo", "Nurture email campaigns (Phase 6)", "Free tier", "Currently dormant — awaiting WP site launch"]}/>
          </Table>
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
    slate: "bg-slate-50 text-slate-600 border-slate-100",
    orange: "bg-orange-50 text-orange-600 border-orange-100",
    teal: "bg-teal-50 text-teal-600 border-teal-100",
    cyan: "bg-cyan-50 text-cyan-600 border-cyan-100",
  };
  return (
    <section className="space-y-4 mt-12 first:mt-0">
      <h2 className="text-xl font-bold text-slate-900 flex items-center gap-3">
        <div className={`h-10 w-10 rounded-xl flex items-center justify-center border ${colorMap[color] || colorMap.slate}`}>
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

function Box({ children, variant = "slate" }: { children: React.ReactNode; variant?: "slate" | "green" }) {
  const cls = variant === "green"
    ? "bg-green-50 border-green-200 text-green-900"
    : "bg-slate-50 border-slate-200 text-slate-700";
  return (
    <div className={`mt-3 rounded-lg border p-3 text-sm ${cls}`}>
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

function Code({ children }: { children: React.ReactNode }) {
  return <code className="bg-slate-100 text-xs px-1.5 py-0.5 rounded font-mono ml-1">{children}</code>;
}
