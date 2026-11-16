# Generated order status

Ivan requested a detailed historical audit and repair after verified generated orders appeared as Pending Review. User authorization: “after gen it should say generated ... audit on detail with sub agents and check history and fix”.

## Contract
- Pending Review remains intake awaiting approval or a deliberately reopened order.
- Generated means all selected/configured automated outputs for the current run have verified PDF upload receipts. It does not mean the manual SWPPP/NOI/NOT package is finished or delivered. Independent environment/OPS warnings remain in generationNote and visible review UI.
- Generation Incomplete means at least one current automated output is verified, with other attempted outputs missing/failed. Generation Failed means no current automated output was verified, including a held routing attempt. Neither looks like intake awaiting first approval.
- Ready and Complete retain stored legacy meanings and do not trigger new completion/outreach work. Existing generation-result manifest authentication, context/CAS validation, and stale-result checks remain unchanged.
- The queue groups Generated with the existing post-generation ready group, labelled Generated / ready. Failed/incomplete states stay in the review group, labelled Needs review; each card displays its exact status. Counts and filters must agree.
- Detail view clearly separates Generated from approval, displays notes and existing file evidence, and offers deliberate regeneration/reopen actions. Generated is locked like an approved order until explicit reopen. Environmental checks on Generated/Ready/Complete preserve the existing generation inputs and PDFs and save lookup provenance only. Changed lookup values require explicit reopen before adoption. Refresh during Approved for Generation/Manual Processing/Processing returns to Pending Review so an old callback cannot mark stale files Generated.
- Backfill only orders whose latest matching execution has verified current-run PDF receipts and matching source context. Folder links or old Ready state alone never establish evidence. Preserve manual Complete/Ready decisions and unrelated edits.

## Approaches
A badge-only rename would leave producer transitions, filters, actions and refresh regression broken. Reusing Ready would lose the distinction between automated generation and package readiness. Add the three explicit generation statuses above, retain review notes and old terminal states, and fix the two live router completion branches plus routing-hold branch.

## Scope
No redesign, new delivery/send behavior, automatic package completion, rebuilding the disabled manifest producer, or removal of review/approval holds.
