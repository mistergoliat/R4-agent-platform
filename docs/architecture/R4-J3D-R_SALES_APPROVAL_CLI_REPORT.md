# R4-J3D-R — Sales Operator Approval CLI Report

Date: 2026-10-09 · Scope: §1 of the R4-J3D recovery instruction (operator approval CLI for the Sales pack) · Status: **PARTIAL** (read-only inspection delivered; approve/reject **BLOCKED** on trusted human identity)

Evidence labels: **SOURCE** = verified in code at `main` `76585b3` plus this slice; **LOCAL** = executed on the workstation against throwaway PostgreSQL databases; **NOT RUN** = not executed.

## 1. Outcome

| Command | State | Why |
|---|---|---|
| `production:sales:control approvals list` | **Delivered** (read-only) | Prints the open approval requests: task, channel, capability@version, argument hash and whether the hash still matches the arguments |
| `production:sales:control approvals show --request <id>` | **Delivered** (read-only) | Prints one open request with its **exact validated arguments**, the argument hash and a recomputed hash check |
| `production:sales:control approvals approve\|reject --request <id> --reason "…"` | **BLOCKED** (refused by design) | No trusted human identity can be obtained through a legitimate existing extension (§2). The command parses strictly and is then refused with `trusted_human_required` before any configuration or database is read |

The same two read-only commands and the same refusal exist in the isolated canary (`sales:canary approvals …`, see the canary report).

```
SALES_APPROVAL_CLI=PARTIAL
```

## 2. Why approve/reject stop here (stop condition of §1)

The instruction says: *"Si la identidad humana confiable no puede proporcionarse mediante una extensión legítima existente, detener esta parte y documentar el bloqueo."* The repository was checked for every possible source of a trusted human identity:

| Candidate | Finding (SOURCE) |
|---|---|
| `AppDependencies.humanContext` (the API's authentication seam) | It is a **seam with no implementation**. `apps/api/src/main.ts` calls `createPlatform(config, { logger })` without it, so every operator route answers `422 trusted_human_required` by design (`apps/api/src/app.ts`). |
| A production IAM, IdP, operator registry or token verifier in R4 | None exists. The roadmap defers it explicitly: *"(E) IAM productivo de operadores — Sin servicio de identidad; no simularlo"* (`docs/roadmap/R4_DELIVERY_ROADMAP.md` §4). ADR-021 §5: *"sin adapter la API refusa (no hay IAM productivo, y no se simula)"*. |
| Production-host access (the trust boundary of `production:sales:control`) | Owner decision **R4-I D-5 rejected** building a `TrustedHumanContext` from a host-declared `humanRef`: *"la administración productiva no finge ser un operador humano ni usa la API del operador"* (`docs/architecture/R4-I_PRODUCTION_CUTOVER_READINESS.md` §6). The control tooling attributes its acts to `platform:production-control`, which means "a host administrative action", **not a verified individual**. |
| The contract test that encodes D-5 | `tests/contract/live-ops-boundaries.test.ts` forbids `TrustedHumanContext`, `humanRef`, `respondHuman` and `takeOver` in the production-control files. Making `approve` work would require weakening this test. That was not done. |
| An operator name passed on the command line (`--as felipe`) | This would be an identity **declared unilaterally by the client**, which the instruction forbids. The parser rejects any extra argument (`unexpected argument: --as`, unit-tested). |
| The OS account on the EC2 host | It was not inspected, because SSH to EC2 is not authorized (§3 of the instruction). Even per-person OS accounts would be a **new** identity mechanism, not an existing R4 extension. Under D-5 that is an owner decision. |
| Quote Service principal registry | It holds service principals for the Quote API, in another repository. It is not a human identity, and R4 must not depend on it. |

**Conclusion.** No legitimate existing extension provides a verified human. Approving through SQL would bypass `TemporalRuntime.respondHuman`: there would be no `approval.approved` event, no wake and no Policy Engine re-evaluation. That is forbidden ("Sin escrituras SQL que simulen aprobaciones") and was not done.

## 3. What would unblock it (owner decision, not implemented)

Each option needs a separate decision. None of them changes the harness.

1. **An operator authentication adapter for the existing seam.** This is an implementation of `AppDependencies.humanContext` backed by a real identity provider, such as the company's Google Workspace OIDC with an allow-listed operator group. A trusted human would then decide through the existing `POST /v1/human-requests/:id/respond`. This is the path the architecture anticipates (ADR-021 §5).
2. **Revisit D-5 explicitly.** The owner could accept a per-person OS account on the production host (one Linux user per operator, SSH key per person, `sudo`-less) as the trusted identity, and map it to a `TrustedHumanContext` with only `approval.decide`. That would amend D-5 and the contract test above. It needs an ADR.
3. **Keep approvals out of R4** until the CRM/operator plane integrates (roadmap §4, "(I → plano CRM/operador)").

Until one of these exists, J3D's governed E2E cannot complete with a real human approval (`R4_GOVERNED_AGENT_E2E=BLOCKED`).

## 4. What was implemented (Sales pack only)

| File | Change |
|---|---|
| `agents/sales/src/production/approvals.ts` (new) | `ApprovalInspection`: `list()` and `show()` over structural ports (the Temporal Runtime's attention view and the production store's binding/task facts). `show()` refuses an invalid id, an unknown id, a non-approval and a decided request. It recomputes `fingerprint(validatedArguments)` and reports `hashVerified`. `APPROVAL_DECISION_BLOCKER` holds the refusal text. No writes and no operator context. |
| `agents/sales/src/cli/approval-inspection.ts` (new) | Host composition. It opens a pool, refuses a non-current schema (Core plus Sales), and reads open human requests through the persistence adapter's own temporal port inside one read transaction: the same read `TemporalRuntime.attention()` performs. The Sales pack may not import `@r4/task-runtime` (ESLint rule `no-restricted-imports` for `agents/sales/src/**`). |
| `agents/sales/src/production/control.ts` | Commands `approvals list`, `approvals show --request`, and `approvals approve\|reject --request --reason`; the last two are refused before anything is read. `runProductionControl(argv, env, io, deps?)` gains an optional `deps.openApprovals`, so existing callers are unaffected. `inspectApprovals()` produces the JSON output and is shared with the canary. |
| `agents/sales/src/cli/production-control.ts` | Injects `openApprovalInspection`. |
| `agents/sales/src/production/index.ts` | Re-exports `approvals.ts`. |

### Security guarantees

| Requirement of §1 | How it is met |
|---|---|
| Authenticated human operator through a trusted existing mechanism | **Not available**, so decisions are refused (§2). |
| Identity and authorization verified, not declared | No identity input exists. The parser rejects extra arguments. Both decision verbs return `trusted_human_required`. |
| Access restricted to the environment's approvals | Requires `R4_EXECUTION_MODE=production`, a Sales production profile and `R4_DATABASE_URL`. Reads process env only (never `.env`). Refuses a schema that is not current. |
| Inspect exact arguments before approving | `approvals show` prints `arguments.validated` exactly as the Policy Engine bound them, plus `arguments.hash` and `arguments.hashVerified`. |
| Persistent attribution and audit | No decision is made, so nothing needs attribution. Reads leave no trace. |
| Reuse runtime approval operations | Decision would go only through `TemporalRuntime.respondHuman`. It is not called, because no trusted context exists. |
| No SQL that simulates approvals | `approvals.ts` and `approval-inspection.ts` are now under the D-5 contract (`tests/contract/live-ops-boundaries.test.ts`, ADMIN list): no `insert`/`update`/`delete`, no `TrustedHumanContext`, `humanRef` or `respondHuman`. |
| No retroactive decisions or argument tampering | Nothing is decided. `hashVerified=false` exposes a request whose stored arguments no longer match their hash. The runtime itself re-checks `argumentsHash === fingerprint(command.validatedArguments)` at execution (`ActionRuntime`, unchanged). |
| No harness modification | None. See the change map. |

## 5. Tests (LOCAL)

| Test | Covers |
|---|---|
| `tests/unit/sales/canary-and-approvals.test.ts` (approval inspection, control parsing and refusal) | Only open approvals are listed, oldest first. Exact arguments are shown and the recomputed hash is checked (a tampered hash gives `false`). `show` refusals. Strict parsing, including a missing `--reason`, a blank reason and `--as`. `approve` and `reject` return exit code 1 with `trusted_human_required` and **empty stdout**, given an empty environment (so before any configuration or database access). `list` without the production declaration is refused. A missing inspection is refused without echoing the database URL. |
| `tests/integration/sales-canary.test.ts` "reaches REQUIRE_APPROVAL…" | A real `quote.create@2` approval request produced by the governed path. `list`/`show` show `capabilityId=quote.create`, version 2, `hashVerified=true` and the exact arguments. Both CLIs refuse `approve` and `reject`. Afterwards the request is still `requested`, there are **0** `approval.approved\|rejected\|cancelled` events, and Quote `createCalls=0`. |
| `tests/contract/live-ops-boundaries.test.ts` (ADMIN list extended) | The new files obey the D-5 boundary. |

Lint, typecheck and the full regression results are listed in the updated J3D report §8.
