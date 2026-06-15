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
- **NOI vs NEC is the `external_permit_nmbr` prefix** (validated against TCEQ, see §11): `TXR05…` = Multi-Sector **NOI** (target), `TXRNE…` = No Exposure Certification (excluded). The two-filter chained query (`MASTER_EXTERNAL_PERMIT_NMBR` + `PERMIT_STATUS_CODE`) is intermittently flaky on EPA's side — retry with backoff, or filter status/prefix locally.
- EPA ICIS_PERMIT carries operator name (`permit_name`) but **no address and no contact channel**. Facility address comes from `ICIS_FACILITY_INTEREST`; contact info does not exist in the EPA mirror at all.
- EPA ECHO also offers a CSV/Excel export button (Industrial Stormwater search) as a fallback / manual check.

EPA is the **targeting** source (who exists, sector, expiry). It is NOT a contactable source. Contact data comes from TCEQ (below).

### 2b. TCEQ — the contact source

EPA gives no contact. **TCEQ's Water Quality General Permits Search exposes a contact for ~100% of permittees** (it's their own filing). Validated live (see §11): per authorization it returns operator company + CN, a **contact person name**, **mailing address**, **physical site address**, county, SIC code, sector, status, coverage dates. It does **not** publicly expose email or phone.

- Per-permit detail: `https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.validate_permit&permit_number=<PERMIT>` (GET works; server-rendered ColdFusion, no JS needed).
- Population enumerate: `fuseaction=home.permit_info_search&permit_types=TXR050000` advanced search filters by *Multi-Sector NOI (TXR05) + status ACTIVE*.

**Production fetch transport (no new vendor):**
1. **Preferred — plain HTTP GET from n8n HTTP node or the Railway backend.** Pages are server-rendered; a GET with query params returns the data. Works if n8n/Railway US IPs aren't blocked.
2. **Fallback — existing Browserless + residential proxy** (the same setup the CMD scraper already uses: `proxy=residential`, token in the CMD workflow). A residential US IP defeats datacenter-IP blocks.

**No VPN, no Firecrawl in production.** TCEQ blocks the *dev sandbox IP* specifically (EPA/everything else reachable from dev). Firecrawl was used only as the dev-time verification proxy (§11) and proved a US datacenter IP *can* reach TCEQ. The first build task confirms whether option 1 works from n8n/Railway; if not, fall to option 2.

### Fields available (for targeting + filtering)
From EPA: facility name, operator name, **MSGP sector code**, coverage type (NOI/NEC via prefix), effective/expiration date, site address (via facility join), and via ECHO: **compliance status** (inspections, violations, overdue-report flags).
From TCEQ: **contact person name**, **mailing address**, physical site address, SIC code, status, coverage dates.

---

## 3. Architecture — Staged Pipeline

The engine is a **new staging-and-promotion pipeline feeding the existing SDR/Apollo send infrastructure.** It does not touch the construction SDR flow or the legacy manual path.

```
[1] INGEST          [2] POOL + RANK      [3] PROMOTE / ENRICH (gated, per batch)        [4] SEND / OUTPUT
EPA Envirofacts  →  Postgres staging  →  top-N batch:                              →   email-able → MSGP
API (TXR05 NOI)     (all ~8,847,          a. TCEQ scrape → contact name + address       Apollo sequence
monthly re-pull     deduped, scored,      b. Apollo/pattern (person+co) → email             ↓ engaged →
                    filterable)           c. daily cap                                  promote to Pipedrive
                                                                                      no-email → call/mail CSV
```

**Enrichment chain (Stage 3) — replaces the failed Apollo-only approach:**
- **a. TCEQ scrape** (HTTP GET from n8n/Railway, US infra; Browserless+residential-proxy fallback) adds the contact name + address EPA lacks — ~100% coverage.
- **b. Email discovery** — Apollo person-match (name + company, higher yield than company-only) and/or email-pattern+verify. The email-able subset enrolls into the Apollo sequence.
- **c. Multi-channel output** — facilities with no discoverable email are **not discarded**: they export to a **call/direct-mail CSV** (full mailing address + contact name + Aug-2026 hook) for Derek's team. Both channels ship.

**Key principle: storage is free; scraping, enrichment, and sending are the constrained resources.**
- Stages 1→2 run on the **entire** population (Postgres handles 8,847 rows trivially; EPA pull is free).
- Stage 3 is **gated** — only a human-selected top-N batch is scraped/enriched/enrolled, protecting Firecrawl + Apollo credits and respecting send limits.
- Stage 4 **reuses shipped infrastructure** — `sdr_sends`, `sdr_engagement_events`, engagement scoring, Apollo enrollment.

---

## 4. Data Model (3 new tables, all state-aware)

### `permit_facilities` — the staging pool
One row per facility coverage from EPA.
- `id`, `npdes_id`/`external_permit_nmbr` (unique), `master_permit` (`TXR050000`), `state` (`TX`)
- `facility_name`, `operator_name`, `site_address`, `city`, `zip`
- `sector_code`, `coverage_type` (`NOI`/`NEC`), `effective_date`, `expiration_date`
- `ownership_type`, `compliance_flags` (jsonb)
- `operator_key` (normalized operator name, for dedupe → links to `permit_operators`)
- `score` (computed rank), `status` (`pool` → `promoted` → `scraped` → `enriched` → `enrolled`/`exported` → `engaged` → `dead`)
- `created_at`, `updated_at`, `last_pulled_at`

### `permit_operators` — deduped company rollup
One pitch per company (operators often hold many facility coverages).
- `id`, `operator_key` (unique), `operator_name`, `customer_number` (TCEQ CN), `state`
- `facility_count`, `best_score`, `chosen_contact_id` (→ enrichment)
- `status`, timestamps

### `permit_enrichment` — contact data per operator (TCEQ + Apollo)
Keeps contact/Apollo state out of Pipedrive (per `feedback_no_new_pipedrive_fields`).
- `id`, `operator_id`
- **From TCEQ scrape:** `contact_name`, `mailing_address`, `tceq_scraped_at`
- **From email discovery:** `apollo_contact_id`, `contact_title`, `verified_email`, `match_confidence`, `email_source` (`apollo`/`pattern`), `credits_spent`
- `channel` (`email` → Apollo sequence | `mail`/`phone` → CSV export), `enriched_at`, `status`

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
2. **Enrichment** — promoted batch running through the chain: TCEQ scrape (contact name + address) → email discovery (Apollo/pattern). Shows per-row state: scraped / email-found / no-email. **Two outputs:**
   - **Email-able** → **Enroll** into the MSGP Apollo sequence.
   - **No email** → **Download call/mail CSV** (contact name + mailing address + facility + Aug-2026 hook) for Derek's team. Counts shown so nothing is silently dropped.

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
- EPA Envirofacts ingest for TXR050000, **NOI coverage only** (`TXR05` prefix; one-shot + monthly re-pull)
- Dedupe by operator, scoring, filter/rank
- Permits tab (Pool + Enrichment) in the Cold lane
- **Master activation switch** (off by default) + **per-mailbox enable/disable** for the permit engine
- **TCEQ scrape** (via Firecrawl) for contact name + address, gated per batch
- Email discovery (Apollo person-match / pattern) with daily cap
- One MSGP Renewal Apollo sequence + copy
- **Multi-channel output:** email-able → Apollo sequence; no-email → call/mail CSV export
- Enroll → reuse sends/engagement → promote to Pipedrive on engagement

### NOT in scope (deferred)
- **Multi-state** — schema is state-aware, only TX wired. Follow-on phase = the evergreen engine.
- **NEC holders** — excluded entirely (not ingested).
- **Fixing the OOM Apollo-verify / lead-scoring workflows** — build a clean standalone enrichment path instead (see risk 3).
- **Auto-promotion** — every batch is human-triggered this phase.
- **Phone/mail as in-app channels** — output is a CSV export for Derek's team; no dialer/mail-merge infra built in-app.

---

## 9. Risks & Mitigations

1. **Apollo match rate is too low for the long tail — RESOLVED by design change.** Spike (§11) measured **~20% company-match, noisy** on small industrial operators. *Mitigation, now baked in:* TCEQ supplies contact name + address for ~100%; Apollo is demoted to one of two email-discovery methods, not the source. The no-email remainder goes to the call/mail CSV instead of being lost.
2. **Email-discovery rate from name+company is still unknown** (the new open question) — TCEQ gives a name + company + city but no email; how many convert to a verified email via Apollo person-match / pattern is unmeasured. *Mitigation:* a secondary spike during build measures email-find rate on ~30 TCEQ-enriched records; whatever doesn't resolve simply routes to the CSV channel (still actionable).
3. **TCEQ scrape volume — cost + time** — ~8,847 detail fetches take wall-clock (and Browserless minutes if the fallback is used). *Mitigation:* the gated/batched model means we only scrape promoted top-N batches, not the whole pool; EPA (free) covers full-pool targeting. Re-pulls are incremental.
4. **Enrichment dependency on broken OOM workflows** — do NOT reuse the OOM `Apollo Email Verification` workflow; build a clean standalone enrichment path.
5. **TCEQ access from production IPs (open until build task 1)** — dev sandbox is IP-blocked; a US datacenter IP (Firecrawl) reached it fine. Whether n8n/Railway's specific IPs are blocked is unconfirmed. *Mitigation:* first build task tests the plain HTTP GET from n8n/Railway; if blocked, use the existing Browserless + residential proxy (no new vendor). Also monitor for TCEQ HTML/form changes to the `wq_dpa` `fuseaction` endpoints.
6. **EPA two-filter query flakiness** — retry with backoff or filter locally (§2).

---

## 10. Open Questions for Implementation Planning
- Exact scoring weights (tune on real data).
- Email-discovery method order (Apollo person-match vs pattern+verify) — decided by the §9.2 spike.
- TCEQ scrape transport: plain HTTP GET (n8n node vs Railway backend) vs Browserless+residential-proxy fallback — decided by build task 1 (IP-block test).
- Daily enrollment cap default value (start conservative).

---

## 11. Validation Log (spikes run 2026-06-15)

**EPA Envirofacts** — live-queried. 12,985 active (`EFF`) coverages under TXR050000; expiry `2026-08-13`. `TXR05…` prefix = NOI, `TXRNE…` = NEC (cross-checked against TCEQ labels). EPA has operator name but **no address/contact**; two-filter chained query intermittently returns `{"error":"Query failed"}` — retry resolves it.

**Apollo match-rate spike** — 18 active NOI operators, search-only (no credit burn). **4/18 (~22%)** had a targetable contact; relaxed filters gave 29% any-contact / 43% "company known" but with **false positives** ("Mh Trucking"→"Linkedin Articles", "Smart Materials"→Italian "Saes Smart Materials"). Matches skewed to large firms (Nucor 8 people). **Conclusion: Apollo-only is not viable** for this population.

**TCEQ source check** — dev sandbox cannot reach TCEQ (TCP connect fails; EPA/others fine → IP block, not VPN-needed). Via Firecrawl (US infra) the `wq_dpa` tool loaded and returned, per authorization: operator + CN, **contact person name**, mailing address, site address, county, SIC, sector, status, dates. Verified on 4 permits (TXR05DP22 Marshall Davis; TXR05CO95 David Clark; TXR05BB10 Wanda Kersh; TXR05EH17 Matthew Hughes). **No email/phone in public view.** Advanced search supports *Multi-Sector NOI (TXR05) + ACTIVE* enumeration.
