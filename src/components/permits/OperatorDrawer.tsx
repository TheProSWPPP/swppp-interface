import { useEffect, useState, useCallback } from "react";
import { X } from "lucide-react";
import {
  getOperatorDetail,
  promoteOperator,
  logOutreach,
  type OperatorDetail,
  type OperatorRow,
} from "../../lib/permitApi";

type ComplianceTier = OperatorRow["compliance_tier"];

function ComplianceBadge({ tier }: { tier: ComplianceTier }) {
  if (tier === "snc")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
        ⚠ Significant noncompliance
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
  return (
    <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
      Clean
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">{children}</p>
  );
}

function PainChip({ pain }: { pain?: number }) {
  if (!pain) return null;
  const cls =
    pain >= 12
      ? "bg-red-100 text-red-700"
      : pain >= 8
        ? "bg-orange-100 text-orange-700"
        : "bg-amber-100 text-amber-700";
  return (
    <span className={`ml-1 rounded px-1.5 py-0.5 text-xs font-semibold ${cls}`}>
      pain {pain}
    </span>
  );
}

function deriveComplianceTier(maxPain: number): ComplianceTier {
  // Must match backend pain tiering exactly (bulk compliance model):
  // current violation = +12, SNC adds +6 (so SNC totals >= 18), inspected-only = +2
  if (maxPain >= 18) return "snc";
  if (maxPain >= 12) return "violation";
  if (maxPain > 0) return "inspected";
  return "clean";
}

interface Props {
  operatorKey: string | null;
  onClose: () => void;
  onChanged: () => void;
  pushToast?: (m: string, k?: "success" | "error") => void;
}

export default function OperatorDrawer({ operatorKey, onClose, onChanged, pushToast }: Props) {
  const [detail, setDetail] = useState<OperatorDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const loadDetail = useCallback(() => {
    if (!operatorKey) return;
    setLoading(true);
    setError(null);
    getOperatorDetail(operatorKey)
      .then((d) => setDetail(d))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [operatorKey]);

  useEffect(() => {
    if (operatorKey) {
      setDetail(null);
      loadDetail();
    }
  }, [operatorKey, loadDetail]);

  // Escape key closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock background scroll while drawer is open
  useEffect(() => {
    if (operatorKey) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [operatorKey]);

  async function handlePromote() {
    if (!operatorKey) return;
    setActing(true);
    try {
      const { promoted } = await promoteOperator(operatorKey);
      pushToast?.(`Promoted ${promoted} permit(s)`, "success");
      onChanged();
      loadDetail();
    } catch (e) {
      pushToast?.(`Promote failed: ${(e as Error).message}`, "error");
    } finally {
      setActing(false);
    }
  }

  async function handleOutreach(status: "mailed" | "skipped") {
    if (!operatorKey) return;
    setActing(true);
    try {
      await logOutreach(operatorKey, status);
      pushToast?.(`Marked as ${status}`, "success");
      onChanged();
      loadDetail();
    } catch (e) {
      pushToast?.(`Action failed: ${(e as Error).message}`, "error");
    } finally {
      setActing(false);
    }
  }

  if (!operatorKey) return null;

  const op = detail?.operator;
  const permits = detail?.permits ?? [];
  const enrichment = detail?.enrichment ?? null;
  const outreach = detail?.outreach ?? [];
  const mailable = detail?.mailable ?? false;

  const complianceTier = op ? deriveComplianceTier(op.max_pain) : "clean";
  const hasPoolPermit = permits.some((p) => p.status === "pool");

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-md bg-white shadow-xl z-50 overflow-y-auto flex flex-col">
        {/* Close button */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <span className="font-semibold text-slate-800 truncate pr-4">
            {op ? op.operator_name : "Loading…"}
          </span>
          <button
            onClick={onClose}
            className="shrink-0 p-1 rounded-lg hover:bg-slate-100 text-slate-400"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-4 space-y-5">
          {loading && (
            <p className="text-sm text-slate-400 text-center py-10">Loading operator detail…</p>
          )}
          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-xl p-3">{error}</p>
          )}

          {detail && op && (
            <>
              {/* ── Header ── */}
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <ComplianceBadge tier={complianceTier} />
                  <span className="text-xs text-slate-500">{op.permit_count} permit(s)</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {op.possible_customer && (
                    <span className="inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                      ★ Possible existing customer
                    </span>
                  )}
                  {op.possible_crm && (
                    <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                      ⚑ Possible CRM match
                    </span>
                  )}
                </div>
              </div>

              {/* ── Contact & address ── */}
              <div>
                <SectionLabel>Contact &amp; Address</SectionLabel>
                <div className="space-y-1 text-sm text-slate-700">
                  {enrichment?.contact_name ? (
                    <p>
                      <span className="text-slate-500">Contact:</span>{" "}
                      {enrichment.contact_name}
                    </p>
                  ) : (
                    <p className="italic text-slate-400">
                      No named contact — mail to operator at the site address
                    </p>
                  )}
                  {enrichment?.mailing_address && (
                    <p>
                      <span className="text-slate-500">Mail:</span>{" "}
                      {enrichment.mailing_address}
                    </p>
                  )}
                  {!mailable && (
                    <p className="mt-1 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600">
                      ⚠ Not mailable (no ZIP) — excluded from CSV
                    </p>
                  )}
                  {enrichment?.site_address && (
                    <p>
                      <span className="text-slate-500">Site:</span>{" "}
                      {enrichment.site_address}
                    </p>
                  )}
                  {enrichment?.sic_code && (
                    <p>
                      <span className="text-slate-500">SIC:</span> {enrichment.sic_code}
                    </p>
                  )}
                  {enrichment?.channel && (
                    <p>
                      <span className="text-slate-500">Channel:</span>{" "}
                      <span className="inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                        {enrichment.channel}
                      </span>
                    </p>
                  )}
                  {!enrichment && (
                    <p className="text-slate-400 italic text-xs">No enrichment data yet.</p>
                  )}
                </div>
              </div>

              {/* ── Permits ── */}
              <div>
                <SectionLabel>Permits ({permits.length})</SectionLabel>
                <div className="space-y-1">
                  {permits.map((p) => (
                    <div
                      key={p.external_permit_nmbr}
                      className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs"
                    >
                      <span className="font-mono font-medium text-slate-700">
                        {p.external_permit_nmbr}
                        <PainChip pain={p.compliance_flags?.pain} />
                      </span>
                      <div className="flex items-center gap-2 text-slate-500">
                        <span>{p.status}</span>
                        <span>{p.expiration_date || "—"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Compliance ── */}
              <div>
                <SectionLabel>Compliance</SectionLabel>
                <div className="text-sm text-slate-700 space-y-1">
                  <ComplianceBadge tier={complianceTier} />
                  {(() => {
                    const topPermit = permits.reduce(
                      (a, b) =>
                        (a.compliance_flags?.pain ?? 0) >= (b.compliance_flags?.pain ?? 0) ? a : b,
                      permits[0],
                    );
                    const flags = topPermit?.compliance_flags;
                    if (!flags) return null;
                    return (
                      <div className="flex flex-wrap gap-2 mt-1.5 text-xs">
                        {(flags.vioLast4Q ?? 0) > 0 && (
                          <span className="rounded bg-orange-50 px-2 py-0.5 text-orange-700 font-semibold">
                            {flags.vioLast4Q} violation(s) last 4Q
                          </span>
                        )}
                        {(flags.sv ?? 0) > 0 && (
                          <span className="rounded bg-red-50 px-2 py-0.5 text-red-700 font-semibold">
                            {flags.sv} SV
                          </span>
                        )}
                        {(flags.insp ?? 0) > 0 && (
                          <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700 font-semibold">
                            {flags.insp} inspection(s)
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* ── Possible matches ── */}
              <div>
                <SectionLabel>Possible Matches</SectionLabel>
                <div className="text-sm space-y-1">
                  {op.possible_customer ? (
                    <p className="rounded-xl bg-amber-50 px-3 py-1.5 text-amber-700 text-xs font-semibold">
                      ★ Possible existing customer (POSSIBLE — not confirmed)
                    </p>
                  ) : null}
                  {op.possible_crm ? (
                    <p className="rounded-xl bg-slate-100 px-3 py-1.5 text-slate-600 text-xs font-semibold">
                      ⚑ Possible CRM match (POSSIBLE — not confirmed)
                    </p>
                  ) : null}
                  {!op.possible_customer && !op.possible_crm && (
                    <p className="text-slate-400 text-xs italic">
                      No customer/CRM match found.
                    </p>
                  )}
                </div>
              </div>

              {/* ── Outreach history ── */}
              <div>
                <SectionLabel>Outreach History</SectionLabel>
                {outreach.length === 0 ? (
                  <p className="text-xs italic text-slate-400">No outreach yet.</p>
                ) : (
                  <div className="space-y-1">
                    {outreach.map((ev, i) => (
                      <div
                        key={i}
                        className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-slate-600"
                      >
                        <span className="font-semibold text-slate-700">{ev.status}</span>
                        {ev.channel && (
                          <span className="text-slate-400">• {ev.channel}</span>
                        )}
                        <span className="text-slate-400">
                          • {new Date(ev.created_at).toLocaleDateString()}
                        </span>
                        {ev.note && (
                          <span className="text-slate-500 italic">— {ev.note}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Actions footer ── */}
        {detail && (
          <div className="sticky bottom-0 bg-white border-t border-slate-100 px-5 py-3 flex flex-wrap gap-2">
            {hasPoolPermit && (
              <button
                onClick={handlePromote}
                disabled={acting}
                className="flex-1 min-w-[120px] text-sm font-semibold px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Promote
              </button>
            )}
            <button
              onClick={() => handleOutreach("mailed")}
              disabled={acting}
              className="flex-1 min-w-[120px] text-sm font-semibold px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
            >
              Mark mailed
            </button>
            <button
              onClick={() => handleOutreach("skipped")}
              disabled={acting}
              className="flex-1 min-w-[120px] text-sm font-semibold px-3 py-2 rounded-xl border border-slate-100 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              Mark skipped
            </button>
          </div>
        )}
      </div>
    </>
  );
}
