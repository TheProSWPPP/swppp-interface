# Permit Engine UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Replace the confusing per-permit Permits UI with an operator-centric (by-company) workspace: one list per company, a detail drawer showing everything (contact, address, all permits, compliance, cross-ref flags, outreach history), authoritative outreach tracking, customer/CRM "possible match" flags, a visual (WYSIWYG) email editor, and full edge-case coverage.

**Architecture:** Aggregate the per-permit data to the operator level (operators are the outreach unit — Paso Del Norte's 5 permits = 1 company = 1 letter). A new `permit_outreach` log is the authoritative "already contacted" signal. Customer/CRM matches are best-effort normalized-name soft flags against `projects.name` and `sdr_lead_state.lead_title`. Frontend: a left list + right slide-over drawer, react-quill for the email editor. Engine stays OFF; no sending added.

**Tech Stack:** Node ESM/Express, pg/Postgres, React+TS+Vite, react-quill, Vitest.

---

## Edge-case matrix (must be handled across endpoints + UI)
- Operator with multiple permits → ONE row; drawer lists all permits; CSV emits ONE letter per operator.
- Operator with no named contact (multi-record list page) → "no contact — mail to operator at site address".
- Operator with no mailable address (narrative description, no ZIP) → "not mailable" flag + reason; excluded from CSV.
- Operator already exported/mailed (permit_outreach) → ✉ badge + date; default-hidden when "Hide already-contacted" is on.
- Operator = possible existing customer (projects.name match) → ★ "possible customer" flag (soft).
- Operator = possible CRM match (sdr_lead_state.lead_title match) → "possible in pipeline" flag (soft).
- Email-able (channel='email') vs mail-only → channel chip; email actions remain disabled (no sending).
- Compliance tiers → color-coded: SNC (pain≥18) red, current violation (pain≥12) orange, inspected (pain>0) amber, clean grey.
- Mixed stages within an operator's permits → operator stage = furthest-along permit (mailed>enriched>promoted>pool).
- Empty states everywhere with the concrete next action.

---

## PHASE 1 — Backend: operator aggregation, outreach log, cross-ref, deduped CSV

### Task 1.1: `permit_outreach` table
**Files:** modify `server.js` (initDB, after `permit_msgp_template`).
- [ ] Add:
```js
await pool.query(`
  CREATE TABLE IF NOT EXISTS permit_outreach (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_key TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'mail' CHECK (channel IN ('mail','email')),
    status TEXT NOT NULL DEFAULT 'exported' CHECK (status IN ('exported','mailed','emailed','replied','skipped')),
    batch_id TEXT,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_permit_outreach_opkey ON permit_outreach(operator_key)`);
```
- [ ] `node --check server.js`; commit `feat(permits): permit_outreach log table`.

### Task 1.2: Pure company-name normalizer (reuse + test)
**Files:** `lib/permitIngest.js` already exports `operatorKey(name)` (lowercases, strips legal suffixes/punct, collapses initials). Create `lib/permitMatch.js` that re-exports a `companyKey` = operatorKey for cross-ref, plus `crossRefIndex(rows)` building a Set of normalized names. Test `lib/__tests__/permitMatch.test.js`.
- [ ] Test first: `companyKey("Brenntag Southwest, LLC")` === `companyKey("BRENNTAG SOUTHWEST LLC")`; `crossRefIndex([{name:"Acme, Inc."}], r=>r.name)` has `companyKey("acme inc")`.
- [ ] Implement:
```js
import { operatorKey } from "./permitIngest.js";
export const companyKey = (name) => operatorKey(name || "");
/** Build a Set of normalized company keys from rows via a name accessor. */
export function crossRefIndex(rows, getName) {
  const s = new Set();
  for (const r of rows || []) { const k = companyKey(getName(r)); if (k) s.add(k); }
  return s;
}
```
- [ ] vitest pass; commit `feat(permits): companyKey + crossRefIndex for soft customer/CRM matching`.

### Task 1.3: Operator-centric list endpoint
**Files:** `lib/permitRoutes.js`. New `GET /api/permits/operators-list`.
Query params: `stage` (pool|promoted|enriched|mailed|all), `compliance` (snc|violation|any|all), `hideContacted` (bool), `search`, `page`, `pageSize`.
Behavior — aggregate from `permit_facilities` grouped by `operator_key`, left-joined to enrichment + outreach:
```sql
SELECT f.operator_key, MIN(f.operator_name) AS operator_name,
       COUNT(*) AS permit_count,
       MAX((f.compliance_flags->>'pain')::int) AS max_pain,
       MAX(f.score) AS best_score,
       MIN(f.expiration_date) AS earliest_expiry,
       BOOL_OR(f.status='enriched') AS any_enriched,
       BOOL_OR(f.status IN ('promoted','enriched')) AS any_promoted,
       COUNT(e.external_permit_nmbr) AS enriched_count,
       MAX(e.contact_name) AS sample_contact,
       (SELECT count(*) FROM permit_outreach o WHERE o.operator_key=f.operator_key) AS outreach_count,
       (SELECT max(created_at) FROM permit_outreach o WHERE o.operator_key=f.operator_key) AS last_outreach_at
  FROM permit_facilities f
  LEFT JOIN permit_enrichment e ON e.external_permit_nmbr=f.external_permit_nmbr
 WHERE f.state='TX'
 GROUP BY f.operator_key
```
Wrap in filters (HAVING for compliance/stage; operator_name ILIKE search; hideContacted → outreach_count=0). Order by max_pain DESC, best_score DESC. Paginate.
- Derive `stage` per operator in JS: mailed (outreach status mailed/emailed) > enriched (any_enriched) > promoted (any_promoted) > pool.
- Cross-ref flags: once per request, load+cache (module-level, 5-min TTL) two Sets — customer keys from `SELECT name FROM projects WHERE archived=false`, CRM keys from `SELECT lead_title FROM sdr_lead_state` — via `crossRefIndex`. Annotate each operator: `possible_customer = custSet.has(companyKey(operator_name))`, `possible_crm = crmSet.has(companyKey(operator_name))`.
- [ ] Return `{ operators:[...], total, page, pageSize, counts:{pool,promoted,enriched,mailed} }` (counts via a small grouped query for the funnel header).
- [ ] commit `feat(permits): operator-centric list endpoint with stage/compliance filters + soft cross-ref flags`.

### Task 1.4: Operator detail endpoint
**Files:** `lib/permitRoutes.js`. `GET /api/permits/operator/:operatorKey`.
Return:
- `operator`: operator_key, operator_name, permit_count, max_pain, best_score, possible_customer, possible_crm.
- `permits`: array — external_permit_nmbr, status, score, expiration_date, compliance_flags (pain/vioLast4Q/sv/insp), from permit_facilities.
- `enrichment`: representative row (contact_name, mailing_address, site_address, sic_code, sector, channel) — pick the one with a contact, else any; plus `mailable` (mailing_address ~ '\d{5}').
- `outreach`: array of permit_outreach rows (status, channel, created_at, note) desc.
- [ ] commit `feat(permits): operator detail endpoint`.

### Task 1.5: Operator actions — promote, log outreach
**Files:** `lib/permitRoutes.js`.
- `POST /api/permits/operator/:operatorKey/promote` → set status='promoted' for that operator's `status='pool'` permits; return count.
- `POST /api/permits/operator/:operatorKey/outreach` { status, channel?, note? } → insert a permit_outreach row; return it. Validate status in the allowed set.
- [ ] commit `feat(permits): operator promote + outreach-log endpoints`.

### Task 1.6: Operator-deduped direct-mail CSV + export logging
**Files:** `lib/permitRoutes.js` (export route), `lib/permitCsv.js` (no change needed if rows are pre-deduped).
- Change the export query to emit ONE row per operator_key (DISTINCT ON operator_key, prefer a row with a contact + mailable address, highest score). Keep existing columns.
- After building the CSV, INSERT a `permit_outreach` row (status='exported', channel='mail', batch_id = a timestamp passed by caller or `to_char(now())`) for each included operator_key, so they show as contacted.
- Add `?includeContacted=1` to allow re-export; default excludes operators with an existing 'exported'/'mailed' outreach row.
- [ ] commit `feat(permits): operator-deduped direct-mail CSV + logs exports as outreach`.

---

## PHASE 2 — Frontend: operator workspace + detail drawer

### Task 2.1: API client
**Files:** `src/lib/permitApi.ts`. Add types (`OperatorRow`, `OperatorDetail`, `OutreachEvent`) + functions (`getOperatorsList`, `getOperatorDetail`, `promoteOperator`, `logOutreach`) using the `j<T>` helper. Match existing conventions.
- [ ] commit `feat(permits): operator workspace API client`.

### Task 2.2: OperatorWorkspace component
**Files:** create `src/components/permits/OperatorWorkspace.tsx`.
- Funnel header: Pool ▸ Promoted ▸ Enriched ▸ Mailed with counts (from endpoint `counts`).
- Filter bar: stage select, compliance select, "Hide already-contacted" checkbox, search input, "Run enrichment (50)" button (calls existing enrich), "Download CSV" link.
- Table rows: operator_name, permit_count, compliance badge (tiered colors per matrix), earliest_expiry, stage chip, flags (★ possible customer, ⚑ possible CRM, ✉ mailed/exported w/ date, ⚠ in violation). Click row → open drawer (selected operatorKey state).
- "Promote top N (operators)" + "Promote selected" actions.
- Empty/loading states.
- [ ] commit `feat(permits): operator-centric workspace (funnel, filters, flags)`.

### Task 2.3: OperatorDrawer component
**Files:** create `src/components/permits/OperatorDrawer.tsx`.
- Slide-over (fixed right panel, overlay, ESC/×/overlay to close).
- Sections: header (name + compliance badge + stage); Contact & address (contact_name or "no contact — mail to site", mailing_address, mailable flag, sic/sector); Permits (list: permit#, compliance pain, expiry, status); Compliance breakdown (vioLast4Q, sv, insp); Cross-ref ("possible existing customer" / "possible in CRM" or "no match found", clearly soft); Outreach history (events or "none yet").
- Actions: Promote (if any pool), Enrich (if promoted; calls enrich), Mark mailed (logOutreach status='mailed'), Mark skipped, Export this operator. Refresh list on action.
- [ ] commit `feat(permits): operator detail drawer`.

---

## PHASE 3 — Visual email editor (react-quill)

### Task 3.1: Install + integrate react-quill
**Files:** `package.json` (add react-quill compatible with the repo's React version — verify React major; if React 19, use a maintained fork e.g. `react-quill-new`), `src/components/permits/MsgpCopyView.tsx`.
- Replace the body `<textarea>` with a Quill editor (toolbar: headers, bold, italic, underline, link, ordered/bullet lists, clean). `value`/`onChange` bound to `body` (HTML string).
- Keep Subject as a plain input. Keep the "Sending OFF" banner.
- Add a merge-tag inserter row (buttons: First name, Operator, Permit #, Expiry) that inserts `{{first_name}}` etc. at cursor (or appends).
- Add a "</> HTML source" toggle that swaps Quill for the raw textarea (round-trips the same `body`).
- Import Quill CSS (`react-quill/dist/quill.snow.css`).
- [ ] `npm install`, `npx tsc --noEmit`, build check; commit `feat(permits): visual WYSIWYG email editor (react-quill) + merge tags + source toggle`.

---

## PHASE 4 — PermitsTab restructure + polish

### Task 4.1: Restructure PermitsTab
**Files:** `src/components/permits/PermitsTab.tsx`.
- Keep the settings bar (engine active, cap, mailboxes).
- Replace the `pool|enrichment` sub-tabs with `leads|email` where **Leads = OperatorWorkspace** (with the stage filter covering pool/promoted/enriched/mailed, so the old two tabs collapse into one) and **Email = MsgpCopyView**.
- Remove now-redundant PoolView/EnrichmentView imports (leave files or delete — delete if fully unused; the enrich + CSV actions now live in OperatorWorkspace).
- [ ] `tsc --noEmit`; commit `feat(permits): unify Permits into Leads workspace + Email tabs`.

### Task 4.2: Edge-case + empty-state polish pass
**Files:** OperatorWorkspace/OperatorDrawer.
- Verify every matrix row renders a sensible state (no-contact, not-mailable, mailed, possible-customer, email-able, compliance tiers, mixed-stage, empty list).
- [ ] commit `chore(permits): edge-case + empty-state polish`.

---

## Self-Review
- Operator-centric (dedup): Tasks 1.3/1.6/2.2 group by operator_key; CSV one row per operator. ✓
- Detail on click (contact/email/address/all permits): Task 1.4 + 2.3. ✓
- Outreach history + already-contacted: 1.1/1.5/1.6 (authoritative log) + flags in 1.3/2.2. ✓
- Duplicates / customer / pipeline: operator rollup + soft cross-ref flags (1.2/1.3), clearly labeled "possible". ✓
- Visual editor: Phase 3. ✓
- Usability/"where do I do what": funnel header + stage filter + per-stage drawer actions + empty states (2.2/2.3/4). ✓
- No sending: no enroll/send route added; email actions disabled. ✓
