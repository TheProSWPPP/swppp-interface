# Internal reply reminders

Ivan approved reminders on November 16, then clarified that staff use Pipedrive and email, not the custom interface. Existing CMD copy and outreach sequences are outside scope.

## Approach
Use existing reply tasks as the work record and email verified internal .com recipients. A new dashboard or action buttons would conflict with staff habits; notes alone do not ensure staff see the reminder. No CRM task is created, edited, completed or reassigned by this worker. Staff complete a task to stop reminders or move its due date to postpone them.

## Behavior
- Weekdays 09:00–16:59 America/Chicago only. Owner reminder after one business day; escalation to Derek after two business days, with at least one business day after the first reminder. No repeated escalation loop. Tasks owned by Derek skip escalation to himself.
- Honor clearly stated buyer follow-up dates. Ambiguous nurture timing holds for review. Explicit follow-up clauses are honored across eligible intents; yearless future dates roll into the next year when needed. Approved tasks remain eligible beyond 30 days so long deferrals are retained. A future Pipedrive due date postpones notifications. Escalation waits until at least the next business day after that due date.
- Clearly stated proposal deadlines add reminders two and one business days beforehand; no more than one email per task per business date.
- Fresh task status, current assignee and verified internal routing are required. Read the original conversation and accessible project-specific mail/call/note evidence. Observed later handling suppresses reminders; missing private mail never proves neglect.
- Email wording asks whether the request was handled and links directly to the existing Pipedrive task. No buyer email is sent. No custom interface is required.
- A durable send-intent ledger blocks repeat sends after uncertainty or a crash. Uncertain outcomes require reconciliation; never blindly replay. Explicit Gmail rejection responses may retry on a later worker run; HTTP 408, network errors and server errors stay uncertain. Reconciliation rotates through held records so older unknown sends cannot starve newer ones.
- Default off; dry run returns plans without notification writes. Launch includes the four checked task IDs 38991,39052,39093,39261 and new tasks after the configured launch cutoff. Existing older tasks are excluded.

## Implementation decisions
One bounded worker, a read-only CRM adapter, and additive tables. Current verified reply routes and active Pipedrive users determine recipients. Same-day dedupe also applies across scheduling/ownership changes. Escalation cannot run without a confirmed first notification. Fail closed on unavailable sources, revoked access, ambiguous recipients or changed identity.
