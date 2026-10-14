# R4 — J3E Cross-PC Handoff

Date: 2026-10-14 · Scope: state of R4 after J3E-A and J3E-B were merged into `main`, so work can resume from another workstation without unpublished local changes.

Next authorized work item: **none started.** The next proposed slice is `R4-J3E-C — Deterministic Commercial Offer & Production Safety` (§6). It needs the owner's explicit authorization before it starts (AGENTS.md: do not advance roadmap phases without explicit authorization).

## 1. Recover the project

```bash
git clone https://github.com/mistergoliat/R4-agent-platform.git
cd R4-agent-platform
git checkout main
git log --oneline -1          # must match the origin/main SHA reported for this handoff
npm ci
npm run build
npm run db:up                 # Docker Desktop must be running (DB-backed test projects)
```

On Windows, run Vitest from an uppercase drive-letter cwd (`E:\…`, not `e:\…`). From a lowercase cwd every file reports `(0 test)` with `Cannot read properties of undefined (reading 'config')`; that run is invalid.

Read before architectural changes: `docs/architecture/R4_AGENTIC_PLATFORM_MOTIVATION_AND_CONSTRAINTS.md`, `docs/architecture/R4_AGENTIC_PLATFORM_PRD_AND_ROADMAP.md`, `docs/adr/ADR-034-autonomous-quote-issuance.md`, `docs/adr/ADR-035-conversational-intent-verification.md`.

## 2. What `main` contains

`main` was consolidated from `origin/main` `ef5a354` (PR #7, J3D-R/J3D-S) with two `--no-ff` merges, history preserved:

| Merge | Branch | Commits |
|---|---|---|
| `6592987` | `r4-j3d-ec2-acceptance-evidence` | `d94b122` docs: J3D EC2 deployment evidence and Quote W10 closure |
| `29d0fc4` | `r4-j3e-b-independent-intent` (contains J3E-A) | `cc1e6c3` J3E-A code (ADR-034, `sales-production@5`) · `4fc071a` J3E-A EC2 evidence · `a841adb` J3E-B code (ADR-035, `sales-production@6`) · `51e98b8` J3E-B EC2 evidence |

No conflicts: the W10/J3D evidence touches two report files that the J3E line does not modify. The handoff document itself is the commit after `29d0fc4`.

Harness diff (`packages/`, `apps/`, `adapters/`) between `ef5a354` and the merged `main`: **empty**. Released migration `0007` is unchanged; `0008` and `0009` are new Sales migrations.

## 3. Technical state

| Slice | State |
|---|---|
| J3B/J3C | Quote V2 integrated into Sales (`sales-production@4`, `quote.create@2` under approval, migration `0007`). Synthetic E2E evidence on EC2. |
| J3D | Infrastructure on EC2 and the approval canary tooling (`sales:canary`, OIDC operator approvals, ADR-033). `0007` applied to production; `ef5a354` deployed under `@3`. **No real OIDC**: the owner has not created the Google OAuth client and registry, so the governed `@4` canary with human approval was not run. |
| J3E-A | `sales-production@5`: autonomous issuance through `quote.create@3` (`{previewId}` only), `quote.preview@1`, `workspace.update@2`, Sales definition v5, policy `sales-production-autonomous-policy@1`, migration `0008`. ADR-034 accepted **for canary only**. Validated on the EC2 canary (PC-000004). Customer intent is **model-attested** in `@5`. |
| J3E-B | `sales-production@6`: `quote.create@4` verifies the customer's confirmation from `ProductionStore.thread` with the closed grammar `r4-sales-confirmation-es-v1` and offer reference `Q-<previewId6>-<commercialVersion>`; `quote.preview@2`; Sales definition v6; total-units limit (`R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS`) and confirmation window (`R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS`); migration `0009` (single-use confirmation input, hashes only). ADR-035 accepted **for canary only**. Validated on the EC2 canary (PC-000005). |
| J3E-C | Not designed or implemented (§6). |
| J4 Customer Profile | Pending remediation. Customer is UNAVAILABLE to Sales: no verified recipient is known. |

Version pins that tests enforce: profiles `@1`–`@6` fingerprints, both policy hashes (`SALES_PRODUCTION_ACTION_POLICY` and the autonomous policy), `quote.create@2/@3/@4`, `quote.preview@1/@2`. `@3` profile fingerprint `847aa0ef…` is the one deployed on EC2. See `tests/contract/sales-profile-v3.test.ts`, `sales-quote-v2.test.ts`, `sales-autonomous-quote.test.ts`, `sales-confirmed-intent.test.ts`, `tests/unit/live-ops/mode-profile-rollout.test.ts`.

## 4. Evidence

| Item | Location / value |
|---|---|
| ADR-034 (autonomous issuance, canary only) | `docs/adr/ADR-034-autonomous-quote-issuance.md` |
| ADR-035 (conversational intent, canary only) | `docs/adr/ADR-035-conversational-intent-verification.md` |
| J3E-A report | `docs/architecture/R4-J3E_AUTONOMOUS_QUOTE_ISSUANCE_REPORT.md` (§15 EC2 canary) |
| J3E-B report | `docs/architecture/R4-J3E_B_INDEPENDENT_INTENT_VERIFICATION_REPORT.md` (§11 EC2 canary) |
| J3D report | `docs/architecture/R4-J3D_GOVERNED_AGENT_EC2_ACCEPTANCE_REPORT.md` (§10–§11) |
| W10 Gmail report | `docs/architecture/QUOTE_W10_GMAIL_E2E_REPORT.md` |
| PC-000004 (J3E-A) | 52 980 CLP, one issuance, real model `deepseek-v4-flash`, PDF SHA-256 verified (manifest = stored artifact = R4 receipt). Intent: model-attested. |
| PC-000005 (J3E-B) | One issuance after "Sí, emítela."; plain "Sí." refused as ambiguous. PDF SHA-256 verified. Intent: thread-verified (confirmation `inputId` = the customer's last real input). |

Both quotes live in the Quote V2 **integration** deployment (synthetic-only, Gmail disabled). Neither was delivered.

### Test results on the merged tree

Run on 2026-10-14 against merge `29d0fc4`, local Docker PostgreSQL:

| Step | Result |
|---|---|
| `npm run build`, `lint`, `typecheck` | exit 0 |
| `test:unit` | 72 files; 1 019 passed, 1 skipped (pre-existing POSIX-only skip) |
| `test:contract` | 25 files; 318 passed |
| `test:sales` / `test:shadow` | 29 / 5 passed |
| `test:integration` | Parallel run: 20 tests timed out at ~30 s (known contention flake, made worse by a concurrent `npm ci`). `--no-file-parallelism`: 34 files passed, 1 skipped; **422 passed**, 12 skipped (pre-existing). |
| `test:recovery` | 17 passed, **1 pre-existing failure** (below) |

The pre-existing failure was reproduced in a temporary worktree at `ef5a354`. It fails on the same assertion at line 48, received `registered: sales@3, sales@4` there and `registered: sales@3, sales@4, sales@5, sales@6` on the merged tree. The extra entries are the J3E definitions.

## 5. Operational state (EC2, unchanged by this merge)

- Production profile: **`sales-production@3`**. Production checkout at `ef5a354`. Pushing `main` does not deploy: there are no GitHub Actions workflows, webhooks, runners or environments, and EC2 deploys only through the manual operator runbook (J3D report §4: `git pull`, `npm ci`, build, `sales:migrate`, bootstrap, reviewed PM2 restart). The read-only deploy key "R4 production EC2" was last used on 2026-10-09 (the J3D deployment).
- WhatsApp rollout: unchanged (0 %, one allowlisted key).
- Gmail: disabled.
- Canary runtime: stopped. Separate checkout `~/r4-j3e-canary` at `a841adb`; canary database has `0008`, `0009`, `sales@5`, `sales@6`.
- Before any future canary run, cancel the canary task `j3eb-pos-1` (runnable after a disclosed replay error, J3E-B §12.3) and note that `j3eb-neg-1` is blocked with a handoff.
- Migrations `0008` and `0009` exist **only in the canary database**. Production has Sales up to `0007`.
- Rollout of `@5` or `@6` to customers: **not authorized** (`AUTONOMOUS_QUOTE_CUSTOMER_ROLLOUT_NOT_APPROVED`).

Host-side files (env files, OIDC store, logs) stay on the host and are not part of the repository.

## 6. Remaining blockers and the next slice

Production blockers for autonomous issuance:

1. **Contractual provenance of customer messages.** `ProductionStore.thread` does not expose the input's actor. `@6` is safe only under the `single-input-producer` topology (only the authenticated channel ingress creates customer inputs). A contract that carries the actor is needed.
2. **Deterministic integrity of the whole commercial offer.** `quote.create@4` binds only the reference and the total. Lines, quantities, shipping and validity are rendered by the model (J3E-B §11.6).
3. **Production commercial limits.** The canary limits (amount, units, lines, window) are not validated production limits.
4. **Structured-output observability and robustness.** The real model returned non-JSON twice at the offer step in one canary conversation, which became a handoff (J3E-B §11.4). `finishReason` and the parse failure class are not recorded.
5. **Autonomous document delivery over WhatsApp.** No delivery capability, no `quotes:delivery:email` principal, no verified recipient (J4), no WhatsApp media support, no `mismatch`/`unavailable` document policy (J3E-A §12).

### `R4-J3E-C — Deterministic Commercial Offer & Production Safety`

Starting point: the proposals in J3E-B §12, not implemented and each needing approval:

- **§12.1 deterministic offer rendering** (blocker 2): `quote.preview@3` returns a fixed, versioned offer block (`r4-sales-offer-es-v1`) rendered from the snapshot and its SHA-256; the agent includes it verbatim; `quote.create@5` checks the delivered offer contains that exact block, else `offer_not_presented`. It also removes the free-form offer generation where every format failure happened (blocker 4).
- **§12.2 bounded cost and robustness**: provider JSON mode validated on a canary, prompt caching, recording `finishReason` and parse failure class (a harness logging change, separate decision).
- Blockers 1, 3 and 5 need owner decisions (input-actor contract, production limits, delivery channel and J4).

Constraints that carry over: new behavior goes into **new** versions (profile, capability, definition, migration); never edit released versions or migrations; the pack-boundary test forbids `intent`/`stage` as identifiers followed by `:`/`=`; Sales may not import `@r4/task-runtime` or persistence outside `agents/sales/src/cli/`.

### Pre-existing test failure

`tests/recovery/production-bootstrap-process.test.ts` expects the bootstrap to register only `sales@3`. It has been stale since J2D added later Sales definitions and fails on `main` `ef5a354` without any J3E code. It was left untouched; fixing it is a separate, small change.

## 7. Other local work not in `main`

The worktree `R4-agent-platform-discover-i1` (branch `r4-discover-i1-catalog-discover`, `catalog.discover`, non-production) has unpublished commits and uncommitted edits on the original workstation. It is unrelated to J3E, was not reviewed for this merge and was **not** pushed. Publish it from that workstation before moving, if it is still needed.
