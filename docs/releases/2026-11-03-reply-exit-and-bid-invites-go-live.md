# Reply exit and bid invite follow-ups: go-live order

Covers PR #125 (a reply exits the person from every sequence, `SDR_REPLY_EXIT_MODE`) and PR #126 (bid invite follow-ups from Gmail, `BID_INVITE_SEQUENCE`), with the go-live review fixes of 2026-11-03. Both ship switched off. Derek was told: any reply takes the person out of every sequence, the lead turns manual and he gets a drafted reply. Bid invite emails therefore never go out live unless the reply exit is live too.

## Read this first: the reply-exit migration changes behaviour on its own

`migrations/2026-11-03-sdr-reply-exit.sql` is additive, but applying it changes behaviour immediately, even with `SDR_REPLY_EXIT_MODE` unset (off):

- It adds `sdr_reply_messages.from_email` and fills it for existing reply rows from the sender recorded on their reply actions. From then on every new reply row records its sender too.
- The 180-day recent-reply fence (`lib/recentReply.js`) reads that column at once. Anyone who wrote back in the last 180 days, Gmail or Pipedrive-copied, is fenced from new automatic cold outreach on every project (auto outreach, bid invite emails, LinkedIn prospect lanes). Before the migration only the legacy inbox log and message facts fed the fence, so expect more people to be held back the day it is applied. Staff can still send any draft by hand.
- The bid invite send claim (`lib/bidInviteEngine.js`) refuses an address with a human reply or exit trigger in the last 180 days, using the same column.
- Nothing is written to Apollo and no exit is queued while the mode is off.

Check before applying, read only:

```
SELECT count(DISTINCT lower(trim(a.payload->>'fromEmail'))) AS senders_fenced_after_migration
FROM sdr_reply_actions a JOIN sdr_reply_messages m ON m.provider_message_id=a.provider_message_id
WHERE m.reply_kind='human' AND m.received_at > now() - interval '180 days' AND a.payload->>'fromEmail' IS NOT NULL;
```

## Order

Do each step, check it, then move on. Every env change needs a redeploy.

1. **Migrations** (backup first, then in this order):
   ```
   psql "$DATABASE_URL" -f migrations/2026-11-03-sdr-reply-exit.sql
   psql "$DATABASE_URL" -f migrations/2026-11-03-sdr-volume-alerts.sql
   psql "$DATABASE_URL" -f migrations/2026-11-03-bid-invite-sequence.sql
   ```
   Expect the fence change above the moment the first one is applied.
2. **`SDR_REPLY_EXIT_MODE=dry_run`.** Each human reply records its plan in `sdr_reply_exits` (which Apollo memberships, sends, drafts and LinkedIn work it would close). Nothing is written to Apollo. Check a few plans against Apollo by hand. Optional: `node scripts/backfill-reply-exits.mjs` (dry run by default) lists the replies of the last 30 days that never got an exit.
3. **`SDR_REPLY_EXIT_MODE=live`.** Dry-run exits from the last 14 days run again for real on the first drain. Watch the reply action backlog for `exit_review` rows.
4. **`BID_INVITE_SEQUENCE=dry_run`.** Open `/api/sdr/bid-invites/preview?format=html` and show Derek the sample emails. Flags marked as not on the page need his OK: Email 2/3 naming several projects, more than 3 projects ("and 2 more"), the signature. The page also says which follow-ups are skipped for old bids and which samples wait a day because the company already got one that day.
5. **Pilot.** `BID_INVITE_SEQUENCE=live` with `BID_INVITE_ONLY_LEADS=<a few lead ids>`. Live refuses to send while `SDR_REPLY_EXIT_MODE` is not `live` (or the reply-exit migration is missing): the server logs `[bid-invites] live mode will not send: ...` at startup and on every run, counts the due batches as held (`reply_exit_not_live`), and `/api/sdr/bid-invites/status` shows the reason in `sendBlocked`.
6. **Live.** Clear `BID_INVITE_ONLY_LEADS`.

Going back: set `BID_INVITE_SEQUENCE=off` first, then `SDR_REPLY_EXIT_MODE=off`. Turning the reply exit off while bid invites are live simply holds every bid email.

## What a bid invite reply does

A reply the bid engine detects counts when it is in our .co thread, or when the contact wrote to the rep's .com inbox after our first bid email from the batch contact's own address (Pipedrive synced it and the Pipedrive reply intake classified it as a person writing). Older mail, mail from a colleague and out-of-office replies are not replies to the follow-up. A reply:

- stops every bid email to that address and puts the address on manual follow-up (recipient hold);
- queues one cross-sequence exit (`exit_person`) stamped with the time they wrote, unless the inbox watch or the Pipedrive intake already recorded the same reply with its own exit;
- creates a Pipedrive task with a drafted answer for the rep behind the sending mailbox (or a note on the lead when a "Reply received" task already covers it).

A reply recorded elsewhere closes the person's bid batches through the exit hook, matched on the replying address only: a colleague's reply on someone else's project does not close that person's batch. Pipedrive's "last email received" for the person (no address) and synced mail not yet classified only hold the next email back a week.

## Other rules switched on with `BID_INVITE_SEQUENCE`

- At most one bid email per company per Chicago day, across mailboxes. Two sends are the same company when they share the Pipedrive organization or the email domain (a batch with an organization and one without it, same domain, count as one); personal mail domains (gmail.com and the like) are never a company.
- A cold Apollo enrolment to an address that got a bid email in the last 72 hours is held with a plain message saying when it can go (send guard, `lib/sdrSendSafety.js`), even after the bid lead is archived. The draft is kept.
- Derek's window is 4 to 6 weeks after the bid: Email 2 goes only if it can go by bid + 56 days, Email 3 only by bid + 70 days. A follow-up that cannot make it is skipped and the bid simply ends.
- Time zone: the organization's state, else the contact's phone area code, else Central.
- Each mailbox's "sent today" on the Mailboxes page counts bid follow-ups with cold starts, the same number the shared daily cap counts, and says how many were bid follow-ups.
- The volume alert: "nothing sent by noon" reads cold (Apollo) sends only, so bid emails never hide a full Apollo stop. The dip rule compares cold sends with the cold baseline minus that day's extra bid sends (above the mailbox's own bid average, never below 0), so bid emails that took part of the shared cap are not a false dip. Alerts show cold and bid apart; the freshness check reads Apollo's own outbound facts only.
