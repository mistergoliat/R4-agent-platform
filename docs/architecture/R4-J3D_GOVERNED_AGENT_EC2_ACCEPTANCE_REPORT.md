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
