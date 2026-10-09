# R4-J3D-S — Trusted Human Approval Adapter: Closure Report

Date: 2026-10-09 · Base: branch `r4-j3d-r-sales-canary-tooling` (`d31b3a1`, on top of `main` `76585b3`) · Decision: ADR-033

Evidence labels: **SOURCE** = verified in code; **LOCAL** = executed on the workstation (Docker PostgreSQL, a local standards-conformant OIDC issuer, scripted model, fixture owners); **NOT RUN** = not executed.

```
TRUSTED_HUMAN_AUTH=PASS        (LOCAL, against a conformant OIDC issuer; live Google Workspace sign-in NOT RUN — needs the OAuth client and the operator registry)
SALES_APPROVAL_CLI=PASS        (LOCAL: production:sales:operator / sales:canary approvals approve|reject; host control still refuses by D-5)
GOVERNED_CANARY_LOCAL=PASS     (LOCAL: model → quote.create@2 → REQUIRE_APPROVAL → OIDC operator → Policy Engine → ActionExecutor → Quote V2 fixture → captured reply)
R4_HARNESS_MODIFIED=NO
R4_EC2_DEPLOYMENT=NOT_RUN
CUSTOMER_ROLLOUT_AUTHORIZED=NO
```

## A. Audit (Phase A)

| Question | Finding |
|---|---|
| ADR-021 §5 / D-5 / the `humanContext` contract | `AppDependencies.humanContext?: (request) => TrustedHumanContext \| null` is **synchronous**. The API then sets `correlationId` and validates the result with `trustedHumanContextSchema`. Without it, every human route answers `422 trusted_human_required`. D-5 forbids host administration from fabricating a human. `live-ops-boundaries` encodes that. |
| How the runtime receives and checks the operator | `POST /v1/human-requests/:id/respond` → `human(request)` → adapter → `TemporalRuntime.respondHuman`. That call enforces the scope (`human_scope_denied`), idempotency by `(request, responseKey)` with `humanRef` in the hash, a single terminal decision, expiry and the task lock. It records `temporal_events` with `actor_ref = humanRef`, wakes the task, and the next run's Policy Engine re-evaluates the same proposal with the approval evidence (`argumentsHash` against the command fingerprint). |
| CRM-Customer-360 authentication (read-only audit, `686874c`) | `/api/auth/login` accepts a single shared `ADMIN_BYPASS_TOKEN`. The `hub_session` cookie is `timestamp.HMAC-SHA256(timestamp)` with a 12-hour TTL and **no subject**. The `x-admin-bypass-token` header bypasses the session. |
| Can CRM sessions be reused safely? | **No.** They identify no person (a shared secret), they cannot be scoped per operator, and reusing them would make R4 depend on CRM state, which AGENTS.md forbids. |
| CRM reuse vs Google Workspace OIDC | OIDC gives a stable `sub`, asymmetric signatures with a published JWKS, a Workspace domain (`hd`) and freshness (`iat`). MFA and account lifecycle are governed by the Workspace admin. **Chosen**: ADR-033. |
| Trust boundary | The identity comes from Google (signature verified); authorization from the owner's operator registry (RBAC on `iss`+`sub`); integrity of the approved arguments from the database trigger plus the runtime's hash check. Host root is out of scope, as before; what is protected is the attribution. |

The extension point is sufficient. Its only constraint is that it is synchronous, which is resolved by loading the JWKS before composing the platform. No contract is missing.

## B. Implementation (Phase B): Sales pack only

| File | Role |
|---|---|
| `agents/sales/src/operator-auth/oidc.ts` | Configuration (fails closed; HTTPS or loopback only; Google requires `hd`). Discovery and JWKS. Synchronous `OidcVerifier.verify` with the full claim matrix (ADR-033 §3). |
| `agents/sales/src/operator-auth/registry.ts` | Operator registry: `(issuer, subject)` → `operatorRef` and roles (`approver` → `approval.decide`). Schema validated, duplicates refused, `disabled` honored, POSIX mode 0600 required, never keyed by email. |
| `agents/sales/src/operator-auth/human-context.ts` | `NonceLedger` (single use, 10-minute TTL) and the `humanContext` adapter, the only producer of a `TrustedHumanContext` (`oidc:<operatorRef>`). `diagnose()` gives specific errors without consuming the nonce. |
| `agents/sales/src/operator-auth/login.ts` | Loopback Authorization Code with PKCE S256, `state` (constant-time compare), `nonce`, one callback, `Connection: close` plus closing all connections, 5-minute timeout. |
| `agents/sales/src/cli/operator-approval.ts` | `decideApproval`: inspect (exact arguments and hash; the reviewed hash is required), sign in, verify and check RBAC, re-check, decide through the platform route with the adapter, read back the audit event. `whoAmI` supports provisioning. |
| `agents/sales/src/cli/operator-command.ts`, `cli/operator.ts` | `npm run production:sales:operator -- whoami \| approvals list\|show\|approve\|reject`. |
| `agents/sales/src/cli/canary/{command,runtime}.ts` | `sales:canary approvals approve\|reject --arguments-hash`, using the same flow after the canary isolation check (`assertCanaryReady`). |
| `agents/sales/src/production/approvals.ts` | The refusal text now points host operators to the operator command. Logic unchanged. |
| `package.json` | Script `production:sales:operator`. |

Not modified: Policy Engine, ActionExecutor, Task and Temporal runtimes, the generic approval implementation, API routes, migrations, profiles and composition. No dependency was added (`node:crypto`, `fetch`).

### Requirement → mechanism

| Requirement | Mechanism |
|---|---|
| Real authentication through OIDC | Authorization Code with PKCE against the issuer's discovery endpoints |
| Signature, issuer, audience, expiry, nonce | `OidcVerifier.verify` (RS256 only, JWKS `kid`, `iss`, `aud`/`azp`, `exp`/`nbf`/`iat` with 60 s skew, maximum authentication age, `nonce`, `email_verified`, `hd`) |
| Stable provider identifier bound to an authorized operator | Registry keyed on `(iss, sub)` |
| RBAC | Roles → human scopes. The CLI refuses without `approver`, and the runtime refuses (`human_scope_denied`) even if a context reached it. |
| `humanContext` only after trusted validation | The adapter returns null on any failure, so the API answers `trusted_human_required` |
| Decide on exact, persisted arguments | `--arguments-hash` must equal the stored hash, the stored hash must match the stored arguments, and both are re-checked after sign-in. The database refuses any change to the payload. The runtime re-checks the hash at execution. |
| Audit of actor, action, date and result | `temporal_events` written by the runtime (`actor_ref = oidc:<operatorRef>`, `event_type`, `occurred_at`, `response_key`, reason as `content`), read back and printed |
| Replay | Single-use nonce ledger, plus maximum authentication age, plus runtime idempotency |
| CSRF | `state` on the callback (constant-time compare), PKCE, one callback, loopback only, no cookies |
| Expired sessions | `exp`, `iat` maximum age, login timeout, nonce TTL |
| Reuse of the existing approval runtime | The existing route → `respondHuman` |

## C. Local canary (Phase C), with `tests/integration/sales-canary.test.ts`

The issuer is a local, standards-conformant OIDC provider (`tests/support/oidc-provider.ts`): discovery, RS256 JWKS, authorization with code and state, and a token endpoint enforcing single-use codes, client id, redirect URI and PKCE S256.

| Required validation | Scenario | Result |
|---|---|---|
| An authenticated operator can approve | `oidc:ops.approver` approves through `sales:canary approvals approve`. Status `approved`; the audit event has actor `oidc:ops.approver`, `approval.approved` and the reason. | PASS |
| A valid approval executes the action | After the decision: the Policy Engine re-evaluates, ActionExecutor issues `PC-000001`, receipt `succeeded`, the reply `Cotización PC-000001 emitida.` is captured locally | PASS |
| A rejection keeps `approval_rejected` | `reject` → `approval.rejected` by `oidc:ops.approver`; the agent observes `approval_rejected`; 0 create calls | PASS |
| An operator without permission cannot approve | Registered without `approver`: the CLI refuses with `operator_not_authorized`, and the route alone gives `human_scope_denied` | PASS |
| An invented identity is rejected | Attacker key under the issuer's `kid` → `oidc_signature_invalid`. HS256 → `oidc_algorithm_rejected`. An unregistered `sub` → `operator_not_registered`. Other client → `oidc_audience_mismatch`; other domain → `oidc_domain_mismatch`. No credential, plus an `x-operator` header, at the route → `trusted_human_required`. | PASS |
| An invalid or expired session is rejected | Stale `iat` → `oidc_authentication_stale`; past `exp` → `oidc_token_expired`. A replayed token (nonce consumed, or a foreign nonce) at the route → `trusted_human_required`. | PASS |
| An altered argument hash is rejected | A wrong `--arguments-hash` → `arguments_hash_mismatch` **before any sign-in** (0 authorization requests). An attempt to alter the stored arguments is refused by the database (`invalid human lifecycle transition`). The CLI also refuses `hashVerified=false` (unit test). | PASS |
| No duplicate quotes | A second approve → `approval_not_open`; further worker cycles issue nothing; the owner has 1 quote and 1 create call | PASS |
| No WhatsApp message | 0 non-synthetic outbound rows in the canary; the production testbed's WhatsApp fake recorded 0 new sends | PASS |

Unit tests (`tests/unit/sales/operator-auth.test.ts`): a 16-case negative claim matrix, discovery and configuration, the registry, the adapter (single use, foreign nonce, non-bearer, forged), the nonce TTL, the loopback login (success, CSRF state mismatch, denial, timeout) and command parsing.

Contract (`tests/contract/operator-auth-boundaries.test.ts`):
- Only the adapter builds a human context.
- It reads only `Authorization`, decides on `(iss, sub)` and consumes the nonce.
- RS256 only.
- Decisions go only through the route via `createPlatform({ humanContext })`, with no runtime call, no SQL and no CRM.
- D-5 control does not reach the operator sign-in and still refuses.
- Exactly one script.

## D. To enable it for real (owner, no code)

1. In the Google Cloud project of the Workspace, set the OAuth consent screen to **Internal** and create an OAuth client of type **Desktop app**. Configure `R4_OPERATOR_OIDC_ISSUER=https://accounts.google.com`, `R4_OPERATOR_OIDC_CLIENT_ID`, `R4_OPERATOR_OIDC_CLIENT_SECRET` and `R4_OPERATOR_OIDC_HOSTED_DOMAIN=<workspace domain>`.
2. Each operator runs `production:sales:operator whoami`. The owner adds the printed `issuer` and `subject` with `roles: ["approver"]` to the registry file (host, outside Git, `chmod 600`) and sets `R4_OPERATOR_REGISTRY_FILE`.
3. On EC2 (once the access gate is authorized), the operator connects with `ssh -L 8765:127.0.0.1:8765` and runs `approvals show`, then `approvals approve --arguments-hash <hash> --reason "…"` in the canary first.
4. Recommended: enforce 2-step verification for those accounts in the Workspace.

## E. Verification

LOCAL, workstation, Node 20.19, Docker PostgreSQL:

| Check | Result |
|---|---|
| `npm run build`, `npm run lint`, `npm run typecheck` | exit 0 |
| `test:unit` | 71 files; 974 passed, 1 skipped (registry file-mode test, POSIX only; skipped on Windows) |
| `test:contract` | 23 files, 297 passed |
| `integration` (`--no-file-parallelism`) | 30 files passed, 1 skipped; 372 passed, 12 skipped (pre-existing skips) |
| `test:sales` / `test:shadow` | 29 / 5 passed |
| `test:recovery` | 17 passed, **1 pre-existing failure**: `production-bootstrap-process.test.ts` expects only `sales@3`, but J2D `50ec670` added `sales.v4.agent.json`. The code, definitions and test are unchanged since `76585b3` (J3D report §8.3). |
| Built CLI | `node agents/sales/dist/cli/operator.js approvals approve …` without the production declaration → `production_mode_not_declared`, exit 1; unknown command → usage, exit 2 |

## F. Change map (this slice)

New:
- `agents/sales/src/operator-auth/{oidc,registry,human-context,login,index}.ts`
- `agents/sales/src/cli/{operator-approval,operator-command,operator}.ts`
- `tests/support/oidc-provider.ts`
- `tests/unit/sales/operator-auth.test.ts`
- `tests/contract/operator-auth-boundaries.test.ts`
- `docs/adr/ADR-033-operator-identity-oidc-approvals.md`
- this report

Modified:
- `agents/sales/src/cli/canary/command.ts` (approve/reject through the OIDC flow)
- `agents/sales/src/cli/canary/runtime.ts` (`assertCanaryReady`)
- `agents/sales/src/production/approvals.ts` (refusal text and doc only)
- `package.json` (script)
- `tests/integration/sales-canary.test.ts` (Phase C scenarios; the old canary refusal assertion now expects the operator flow)
- `tests/unit/sales/canary-and-approvals.test.ts` (same)
- `docs/architecture/R4-J3D_GOVERNED_AGENT_EC2_ACCEPTANCE_REPORT.md` (§9)
- `docs/architecture/R4-J3D-R_SALES_APPROVAL_CLI_REPORT.md` (superseded note)

Harness paths (`packages/`, `apps/`, `adapters/`, migrations, profiles, composition, policy, capabilities, definitions): **0 changes**. No dependency was added and `package-lock.json` is unchanged. Not pushed; nothing deployed.
