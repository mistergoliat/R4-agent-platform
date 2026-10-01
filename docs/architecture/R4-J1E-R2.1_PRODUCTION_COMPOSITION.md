# R4-J1E-R2.1 — Production composition correction (runbook)

Status: **deployed** (R4-J1E-R2.1, merged in `3b3cd8d`). The production state below was reported by the
operator on 2026-10-01; it is recorded here, not re-verified from this repository.

| Item | Production state (2026-10-01) |
|---|---|
| Operator gate (§B) | **Completed** |
| Stale Oxford task `01a0f85e-80e7-7bda-aa19-73193021d287` | **Cancelled** with `production:sales:control tasks cancel` (its overdue wake `01a0f861-4405-72e5-b2f0-6f0e2f36db6c` was cancelled with it) |
| `r4-scheduler` | **Active** next to `r4-channel-gateway` and `r4-sales-worker` |
| Reconciliation policy | `maxAttempts=5`, `initialBackoffMs=5000`, `maxBackoffMs=60000`, `deadlineMs=300000` |
| Oxford `response_authority_contradiction` | **Diagnosed: false positive** of the response-authority heuristics (see "Oxford diagnosis" below) |
Scope: production composition correction. It is not a redesign of the temporal runtime (ADR-021/022
unchanged) and it does not touch Catalog, catalog-service or the Sales evidence rules.

## Why

> **R4-J1E-R2.2 note.** The response-authority deferral described below no longer exists: ADR-031 is
> superseded, a valid `respond` is sent as decided and closes the turn. The scheduler remains a
> required production process for agent WAIT_UNTIL, human request expiries, retry release and
> reconciliation dispatch. The operator gate below still applies to the overdue production task.

J1E-R2 (ADR-031 §7) defers a draft whose owner evidence is close to expiry: it records the draft
`refused` (`response_authority_deferred`) and suspends the run on a platform `WAIT_UNTIL`, which
creates a durable `schedules` row (`kind = wake`). The only consumer of schedules is the scheduler
process (`apps/scheduler`, `TemporalRuntime.claimSchedule`). Workers claim only `pending`/`running`
tasks. Production ran only the gateway and the worker, so the wake never fired and the task stayed
`waiting` (production task `01a0f85e-80e7-7bda-aa19-73193021d287`, schedule
`01a0f861-4405-72e5-b2f0-6f0e2f36db6c`, due `2026-10-01T16:51:59.640Z`).

Separately, a run that had already sent its safe degradation could defer a new commercial draft.
The kernel now checks the run's durable recovery budget before any revalidation (ADR-031 §11).

## Topology

Before (80f63ff deployment):

```
Meta ─► r4-channel-gateway ─► PostgreSQL ◄─ r4-sales-worker ─► model / Catalog
                                   │
                                   └── schedules(kind=wake, pending) ── nobody claims ──► task waits forever
```

After (three independent processes; they share only PostgreSQL):

```
Meta ─► r4-channel-gateway ─────► PostgreSQL ◄──────── r4-sales-worker ─► model / Catalog (v2)
        (webhooks, outbound)          ▲                 (claims, kernel, authority)
                                      │
                                 r4-scheduler  claimSchedule → fireSchedule → wake
                                 (time only: no model, no capabilities)
```

| PM2 process | Command | Owns |
|---|---|---|
| `r4-channel-gateway` | `npm run production:sales:gateway` | provider webhooks, canonical inbound, outbound dispatch |
| `r4-sales-worker` | `npm run production:sales:worker` | task claims, kernel, model, capabilities (no response judge since R4-J1E-R2.2) |
| `r4-scheduler` | `npm run start:scheduler` | due schedules: WAIT_UNTIL wake, expiries, retry release, reconciliation dispatch |

Declared in code by `SALES_PRODUCTION_PROCESSES` (`agents/sales/src/production/topology.ts`) and
reported by `production:sales:plan`. `tests/contract/production-topology.test.ts` fails if a process is
dropped.

## Scheduler configuration (`apps/scheduler/src/config.ts`)

| Variable | Required | Default |
|---|---|---|
| `R4_DATABASE_URL` | yes | — |
| `R4_RECONCILIATION_MAX_ATTEMPTS` (≥ 1) | **yes, no default** | — |
| `R4_RECONCILIATION_INITIAL_BACKOFF_MS` (≥ 0) | **yes, no default** | — |
| `R4_RECONCILIATION_MAX_BACKOFF_MS` (≥ 0) | **yes, no default** | — |
| `R4_RECONCILIATION_DEADLINE_MS` (≥ 1) | **yes, no default** | — |
| `R4_SCHEDULER_ID` | no | `scheduler-<host>-<pid>` |
| `R4_SCHEDULER_LEASE_MS` | no | `30000` |
| `R4_SCHEDULER_POLL_MS` | no | `1000` |
| `R4_LOG_LEVEL`, `R4_DB_POOL_MAX` | no | `info`, `4` |

The reconciliation policy is a governance decision (ADR-022 §5). **Production values (decided and set
2026-10-01):**

```bash
R4_RECONCILIATION_MAX_ATTEMPTS=5
R4_RECONCILIATION_INITIAL_BACKOFF_MS=5000
R4_RECONCILIATION_MAX_BACKOFF_MS=60000
R4_RECONCILIATION_DEADLINE_MS=300000
```

The README values are a local example and the shadow policy is a test policy; neither is the
production policy. Without these variables the process refuses to start:
it exits with code 1 and logs `service.boot_failed`, naming each missing variable
(`tests/recovery/production-scheduler-process.test.ts`). `production:sales:plan` reports the same
check as `scheduler.configuration`.

`apps/scheduler/src/main.ts` loads `.env` from its working directory. It reads only the variables
above, and refuses to start if the schema is not current.

## Deployment runbook

Run every step on the production host, in the R4 deployment directory. Nothing in this repository
runs it.

### A. Preflight

1. `git rev-parse HEAD`: record the currently deployed SHA (expected `80f63fff72cf36edafc9f4875696c53450a03fa3`).
2. `pm2 describe r4-sales-worker` and `pm2 describe r4-channel-gateway`: record how the two existing
   processes are started (script or `npm` form, working directory, environment source). Start
   `r4-scheduler` the same way in step E.
3. Record the governance decision for `R4_RECONCILIATION_*`. Add the four variables to the deployment's
   `.env` (values reported only as PRESENT/MISSING in any evidence).

### B. PRE-DEPLOY OPERATOR GATE (mandatory before `r4-scheduler` starts) — **COMPLETED 2026-10-01**

> Done: the stale Oxford task was cancelled with the existing production control before
> `r4-scheduler` started. Kept below as the procedure for any future first start of a scheduler.

**Do NOT start `r4-scheduler` while task `01a0f85e-80e7-7bda-aa19-73193021d287` is active.** Its
wake `01a0f861-4405-72e5-b2f0-6f0e2f36db6c` is already overdue, so a scheduler would claim it at once
and wake a run that resolves an hours-old Oxford draft. This change makes that draft refused with no
Catalog READ and no outbound, because the run had already degraded. The gate is still mandatory: the
code does not decide what happens to a stale production conversation.

1. Retire the task with the existing production control. The CLI reads the process environment only
   (never `.env`), so export the deployment environment first:

   ```bash
   set -a; . ./.env; set +a
   npm run production:sales:control -- tasks cancel --task 01a0f85e-80e7-7bda-aa19-73193021d287 --reason "R4-J1E-R2.1: stale deferred response; retire before starting r4-scheduler"
   ```

   Expected output: `cancelled.outcome` and `taskStatus: "cancelled"`. The cancellation also cancels
   the task's pending schedules in the same transaction (`TemporalRuntime.cancelTaskByPlatform`).
2. List every schedule a scheduler would claim right now:

   ```bash
   R4_EXECUTION_MODE=production npm run production:sales:plan
   ```

   `scheduler.dueSchedules` must be `[]`. If any remain, **stop**: each belongs to a task the operator
   must decide on (the same control) before the scheduler starts.

### C. Build

```bash
git fetch && git checkout <J1E-R2.1 SHA>
npm ci
npm run build
```

### D. Migrations

This change adds no migration (schema head stays `0010_platform_step_decisions`). Confirm the schema
is current. Both commands are idempotent:

```bash
npm run db:migrate
npm run sales:migrate
```

### E. Start / restart the processes

1. `pm2 restart r4-channel-gateway --update-env` and `pm2 restart r4-sales-worker --update-env` (new code).
2. Start the scheduler with the same form recorded in A.2. With the `npm` form:

   ```bash
   pm2 start npm --name r4-scheduler -- run start:scheduler
   pm2 save
   ```

### F. Verify the scheduler

- `pm2 logs r4-scheduler --lines 50`: one `service.started` with its `schedulerId`, `leaseMs` and
  `pollMs`; no `service.boot_failed`; no repeated `scheduler.cycle.failed`.
- `R4_EXECUTION_MODE=production npm run production:sales:plan`: `processes` lists the three
  processes, `scheduler.configuration.usable` is `true`, and `scheduler.dueSchedules` is `[]`.
- `pm2 ls`: `r4-channel-gateway`, `r4-sales-worker` and `r4-scheduler` are online with stable restart counts.

### G. Temporal smoke (requires explicit E2E authorization)

No production command triggers a deferral on demand. The temporal path is observed in an authorized
E2E conversation (allowlisted identity). For any task that deferred a response, confirm read-only, in
`temporal_events`, the ordered sequence `schedule.created` → `schedule.claimed` (actor =
`R4_SCHEDULER_ID`) → `schedule.fired` → `task.wait.completed` (`resolution = timer`) → `task.woken`,
then a new run. That run's first steps are a platform `read_capability` (`catalog.get_product_context`)
and a platform `respond` (`recorded` or `refused`).

### H. Verify outbound

For that task: every `outbound_messages` row with a provider message id (accepted), then delivered or
read; no duplicate outbound for one response step; no outbound for `refused` steps. A degraded run
shows exactly one safe-degradation outbound and no later deferral (`response_authority_deferred`
after `response_authority_degraded` must not exist in the same run).

## Oxford diagnosis (closed)

**FALSE POSITIVE of the response-authority heuristics; the agent's draft was correct.** The exact
production draft ("La Colchoneta Oxford Negro/Rojo 100x50x5cm de 2da Selección (FICLE3-SU55) figura a
$6.296 CLP, con descuento sobre su precio normal de $13.990 CLP — pero es un precio de referencia: hoy
aparece sin stock, así que no se puede pedir. …La versión nueva … sí está disponible y sellable a
$13.990 CLP.") replayed against the R4-J1E-R2.1 code with Catalog P2340 (`not_offerable`,
`not_sellable/out_of_stock`, $6.296, regular $13.990) and P872 (`offerable`, `sellable/in_stock`,
$13.990) is refused with exactly:

> `response_authority_contradiction` — "$6.296 refers to P2340 … which Catalog reports
> not_sellable/out_of_stock: say it is currently not available (or omit it); never present it as available."

Two surface heuristics produced it. The negation "sin stock" sits in the same sentence but *after* the
next amount ($13.990), outside the $6.296 "amount window". That next amount matches P872's price, so the
"product block" treated the sentence as being about another product and never looked for the negation.
Resolution: R4-J1E-R2.2 removed response authority from the `respond` path (ADR-031 superseded). The
exact draft is a permanent regression (`tests/integration/pure-agent-execution.test.ts`): it is sent as
drafted, once.

## Out of scope (unchanged)

Catalog, catalog-service and the model's capabilities are untouched. The Sales evidence rules
(`commercial-evidence.ts`, `availability-wording.ts`) were later removed by R4-J1E-R2.2.
