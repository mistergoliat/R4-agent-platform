# Rotation of `R4_PROD_IDENTITY_HASH_KEY` (identity HMAC)

**State:** `R4_IDENTITY_HMAC_ROTATION_READY_FOR_REVIEW`. The procedure is executable and has been rehearsed on a restored copy of production (§6). **It has not been run in production**: that needs the owner's authorization.

**Why it is needed:** the key had the same value as the former PostgreSQL password, which was exposed in an admin session's output on 2026-11-11 and rotated that same day. So the key counts as compromised.

## 1. What the key is and what derives from it

`conversationKey = HMAC-SHA256(key as UTF-8, channel \0 accountRef \0 conversationRef)`, written as 64 lowercase hex characters (`packages/live-ops/src/rollout.ts`).

For WhatsApp the inputs are:
- `channel`: `whatsapp`;
- `accountRef`: the business number's `phone_number_id`;
- `conversationRef`: the normalised wa_id.

| Derived value | Where | Treatment |
|---|---|---|
| `channel_conversation_bindings.conversation_key` | Routing: one open binding per key; continuity across tasks | **Migrated** (every row: open and closed) |
| `R4_PROD_ROLLOUT_ALLOWLIST`, `_DENYLIST`, `R4_PROD_LANE_ALLOWLIST` | Deployment configuration | **Recalculated**, only from verifiable identities |
| Cohort bucket (first 8 hex of the key) | Decided when a binding opens; frozen in `autonomy` | No effect: rollout at 0 % |
| Advisory lock key (`conversationLockKey`) | Computed at runtime, never stored | No action |
| `inbound_events.conversation_key` | Settled ones are history; `received` ones are used | Must be **zero** `received` (abort condition) |
| `identity_verification.expectations.conversation_key` | Protection lookups | Must be **zero** live or protected (abort condition). The schema does not exist in production |
| `task_inputs.actor_ref` (`whatsapp:` + 32 hex), `request_hash`, `memory_entries`, `context_snapshots` | Immutable history | **Kept** (never compared across keys; rewriting would break their hashes) |

`R4_PROD_SMOKE_RECIPIENT` and the canary environment (its own key and database) are outside this rotation.

## 2. Original identities: preservation that can be verified

Each binding keeps the inputs of its own key: `channel`, `account_ref` and `recipient_ref` (the wa_id).
- **Verification:** a row is rewritten only if HMAC_old(those inputs) **equals** the stored key. That is verifiable proof of identity, not an inference.
- **Rows that don't verify:** they are never reassigned. If one is open, that's an abort condition, because routing would break. If it's closed, it stays as history.
- **Allowlist:** each list entry is recomputed only if it matches a verified identity. An authorized number that never wrote has no verifiable identity, so it is an abort condition and the owner provides that number.

## 3. Abort conditions (the tool refuses and nothing changes)

- An open binding that doesn't verify under the old key.
- A key collision: two identities under one old key, or two old keys under one new key.
- An inbound event `received` (not settled).
- An identity-verification expectation that is live or protected.
- A list entry with no verifiable identity.
- An unsettled action or outbound, or a failed verification after the rewrite (that one goes to rollback).

## 4. Procedure (`ops/r4-identity-rotation/`)

- **`rotation.mjs`**: the logic. Plan, apply in **one transaction** with the binding table locked, verify.
  - The identity-immutability trigger is disabled only inside the transaction.
  - Before commit it checks that every row verifies under the new key and that the trigger is back on.
- **`rotate.mjs`**: the CLI. It prints counts only and never a key, a wa_id or a derived key. The recalculated lists are written to a 0600 file.
- **`rotate-production.sh`**:
  1. preconditions;
  2. new key by CSPRNG (256 bits) into a 0700 folder;
  3. read-only plan with production running;
  4. kill switch, drain, stop the 4 processes;
  5. backup: `pg_dump`, configuration, pm2 dump;
  6. `apply`;
  7. new key and lists written in place;
  8. `verify`;
  9. restart with `--update-env` passing **only** the new key, which also purges the old value from pm2 and its dump;
  10. autonomy back as it was.
- **`restored-copy-test.sh`**: the rehearsal on a copy (§6).

**Impact:**
- About 1 minute with R4 stopped and the kill switch on. Meta retries webhooks, so nothing is lost.
- Conversations keep their binding and their task.
- New `actor_ref` values use the new key; earlier ones keep the old one (audit readability only).
- `rollout_fingerprint` changes for new bindings (informational).

**Rollback:** the same tool with the keys swapped (`B/rotated.env` with `B/old.key`), plus the configuration restored from the backup. As a last resort, `pg_restore` of the dump. Rollback is rehearsed in §6.

## 5. Exposure of old copies and access control

**Where the old value is** (EC2, `ec2-user`, files 0600 and folders 0700):
- `~/.config/r4/production.env.bak-*` (13);
- `production.env` inside every backup folder in `~/backups/r4-production/`;
- the credential-rotation backup;
- `~/transport/develop-r1/dump.pm2.copy-*`;
- the current `~/.pm2/dump.pm2` (until the rotation).

Outside EC2 it is in the local history of the admin session where the exposure happened (owner's PC) and in what was sent to the model provider in that session.

**Recommendations:**
- after the rotation and the rollback window, shred `.bak` files and copies that are no longer needed;
- keep the backups that are needed for recovery under 0700/0600 (they already hold full dumps and are just as sensitive);
- limit SSH access to the host to the people who operate it.

**Finding that limits the benefit.** `channel_conversation_bindings.recipient_ref` stores the wa_id **in plain text**: it's the delivery address the gateway uses. `inbound_events.conversation_ref` does too, transiently, until settlement. As a result:
- **The rotation does protect** the pseudonymous references that leave the database: lists in configuration, actor refs inside the contexts the model sees, prefixes in logs.
- **It does not protect** against someone who obtains a dump. That person can read the numbers without any key.

Encrypting `recipient_ref` (a delivery key that only the gateway holds) is the measure that would close that gap. It is outside this mandate and is left as a recommendation.

## 6. Tests

- **`tests/integration/identity-hmac-rotation.test.ts`** (through the real CLI, against a database written by a real gateway):
  - the plan refuses an allowlisted number with no identity, and an unsettled inbound;
  - after rotating, the same bindings and tasks continue under the new key, with the recalculated lists, after redeploying the gateway with the new key;
  - an unverifiable row is untouched;
  - the output contains no keys or numbers;
  - rollback restores the original keys;
  - the immutability trigger is back in force.
- **Rehearsal on a restored copy of production** (2026-11-11 19:52 UTC, `restored-copy-test.sh`):
  - **Copy:** fresh dump restored into a temporary `postgres:16-alpine` on tmpfs (127.0.0.1 only), destroyed at the end. Production was only read (`pg_dump`). The test key was random and shredded.

| Check | Result |
|---|---|
| Copy | 24 bindings, 24 tasks, 665 inbound events |
| Plan | 24/24 bindings verify under the old key (3 open; 3 distinct identities); 0 collisions; 0 unsettled inbound; identity-verification schema absent; **0 blockers** |
| Lists | Rollout allowlist 2/2 recalculated; lane allowlist 2/2; denylist empty |
| Apply | 24 rewritten in one transaction |
| Verify (new key) | 24/24; 0 open unverifiable; 0 duplicate open |
| Integrity | **0 tables changed** other than `channel_conversation_bindings` (checksum per table); 0 tasks without a binding; trigger enabled; an ordinary update of the key is refused again |
| Rollback (keys swapped) | Binding table **identical** to the original (same checksum for every table) |
| Leftovers | No container or temporary file from the rehearsal remains; production still at 24 bindings with its key unchanged |
