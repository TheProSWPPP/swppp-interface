import { useEffect, useState, useCallback, useRef } from "react";
import { ChevronRight, Search, Download, Sparkles } from "lucide-react";
import {
  getOperatorsList,
  permitApi,
  type OperatorRow,
  type OperatorsListResponse,
} from "../../lib/permitApi";
import OperatorDrawer from "./OperatorDrawer";

type FunnelStage = "pool" | "promoted" | "enriched" | "mailed";
type Stage = "all" | FunnelStage;
type Compliance = "all" | "violation" | "snc";

const STAGE_LABELS: { key: FunnelStage; label: string; tip: string }[] = [
  { key: "pool", label: "All", tip: "Every company — not started yet" },
  { key: "promoted", label: "Picked", tip: "Companies you've picked to work" },
  { key: "enriched", label: "Address ready", tip: "Mailing address pulled — ready for the CSV" },
  { key: "mailed", label: "Mailed", tip: "Already mailed or exported" },
];

const PAGE_SIZE = 50;

function ComplianceBadge({ tier }: { tier: OperatorRow["compliance_tier"] }) {
  if (tier === "snc")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
        ⚠ Significant
      </span>
    );
  if (tier === "violation")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-700">
        ⚠ In violation
      </span>
    );
  if (tier === "inspected")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
        Inspected
      </span>
    );
  return <span className="text-slate-400 text-xs">—</span>;
}

function StagePill({ stage }: { stage: OperatorRow["stage"] }) {
  const map: Record<string, string> = {
    pool: "bg-slate-100 text-slate-600",
    promoted: "bg-blue-100 text-blue-700",
    enriched: "bg-indigo-100 text-indigo-700",
    mailed: "bg-green-100 text-green-700",
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${map[stage] ?? "bg-slate-100 text-slate-600"}`}
    >
      {stage}
    </span>
  );
}

function FlagsCell({ row }: { row: OperatorRow }) {
  const chips: React.ReactNode[] = [];
  if (row.possible_customer)
    chips.push(
      <span
        key="cust"
        className="inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700"
      >
        ★ Customer?
      </span>,
    );
  if (row.possible_crm)
    chips.push(
      <span
        key="crm"
        className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600"
      >
        ⚑ In CRM?
      </span>,
    );
  if (row.contacted) {
    const dateStr = row.last_outreach_at
      ? new Date(row.last_outreach_at).toLocaleDateString()
      : "";
    chips.push(
      <span
        key="contacted"
        className="inline-block rounded-full bg-green-50 px-2 py-0.5 text-xs font-semibold text-green-700"
      >
        ✉ Contacted{dateStr ? ` ${dateStr}` : ""}
      </span>,
    );
  }
  if (!chips.length) return <span className="text-slate-400 text-xs">—</span>;
  return <div className="flex flex-wrap gap-1">{chips}</div>;
}

export default function OperatorWorkspace({
  pushToast,
}: {
  pushToast?: (m: string, k?: "success" | "error") => void;
}) {
  const [data, setData] = useState<OperatorsListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [enriching, setEnriching] = useState(false);

  const [stage, setStage] = useState<Stage>("all");
  const [compliance, setCompliance] = useState<Compliance>("all");
  const [hideContacted, setHideContacted] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Keep a ref so `load` can always read the latest search without being
  // re-created every keystroke (avoids cascading effect re-runs).
  const searchRef = useRef(search);
  searchRef.current = search;

  const load = useCallback(
    (p = page) => {
      setLoading(true);
      getOperatorsList({
        stage: stage !== "all" ? stage : undefined,
        compliance: compliance !== "all" ? compliance : undefined,
        hideContacted: hideContacted || undefined,
        search: searchRef.current || undefined,
        page: p,
        pageSize: PAGE_SIZE,
      })
        .then((r) => setData(r))
        .catch((e) => pushToast?.(`Load failed: ${(e as Error).message}`, "error"))
        .finally(() => setLoading(false));
    },
    [stage, compliance, hideContacted, page, pushToast],
  );

  // Non-search filters + page: reload whenever these change
  useEffect(() => {
    load(page);
  }, [load]);

  // Debounced search: 300ms after the user stops typing, reset to page 1 and load
  useEffect(() => {
    const t = setTimeout(() => {
      setPage((prev) => {
        // If already on page 1, `load` dep won't change — call load directly
        if (prev === 1) { load(1); return 1; }
        return 1; // changing page triggers the load effect above
      });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function runEnrich() {
    setEnriching(true);
    try {
      const r = await permitApi.enrich(50);
      pushToast?.(`Enriched ${r.ok}/${r.processed} (${r.fail} failed)`, "success");
      load(1);
    } catch (e) {
      pushToast?.((e as Error).message, "error");
    } finally {
      setEnriching(false);
    }
  }

  const counts = data?.counts ?? { pool: 0, promoted: 0, enriched: 0, mailed: 0 };
  const total = data?.total ?? 0;
  const operators = data?.operators ?? [];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const complianceRefreshed = data?.compliance_last_refreshed ?? null;

  // Determine freshness: stale if older than 30 days from today
  const complianceFreshnessClass = (() => {
    if (!complianceRefreshed) return null;
    const diffMs = Date.now() - new Date(complianceRefreshed).getTime();
    return diffMs > 30 * 24 * 60 * 60 * 1000 ? "text-amber-500" : "text-slate-500";
  })();

  return (
    <div className="space-y-4">
      {/* ── Funnel header ── */}
      <div className="flex flex-wrap items-center gap-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
        {STAGE_LABELS.map(({ key, label, tip }, i) => (
          <span key={key} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-4 w-4 text-slate-400" />}
            <button
              onClick={() => setStage((s) => (s === key ? "all" : key))}
              title={tip}
              className={`rounded-full px-3 py-1 text-sm font-semibold transition-colors ${
                stage === key
                  ? "bg-indigo-600 text-white"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
              }`}
            >
              {label}{" "}
              <span className={stage === key ? "text-indigo-200" : "text-slate-400"}>
                {counts[key].toLocaleString()}
              </span>
            </button>
          </span>
        ))}
      </div>

      {/* ── Compliance freshness ── */}
      {complianceRefreshed === null && data && (
        <p className="text-xs text-slate-500">Compliance data: not yet scored</p>
      )}
      {complianceRefreshed && (
        <p className={`text-xs ${complianceFreshnessClass}`}>
          Compliance data refreshed: {complianceRefreshed}
          {complianceFreshnessClass === "text-amber-500" && " (may be stale — run a refresh)"}
        </p>
      )}

      {/* ── Filter / action bar ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
          <input
            className="pl-8 pr-3 py-2 rounded-xl border border-slate-200 text-sm"
            placeholder="Search operator"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select
          value={compliance}
          onChange={(e) => setCompliance(e.target.value as Compliance)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white"
        >
          <option value="all">All compliance</option>
          <option value="violation">In violation</option>
          <option value="snc">Significant noncompliance</option>
        </select>

        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
          <input
            type="checkbox"
            className="rounded"
            checked={hideContacted}
            onChange={(e) => setHideContacted(e.target.checked)}
          />
          Hide already-contacted
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={runEnrich}
            disabled={enriching || counts.promoted === 0}
            title={counts.promoted === 0 ? "Promote operators first" : undefined}
            className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />
            {enriching ? "Enriching…" : "Enrich promoted (up to 50)"}
          </button>
          {counts.enriched === 0 ? (
            <button
              disabled
              title="Get mailing addresses first — click Enrich"
              className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl border border-slate-200 opacity-50 cursor-not-allowed"
            >
              <Download className="h-4 w-4" /> Download mailing list ({counts.enriched.toLocaleString()})
            </button>
          ) : (
            <a
              href={permitApi.directMailCsvUrl()}
              className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50"
            >
              <Download className="h-4 w-4" /> Download mailing list ({counts.enriched.toLocaleString()})
            </a>
          )}
        </div>
      </div>

      {/* ── Sort hint ── */}
      <p className="text-xs text-slate-400">Sorted: hottest (most non-compliant) first</p>

      {/* ── Operator table ── */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left p-2">Company</th>
              <th className="text-right p-2">Permits</th>
              <th className="text-left p-2">Compliance</th>
              <th className="text-right p-2">Expiry</th>
              <th className="text-left p-2">Stage</th>
              <th className="text-left p-2">Flags</th>
            </tr>
          </thead>
          <tbody>
            {operators.map((row) => (
              <tr
                key={row.operator_key}
                className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                onClick={() => setSelectedKey(row.operator_key)}
              >
                <td className="p-2 font-medium text-slate-800">{row.operator_name || "—"}</td>
                <td className="p-2 text-right text-slate-600">{row.permit_count}</td>
                <td className="p-2">
                  <ComplianceBadge tier={row.compliance_tier} />
                </td>
                <td className="p-2 text-right text-slate-500">
                  {row.earliest_expiry || "—"}
                </td>
                <td className="p-2">
                  <StagePill stage={row.stage} />
                </td>
                <td className="p-2">
                  <FlagsCell row={row} />
                </td>
              </tr>
            ))}
            {!operators.length && !loading && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-slate-400">
                  No operators match these filters.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={6} className="p-4 text-center text-slate-400 text-xs">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>
          Page {page} / {pages} &nbsp;·&nbsp; {total.toLocaleString()} operators
        </span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40"
          >
            Prev
          </button>
          <button
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>

      {/* ── Drawer ── */}
      <OperatorDrawer
        operatorKey={selectedKey}
        onClose={() => setSelectedKey(null)}
        onChanged={() => load(page)}
        pushToast={pushToast}
      />
    </div>
  );
}
