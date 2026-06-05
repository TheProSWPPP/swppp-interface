# Automation Roadmap — Design

**Date:** 2026-06-05
**Status:** Approved

## Problem

Derek has no shared, persistent place to see and steer the automation work being
delivered for Pro SWPPP. Status lives in chat/calls. We want a "Roadmap" tab on the
existing dashboard where automation tasks (e.g. SDR Interface, Pull TXR050000
permittee list) are tracked, edited, and updated — by both the Pro SWPPP team and
Derek.

## Decisions (from brainstorming)

- **Model:** Shared roadmap. Team posts automation tasks + sets status; Derek can
  add requests, edit, reorder, and append updates.
- **Fields per task:** title, description/notes, priority/order, status, running
  updates log.
- **Statuses:** `planned → in_progress → blocked → done` (4 stages).
- **View:** Ordered list with inline editing (Approach A) — not Kanban.
- **Authorship:** Convention-based. The interface has no per-user identity (header
  is a hardcoded "Admin User"), so each update carries a free-text `author` label.
  The JSONB `author` field is forward-compatible with real SDR-auth identity later.

## Data Model

One table, following the `seo_ideas` pattern in `server.js`:

```sql
CREATE TABLE IF NOT EXISTS automation_tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','in_progress','blocked','done')),
  sort_order   DOUBLE PRECISION NOT NULL DEFAULT 0,
  updates      JSONB NOT NULL DEFAULT '[]',  -- [{id, author, body, created_at}]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_tasks_status ON automation_tasks(status);
CREATE INDEX IF NOT EXISTS idx_automation_tasks_order  ON automation_tasks(sort_order);
```

- Updates/comments are a JSONB array on the row — no child table/routes (YAGNI).
- `sort_order` is a float so a drag-reorder writes only the moved row (midpoint
  between its new neighbors) instead of renumbering the whole list.

### Idempotent seed

On init, if `automation_tasks` is empty, insert the two real starter tasks:

1. **SDR Interface** — `in_progress`, sort_order 1000.
2. **Pull TXR050000 permittee list** — `planned`, sort_order 2000. Description holds
   the technical brief (below).

## API

Mirrors the existing `/api/...` REST style. Global `bodyParser.json` already parses
bodies. All return JSON; `[]` / `501` when `DATABASE_URL` is unset.

- `GET    /api/automation-tasks` — all rows ordered by `sort_order ASC, created_at ASC`
- `POST   /api/automation-tasks` — create `{title, description?, status?}`; sort_order
  defaults to `(max+1000)`
- `PUT    /api/automation-tasks/:id` — patch any of `{title, description, status,
  sort_order}`; bumps `updated_at`
- `POST   /api/automation-tasks/:id/updates` — append one `{author, body}` to the log
  (server stamps `id` + `created_at`)
- `DELETE /api/automation-tasks/:id` — remove

## Frontend

- **Nav:** new "Roadmap" tab in `src/App.tsx` header (after Lead Import), hash route
  `#/roadmap`, `ListChecks` lucide icon. Add to `View` type + `ALL_VIEWS`.
- **Component:** `src/components/AutomationRoadmap.tsx` — self-contained, fetches its
  own data (like `AIContent`/`SeoIdeas`), not wired through `App` project state.
  - Header: "Automation Roadmap" + "Add task" button.
  - Rows ordered by `sort_order`: drag handle, title, status badge (click → dropdown
    to change status), update count + last-update date.
  - Row expand: editable title/description (save on blur via PUT), updates timeline,
    "Add update" box (author label free-text), delete button.
  - Status badge colors: planned=slate, in_progress=indigo, blocked=amber, done=green.
  - Optimistic UI with rollback on fetch failure (same pattern as
    `handleUpdateProject` in `App.tsx`).

## TXR050000 task — technical brief (seed description)

```
Target: Active permittee list for the Texas Industrial Multi-Sector General Permit
(TCEQ permit no. TXR050000). Public record.

Action: Scrape the active permittee list from the TCEQ public website.

Purpose: Lead source for industrial stormwater SWPPP renewal services — existing
facilities (recurring inspections + 5-year permit renewal), higher-value than
construction.

Timing: TX TXR050000 expires August 2026. Market window = June–Aug 2026 (now).

Repeatable engine: One industrial MSGP per state, each with its own expiry. Pull
list → market facilities ~6 months before that state's expiry.

Pipeline: pull list → AI compliance-doc generation (permit → compliant draft) →
market expiring facilities → follow-up sequence. Output destination: lead
import / Slack.
```

## Error Handling & Testing

- Routes return `{error}` with 4xx/5xx; 404 on unknown id.
- Smoke-test the routes against the Railway DB (create → list → update → add update →
  delete).
- Verify the component in-browser.
