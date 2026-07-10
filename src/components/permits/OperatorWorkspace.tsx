import { useEffect, useState, useCallback, useRef } from "react";
import { Search, Phone, Mail, Home, Download, UserCheck } from "lucide-react";
import {
  getOperatorsList,
  logOutreach,
  type OperatorRow,
  type OperatorsListResponse,
} from "../../lib/permitApi";
import OperatorDrawer from "./OperatorDrawer";

type Stage = "todo" | "contacted" | "all";
type Channel = "all" | "phone" | "email" | "mail";
type Ehs = "all" | "enriched" | "missing";
type Compliance = "all" | "violation" | "snc";

const PAGE_SIZE = 50;
const LEADS_CSV_URL = "/api/permits/export/leads-full.csv";

function ComplianceBadge({ tier }: { tier: OperatorRow["compliance_tier"] }) {
  if (tier === "snc")
    return <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">⚠ Significant</span>;
  if (tier === "violation")
    return <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-700">⚠ In violation</span>;
  if (tier === "inspected")
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Inspected</span>;
  return <span className="text-slate-400 text-xs">—</span>;
}

/** Which channels we can reach this company on, at a glance. */
function ChannelIcons({ row }: { row: OperatorRow }) {
  return (
    <div className="flex items-center gap-1.5">
      <Phone className={`h-4 w-4 ${row.has_phone ? "text-emerald-600" : "text-slate-200"}`} aria-label={row.has_phone ? "Has phone" : "No phone"} />
      <Mail className={`h-4 w-4 ${row.has_email ? "text-blue-600" : "text-slate-200"}`} aria-label={row.has_email ? "Has email" : "No email"} />
      <Home className={`h-4 w-4 ${row.has_address ? "text-violet-600" : "text-slate-200"}`} aria-label={row.has_address ? "Has mailing address" : "No address"} />
    </div>
  );
}

export default function OperatorWorkspace({
  pushToast,
}: {
  pushToast?: (m: string, k?: "success" | "error") => void;
}) {
  const [data, setData] = useState<OperatorsListResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const [stage, setStage] = useState<Stage>("todo");
  const [channel, setChannel] = useState<Channel>("all");
  const [ehs, setEhs] = useState<Ehs>("all");
  const [compliance, setCompliance] = useState<Compliance>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<string>("pain");
  const [page, setPage] = useState(1);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const clearSel = () => setSelected(new Set());
  const toggleRow = (key: string) =>
    setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const searchRef = useRef(search);
  searchRef.current = search;

  const load = useCallback(
    (p = page) => {
      setLoading(true);
      getOperatorsList({
        stage: stage !== "all" ? stage : undefined,
        channel: channel !== "all" ? channel : undefined,
        ehs: ehs !== "all" ? ehs : undefined,
        compliance: compliance !== "all" ? compliance : undefined,
        search: searchRef.current || undefined,
        sort: sort !== "pain" ? sort : undefined,
        page: p,
        pageSize: PAGE_SIZE,
      })
        .then((r) => setData(r))
        .catch((e) => pushToast?.(`Load failed: ${(e as Error).message}`, "error"))
        .finally(() => setLoading(false));
    },
    [stage, channel, ehs, compliance, sort, page, pushToast],
  );

  useEffect(() => { load(page); }, [load]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      setPage((prev) => { if (prev === 1) { load(1); return 1; } return 1; });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Bulk "mark contacted" — after a mail merge / call session on the ticked rows.
  async function bulkMarkContacted() {
    const keys = [...selected];
    if (!window.confirm(`Mark ${keys.length} compan${keys.length === 1 ? "y" : "ies"} as contacted?`)) return;
    setBulkBusy(true);
    try {
      let ok = 0;
      for (const k of keys) {
        try { await logOutreach(k, "mailed", "mail"); ok++; } catch { /* skip one */ }
      }
      pushToast?.(`Marked ${ok} contacted`, "success");
      clearSel();
      load(page);
    } finally { setBulkBusy(false); }
  }

  const counts = data?.counts ?? { all: 0, todo: 0, contacted: 0, with_phone: 0, with_email: 0, with_address: 0, with_ehs: 0 };
  const total = data?.total ?? 0;
  const operators = data?.operators ?? [];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const complianceRefreshed = data?.compliance_last_refreshed ?? null;
  const complianceFreshnessClass = (() => {
    if (!complianceRefreshed) return null;
    const diffMs = Date.now() - new Date(complianceRefreshed).getTime();
    return diffMs > 30 * 24 * 60 * 60 * 1000 ? "text-amber-500" : "text-slate-500";
  })();

  const stageChip = (key: Stage, label: string, count: number) => (
    <button
      onClick={() => { setStage(key); setPage(1); }}
      className={`rounded-full px-3 py-1 text-sm font-semibold transition-colors ${
        stage === key ? "bg-brand-600 text-white" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
      }`}
    >
      {label} <span className={stage === key ? "text-brand-200" : "text-slate-400"}>{count.toLocaleString()}</span>
    </button>
  );

  const channelBtn = (key: Channel, label: React.ReactNode, count?: number) => (
    <button
      onClick={() => { setChannel(key); setPage(1); }}
      className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
        channel === key ? "bg-slate-800 text-white" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
      }`}
    >
      {label}{count !== undefined && <span className={channel === key ? "text-slate-300" : "text-slate-400"}>{count.toLocaleString()}</span>}
    </button>
  );

  return (
    <div className="space-y-4">
      {/* Progress chips */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
        {stageChip("todo", "To do", counts.todo)}
        {stageChip("contacted", "Contacted", counts.contacted)}
        {stageChip("all", "All", counts.all)}
        <a
          href={LEADS_CSV_URL}
          className="ml-auto flex items-center gap-1 rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          title="Download the full leads list (phone, email, address, violation) as CSV"
        >
          <Download className="h-4 w-4" /> Download list
        </a>
      </div>

      {complianceRefreshed && (
        <p className={`text-xs ${complianceFreshnessClass}`}>
          Compliance data refreshed: {complianceRefreshed}
          {complianceFreshnessClass === "text-amber-500" && " (may be stale — run a refresh)"}
        </p>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
          <input className="pl-8 pr-3 py-2 rounded-xl border border-slate-200 text-sm" placeholder="Search company"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {/* Channel filter — work one channel at a time */}
        <div className="flex items-center gap-1">
          {channelBtn("all", "Any")}
          {channelBtn("phone", <Phone className="h-3.5 w-3.5" />, counts.with_phone)}
          {channelBtn("email", <Mail className="h-3.5 w-3.5" />, counts.with_email)}
          {channelBtn("mail", <Home className="h-3.5 w-3.5" />, counts.with_address)}
        </div>

        <select value={compliance} onChange={(e) => { setCompliance(e.target.value as Compliance); setPage(1); }}
          className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white">
          <option value="all">All compliance</option>
          <option value="violation">In violation</option>
          <option value="snc">Significant noncompliance</option>
        </select>

        {/* EHS enrichment — find the EHS named contact, or isolate the un-enriched pool for a future top-up */}
        <select value={ehs} onChange={(e) => { setEhs(e.target.value as Ehs); setPage(1); }}
          className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white" title="EHS named-contact enrichment status">
          <option value="all">EHS: all</option>
          <option value="enriched">Has EHS contact ({counts.with_ehs.toLocaleString()})</option>
          <option value="missing">Missing EHS contact</option>
        </select>

        <select value={sort} onChange={(e) => setSort(e.target.value)}
          className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white" title="Sort companies">
          <option value="pain">Sort: violation severity</option>
          <option value="permits"># of permits (multi-plant first)</option>
          <option value="expiry">Soonest expiry</option>
          <option value="score">Lead score</option>
        </select>
      </div>

      {/* Bulk bar */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
          <span className="font-semibold text-brand-700">{selected.size} selected</span>
          <button onClick={bulkMarkContacted} disabled={bulkBusy}
            className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            Mark contacted ({selected.size})
          </button>
          <button onClick={clearSel} className="ml-auto text-xs text-slate-500 hover:text-slate-700">Clear</button>
        </div>
      ) : (
        <p className="text-xs text-slate-400">Hottest first · 📞 ✉ 🏠 show how you can reach each company · tick rows to mark contacted in bulk</p>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="w-8 p-2">
                <input type="checkbox" aria-label="Select all on page"
                  checked={operators.length > 0 && operators.every((o) => selected.has(o.operator_key))}
                  onChange={(e) => setSelected((s) => {
                    const n = new Set(s);
                    if (e.target.checked) operators.forEach((o) => n.add(o.operator_key));
                    else operators.forEach((o) => n.delete(o.operator_key));
                    return n;
                  })} />
              </th>
              <th className="text-left p-2">Company</th>
              <th className="text-right p-2">Permits</th>
              <th className="text-left p-2">Compliance</th>
              <th className="text-left p-2">Reach</th>
              <th className="text-left p-2">Phone</th>
              <th className="text-right p-2">Expiry</th>
              <th className="text-left p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {operators.map((row) => (
              <tr key={row.operator_key}
                className={"border-t border-slate-100 hover:bg-slate-50 cursor-pointer " + (selected.has(row.operator_key) ? "bg-brand-50/60" : "")}
                onClick={() => setSelectedKey(row.operator_key)}>
                <td className="p-2" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Select ${row.operator_name || row.operator_key}`}
                    checked={selected.has(row.operator_key)} onChange={() => toggleRow(row.operator_key)} />
                </td>
                <td className="p-2 font-medium text-slate-800">
                  {row.operator_name || "—"}
                  {row.possible_customer && <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-700" title="Possible existing customer">★</span>}
                  {row.has_ehs && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-blue-50 px-1.5 py-0.5 text-xs font-semibold text-blue-700" title="Has a named EHS/Environmental contact (Apollo)">
                      <UserCheck className="h-3 w-3" /> EHS
                    </span>
                  )}
                </td>
                <td className="p-2 text-right text-slate-600">{row.permit_count}</td>
                <td className="p-2"><ComplianceBadge tier={row.compliance_tier} /></td>
                <td className="p-2"><ChannelIcons row={row} /></td>
                <td className="p-2 text-slate-600 whitespace-nowrap">{row.phone || <span className="text-slate-300">—</span>}</td>
                <td className="p-2 text-right text-slate-500">{row.earliest_expiry || "—"}</td>
                <td className="p-2">
                  {row.contacted
                    ? <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">Contacted</span>
                    : <span className="text-slate-300 text-xs">—</span>}
                </td>
              </tr>
            ))}
            {!operators.length && !loading && (
              <tr><td colSpan={8} className="p-6 text-center text-slate-400">No companies match these filters.</td></tr>
            )}
            {loading && (
              <tr><td colSpan={8} className="p-4 text-center text-slate-400 text-xs">Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>Page {page} / {pages} &nbsp;·&nbsp; {total.toLocaleString()} companies</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40">Prev</button>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1 rounded-lg border border-slate-200 disabled:opacity-40">Next</button>
        </div>
      </div>

      <OperatorDrawer
        operatorKey={selectedKey}
        onClose={() => setSelectedKey(null)}
        onChanged={() => load(page)}
        pushToast={pushToast}
      />
    </div>
  );
}
