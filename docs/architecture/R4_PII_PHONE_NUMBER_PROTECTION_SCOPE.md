# Protection of contact phone numbers: scope of the work

**State:** `PROPOSED`. This is a scoping document; it changes nothing. It was opened as separate work after the identity HMAC rotation (PR #71), at the owner's request (2026-11-11). It is **not** part of PR #70.

## 1. What was measured (production, 2026-11-11, read-only, counts only)

| Where | Holds the number in clear | Measure |
|---|---|---|
| `channel_conversation_bindings.recipient_ref` | **Yes**: the delivery address | 24 rows, 3 contacts. It is the **only** place among the 286 text/JSON columns of the R4 database |
| `inbound_events.conversation_ref` | Transient: only while `received`; cleared at settlement | 0 rows now |
| Full backups (`~/backups/r4-production/*/r4_production.dump`) | **Yes** (copy of the table above) | **6 of 6 dumps** |
| Configuration: `R4_PROD_SMOKE_RECIPIENT` in `production.env` | **Yes**: the smoke-test recipient | 1 variable, plus 13 historical `production.env.bak*` / `pre-*` copies |
| Production logs (`~/.pm2/logs/r4-*`) | No | 0 lines |
| Quote V2 database | No | 0 of 120 columns |
| Conversation memory, inputs, contexts | No: the actor is `whatsapp:<HMAC>`. A customer could type a number as free text; that's message content, outside this scope | 0 matches |
| Web QA database | Not measured (another deployment, other credentials) | Pending |

## 2. Who needs the original number (code)

| Consumer | Why | Needs the number in clear? |
|---|---|---|
| Delivery (`production-store.ts` dispatch, `whatsapp-cloud/outbound.ts`) | It's the `to` of every reply and every document | **Yes**, at send time |
| Gateway, when a binding opens (`ingress.ts`) | It writes it from the webhook | Receives it; doesn't need to read it back |
| Identity resolution (`customer-v2/v3.ts`, `identity-verification.ts`: `subjectRef`) | Sends it to CIA to resolve the customer (profiles @7–@8, not active) | Yes, if those profiles come back |
| OTP dispatcher (`identity/verification/dispatcher.ts`) | Address of the code | Yes (only @8, not active) |
| Inspector (`inspection.ts`, `binding.recipientRef`) | Direct-sender check | It can compare against an HMAC |
| `--identity-key` CLI, smoke | Computes keys and tests the canal | It can take the number as an argument without storing it |

## 3. Proposal to evaluate (to be decided in that work)

- **Pseudonymize** (HMAC, as today): everything that only compares or groups (routing, allowlist, actor, locks).
- **Encrypt** (AES-256-GCM, per-version keys, AAD = `binding_id` + `channel`):
  - `recipient_ref`, decrypted only by the process that sends (gateway delivery) or by the identity adapters that need it;
  - `R4_PROD_SMOKE_RECIPIENT`, or remove it from the permanent configuration.
- **Keys:**
  - keep them separate from the identity HMAC and from the database;
  - a keyring with versions, like `R4_PROD_VERIFICATION_CODE_KEYS`;
  - only the gateway receives them;
  - rotate them with the same pattern as PR #71: verify, re-encrypt in one transaction, rollback.
- **Historical backups:**
  - define retention;
  - decide whether old dumps are deleted, re-encrypted or kept under restricted access (today they're 0600 inside a 0700 folder, on the same host);
  - consider encryption at rest of the folder or of the volume.
- **Migration:** the `recipient_ref` column is protected by the identity-immutability trigger. Encrypting it needs a migration with the same care as the HMAC rotation, plus a change to the dispatch path. It is a Core change, so it needs an ADR.

## 4. Open questions for the owner

1. Retention of full backups: how many, and for how long?
2. Do customer identity profiles (@7–@8) come back? That decides whether anything other than the gateway needs the number.
3. Is `R4_PROD_SMOKE_RECIPIENT` still needed in the permanent configuration?
