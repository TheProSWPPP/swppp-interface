import { useEffect, useState, useCallback, useRef } from "react";
import { ChevronRight, Search, Sparkles } from "lucide-react";
import {
  getOperatorsList,
  permitApi,
  generatePermitDrafts,
  discardOperators,
  type OperatorRow,
  type OperatorsListResponse,
} from "../../lib/permitApi";
import OperatorDrawer from "./OperatorDrawer";

type FunnelStage = "pool" | "promoted" | "email_ready" | "mailed" | "discarded";
type Stage = "all" | FunnelStage;
type Compliance = "all" | "violation" | "snc";

const STAGE_LABELS: { key: FunnelStage; label: string; tip: string }[] = [
  { key: "pool", label: "All", tip: "Every company — not started yet" },
  { key: "promoted", label: "Picked", tip: "Companies you've picked — run Find emails to check them" },
  { key: "email_ready", label: "Email ready", tip: "We found an email — send it from the Email Queue tab" },
  { key: "mailed", label: "Contacted", tip: "Already emailed" },
  { key: "discarded", label: "Discarded", tip: "Checked but no email found — dropped from the pipeline" },
];

const STAGE_PILL: Record<FunnelStage, { label: string; cls: string }> = {
  pool: { label: "Not started", cls: "bg-slate-100 text-slate-600" },
  promoted: { label: "Picked", cls: "bg-blue-100 text-blue-700" },
  email_ready: { label: "Email ready", cls: "bg-emerald-100 text-emerald-700" },
  mailed: { label: "Contacted", cls: "bg-green-100 text-green-700" },
  discarded: { label: "No email", cls: "bg-slate-100 text-slate-400" },
};

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
  const p = STAGE_PILL[stage as FunnelStage] ?? { label: stage, cls: "bg-slate-100 text-slate-600" };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${p.cls}`}>
      {p.label}
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
  const [sort, setSort] = useState<string>("pain");
  const [page, setPage] = useState(1);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Multi-select for bulk actions (separate from the drawer's single selection).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const clearSel = () => setSelected(new Set());
  const toggleRow = (key: string) =>
    setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

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
        sort: sort !== "pain" ? sort : undefined,
        page: p,
        pageSize: PAGE_SIZE,
      })
        .then((r) => setData(r))
        .catch((e) => pushToast?.(`Load failed: ${(e as Error).message}`, "error"))
        .finally(() => setLoading(false));
    },
    [stage, compliance, hideContacted, sort, page, pushToast],
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

  async function runFindEmails(operatorKeys?: string[]) {
    setEnriching(true);
    try {
      const r = await permitApi.findEmails(operatorKeys?.length ? { operatorKeys } : {});
      pushToast?.(
        `Checked ${r.probed} — found ${r.found} email${r.found === 1 ? "" : "s"}, discarded ${r.discarded}`,
        r.found > 0 ? "success" : "error",
      );
      clearSel();
      load(1);
    } catch (e) {
      pushToast?.((e as Error).message, "error");
    } finally {
      setEnriching(false);
    }
  }

  // ── Bulk actions on the ticked rows ──
  async function bulkDraft() {
    const keys = [...selected];
    setBulkBusy(true);
    try {
      const r = await generatePermitDrafts({ operatorKeys: keys });
      pushToast?.(
        r.created > 0 ? `Drafted ${r.created} — review in Email Queue` : "Nothing draftable in selection (need a found email, not already queued/contacted)",
        r.created > 0 ? "success" : "error",
      );
      clearSel();
      load(page);
    } catch (e) {
      pushToast?.((e as Error).message, "error");
    } finally { setBulkBusy(false); }
  }

  async function bulkDiscard() {
    const keys = [...selected];
    if (!window.confirm(`Discard ${keys.length} compan${keys.length === 1 ? "y" : "ies"}? They drop out of the pipeline.`)) return;
    setBulkBusy(true);
    try {
      const { discarded } = await discardOperators(keys);
      pushToast?.(`Discarded ${discarded}`, "success");
      clearSel();
      load(page);
    } catch (e) {
      pushToast?.((e as Error).message, "error");
    } finally { setBulkBusy(false); }
  }

  const counts = data?.counts ?? { pool: 0, promoted: 0, email_ready: 0, discarded: 0, mailed: 0 };
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

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white"
          title="Sort operators"
        >
          <option value="pain">Sort: violation severity</option>
          <option value="permits"># of permits (multi-plant first)</option>
          <option value="expiry">Soonest expiry</option>
          <option value="score">Lead score</option>
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
            onClick={() => runFindEmails()}
            disabled={enriching || counts.pool + counts.promoted === 0}
            title={counts.pool + counts.promoted === 0 ? "Every company has been checked" : "Apollo email lookup on the next 25 hottest unchecked (~1 credit each)"}
            className="flex items-center gap-1 text-sm font-semibold px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />
            {enriching ? "Finding…" : `Find emails (${Math.min(25, counts.pool + counts.promoted)})`}
          </button>
        </div>
      </div>

      {/* ── Bulk action bar (ticked rows) ── */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm">
          <span className="font-semibold text-indigo-700">{selected.size} selected</span>
          <button onClick={() => runFindEmails([...selected])} disabled={enriching || bulkBusy}
            className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
            Find emails ({selected.size})
          </button>
          <button onClick={bulkDraft} disabled={bulkBusy || enriching}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Draft ({selected.size})
          </button>
          <button onClick={bulkDiscard} disabled={bulkBusy || enriching}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-500 hover:text-rose-600 disabled:opacity-50">
            Discard ({selected.size})
          </button>
          <button onClick={clearSel} className="ml-auto text-xs text-slate-500 hover:text-slate-700">Clear</button>
        </div>
      ) : (
        <p className="text-xs text-slate-400">Sorted: hottest (most non-compliant) first · tick rows for bulk actions</p>
      )}

      {/* ── Operator table ── */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="w-8 p-2">
                <input
                  type="checkbox"
                  aria-label="Select all on page"
                  checked={operators.length > 0 && operators.every((o) => selected.has(o.operator_key))}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (e.target.checked) operators.forEach((o) => n.add(o.operator_key));
                      else operators.forEach((o) => n.delete(o.operator_key));
                      return n;
                    })
                  }
                />
              </th>
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
                className={"border-t border-slate-100 hover:bg-slate-50 cursor-pointer " +
                  (selected.has(row.operator_key) ? "bg-indigo-50/60" : "")}
                onClick={() => setSelectedKey(row.operator_key)}
              >
                <td className="p-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.operator_name || row.operator_key}`}
                    checked={selected.has(row.operator_key)}
                    onChange={() => toggleRow(row.operator_key)}
                  />
                </td>
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
                <td colSpan={7} className="p-6 text-center text-slate-400">
                  No operators match these filters.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={7} className="p-4 text-center text-slate-400 text-xs">
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
