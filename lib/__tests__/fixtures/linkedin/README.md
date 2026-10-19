# Synthetic Unipile v1 contracts

The request spies and journey payloads are synthetic. They prove the local API boundary and fail-closed decisions; they do not prove the current sender, credential, webhook subscription or exact connected-account payload shape. No test here contacts Unipile.

The approved DSN ends at `/api/v1`. The adapter pins `X-API-KEY` and one server-side `account_id`. It uses these documented v1 routes:

- [Get account](https://developer.unipile.com/reference/accountscontroller_getaccountbyid): `GET /accounts/{id}`. A LinkedIn account reports `type: LINKEDIN` and source status `OK`; account identity is verified again on read.
- [Get profile](https://developer.unipile.com/reference/userscontroller_getprofilebyidentifier): `GET /users/{identifier}?account_id=...`. Classic public IDs can resolve to `provider_id`; ACo (Classic) and ACw (Sales Navigator) remain distinct.
- [Pending invitations](https://developer.unipile.com/reference/userscontroller_listalluserinvitationssent): `GET /users/invite/sent?account_id=...` with a cursor. Disappearance from this list never proves acceptance.
- [Send invitation](https://developer.unipile.com/docs/invite-users): `POST /users/invite` JSON with `account_id`, `provider_id`, and optional `message`.
- [List chats for an attendee](https://developer.unipile.com/reference/chatattendeescontroller_listchatsbyattendee): `GET /chat_attendees/{attendee_id}/chats?account_id=...`. Returned chats carry their account ID.
- [Send messages](https://developer.unipile.com/docs/send-messages): multipart `POST /chats` with `account_id`, `text`, one `attendees_ids`; continuation is multipart `POST /chats/{chat_id}/messages` with text. The first release excludes InMail.
- [Webhook authentication](https://developer.unipile.com/docs/webhooks-2) uses a configured static `Unipile-Auth` header. [Message events](https://developer.unipile.com/docs/new-messages-webhook) include both prospect and own outbound messages; compare `account_info.user_id` with `sender.attendee_provider_id` for direction.
- [Account status](https://developer.unipile.com/docs/account-lifecycle): only `OK` is healthy. Any unknown/restricted status pauses local dispatch.
- [Hosted Auth Wizard v1](https://developer.unipile.com/docs/hosted-auth): `POST /hosted/accounts/link` uses `type: reconnect`, `reconnect_account`, `api_url`, `expiresOn`, `notify_url` and a one-time `name`; a `RECONNECTED` notification returns `account_id` and `name`. The callback only claims a nonce; the adapter reads the exact bound account and Classic self ID before storing it, with mode still disabled.

Connected rollout must pin bounded real read responses and verify field names, pagination, sender Classic identity and webhook delivery before enabling writes. The fixture account and provider IDs are invented.
