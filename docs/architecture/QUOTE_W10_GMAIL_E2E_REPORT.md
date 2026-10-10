# Quote W10 — Gmail Single-Delivery E2E Report

Date: 2026-10-08 · Scope: one controlled Quote V2 email to an approved internal mailbox · Status: **BLOCKED** (no EC2 command executed; preconditions unmet)

Evidence labels: **SOURCE** = verified in `MS-pesaschile-quote-service` at `686a0f6` (deployed release `6735352`, J3B §A); **NOT RUN** = not executed.

## 1. Outcome summary

| Precondition (§7 of the instruction) | State |
|---|---|
| J3D completed or in a safe, stable state | J3D **BLOCKED** before any EC2 change, so EC2 is unchanged. |
| Gmail credentials validated | **NOT RUN**: EC2 access refused by the session's permission policy. File presence and permissions not checked. |
| Exact internal recipient approved | **Pending owner**: none provided. |
| Sender and Reply-To confirmed | **Pending owner.** |
| Queue inventory complete, no unrelated eligible deliveries | **NOT RUN.** |
| Dedicated email-test principal | **NOT provisioned.** |
| Synthetic issued quote visible to that principal | **NOT prepared.** |

No delivery request was sent and the provider was never enabled. `QUOTE_EMAIL_PROVIDER=disabled` remains as deployed (`deploy/quote-v2-integration/runtime.public.env:15`). This was not re-read on EC2.

## 2. Contract facts the procedure must respect (SOURCE)

**Route**

- `POST /v2/quotes/{quoteId}/deliveries/email`, scope `quotes:delivery:email`.
- `Idempotency-Key` is required.
- The body is closed: `{ recipient?: { email, name? } }`.
- The answer is `202`. The status is then read with `GET /v2/quotes/{quoteId}/deliveries/{deliveryId}` (`quotes:read`).

**Recipient**

- `body.recipient` overrides the quote's snapshot email. Without it, the frozen `customer.email` is used.
- The G1 synthetic quotes carry `g1-synthetic@example.com`.
- **The W10 request must therefore send `recipient.email = <approved internal mailbox>` explicitly. Never omit it.**

**Visibility**

- The caller must have created the quote or hold `quotes:read:any`. Otherwise it gets `404`.
- The dedicated test principal should hold `quotes:create`, `quotes:read`, `quotes:document:read` and `quotes:delivery:email`, and issue its own synthetic quote. This avoids granting `read:any`.
- `quotes:delivery:email` is **not** added to `r4-sales-integration`.
- Provisioning is the J3C procedure:
  1. Generate the token with `dist/scripts/generate-principal-token.js`.
  2. Edit the registry **in place**: it is a single-file bind mount, and replacing the file would leave the container reading the stale copy.
  3. `docker kill --signal=HUP quote-v2-integration`.

**No allowlist and no single-send mode**

- Enabling `gmail` starts a worker that sends **every** `pending` row whose `next_attempt_at` has passed.
- The claim does not enforce the 24 h window. An old pending row would be sent.
- The queue must therefore be empty:

  ```sql
  select status, origin, count(*) from quote_service.quote_deliveries group by 1,2;
  select delivery_id, status from quote_service.quote_deliveries where status in ('pending','sending');  -- must return 0 rows
  ```

  With the provider disabled, new requests get `503`, so no producer can enqueue during preparation.

**Configuration file pitfall**

- Every optional email or Gmail key is `string().min(1).optional()`, so a `KEY=` line with an empty value fails startup (`runtime.config_invalid`) **even when the provider is disabled**.
- If no Reply-To is wanted, the line must be deleted, not left empty.
- `gmail.pending.env` is not referenced by `compose.yaml`. Enabling Gmail needs it as a third `env_file` entry listed after `runtime.public.env` (later entries win), or a compose override, plus `QUOTE_EMAIL_PROVIDER=gmail`.
- Applying the change requires `docker compose -p quote-v2-integration up -d quote` (a recreate). `docker restart` does not re-read env files.
- The deployment README currently says never to set `gmail`. W10 is the owner-authorized exception.

**Credential validation without sending**

- No repository script exists for it.
- `GOOGLE_GMAIL_USER` is required but unused: the sender always calls `users/me`.
- Checking that the token authorizes the intended account and that the From address is permitted needs a read-only probe from the host. That is a token refresh, then `GET gmail/v1/users/me/profile` (to compare `emailAddress`) and `GET users/me/settings/sendAs` (to confirm the From address is a verified send-as alias).
- Gmail scopes may forbid `sendAs` reads. If so, the From check falls back to inspecting the delivered message.
- The probe output must print only booleans or masked addresses, never tokens.

**Outcomes**

- Message-ID is `<delivery.{deliveryId}@{from-domain}>`.
- `provider_message_id` is stored on the delivery row (it may be null on a 2xx).
- The attachment is the stored bytes, re-hashed against the manifest `pdfSha256` before sending.
- Ambiguous results become `unknown` (terminal). There is no automatic resend; investigate under the same key only.

## 3. Procedure for the next authorized session (NOT RUN)

1. **File hygiene.** `gmail.pending.env` must be mode `0600`, owned by `ec2-user`, and outside Git. Confirm there are no `*~`, `.swp` or `.*.swp` copies in the directory.
2. **Validate the configuration file** with the deployed loader in a one-shot container (`dist/infrastructure/config/env.js`), with provider `gmail`, printing variable names and errors only. Then run the read-only probe from §2.
3. **Owner approves:**
   - the exact internal recipient;
   - From and Reply-To;
   - the delivery key;
   - the procedure owner.
4. **Provision the test principal.** Issue its synthetic quote with the internal recipient as the customer email, which gives a second safeguard on top of the explicit `recipient`. Record the quote's `pdfSha256`.
5. **Inventory the queue:** zero `pending` or `sending` rows. Block other producers: no other principal holds `quotes:delivery:email`; check the registry.
6. **Enable Gmail.** Add the env_file, recreate the `quote` container, and check `/health/ready`.
7. **Send exactly one POST** with one key and the explicit recipient. Poll `GET` until the delivery is `sent`, `failed` or `unknown`.
8. **Verify:**
   - in the database: one row, `sent_at` set, `provider_message_id`;
   - in the mailbox: one message with the expected Message-ID, From and Reply-To, and one PDF whose SHA-256 equals the manifest;
   - no other rows created during the window.
9. **Disable Gmail.** Remove the env_file, recreate, and confirm `emailProvider: disabled` and no send runner. Then remove the delivery scope from the test principal (registry edit plus HUP).

## 4. Final flags

```
QUOTE_GMAIL_CREDENTIALS_VALIDATED=NO
QUOTE_W10_SINGLE_EMAIL=NOT_RUN
QUOTE_W10_ATTACHMENT_SHA256=NOT_RUN
QUOTE_GMAIL_DISABLED_AFTER_TEST=YES      (never enabled; deployed default disabled, not re-read on EC2)
OTHER_SERVICES_UNAFFECTED=YES
QUOTE_W10_STATUS=BLOCKED
CUSTOMER_ROLLOUT_AUTHORIZED=NO
```

## 5. EC2 execution (2026-10-09, SSH authorized)

Evidence label **EC2**. No value was printed: only key names, statuses, booleans and masked addresses.

| Check | Result |
|---|---|
| `~/.config/quote-v2-integration/gmail.pending.env` | Mode 600, owned by `ec2-user`. It has the 7 expected keys and **all 7 are still empty**. The owner has not filled it, so the loader validation (activation procedure §4) and any activation are **not run**. Attaching it today would fail startup (`runtime.config_invalid`). |
| Compose | `~/services/quote-v2-integration/compose.yaml` exists. The override was not created and the `quote` container was not recreated. |
| Quote V1 Gmail OAuth (`~/services/MS-pesaschile-quote-service/.env`, V1 `b504f75`) | The read-only probe (activation procedure §5) ran with V1's 7 keys in process memory. `tokenRefresh: 200`: the client and refresh token are **valid**. Granted scope: `gmail.send` only. `profile` and `sendAs` returned **403**, which is expected with that scope, so the account and the alias **cannot be confirmed by API**. Masked user, From and Reply-To are `j***@gmail.com`. A name-only comparison gives From = Gmail user = Reply-To. That is a **consumer Gmail account**, not the Workspace domain. `QUOTE_EMAIL_FROM_NAME` contains a space: fine for Compose `env_file`, but it breaks a bash `source`. |
| Delivery queue, test principal, recipient | Not run or provisioned. They depend on a filled `gmail.pending.env` and the owner's approval of the recipient, From and Reply-To. |

```
QUOTE_GMAIL_CREDENTIALS_VALIDATED=PARTIAL   (V1 refresh token valid, scope gmail.send; account/From not API-verifiable;
                                             V2 gmail.pending.env still empty)
QUOTE_W10_SINGLE_EMAIL=NOT_RUN
QUOTE_GMAIL_DISABLED_AFTER_TEST=YES         (never enabled; QUOTE_EMAIL_PROVIDER=disabled as deployed; container not recreated)
QUOTE_W10_STATUS=BLOCKED                    (owner: fill gmail.pending.env; approve recipient, From, Reply-To)
CUSTOMER_ROLLOUT_AUTHORIZED=NO
```

## 6. W10 attempt (2026-10-09 ~22:10 UTC, owner-authorized single send)

Authorized recipient: `joaquintorresducci@gmail.com`. Stopped in the preflight, at step 3 (OAuth validation). **Gmail was not activated, the `quote` container was not recreated, no principal was provisioned and no delivery was requested.**

| Preflight step | Result |
|---|---|
| 1. Quote V2 healthy | PASS. `/health/ready` `ready`. Both containers healthy (up 26 h). |
| 2. Seven variables set | PASS on shape. `gmail.pending.env` was updated 22:04 UTC. Mode 600, outside Git, no backup or swap copies. Exactly the 7 known keys, none empty, unquoted, no CRLF, no surrounding whitespace. |
| 3. Refresh token validated without sending | **FAIL.** The read-only probe got `tokenRefresh: 401` with `error: invalid_client`. Shape checks (booleans and lengths only): **`GOOGLE_GMAIL_CLIENT_ID` does not match Google's format** (`<digits>-<id>.apps.googleusercontent.com`) and is 71 characters, where V1's working value is 72. The project number and client secret are the same as V1. `GOOGLE_GMAIL_REFRESH_TOKEN` differs from V1 and is 67 characters, where V1's is 103 (probably truncated). |
| 4. From and Reply-To | Not reached as an authorization check. Name-only comparison: From = `GOOGLE_GMAIL_USER` = Reply-To = the authorized recipient, which is the same account as V1. `QUOTE_EMAIL_FROM_NAME` is the same as V1. |
| 5–8. Queue, producers, Compose and rollback, principal | Not run, because the preflight stopped at step 3. |

Not done: the Compose override, the container recreate, any change to `principals.json` and any delivery. R4, CRM, Catalog, Shipping and Customer Profile were not touched.

```
QUOTE_GMAIL_AUTH=FAIL                     (invalid_client; malformed client id in gmail.pending.env)
QUOTE_W10_RECIPIENT=joaquintorresducci@gmail.com
QUOTE_W10_DELIVERY=NOT_RUN
QUOTE_W10_PDF_SHA256=NOT_RUN
QUOTE_W10_DUPLICATES=0
QUOTE_GMAIL_DISABLED_AFTER_TEST=YES       (never enabled; QUOTE_EMAIL_PROVIDER=disabled; container not recreated)
R4_SERVICES_UNCHANGED=YES
```

## 7. W10 retry (2026-10-09 ~22:16–22:25 UTC)

The owner corrected `gmail.pending.env` (22:15:55 UTC).

| Preflight step | Result |
|---|---|
| 1. Quote V2 healthy | PASS. `/health/ready` ready. `/health/dependencies`: database, storage and renderer up; `emailProvider: disabled`; the `emailDelivery` worker is `enabled:false` with queue 0. |
| 2. Seven variables | PASS. Client id has Google's format (72 characters); refresh token is 103 characters. Same client and refresh token as the V1 credentials. |
| 3. OAuth without sending | **PASS.** `tokenRefresh: 200`, scope `gmail.send`. |
| 4. From and Reply-To | From = Reply-To = `GOOGLE_GMAIL_USER` = the authorized recipient (name-only comparison). Not verifiable by API with `gmail.send`; it must be confirmed on the delivered message. |
| 5. Queue | **PASS.** `quote_deliveries` has **0 rows in total**: nothing `pending`, `sending` or otherwise recoverable. Source at `6735352`: the worker claims only `pending` rows that are due (`next_attempt_at <= now`), and the sweep turns an expired `sending` into `unknown`, never into a resend. |
| 6. Other producers blocked | **PASS.** No principal holds `quotes:delivery:email`. The principals are `quote-g1-synthetic`, `quote-g1-monitor` and `r4-sales-integration`. With the provider disabled, requests get 503. |
| 7. Space, Compose, rollback | PASS. Disk 995 MB free, nothing to download. `compose.gmail.yaml` (0600, secrets dir, outside Git): its merged config has `QUOTE_EMAIL_PROVIDER=gmail`, the 7 Gmail keys and the same volumes. The base config (rollback) resolves to `disabled`. The deployed loader in a one-off `compose run --no-deps` accepted the configuration: `{"ok":true,"emailProvider":"gmail"}`. The running container did not change (`f47dc254…`, started 2026-10-08T20:18:13Z). |
| 8. Independent principal | **BLOCKED.** Provisioning `w10-email-test` (scopes `quotes:read`, `quotes:read:any`, `quotes:document:read`, `quotes:delivery:email`; token in a 0600 host file; in-place registry edit; `HUP`) was refused by the operator session's permission policy before anything ran. Registry unchanged (same inode and mtime) and no token file created. |

Selected quote, so that no second quote is issued: **PC-000001** (`81147e37-…`, `quote-g1-synthetic`, issued, valid until 2026-10-13, customer email on `example.com`). The PDF manifest is `6ec23e4d82dfd0d0306aefdc45bc8124041cbce63a98d95af173f7e912d8a7a8`, 29,255 bytes; the stored artifact re-hashes to the same value. Delivering it needs `quotes:read:any`, because the creator is a different principal.

Gmail was not activated, the `quote` container was not recreated, and no delivery was requested.

## 8. W10 single delivery (2026-10-09 22:20–22:24 UTC, owner-authorized)

The owner explicitly authorized the `w10-email-test` principal with four scopes. Recipient: `joaquintorresducci@gmail.com`.

| Step | Evidence (EC2) |
|---|---|
| Principal | `generate-principal-token` was run inside the container. The token went to `token-w10-email-test` (0600, never printed); only its SHA-256 went into the registry. Registry backup `principals.json.bak-pre-w10`. In-place edit (same inode), `HUP` → `principal_registry.reloaded` (4 principals). Scopes: `quotes:read`, `quotes:read:any`, `quotes:document:read`, `quotes:delivery:email`. `GET` of PC-000001 → 200. |
| Queue re-check | 0 rows, 0 `pending`/`sending`, immediately before activation. |
| Activation | 22:22:34 `docker compose … -f compose.yaml -f compose.gmail.yaml up -d --no-deps quote`. Only `quote` was recreated (new id `fce59054…`); the Postgres container id and start time are unchanged. Mounts are identical: `quote-v2-integration-documents` RW, CA and registry RO. `/health/ready` ready. `/health/dependencies`: `emailProvider: up`, `emailDelivery.enabled: true`, queue 0. |
| Delivery request | **Exactly one** `POST /v2/quotes/81147e37-…/deliveries/email`, `Idempotency-Key: w10-pc000001-20261009-single`, body `{"recipient":{"email":"joaquintorresducci@gmail.com"}}` → **202**, `deliveryId 24cf1cb6-f680-4f81-a99c-fb2a0303e70d`, `pending`. |
| Outcome | `GET` → **`sent`**: `sentAt 2026-10-09T22:22:52.260Z`, 1 attempt, `lastErrorCode null`. Logs: `delivery.claimed` (generation 1) then `delivery.sent` (`providerCalled: true`, 841 ms, `providerMessageId 1a122c313a15296d`, template `quote-email-envelope-v3`). |
| Database | `quote_deliveries`: **1 row in total**: `sent`, origin `v2`, `recipient_email` = the authorized address exactly, `requested_by_principal_id = w10-email-test`, `attempt_count 1`, `provider_message_id` set. |
| PDF | `document_sha256` on the delivery row = manifest `pdf_sha256` = SHA-256 of the stored artifact = `6ec23e4d82dfd0d0306aefdc45bc8124041cbce63a98d95af173f7e912d8a7a8` (29,255 bytes). The sender re-hashes the stored bytes against the manifest before attaching them (source `6735352`). |
| RFC Message-ID | By contract `<delivery.24cf1cb6-f680-4f81-a99c-fb2a0303e70d@gmail.com>`. **Mailbox-side not verifiable from the host**: the grant is `gmail.send` only, so the message count, From header, attachment and attachment SHA-256 in the inbox need the recipient's confirmation. |
| Deactivation | 22:23:23 `docker compose -p quote-v2-integration -f compose.yaml up -d --no-deps quote` (without the override). `/health/ready` ready; container `healthy`, 0 restarts. `emailProvider: disabled`, `emailDelivery.enabled: false`. No `GOOGLE_GMAIL_*` in the container environment, and `QUOTE_EMAIL_PROVIDER=disabled`. Postgres unchanged. |
| Scope removal | `quotes:delivery:email` was removed from `w10-email-test` (in place, same inode, `HUP`, reloaded). A POST now gets **403**. Remaining scopes: `quotes:read`, `quotes:read:any`, `quotes:document:read`. |
| No other mail | Total deliveries remained 1 after deactivation (0 `pending`, `sending`, `unknown` or `failed`). The 403 probe created no row. |
| Other services | R4 `r4-sales-worker`/`r4-channel-gateway`/`r4-scheduler` online, same uptimes as before (no restart), `/ready/r4` 200. Catalog, Customer Profile, CRM and MariaDB were not touched. |
| Secrets | `gmail.pending.env`, `compose.gmail.yaml` and `token-w10-email-test` stay in `~/.config/quote-v2-integration/` (0600, outside Git). |

```
QUOTE_GMAIL_AUTH=PASS
QUOTE_W10_RECIPIENT=joaquintorresducci@gmail.com
QUOTE_W10_DELIVERY=PASS                 (sent, 1 attempt, providerMessageId 1a122c313a15296d)
QUOTE_W10_PDF_SHA256=PASS               (service side: delivery = manifest = stored artifact; inbox attachment pending recipient confirmation)
QUOTE_W10_DUPLICATES=0                  (1 delivery row, 1 provider call)
QUOTE_GMAIL_DISABLED_AFTER_TEST=YES
R4_SERVICES_UNCHANGED=YES
CUSTOMER_ROLLOUT_AUTHORIZED=NO
```

## 9. W10 closure (2026-10-10)

**Received PDF integrity.** The owner reports that the PDF received in the authorized mailbox was verified by SHA-256 and equals the issued document. Full hash:

`6ec23e4d82dfd0d0306aefdc45bc8124041cbce63a98d95af173f7e912d8a7a8`

The same value appears in the manifest `pdf_sha256`, on the delivery row (`document_sha256`), and as the SHA-256 of the stored artifact (29,255 bytes). This confirmation is the owner's; the host's `gmail.send` grant cannot read the mailbox.

**Mailbox checks still pending owner confirmation** (not reported):
- exactly one message received;
- `From` header;
- `Message-ID` `<delivery.24cf1cb6-f680-4f81-a99c-fb2a0303e70d@gmail.com>`.

The service side shows one delivery row and one provider call (§8).

**Temporary principal revoked.**

Pre-checks:
- `w10-email-test` had 1 delivery, `sent` (terminal).
- It had 1 idempotency binding, bound to that delivery.
- No delivery or operation was pending.

Revocation:
1. Removed only its entry from `principals.json`, editing in place (same inode).
2. `HUP` → `principal_registry.reloaded`, `principals: 3`.

Results:
- The other three principals (`quote-g1-synthetic`, `quote-g1-monitor`, `r4-sales-integration`) are byte-identical to before.
- The revoked token gets **401**; the monitor token still gets 200.
- `token-w10-email-test` was shredded.
- `principals.json.bak-pre-w10` (which predates the principal) is kept.

**Gmail.**
- `QUOTE_EMAIL_PROVIDER=disabled` in the running container.
- `/health/dependencies`: `emailProvider: disabled`, `emailDelivery.enabled: false`.
- Container healthy, 0 restarts.
- Total deliveries: 1 (`sent`).
- No new email was sent.

```
QUOTE_W10_PDF_SHA256=PASS                 (owner-verified received attachment = 6ec23e4d…a7a8)
QUOTE_W10_MAILBOX_HEADERS=PENDING_OWNER   (single message, From, Message-ID not confirmed)
QUOTE_W10_TEMP_PRINCIPAL_REVOKED=YES
QUOTE_GMAIL_DISABLED=YES
QUOTE_W10_STATUS=CLOSED                   (headers pending owner confirmation)
```
