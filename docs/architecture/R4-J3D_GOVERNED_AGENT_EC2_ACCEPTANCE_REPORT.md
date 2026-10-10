# R4-J3D — Governed Agent EC2 Acceptance Report

Date: 2026-10-08 · Scope: R4-J3D controlled EC2 deployment of Quote V2 Sales integration and governed `sales-production@4` canary · Status: **BLOCKED** (no EC2 command executed; governed canary has no operational approval mechanism)

**Recovery update 2026-10-09 (R4-J3D-R, §8).** The isolated canary tooling now exists and passes its isolation tests locally. Approval inspection is read-only. Approve and reject remain **blocked**, because no trusted human identity exists. EC2 is still not authorized. J3D stays **BLOCKED**.

Evidence labels: **LOCAL** = executed on the workstation against throwaway resources; **SOURCE** = verified in code at `main`; **NOT RUN** = not executed.

## 1. Outcome summary

| Gate | Result | Reason |
|---|---|---|
| §2 EC2 preflight | **NOT RUN** | The operator session's SSH access to the EC2 host was refused by the session's permission policy before any remote command ran. Nothing on EC2 was read or changed. |
| §3 Backup + migration 0007 on EC2 | **NOT RUN** | Requires §2. Isolated compatibility test **PASS (LOCAL)**, §3. |
| §4 Code deployment under `@3` | **NOT RUN** | Requires §2/§3. |
| §5 Governed `@4` canary | **BLOCKED: missing operational test mechanism** | No production-path operator approval surface; see §5. Not worked around (no harness change, no direct capability call, no SQL approval). |

## 2. Release under test (LOCAL)

- `main` = `origin/main` = `ec59c8d8d689992bb48f9e0f992c8d2ea7741d5b` (merge of PR #6, contains J3B `ee199a9` and J3C `1435672`).
- Working tree: pre-existing local changes not part of this slice (`.claude/settings.json` modified; `docs/architecture/R4_CRM_LEGACY_DEPENDENCY_DECOMMISSION_AUDIT.md` untracked).
- `npm run build` at `ec59c8d`: exit 0.
- Core migrations (`packages/persistence-postgres/migrations`) unchanged between the deployed J2D merge `ae76a9e` and `ec59c8d` (`git diff --stat` empty). Sales `0006` byte-identical to `ae76a9e`.

## 3. Migration 0007 verification

**Content (SOURCE).** `agents/sales/migrations/0007_sales_quote_v2_issuance.sql` creates exactly:

- tables `sales.quote_v2_requests`, `sales.quote_v2_sends`, `sales.quote_v2_acceptances`, `sales.quote_v2_issued`;
- index `sales_quote_v2_issued_by_task`;
- four `before update or delete` triggers calling the existing `sales.forbid_mutation()` (from `0006`).

No `alter`, `drop`, data change or object outside schema `sales`.

**Checksums (LF-normalized, as the migrator stores them in `r4_schema_migrations`).**

| Migration | SHA-256 |
|---|---|
| `0006_sales_reference_application` | `856c60a15ff38c3b54e3e11c2fb0a57dfdf4da39a50e1023ce970dd5015bc684` |
| `0007_sales_quote_v2_issuance` | `414f0d28ebbd0ca7b966f15a4513de3b7417d7bfbedb2019b01d053293c67cb9` |

On EC2, the recorded checksum of `0006` must equal the value above before `0007` is applied. A mismatch makes the migrator refuse (`migration_modified`). **Not checked on EC2.**

**Isolated compatibility test: PASS (LOCAL).** Throwaway `postgres:16-alpine` on loopback, random password, removed with its volume afterwards.

1. Applied the core migrations with `npm run db:migrate`.
2. Applied Sales `0006` only, which is the deployed J2D schema.
3. Seeded a conversation, a workspace and one transition.
4. Applied `0007` with the production command `npm run sales:migrate`.

| Check | Result |
|---|---|
| `sales:migrate` | `sales migrations applied: 0007_sales_quote_v2_issuance` |
| Re-run | `sales schema already current` (no-op) |
| `r4_schema_migrations` diff | only `+ 0007_sales_quote_v2_issuance 414f0d28…` |
| Pre-existing Sales rows (content hash per table) | identical before and after |
| `pg_dump --schema-only` diff | additions only (the only removed lines are pg_dump's random `\restrict` session tokens) |
| New objects | 4 tables, 1 index, 4 triggers, as listed above. 0 objects outside `sales` |
| Append-only guard | `update` and `delete` on `quote_v2_requests` refused: `quote_v2_requests is append-only` |
| `migrationStatus` | `pending: []`, `modified: []` |

**Backup: NOT RUN.** Required before §3 on EC2:

- a consistent `pg_dump -Fc` of the R4 database, streamed off-host (for example `ssh … pg_dump -Fc | local file`) so it does not consume EC2 root storage;
- `pg_restore --list` readability check;
- a documented restore into a throwaway instance.

## 4. Deployment under `@3`: NOT RUN

Required order, recorded for the next authorized session:

1. Preflight:
   - SHA and working tree;
   - PM2 states and restart counters;
   - `df -h /` and `free -m`;
   - `r4_schema_migrations` status;
   - rollout, allowlist, denylist and kill switch (`production:sales:control autonomy status`);
   - Quote V2 `/health/ready`.
2. Off-host backup, then verify it.
3. `git pull` on the R4 checkout, then `npm ci` and `npm run build`. Transient disk use must be measured first against about 1 GB free.
4. `npm run sales:migrate`, then `npm run production:sales:bootstrap`. Expected: `unchanged` for existing definitions.

   **This must run before any restart.** Code from `ec59c8d` refuses to bootstrap and control with `schema_not_current` until `0007` is applied (J3B §Q).
5. `production:sales:plan` with `R4_PROD_POLICY_PROFILE=sales-production@3`. The v3 fingerprint must be unchanged and `quote.create` must not be registered.
6. Run the reviewed PM2 restart of `r4-sales-worker` and `r4-channel-gateway` together, then run the v3 regression checks.

## 5. Governed `@4` canary: missing operational test mechanism

The complete governed flow (model → `quote.create@2` proposal → human approval of the exact arguments → Policy Engine → `ActionExecutor` → Quote V2) **cannot be executed in isolation with existing tooling**. Each gap was verified in source at `ec59c8d`.

| Requirement | Status | Evidence |
|---|---|---|
| Real model and real Catalog, Shipping and Quote under `@4` | Exists | `production:sales:worker` composes all three. `@4` fails closed without them (`agents/sales/src/production/composition.ts`). |
| Proposal reaches `require_approval` | Exists, only for a task with `provisional` identity | `SALES_PRODUCTION_ACTION_POLICY` `quote.create: require_approval, minimumIdentity provisional`. A task created via the API is `unauthenticated`, so the policy **denies** it (`insufficient_identity`) instead of asking for approval. Only the channel gateway's task factory sets a `provisional` requester. |
| **Human inspects and approves the exact arguments** | **MISSING** | The only route is `POST /v1/human-requests/:id/respond`. `apps/api/src/main.ts` calls `createPlatform(config, { logger })` without a `humanContext`, so the route (and `GET /v1/attention`) answers `422 trusted_human_required` by design. `production:sales:control` has no approve or reject command. Approving by SQL would bypass `TemporalRuntime.respondHuman` (no event, no wake): not governed. |
| Synthetic inbound without WhatsApp | **MISSING as tooling** | The only `provisional` ingress is the WhatsApp webhook. The workaround is a canary gateway with `R4_GATEWAY_DISPATCH=false` and a hand-signed webhook payload. No CLI builds or signs one. |
| Isolation from the live `@3` worker | Possible only with a **separate database** | `claimRunnableTask` is not partitioned by agent, version or profile (`packages/persistence-postgres/src/execution-store.ts`). `@3` and `@4` both pin `sales@4`. On a shared database, the live worker would claim the canary task and the canary worker would claim live customer tasks. The live gateway's dispatcher would also deliver canary replies over WhatsApp. |

**Smallest additions that would close the gap.** These are Sales-pack or operator tooling, not harness changes. Each needs separate authorization.

1. An operator approval command, `production:sales:control approvals list|show|approve|reject`, that calls the existing `TemporalRuntime.respondHuman` with a production-host operator `TrustedHumanContext` (scope `approval.decide`) and prints the exact `validatedArguments` and `argumentsHash` before deciding.
2. A synthetic-inbound injector that opens a Sales task through the production task factory (service requester, `provisional`), bound to a non-delivering channel. Alternatively, a documented signed-webhook procedure against a canary gateway with dispatch off.
3. A dedicated canary database (core and Sales migrations, `production:sales:bootstrap`) and canary-only worker and gateway environments. This is operational and needs no code.

Per instruction, the harness was **not** modified to create any of these, and no direct capability call is presented as a governed E2E.

## 6. Services impact

No EC2 command was executed. PM2 processes, the R4 EC2 database, Quote V2, CRM-Customer-360, Catalog, Shipping, Customer Profile, MariaDB, nginx, rollout and allowlist were not touched. Local throwaway container removed (`docker ps -a` empty for it).

## 7. Final flags

```
R4_HARNESS_MODIFIED=NO
R4_SALES_MIGRATION_0007=NOT_RUN        (isolated compatibility test: PASS)
R4_PROFILE_V3_REGRESSION=NOT_RUN
R4_GOVERNED_AGENT_E2E=NOT_RUN
R4_QUOTE_PDF_VERIFIED=NO
R4_PRODUCTION_WHATSAPP_ROLLOUT_UNCHANGED=YES
OTHER_SERVICES_UNAFFECTED=YES
R4_J3D_STATUS=BLOCKED
CUSTOMER_ROLLOUT_AUTHORIZED=NO
```

## 8. Recovery update (R4-J3D-R, 2026-10-09)

Authorized scope: Sales-pack tooling only (an operator approval CLI and an isolated synthetic canary), no harness change, no EC2 change while the access gate is pending. Details:

- `R4-J3D-R_SALES_APPROVAL_CLI_REPORT.md`
- `R4-J3D-R_SALES_ISOLATED_CANARY_REPORT.md`
- `QUOTE_W10_GMAIL_ACTIVATION_PROCEDURE.md`
- `R4-J3D-R_CHANGE_MAP.md`

### 8.1 Gaps of §5, re-assessed

| §5 gap | Now |
|---|---|
| Human inspects and approves the exact arguments | **Inspection delivered** (`approvals list\|show`: exact validated arguments, hash, recomputed hash check). **Decision BLOCKED**: no legitimate existing mechanism provides a trusted human identity (no IAM; ADR-021 §5; roadmap "(E) no simularlo"; D-5 rejected host-declared identity, enforced by `live-ops-boundaries`). `approve`/`reject` are refused with `trusted_human_required`. |
| Synthetic inbound without WhatsApp | **Delivered**: `sales:canary send` runs the real `ChannelIngress.ingest` on the synthetic channel `r4-synthetic`, with the production task factory (provisional requester, pinned `sales@4`). |
| Isolation from the live `@3` worker | **Delivered**: dedicated database (marker, name and foreign-traffic guards, checked before every claim), local outbound capture, its own rollout. 10/10 isolation scenarios pass locally, with the production database fingerprint unchanged. |

### 8.2 EC2 (§3–§4 of the recovery instruction)

SSH stays refused by the session's permission policy. No other access mechanism was attempted. The read-only preflight, the off-host backup, the isolated `0007` validation copy, the migration, the `@3` deployment and regression, and the isolated `@4` canary on EC2 were **not run**. The runbook in §4 and canary report §7 still apply. To proceed, the operator must enable SSH to the host for the session (permission configuration) and authorize the preflight.

### 8.3 Verification (LOCAL, workstation, Node 20.19, Docker Postgres)

| Check | Result |
|---|---|
| `npm run build`, `npm run lint`, `npm run typecheck` | exit 0 |
| `test:unit` | 70 files, 946 passed |
| `test:contract` | 22 files, 292 passed |
| `integration` (`--no-file-parallelism`) | 30 files passed, 1 skipped; 367 passed, 12 skipped |
| `test:sales` | 29 passed |
| `test:shadow` | 5 passed |
| `test:recovery` | 17 passed, **1 failed (pre-existing)**: `production-bootstrap-process.test.ts` expects `registered: sales@3`. Since J2D `50ec670` added `sales.v4.agent.json`, the bootstrap registers `sales@3, sales@4`. The bootstrap code, the definitions and the test are byte-identical to `76585b3`, so this is a stale expectation, outside this slice and unchanged. Operational note: on EC2, `production:sales:bootstrap` will register `sales@4` the first time it runs with this code, which is expected by J2D's design. |

### 8.4 Flags

```
SALES_APPROVAL_CLI=PARTIAL            (list/show delivered; approve/reject BLOCKED on trusted human identity)
SALES_CANARY_ISOLATION=PASS           (LOCAL)
R4_HARNESS_MODIFIED=NO
R4_EC2_DEPLOYMENT=NOT_RUN             (EC2 access gate pending)
R4_GOVERNED_AGENT_E2E=BLOCKED         (no trusted human approval; real model/owners on EC2 NOT RUN)
QUOTE_W10_CONFIG_PREPARED=YES         (procedure, validation and probe prepared; owner file not yet filled)
QUOTE_W10_EMAIL_SENT=NO
CUSTOMER_ROLLOUT_AUTHORIZED=NO
R4_J3D_STATUS=BLOCKED
```

The tooling is not a governed acceptance. J3D acceptance still depends on the real E2E with a real human approval.

## 9. Trusted human approval (R4-J3D-S, 2026-10-09)

The §8.1 approval blocker is resolved **locally** by ADR-033: Google Workspace OIDC operators, authorized by an owner-managed registry, decide through the platform's existing approval route with a `humanContext` adapter. The harness is unchanged. Validated on the isolated canary against a local, conformant OIDC issuer (`R4-J3D-S_TRUSTED_HUMAN_APPROVAL_REPORT.md`).

Still open for J3D acceptance:

- registering the Google OAuth client and the operator registry (owner);
- the EC2 access gate;
- deployment §4;
- the real-model, real-owner governed E2E on EC2.

```
TRUSTED_HUMAN_AUTH=PASS (LOCAL)   SALES_APPROVAL_CLI=PASS (LOCAL)   GOVERNED_CANARY_LOCAL=PASS
R4_HARNESS_MODIFIED=NO            R4_EC2_DEPLOYMENT=NOT_RUN          R4_J3D_STATUS=BLOCKED (EC2 gate, live IdP, real E2E)
```

## 10. EC2 execution (2026-10-09, SSH authorized)

Evidence label **EC2** = executed on the production host (`ip-172-31-1-183`, `ssh Master`). Times are UTC. No secret value was printed or copied off the host. The backups are the only production data taken off the host (to the operator workstation).

### 10.1 Preflight (§A): read-only

| Check | Result |
|---|---|
| R4 checkout | `main` at `ae76a9e` (J2D), clean. `origin/main` = `ef5a354` (PR #7). |
| Diff `ae76a9e..ef5a354` | Harness paths (`packages/`, `apps/`, `adapters/channels`, `adapters/models`, Catalog and Shipping adapters): **0 changes**. Lock: only the new workspace link `adapters/domains/quote/http`, no external dependency. Migrations: only Sales `0007` added. `profile-v3.ts`: the profile registry moved to `profile-v4.ts`, and the `@3` object is unchanged. |
| PM2 | `r4-sales-worker`, `r4-channel-gateway`, `r4-scheduler`, `catalog-service`, `customer-profile`, `crm-web` online. `quote-service` (V1) stopped since 2026-09-16. Four `crm-*` jobs stopped. All pre-existing, none touched. |
| Docker | `r4-production-postgres` (healthy, 10 days), `quote-v2-integration` and its Postgres (healthy), `crm-customer-360-mariadb`, `pesaschile-quote-service-postgres` (exited, pre-existing). Images 1.41 GB, build cache 0. |
| Capacity | Root 10 GB, 90 % used, **1.1 GB free** (993 MB after this session). Inodes 10 %. RAM 3.8 GB, about 1.8 GB available, no swap. `/tmp` is tmpfs. |
| R4 config | `R4_PROD_POLICY_PROFILE=sales-production@3`, rollout 0 % with 1 allowlisted key, `R4_GATEWAY_DISPATCH=true`, autonomy `enabled` (`global:2`, 2026-09-28). |
| Migration ledger | `0006_sales_reference_application` = `856c60a1…` (expected). `0007_sales_quote_v2_issuance` absent. Core `0001–0010` applied. |
| Old-code tolerance | `migrationStatus` reports only on-disk migrations that are pending or modified. An applied migration unknown to the code is ignored, so `ae76a9e` keeps running with `0007` applied. That makes the application rollback possible without a down migration. |
| Quote V2 | `127.0.0.1:4020` `/health/ready`: `ready` (database, schema, artifactStorage, renderer, lifecycle ok). |
| Pre-deploy plan | `@3`, profile fingerprint `847aa0ef…`, `quote.create` `domain_unavailable`, Shipping REAL (saved: `~/r4-j3d/plan-before.json`). |

### 10.2 Backup and migration (§B)

| Step | Result |
|---|---|
| Off-host backup | `pg_dump -Fc` streamed over SSH to the workstation (`E:\dev\codex\R4-backups\r4-production-pre-0007-20261009T205622Z\`), plus `globals.sql` (no role passwords) and the ledger. `r4_production.dump` SHA-256 `dbfc08cb…`. A final dump right before the migration, `r4_production.final-pre-migrate.dump`, has SHA-256 `e61cccb4…`. No EC2 disk was used. |
| Backup verification | Restored into a throwaway local `postgres:16-alpine`: `pg_restore --exit-on-error` succeeded with 36 `TABLE DATA` entries. Row counts per table are **identical** to live production at the time (36/36). |
| Isolated rehearsal | On the restored copy with `main`'s `npm run sales:migrate`: applied `0007` (`414f0d28…`), and the re-run is a no-op. Content hashes of every pre-existing table are unchanged, apart from the ledger row. Schema diff: additions only (the 2 removed lines are `pg_dump`'s random `\restrict` tokens). Objects: 4 tables, `sales_quote_v2_issued_by_task`, 4 triggers. A `DELETE` on a probe row was refused (`quote_v2_requests is append-only`). Container removed with its volume. |
| Production | 20:59:48 `sales:migrate`: `sales migrations applied: 0007_sales_quote_v2_issuance`. Re-run: `sales schema already current`. Ledger `0007` = `414f0d28ebbd0ca7…` and `0006` unchanged. 4 tables, 1 index and 4 triggers present; `quote_v2_requests` has 0 rows. |
| Data preservation | Every pre-existing table in live production after the migration was compared with the final pre-migration dump (restored locally), by count and content hash: **34/35 identical**. The only difference is `public.worker_presence` (1 row), the live worker heartbeat. |

A first in-place before/after hash on production was invalid: `docker exec` without `-i` dropped stdin, so both captures were the same SQL error. It was discarded and replaced by the dump comparison above.

Quote V2 PostgreSQL was not touched.

### 10.3 Deployment under `@3` (§C)

| Step | Result |
|---|---|
| Code | `git merge --ff-only origin/main` → `ef5a354`. `npm install --prefer-offline` added the one workspace link and left the lock unchanged. The working tree stays clean. `npm run build` exit 0. Disk unchanged. `npm install` was used instead of `npm ci` so `node_modules` was never deleted under the live processes. |
| Bootstrap | `production:sales:bootstrap`: `unchanged: sales@3, sales@4`. |
| Plan after (`@3`) | Compared key by key with the pre-deploy plan. `profile`, `profileFingerprint` (`847aa0ef…`), `productionConfigFingerprint`, `capabilities` (`quote.create` still `domain_unavailable`), `writes`, `rollout`, `killSwitch`, `agentDefinition` (`sales@4`), `channel`, `model`, Catalog and Shipping are **identical**. New key `quote`: "UNAVAILABLE in this profile (not composed)". `scheduler` differs only by its PID-bearing owner string. |
| Restart | 21:01:43 `pm2 restart r4-sales-worker r4-channel-gateway`, with no running task or run at that moment (tasks: 9 cancelled, 1 failed, 1 waiting). Both online, with no further restarts after 60 s and empty error logs. The worker logged `service.composed profile=sales-production@3 profileFingerprint=847aa0ef…`. `r4-scheduler` was not restarted: the generic scheduler code is unchanged. |
| Regression | Gateway `/health` 200. `/ready` 200: `sales-production@3`, `pendingMigrations: []`, WhatsApp REAL, dispatcher on. `/ready/r4` 200. Autonomy unchanged (`enabled`, version 2). Approvals: 0 open, and host control still refuses decisions (D-5). 0 outbound messages since the restart. |

Not exercised: a live WhatsApp turn. The regression is readiness, plan and fingerprint equality; no customer conversation was triggered.

**Rollback**:
- **Application:** `git checkout --detach ae76a9e && npm install && npm run build && pm2 restart r4-sales-worker r4-channel-gateway`. This keeps the `0007` tables and their data; the old code ignores them (§10.1).
- **Data:** only on corruption, restore the off-host dump into a new database. This loses writes made after 20:59.

### 10.4 Google Workspace OIDC (§D): BLOCKED on the owner

- Private store created separately from Gmail and production: `~/.config/r4-operator/` (0700) holds `oidc.env` (0600) and `operators.json` (0600, `{"version":1,"operators":[]}`).
  - `oidc.env` sets `ISSUER=https://accounts.google.com`, `HOSTED_DOMAIN=pesaschile.cl` (to be confirmed by the owner) and `REDIRECT_PORT=8765`.
  - `CLIENT_ID` and `CLIENT_SECRET` are empty.
- `production:sales:operator whoami` fails closed: `operator_auth_config_incomplete: R4_OPERATOR_OIDC_CLIENT_ID is required`.
- No Google OAuth client exists. None of the real-Google checks (PKCE, state, nonce, signature, iss, aud, exp, registry, `approval.decide`, rejection of an unknown identity, audit) could be run.

### 10.5 Governed canary (§E): prepared, BLOCKED on §10.4

| Element | State |
|---|---|
| Canary PostgreSQL | **Separate container** `r4-sales-canary-postgres` from the existing `postgres:16-alpine` image (no download): loopback `127.0.0.1:55434`, volume `r4-sales-canary-pgdata`, `--memory 384m`. The password is in `~/.config/r4-canary/pg-password` (0600). |
| Canary env | `~/.config/r4-canary/canary.env` (0600). Derived from `production.env` with the model, Catalog, Shipping, reconciliation and worker timings. It has **no** WhatsApp, gateway, `R4_DATABASE_URL`, production identity key or allowlist. It has its own identity hash key, `sales-production@4`, rollout 0 % with 1 synthetic key, `R4_QUOTE_*` → `127.0.0.1:4020` with the `r4-sales-integration` principal, `R4_EXEC_MAX_WRITE_ACTIONS=3`, and capture to `~/r4-j3d/canary-outbound.jsonl`. |
| `sales:canary init` | Marker written (`canaryId 50ea36160c0b`), migrations applied, `sales@3`/`sales@4` registered, autonomy enabled **in the canary database only**. |
| `sales:canary status` | `isolation: verified`, foreign traffic 0/0/0, no tasks. `production.env` unchanged. |
| `run`/`send` | **NOT RUN.** Without a real OIDC operator the flow would stop at `REQUIRE_APPROVAL` with an approval nobody can decide. Per instruction, no approval is simulated. |

### 10.6 Flags (this session)

```
R4_EC2_DEPLOYMENT=PASS                 (ef5a354 on EC2; worker+gateway restarted under sales-production@3)
R4_SALES_MIGRATION_0007=PASS           (off-host verified backup; isolated rehearsal; 34/35 tables identical, the 35th is the live heartbeat)
R4_PROFILE_V3_REGRESSION=PASS          (fingerprint, plan, readiness, controls identical; no live WhatsApp turn exercised)
R4_GOOGLE_OIDC_REAL=BLOCKED            (no Google OAuth client; private store prepared; fails closed)
R4_GOVERNED_AGENT_E2E=BLOCKED          (canary DB/env/init ready and isolated; needs a real OIDC operator)
R4_HARNESS_MODIFIED=NO
R4_PRODUCTION_WHATSAPP_UNCHANGED=YES   (profile, rollout, allowlist, kill switch, Meta config unchanged; 0 outbound since restart)
CUSTOMER_ROLLOUT_AUTHORIZED=NO
R4_J3D_STATUS=BLOCKED                  (owner: OAuth client + operator registry)
```

## 11. Final acceptance attempt (2026-10-10)

**Phase 1, W10 closure.** Done; see `QUOTE_W10_GMAIL_E2E_REPORT.md` §9.
- Received PDF SHA-256 `6ec23e4d…a7a8`, as confirmed by the owner.
- Temporary principal `w10-email-test` revoked (token → 401; other principals byte-identical).
- Gmail disabled.

**Phase 2, Google OIDC: BLOCKED.**
- `~/.config/r4-operator/oidc.env` is unchanged since 2026-10-09 21:06 UTC: `R4_OPERATOR_OIDC_CLIENT_ID` and `R4_OPERATOR_OIDC_CLIENT_SECRET` are empty.
- `operators.json` lists 0 operators.
- No sign-in was attempted. No identity was accepted from an email, a header, a Linux user, a SQL write or `ADMIN_BYPASS_TOKEN`.

Sign-in procedure once the client exists:
1. Run `ssh -L 8765:127.0.0.1:8765 Master` with `production:sales:operator whoami`, using `production.env` + `oidc.env`.
2. The operator opens the printed URL in a browser on the workstation that holds the tunnel.
3. Google redirects to `127.0.0.1:8765`, which the tunnel forwards to the EC2 listener.
4. The CLI verifies the token (RS256/JWKS, `iss`, `aud`/`azp`, `exp`/`iat`, `nonce`, `email_verified`, `hd=pesaschile.cl`) and prints `(iss, sub)`.
5. The owner then approves adding that `(iss, sub)` with role `approver` to the registry.

**Phase 3, governed canary: BLOCKED on Phase 2.**
- Not started, so no approval waits to expire.
- Canary state: `isolation: verified`, 0 foreign traffic, 0 tasks, 0 open human requests.
- No direct `quote.create@2` call and no simulated approval.

**Production.**
- Gateway `/ready`: `ready`, `sales-production@3`, WhatsApp REAL.
- `production.env` still `sales-production@3`, rollout 0 %.
- PM2 restart counters unchanged since the deployment (worker 16, gateway 11, scheduler 0).
- EC2 checkout `ef5a354`, clean.

```
GOOGLE_OIDC_REAL=BLOCKED               (OAuth client not configured in oidc.env)
TRUSTED_OPERATOR_AUTH=BLOCKED          (no Google-authenticated operator; registry empty)
R4_GOVERNED_AGENT_E2E=BLOCKED          (requires a trusted operator; canary ready, not started)
R4_QUOTE_ISSUED_ONCE=NO                (no governed issuance yet; nothing issued by the canary)
R4_PDF_SHA256=NOT_RUN
R4_HARNESS_MODIFIED=NO
R4_PRODUCTION_PROFILE=@3
R4_WHATSAPP_UNCHANGED=YES
QUOTE_GMAIL_DISABLED=YES
QUOTE_W10_TEMP_PRINCIPAL_REVOKED=YES
CUSTOMER_ROLLOUT_AUTHORIZED=NO
```
