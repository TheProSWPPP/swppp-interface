# Permit-Expiry Lead Engine — Phase 4 Design

**Date:** 2026-06-15
**Status:** Design approved, pending spec review → implementation plan
**Scope this phase:** Texas TXR050000 (Industrial MSGP) only, end-to-end. Schema state-aware for later replication.

---

## 1. Problem & Opportunity

Texas's Industrial Multi-Sector General Permit (**TXR050000**) is a single 5-year general permit covering all industrial stormwater dischargers in Texas. The current permit **expires August 13, 2026** — and unlike per-facility permits, *every active permittee is on the same renewal clock*. When TCEQ reissues the permit, all existing permittees must file a renewal NOI within ~90 days of the new permit's effective date (precedent: 2021 cycle ran Aug → mid-Nov). So the selling window is roughly **August → ~November 11, 2026**, and late-renewers (Sept/Oct) are the *hottest* leads — out of compliance, under deadline pressure.

This is a built-in deadline against a known, public population: a permit-renewal lead engine. Derek sells SWPPP renewal services; this list is thousands of warm, deadline-driven prospects. The same playbook replicates per-state (each state's industrial GP on its own cycle) — that's the evergreen flywheel, deferred to a later phase.

### The population (live-verified from EPA Envirofacts, 2026-06-11)
- **12,985** active (status `EFF`) coverages under master permit TXR050000.
- TCEQ Oct 2025 count cross-checks: **8,847 active NOIs + 3,846 NECs** ≈ 12,700.
- **NOI holders (~8,847)** = required to have a SWPPP → **the target list.**
- **NEC holders (~3,846)** = certified "no exposure," exempt from SWPPP → **excluded entirely** (not ingested). Ingest filters to NOI coverage only.

---

## 2. Data Source — EPA Envirofacts (NOT scraping)

Public REST API, no auth, no key, returns JSON or CSV directly. Verified working live:

```
https://data.epa.gov/efservice/ICIS_PERMIT/MASTER_EXTERNAL_PERMIT_NMBR/TXR050000/PERMIT_STATUS_CODE/EFF/rows/0:9999/JSON
```

- Pagination via `rows/START:END`. `COUNT/JSON` returns total.
- Join `ICIS_FACILITIES` on permit number for street address/lat-long.
- EPA ECHO also offers a CSV/Excel export button (Industrial Stormwater search) as a fallback / manual check.
- TCEQ's own query tool geo-blocked the dev machine; EPA federal mirror carries the same data, so TCEQ is not a dependency. Federal mirror can lag TCEQ slightly — acceptable for marketing; monthly re-pull keeps it current.

### Fields available per facility (for targeting + filtering)
facility name, operator/owner name, address/city/zip, **MSGP sector code**, coverage type (NOI/NEC), effective date, expiration date, **ownership type** (private/government), and via ECHO: **compliance status** (inspections, violations, overdue-report flags).

---

## 3. Architecture — Staged Pipeline

The engine is a **new staging-and-promotion pipeline feeding the existing SDR/Apollo send infrastructure.** It does not touch the construction SDR flow or the legacy manual path.

```
[1] INGEST            [2] POOL + RANK          [3] PROMOTE / ENRICH        [4] SEND + PROMOTE
EPA Envirofacts   →   Postgres staging     →   top-N batch → Apollo    →   MSGP Apollo sequence
API (TXR050000)       (all ~8,847,             enrich (operator →           (reuses sdr_sends +
monthly re-pull       deduped, scored,         contact + verified           engagement tracking)
                      filterable)              email), daily cap                  ↓
                                                                       engaged → promote to Pipedrive
                                               no-match → manual/phone export
```

**Key principle: storage is free, enrichment + sending are the constrained resources.**
- Stages 1→2 run on the **entire** population (Postgres handles 8,847 rows trivially).
- Stage 3 is **gated** — only a human-selected top-N batch is enriched/enrolled, protecting Apollo credits (Basic plan) and respecting send limits.
- Stage 4 **reuses shipped infrastructure** — `sdr_sends`, `sdr_engagement_events`, engagement scoring, Apollo enrollment.

---

## 4. Data Model (3 new tables, all state-aware)

### `permit_facilities` — the staging pool
One row per facility coverage from EPA.
- `id`, `npdes_id` (unique), `master_permit` (`TXR050000`), `state` (`TX`)
- `facility_name`, `operator_name`, `address`, `city`, `zip`
- `sector_code`, `coverage_type` (`NOI`/`NEC`), `effective_date`, `expiration_date`
- `ownership_type`, `compliance_flags` (jsonb)
- `operator_key` (normalized operator name, for dedupe → links to `permit_operators`)
- `score` (computed rank), `status` (`pool` → `promoted` → `enriched` → `enrolled` → `engaged` → `dead`)
- `created_at`, `updated_at`, `last_pulled_at`

### `permit_operators` — deduped company rollup
One pitch per company (operators often hold many facility coverages).
- `id`, `operator_key` (unique), `operator_name`, `state`
- `facility_count`, `best_score`, `chosen_contact_id` (→ enrichment)
- `status`, timestamps

### `permit_enrichment` — Apollo results per operator
Keeps Apollo state out of Pipedrive (per `feedback_no_new_pipedrive_fields`).
- `id`, `operator_id`, `apollo_contact_id`, `contact_name`, `contact_title`
- `verified_email`, `match_confidence`, `credits_spent`, `enriched_at`, `status`

Engagement reuses existing `sdr_sends` / `sdr_engagement_events` with `source = 'permit_tx_msgp'`.

---

## 5. Scoring & Filtering

**Filters that shrink the list:** dedupe by operator; drop government/municipal ownership; cluster by metro.
**Filters that rank warmth:** sector code (complex sectors = likelier to outsource), **compliance pain** (open violation / overdue report = in pain now = hottest), coverage age (recent filers may lack a consultant).

`score` is a weighted composite (compliance pain weighted highest, then sector value, then recency). Surfaced as sortable rank in the Pool view. Exact weights tuned during implementation; the hot tier (compliance problems) is the headline segment.

---

## 6. UI — "Permits" tab in the Cold · Apollo lane

The Outreach console has a lane toggle (`Cold · Apollo` | `Nurture · Brevo`). **Permits is a lead *source* feeding Apollo, so it lives inside the Cold lane** — not a third lane, not Brevo (cold outreach = Apollo, per infra rule).

New **"Permits" tab** with two sub-views:
1. **Pool** — full ~8,847, filterable (sector / metro / compliance tier / ownership), sortable by score. Multi-select or "select top N" → **Promote batch**.
2. **Enrichment** — promoted batch running through Apollo; shows matched / verified / failed. Clean matches → **Enroll** into the MSGP Apollo sequence. No-match facilities → **manual/phone export** for Derek (not wasted).

Enrolled permit leads flow into the existing **Engaged / Dashboard** views like any cold lead.

### Activation & mailbox control
- **Master activation switch** — the engine is **OFF by default**. No enrichment and no sending happen until a user explicitly activates it. Deactivating halts new enrollments/sends. Stored as engine state (e.g. `permit_engine_settings.active`).
- **Per-mailbox enable/disable** — the team chooses which mailboxes the permit engine sends from, independently of the construction SDR flow. A mailbox can be on for construction SDR but off for permits, or vice versa. Stored per-mailbox (e.g. `permit_engine_enabled` flag on the mailbox/settings).

### Pacing safety (no 8k-in-a-day)
Enforced at three layers:
1. Promotion is a deliberate, human-sized batch action.
2. Configurable **daily enrollment cap** in the engine (default 50–100/day).
3. Apollo's own per-mailbox warmup throttle (10–40/day/mailbox) drips sends regardless — a large enroll cannot fire all at once.
The Permits tab shows **"today's remaining send budget"** so the ceiling is always visible. Nothing sends while the master switch is off.

---

## 7. Sequencing & Pipedrive Promotion

- One dedicated **"MSGP Renewal" Apollo sequence** with renewal-deadline copy ("your TXR050000 coverage expires Aug 2026 — need your SWPPP updated?"). Created via the same Apollo API path used for the existing 4 sequences.
- Permit sends reuse `sdr_sends` + `sdr_engagement_events` (source-tagged).
- **Pipedrive promotion only on engagement** (reply/click) — a facility becomes a real Pipedrive lead only when it shows interest, so the CRM never holds thousands of dead rows. Reuses the existing engagement→Pipedrive path.

---

## 8. Scope Boundaries

### In scope (Phase 4)
- EPA Envirofacts ingest for TXR050000, **NOI coverage only** (one-shot + monthly re-pull)
- Dedupe by operator, scoring, filter/rank
- Permits tab (Pool + Enrichment) in the Cold lane
- **Master activation switch** (off by default) + **per-mailbox enable/disable** for the permit engine
- Apollo enrichment with daily cap
- One MSGP Renewal Apollo sequence + copy
- Enroll → reuse sends/engagement → promote to Pipedrive on engagement
- No-match → manual/phone export

### NOT in scope (deferred)
- **Multi-state** — schema is state-aware, only TX wired. Follow-on phase = the evergreen engine.
- **NEC holders** — excluded entirely (not ingested).
- **Fixing the OOM Apollo-verify / lead-scoring workflows** — but see risk 3.
- **Auto-promotion** — every batch is human-triggered this phase.

---

## 9. Risks & Mitigations

1. **Apollo match rate on industrial facilities** (highest risk) — small-town scrap yards / metal shops may not be in Apollo's DB.
   *Mitigation:* an **early enrichment spike** measures match rate on a ~50-facility sample *before* committing the full UI to Apollo. If low, add a fallback (domain-guess + verify, or a manual-research lane).
2. **Apollo credit burn / Basic plan limits** — gated batches + daily cap.
3. **Enrichment dependency on broken OOM workflows** — if Apollo enrichment would reuse the OOM `Apollo Email Verification` workflow, build a clean standalone enrichment path instead (or fix that workflow first). Resolve during planning.
4. **EPA data freshness** — federal mirror lags TCEQ; acceptable for marketing, monthly re-pull mitigates.

---

## 10. Open Questions for Implementation Planning
- Exact scoring weights (tune on real data).
- Enrichment: direct Apollo API call from backend vs n8n workflow — decided by the spike + dependency-risk resolution.
- Daily enrollment cap default value (start conservative).
