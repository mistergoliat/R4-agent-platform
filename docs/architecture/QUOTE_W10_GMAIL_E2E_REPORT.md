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
