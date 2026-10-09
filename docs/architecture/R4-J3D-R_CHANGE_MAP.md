# R4-J3D-R — Change Map

Date: 2026-10-09 · Base: `main` `76585b3` · Scope: Sales operator approval tooling (read-only), isolated Sales canary, documents.

## 1. Zero harness modification

```
git status --short -- packages apps adapters \
  agents/sales/migrations agents/sales/sales.agent.json agents/sales/sales.v4.agent.json \
  agents/sales/src/production/{composition,profile,profile-v2,profile-v3,profile-v4,bootstrap}.ts \
  agents/sales/src/cli/production.ts agents/sales/src/capabilities agents/sales/src/policy.ts   →  0 entries
```

| Component named by the instruction | Location | Changed |
|---|---|---|
| Agent Kernel | `packages/agent-kernel` | **No** |
| Policy Engine | `packages/policy-engine` | **No** |
| Capability Gateway | `packages/capability-runtime` | **No** |
| ActionExecutor | `packages/task-runtime/src/action-runtime.ts` | **No** |
| Task Runtime and Temporal Runtime | `packages/task-runtime` | **No** |
| Generic recovery | `packages/task-runtime`, `apps/worker`, `apps/scheduler` | **No** |
| Persistence, migrations | `packages/persistence-postgres` (Core migrations), `agents/sales/migrations` | **No** (no new migration; `0007` unchanged) |
| Gateway, API, worker and scheduler apps | `apps/*` | **No** |
| Adapters (WhatsApp, Catalog, Shipping, Quote, model) | `adapters/*` | **No** |
| Sales production profiles, composition, policy, definitions, capabilities | `agents/sales/src/production/{profile*,composition,bootstrap}.ts`, `policy.ts`, `*.agent.json`, `capabilities/` | **No**. The `sales-production@3` and `@4` fingerprints are unchanged. |

```
R4_HARNESS_MODIFIED=NO
```

## 2. Every changed file

### Sales tooling (code)

| File | Kind | Lines | What |
|---|---|---|---|
| `agents/sales/src/production/approvals.ts` | new | 99 | `ApprovalInspection` (read-only list/show over structural ports; hash re-check), `APPROVAL_DECISION_BLOCKER`, `OpenApprovalInspection` type |
| `agents/sales/src/cli/approval-inspection.ts` | new | 37 | Host composition of the inspection (pool, schema check, persistence adapter's temporal read port, production store) |
| `agents/sales/src/production/control.ts` | modified | +59/−3 | `approvals list|show` (read-only); `approvals approve|reject` refused before any read; optional `deps.openApprovals`; shared `inspectApprovals()` |
| `agents/sales/src/cli/production-control.ts` | modified | +4/−2 | Injects `openApprovalInspection`; doc line |
| `agents/sales/src/production/index.ts` | modified | +1 | Re-export `approvals.ts` |
| `agents/sales/src/cli/canary/isolation.ts` | new | 116 | Marker, name and foreign-traffic guards; `CanaryAdmission` |
| `agents/sales/src/cli/canary/channel.ts` | new | 84 | Synthetic canonical inbound; `CaptureOutboundAdapter` (`local-fake`, JSONL) |
| `agents/sales/src/cli/canary/runtime.ts` | new | 299 | Canary environment proof, `initCanary`, `sendSynthetic` (real `ChannelIngress`), `startCanaryRuntime` (production worker composition plus scheduler plus capture delivery plus watchdog), approvals, status |
| `agents/sales/src/cli/canary/command.ts` | new | 204 | Strict command parser and runner (`sales:canary`) |
| `agents/sales/src/cli/canary/index.ts` | new | 3 | Module index |
| `agents/sales/src/cli/canary.ts` | new | 19 | Process entry point |

### Wiring

| File | Change |
|---|---|
| `package.json` | Script `sales:canary` → `node agents/sales/dist/cli/canary.js` |
| `agents/sales/package.json` | Export `./canary` → `dist/cli/canary/index.js` |
| `vitest.config.ts` | Alias `@r4-sales/agent/canary` |

No dependency was added; `package-lock.json` is unchanged.

### Tests

| File | Kind | What |
|---|---|---|
| `tests/unit/sales/canary-and-approvals.test.ts` | new (9 tests) | Inspection semantics; control and canary parsing; decisions refused before any read; synthetic inbound; capture adapter |
| `tests/integration/sales-canary.test.ts` | new (10 tests) | Guards, init, ingress, governed path to REQUIRE_APPROVAL, test-only approve/reject, error, restart, foreign traffic; production fingerprint unchanged |
| `tests/contract/sales-canary-boundaries.test.ts` | new (6 tests) | Canary boundaries (no provider, no operator identity, no direct capability calls, no SQL writes, no `.env`, one script) |
| `tests/contract/live-ops-boundaries.test.ts` | modified (+2/−1) | The D-5 ADMIN boundary now also covers `production/approvals.ts` and `cli/approval-inspection.ts`. This is a **stricter** rule; no assertion was relaxed. |
| `tests/support/database.ts` | modified (+4/−3) | `createTestDatabase(prefix = 'r4_it')`, so tests can name a database `…canary…`. The default is unchanged. |

### Documents

| File | Kind |
|---|---|
| `docs/architecture/R4-J3D-R_SALES_APPROVAL_CLI_REPORT.md` | new |
| `docs/architecture/R4-J3D-R_SALES_ISOLATED_CANARY_REPORT.md` | new |
| `docs/architecture/QUOTE_W10_GMAIL_ACTIVATION_PROCEDURE.md` | new |
| `docs/architecture/R4-J3D-R_CHANGE_MAP.md` | new (this file) |
| `docs/architecture/R4-J3D_GOVERNED_AGENT_EC2_ACCEPTANCE_REPORT.md` | modified (§8 recovery update; status line) |

## 3. Excluded from the commits

- `.claude/settings.json`: a local change identical to upstream `76585b3`, stashed before the pull (`stash@{0}`); not part of this work.
- `artifacts/` (git-ignored): canary capture files, if any.
- Nothing in `MS-pesaschile-quote-service` was changed. W10 artifacts (the Compose override and the probe) are documented as host-only files and were not created.

## 4. Not done (gates)

- No push; no EC2 command; no SSH attempt by any other mechanism.
- No change to rollout, allowlist, kill switch or WhatsApp configuration.
- No approval decided by any means other than the in-test `TemporalRuntime.respondHuman` with an explicitly test-only operator.
