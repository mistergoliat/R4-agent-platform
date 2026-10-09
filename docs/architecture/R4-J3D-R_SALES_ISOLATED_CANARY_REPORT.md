# R4-J3D-R — Isolated Sales Canary Report

Date: 2026-10-09 · Scope: §2 of the R4-J3D recovery instruction (synthetic-input runner with isolated execution) · Status: **PASS for isolation (LOCAL)**. The governed E2E stays **BLOCKED** on human approval (see the approval CLI report).

Evidence labels: **SOURCE**, **LOCAL** (workstation, throwaway PostgreSQL, scripted model, fixture owners), **NOT RUN**.

This is test tooling. **It is not a governed acceptance.** It reaches the point where a human must decide; it cannot decide.

## 1. Outcome

```
SALES_CANARY_ISOLATION=PASS            (LOCAL: dedicated marked database, 10/10 integration scenarios)
R4_GOVERNED_AGENT_E2E=BLOCKED          (no trusted human approval; real model and owners NOT RUN)
R4_HARNESS_MODIFIED=NO
```

## 2. Command

`npm run sales:canary -- <command>` (`agents/sales/src/cli/canary.ts` → `cli/canary/command.ts`). Reads the process environment only (never `.env`). Exit codes: 0 done, 2 invalid command, 1 refused or failed. Database URLs are never echoed.

| Command | What it does |
|---|---|
| `init` | On an **empty** database whose name contains `canary`: writes the marker, applies Core and Sales migrations, registers the Sales definitions through the Agent Registry, and enables global autonomy **in this database** (attributed to `platform:sales-canary`). Idempotent; resumable after a partial run. |
| `status` | Isolation verdict, autonomy, task, human-request and outbound counts. No conversation text. |
| `identity-key --conversation <name>` | The conversation key to put in the canary environment's `R4_PROD_ROLLOUT_ALLOWLIST`. |
| `send --conversation <name> --text "<text>"` | One synthetic inbound through the **real** `ChannelIngress.ingest`. |
| `run` | Canary worker, scheduler and local outbound capture until SIGINT or SIGTERM. Stops with exit 1 if isolation stops holding. |
| `approvals list` / `approvals show --request <id>` | Read-only (shared with `production:sales:control`). |
| `approvals approve\|reject …` | **Refused** (`trusted_human_required`). |

### Environment

| Variable | Rule |
|---|---|
| `R4_CANARY_DATABASE_URL` | Required. The **only** database the canary touches. |
| `R4_DATABASE_URL` | Never used as a target. If set and equal to the canary URL (same host, port and database), the canary refuses (`canary_shares_production_database`). For `run`, it is overwritten with the canary URL before the worker and scheduler configurations are loaded. |
| `R4_EXECUTION_MODE=production`, `R4_PROD_POLICY_PROFILE=sales-production@4` | Required. Any other profile is refused. |
| `R4_PROD_ROLLOUT_PERCENT`, `R4_PROD_ROLLOUT_ALLOWLIST`, `R4_PROD_IDENTITY_HASH_KEY` | The canary's own rollout. Use `0` with an allowlist of synthetic keys. `send` refuses a non-eligible synthetic conversation instead of creating a held task. |
| `R4_PROD_ALLOW_NETWORK=true`, `R4_MODEL_*`, `R4_CATALOG_*`, `R4_SHIPPING_*`, `R4_QUOTE_MODE=real`, `R4_QUOTE_*` | Required by `run` (real model and owners). Composition fails closed without them. |
| `R4_EXEC_MAX_WRITE_ACTIONS` | At least 2 for a quote flow (workspace update plus `quote.create`). |
| `R4_RECONCILIATION_*` | Required by the scheduler (Quote V2 reconciliation). |
| `R4_CANARY_WORKER_ID`, `R4_CANARY_SCHEDULER_ID`, `R4_CANARY_CAPTURE_FILE` | Optional. Default capture path: `artifacts/sales-canary/<canaryId>/outbound.jsonl` (git-ignored). |

## 3. Topology

```
                 synthetic inbound (sales:canary send)
                               │  CanonicalInbound: channel r4-synthetic,
                               │  account sales-canary, conversation synthetic:<name>,
                               │  event synthetic:<uuid>, metadata {synthetic:true, canaryId}
                               ▼
  ┌─────────────────────── R4_CANARY_DATABASE_URL (marked: r4-sales-canary:v1:<id>) ───────────────────────┐
  │ ChannelIngress.ingest (real) → inbound_events → binding (rollout of the CANARY env) →                   │
  │ Sales task via salesConversationTaskFactory (service requester ⇒ provisional; pinned sales@4) → input   │
  │                                                                                                         │
  │ sales:canary run (one OS process, three components, each with its own pool, all on this database):     │
  │   • worker    = createWorkerPlatform(composeSalesProductionWorker(@4).bindings,                         │
  │                                       admission = CanaryAdmission(isolation ∧ autonomy controls))       │
  │                 real model · Catalog · Shipping · Quote V2 · SALES_PRODUCTION_ACTION_POLICY ·            │
  │                 ActionRuntime/Policy Engine · persistence · ADR-028 recovery (all unchanged)            │
  │   • scheduler = createSchedulerPlatform (WAIT_UNTIL, expiries, Quote V2 reconciliation dispatch)        │
  │   • delivery  = OutboundDeliveryRuntime + DeliveryDispatcher (real lifecycle), single adapter:         │
  │                 CaptureOutboundAdapter (channel r4-synthetic, bindingKind local-fake) → JSONL file       │
  │   • watchdog  = isolation re-proved every 10 s; on violation the process stops (exit 1)                 │
  └─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                          ▲ human approval: NOT POSSIBLE (no trusted identity)

  Production database (R4_DATABASE_URL), live @3 worker, gateway and dispatcher: never connected to.
```

**Deviation from the production topology.** In production the gateway, worker and scheduler are separate OS processes. The canary hosts the worker, scheduler and delivery in one process for operability. Each still uses its own composition root and pool, and none embeds another's code. The isolation boundary is the database, not the process.

## 4. Isolation layers (SOURCE: `agents/sales/src/cli/canary/isolation.ts`)

1. **Separate database.** `claimRunnableTask` is not partitioned by agent, version or profile (J3D §5). Isolation therefore comes from the database: tasks, runs, leases, schedules, inbound and outbound rows exist only there. No production worker, gateway or dispatcher can claim them, and the canary can never claim theirs.
2. **Marker.** `COMMENT ON DATABASE … 'r4-sales-canary:v1:<canaryId>'` is written once, and only on an **empty** database. It uses no migration, table or harness state. A production database never carries it.
3. **Name.** The database name must contain `canary`. This is an independent guard against a mistyped URL.
4. **No foreign traffic.** There must be zero bindings, inbound events or outbound messages on any channel other than `r4-synthetic`. This is checked by every command, **before every worker claim** (`CanaryAdmission` on the worker's public `admission` seam), and by the watchdog of `run`.
5. **No provider.** The only outbound adapter is `local-fake`. A production gateway refuses it for a REAL channel (`createGatewayPlatform` requires `bindingKind: real`). The canary never imports a channel adapter or the gateway composition (contract test).
6. **Separate configuration.** The canary database comes from `R4_CANARY_DATABASE_URL` only. The canary's rollout, autonomy and allowlist are its own and live in its own database. Production rollout, allowlist and channel configuration are not read or changed.

## 5. What is real and what is synthetic

| Element | Canary |
|---|---|
| Ingress | Real `ChannelIngress` (dedupe, binding, rollout eligibility, task factory, canonical input); synthetic transport |
| Task identity | Real production task factory: `requestedBy = service:sales-channel-ingress`, so `provisional`; pinned Sales definition v4 |
| Agent, kernel, context, policy, ActionExecutor, persistence, recovery | Real, unchanged: the production worker composition for `sales-production@4` |
| Model, Catalog, Shipping, Quote V2 | Real in `run` (fails closed without configuration). **Fixtures and a scripted model in tests only.** |
| Human approval | **Not available** (blocked) |
| Outbound | Real delivery lifecycle; capture to a local JSONL file; never a provider |
| Scheduler and reconciliation | Real generic scheduler |

## 6. Tests (LOCAL)

`tests/integration/sales-canary.test.ts`, 10/10 passed. "Production" is a `LiveOpsTestbed` database: a production gateway and worker composition with a real WhatsApp-shaped conversation and a runnable task. Each scenario asserts the production database's durable fingerprint is **byte-identical** before and after. The fingerprint covers the marker, the migration ledger, tasks with status and `updated_at`, runs, bindings, inbound, outbound and controls.

| Scenario | Result |
|---|---|
| Environment: `@3` refused; missing URL refused; canary URL equal to `R4_DATABASE_URL` refused; no production declaration refused | PASS |
| `init`/`send` against the production database refused (`canary_database_name`); a non-empty unmarked `canary`-named database refused (`not_a_canary_database`, `canary_marker_missing`) and left unmarked | PASS |
| `init` marks, migrates (Core plus Sales 0006, 0007), registers Sales and enables autonomy (attributed to `platform:sales-canary`); re-init is a no-op | PASS |
| `send`: a non-eligible conversation is refused; an eligible one opens a `sales@4` task, requester `service/sales-channel-ingress`, binding on `r4-synthetic` with `sales-production@4`; a replayed event id gives `duplicate` | PASS |
| Governed path: catalog read → workspace update → `quote.create@2` → **REQUIRE_APPROVAL** (task `requires_approval`). Inspection shows the exact arguments with `hashVerified=true`. Both CLIs refuse `approve` and `reject`. 0 decision events; Quote `createCalls=0`. | PASS |
| **Test-only operator** (in-test `TemporalRuntime.respondHuman`, as other approval tests do; never a CLI): approve → Policy Engine re-evaluation → ActionExecutor → Quote V2 fixture issues `PC-000001`, receipt `succeeded` → reply captured locally, outbound `accepted` with a `capture:` id | PASS |
| **Test-only operator**: reject → the agent observes `approval_rejected`; nothing issued; reply captured | PASS |
| Error: a retryable model failure fails run 1; ADR-028 recovery run 2 completes inside the canary; production unchanged | PASS |
| Restart: inbound arrives while the canary is down and is served after restart. A production worker run then serves production's own conversation and leaves the canary database's fingerprint unchanged. | PASS |
| Foreign traffic: a `whatsapp` binding appears in a canary database. Admission refuses (`canary_isolation_violated`) and a runnable synthetic task is not claimed. `send`, `approvals` and `status` refuse or report it. A running canary stops (`violation` resolves). | PASS |

Unit (`tests/unit/sales/canary-and-approvals.test.ts`): command parsing, the refusal before any read, the synthetic inbound is canonical and marked synthetic, and the capture adapter is `local-fake` and records to JSONL.

Contract (`tests/contract/sales-canary-boundaries.test.ts`): no channel adapter or gateway composition. No operator identity or decision. The agent runs only through `composeSalesProductionWorker` plus `createWorkerPlatform` with `CanaryAdmission`, and no capability is registered, executed or reconciled directly. No SQL writes other than the marker. No `.env`. `R4_DATABASE_URL` is used only to refuse or replace. Exactly one script.

**Not exercised:** SIGKILL of a canary process mid-run. Lease-expiry recovery is the generic harness behavior already covered by `tests/recovery`, and the canary adds nothing to it.

## 7. Using it on EC2 (NOT RUN; requires the EC2 gate)

1. Create a dedicated database whose name contains `canary` (for example `r4_sales_canary`). It can be a new database in the R4 PostgreSQL instance, owned by a role that may `COMMENT ON DATABASE`, or a separate container. Same instance means shared CPU and disk, but not shared tables or queues. The owner decides.
2. Prepare a canary environment file outside Git: `R4_CANARY_DATABASE_URL`, `sales-production@4`, its own identity hash key and allowlist, the model, Catalog, Shipping and Quote settings (`R4_QUOTE_BASE_URL=http://127.0.0.1:4020`, the R4 Quote principal token), `R4_EXEC_MAX_WRITE_ACTIONS`, and `R4_RECONCILIATION_*`.
3. Run `sales:canary init`, `identity-key`, then add the key to the canary allowlist.
4. Start `sales:canary run` (a separate PM2 app or a foreground session), then run `send`.
5. Run `approvals list|show` to inspect the `quote.create@2` request. **Stop there**: a decision needs a trusted operator identity (approval CLI report §3).
6. Afterwards, drop the canary database. Quotes it issued would be real rows in the Quote V2 *integration* deployment, which is synthetic-only and has Gmail disabled.
