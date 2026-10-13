# R4-J3E — Autonomous Quote Issuance Report

Date: 2026-10-13 · Branch: `r4-j3e-autonomous-quote-issuance` (from `main` `ef5a354`), **not committed, not pushed, not deployed** · Decision: ADR-034 (proposed)

Evidence labels: **SOURCE** = verified in code; **LOCAL** = executed on the workstation (Docker PostgreSQL, fixture owners, scripted stand-in model); **EC2** = executed on the host; **NOT RUN**.

```
R4_HARNESS_MODIFIED=NO
R4_AUTONOMOUS_QUOTE_POLICY=PASS          (LOCAL: Policy Engine allow/autonomous for quote.create@3 only; @2 still REQUIRE_APPROVAL under every policy)
R4_QUOTE_PREVIEW=PASS                    (LOCAL)
R4_AUTONOMOUS_QUOTE_CAPABILITY=PASS      (LOCAL: quote.create@3 over the unchanged Quote V2 machinery)
R4_COMMERCIAL_GUARDS=PASS                (LOCAL; customer intent is model-attested, see §5.3)
R4_LEGACY_PROFILES_UNCHANGED=YES         (@1–@4 fingerprints and SALES_PRODUCTION_ACTION_POLICY hash = main; @3 = 847aa0ef… deployed on EC2)
R4_AUTONOMOUS_CANARY_E2E=NOT_RUN         (EC2; the same agentic path PASSES in the isolated canary runtime LOCALLY with a scripted model, §9)
R4_PRODUCTION_PROFILE=@3
R4_WHATSAPP_ROLLOUT_UNCHANGED=YES
QUOTE_SERVICE_UNCHANGED=YES
CUSTOMER_ROLLOUT_AUTHORIZED=NO
```

## 1. Architectural preflight (audit)

| Component | Finding (SOURCE, `main` `ef5a354`) |
|---|---|
| `quote.create@2` | `agents/sales/src/capabilities/quote-v2.ts`. IRREVERSIBLE_WRITE, `approvalPolicy: required` (defense in depth), `reconcile_before_retry`. The first attempt re-verifies every model-stated commercial fact against the workspace, Catalog, Shipping and the Quote V2 arithmetic, then freezes the CreateQuoteRequest under the execution key (`0007`). The send, settlement (201/202, totals, correlation, PDF SHA-256) and reconciliation by idempotency lookup are generic over the frozen body. |
| `SALES_PRODUCTION_ACTION_POLICY` | `quote.create: require_approval, provisional, requireEvidence`; `workspace.update: allow`; risk classes = platform default. A single object is used for every profile. |
| `sales-production@3` / `@4` | `@3`: Catalog and Shipping REAL, Quote UNAVAILABLE (deployed). `@4`: `@3` + Quote REAL through `quote.create@2` with REQUIRE_APPROVAL. Both pin Sales definition v4. |
| Policy Engine | `packages/policy-engine/src/engine.ts`. Rules are keyed by `capabilityId`, not version. **But** the engine also enforces the capability's own `approvalPolicy` (`capability.approval_policy`) before the rule's autonomy. So a version with `approvalPolicy: none` can be `allow` under a profile-specific policy, while `@2` keeps requiring a human under any policy. |
| ActionExecutor | `packages/capability-runtime/src/action-executor.ts`. Runs only commands with an ALLOW decision. `WriteHandlerContext` = execution key, trusted context, attempt, signal. **No proposal or `evidenceRefs` reach the handler.** |
| Idempotency and reconciliation | Platform execution key = Quote `Idempotency-Key`. The frozen body is resent byte-identical. `not_found` is final only after `QUOTE_V2_TIMEOUT_MS + 30 s`. Never a new key for one command. |
| SalesWorkspace | Versioned jsonb state; explicit operations; no prices. **No persisted shipping choice** (J3B §432: the chosen offer travelled in the approved proposal). |
| Catalog J1 / Shipping J2 | Item context per quantity tier (price, tax, sellability, stock, freshness); order-basis Shipping quote (NET; R4 derives gross); no owner validity for Shipping (R4 bound 15 min). |
| ADR-029 and later | ADR-029 fixed `quote.create` REQUIRE_APPROVAL; J3B/J3D/ADR-033 built the human approval path. |
| Seams for the customer's own words | Inbound text lives in Core `task_inputs`/`memory_entries`. `ContextSource` (ExecutionFacts), `ConversationTaskFactory` (open hook only) and `WorkerBindings` expose none of it to the pack. |

**Verdict.** Autonomous issuance fits existing extension points: a capability version, a profile, a profile-selected action policy (public seam), a workspace version, a Sales migration and a definition version. **No harness change is required.** One guarantee cannot be made deterministic without a new platform seam: verifying customer intent against the literal inbound text (§5.3).

## 2. ADR

`docs/adr/ADR-034-autonomous-quote-issuance.md` (proposed). It supersedes ADR-029's REQUIRE_APPROVAL **only** for `quote.create@3` in `sales-production@5`.

## 3. Profile, policy and capabilities

| Artifact | Content |
|---|---|
| `sales-production@5` (`production/profile-v5.ts`) | `@4` domains and channel. Capabilities: `@4`'s, with `quote.create` ALLOW plus `quote.preview` (READ, domain `quote`). Pins Sales definition v5. Fingerprint `a043636e…`. Gate list `SALES_PRODUCTION_PROFILE_V5_GATE`. |
| `sales-production-autonomous-policy@1` | = production policy + `quote.create: allow` (provisional identity, cited evidence). Risk classes = platform default. Hash `515ce98f…`. Selected by `salesProductionActionPolicy(profile)` for `@5` only; `@1–@4` get the same `SALES_PRODUCTION_ACTION_POLICY` object (hash `5dbbd0f2…`, unchanged). |
| `quote.preview@1` | READ, owner `sales`, scopes `catalog.read` and `shipping.read`, no arguments (§4). |
| `quote.create@3` | IRREVERSIBLE_WRITE, `approvalPolicy: none`, `identityRequirement: provisional`, `key_required`, `reconcile_before_retry`, 90 s timeout. Input `{ previewId }` only. Output = `quote.create@2` output. |
| `sales.workspace.update@2` | v1 operations + `select_shipping_offer`, `exclude_shipping`, `record_quote_request` (§6). |
| Sales definition v5 (`sales.v5.agent.json`) | Same agent, scopes, budgets and model requirements as v4. New guidance for shipping choice, preview, request and autonomous issuance. v3/v4 byte-identical. Not "latest": non-production compositions keep v4. |
| Composition | `@5` registers `workspace.update@2`, `quote.preview` and `quote.create@3` only, and refuses to compose without limits or without REAL Quote, Catalog and Shipping. `@1–@4` registrations are unchanged. |
| Canary | `sales:canary` accepts `@4` or `@5`. `@5` requires the limits. |

## 4. Preview construction (`capabilities/commercial-snapshot.ts`)

Inputs: the Sales workspace (selection, quantities, destination, shipping choice) and the owners **now**. Nothing comes from model output.

1. **Each line.** Catalog `getItemContext(itemKey, quantity)` must be:
   - `found` and `sellable`;
   - in stock (`availableQuantity` ≥ quantity, or null);
   - within its owner validity;
   - priced (`pricing.quantity` = the selected quantity, i.e. its tier);
   - with a representable tax rate and printable owner text.

   The unit price is the Catalog `finalGross` for that tier, tax included.
2. **Shipping.** The decision must be explicit:
   - destination set and a choice recorded → re-quote Shipping (order basis from Catalog); the same carrier and service must be offered at the **agreed** NET;
   - no destination → explicit `exclude_shipping`;
   - anything else → blocker.
3. **Arithmetic.** Quote V2's `quoteV2ChargeAmounts` / `quoteV2Totals` (per line: net = round-half-up(gross/(1+rate)); shipping: tax = round-half-up(net × rate)).
4. **Snapshot.** Schema `r4-sales-commercial-snapshot-v1`: customer `guest`, lines, shipping, totals. `previewId = sha256(canonicalJson(snapshot))`. Owner timestamps are evidence outside the hash.
5. **Evidence.** Per line `asOf`, `validUntil` and stock; shipping `asOf`. `validUntil` = the earliest validity, which also bounds the preview Observation (ADR-030).

**Persistence.** The CommercialSnapshot is persisted twice:
- as the harness's immutable Observation of `quote.preview`;
- at issuance, in `sales.quote_autonomous_decisions.snapshot` (append-only), together with the frozen request.

A `previewId` is not an authorization: issuance recomputes everything.

## 5. Policy and risk limits

### 5.1 Commercial decision of `quote.create@3` (first attempt, before anything is frozen or sent)

| Requirement | Mechanism | Refusal code |
|---|---|---|
| Explicit customer request | `workspace.quoteRequest` exists and names this `previewId` | `quote_not_requested`, `quote_request_other_preview` |
| Real, sellable products; Catalog prices; stock and constraints | Snapshot recomputed now (§4) | `item_not_sellable`, `insufficient_stock`, `item_price_unavailable`, `item_price_tier_mismatch`, `catalog_evidence_stale`, … |
| Shipping chosen or explicitly excluded | Workspace choice, re-quoted at the agreed NET | `shipping_not_selected`, `shipping_not_decided`, `shipping_offer_unavailable`, `shipping_offer_changed` |
| Correct totals; no model-modified prices; no arbitrary discounts | The model states only a hash. Totals come from the owner arithmetic. The request's `expectedTotals` = snapshot totals (the owner returns 422 on any difference). No discount field exists. | `preview_stale`, `expected_totals_mismatch` |
| No fabricated customer data | Customer = `guest` and the input cannot carry one | (schema) |
| No stale commercial information | Recomputed at execution; Catalog owner validity checked | `catalog_evidence_stale`, `preview_stale` |
| No duplicates | Under an advisory lock: an earlier authorization of the same snapshot in the conversation; **unique index** `(task_id, preview_id) where authorized` | `duplicate_quote` |
| Amount, quantity and frequency limits | Configured limits: amount, lines, units per line (snapshot); per conversation and per hour (under the lock) | `autonomy_limit_amount`, `_lines`, `_quantity`, `_conversation`, `_rate` |
| Auditable autonomous decision | `sales.quote_autonomous_decisions` (0008): outcome, reason, snapshot, limits, measurements, quote request, time. Authorized rows are written in the same transaction as the frozen request. The platform's own `policy_decisions` row records `allow`/`autonomous` with the policy id and hash. | — |

A refusal is `rejected` (no effect), with the reason in the observation for the agent to explain. There is no fallback to a human approval.

### 5.2 Limits

The limits are configuration only, with no code default:
- `R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP`
- `R4_AUTONOMOUS_QUOTE_MAX_LINES`
- `R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE`
- `R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION`
- `R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR`

Integer ranges are validated. A missing value refuses composition and the canary. **No production values were chosen**: the owner decides and approves them before any rollout (gate `limits-approved`).

### 5.3 Limit of evidence: customer intent

`record_quote_request` is recorded by the agent (model-attested words), not verified against the inbound text, because no platform seam exposes the inbound text to the pack. R4 enforces structure:
- the request exists;
- it names exactly the snapshot issued;
- any commercial change invalidates it.

The customer's words are stored in the decision for post-hoc audit and evaluation. Deterministic verification requires a new platform seam (owner decision, outside J3E). Gate `intent-attestation`.

### 5.4 Autonomy boundaries (§7 of the instruction)

The autonomous policy covers `quote.create` only. Every risk class keeps the platform default; the contract test proves that other writes (cancel, deliver, charge, discount) are not allowed. The R4 Quote principal keeps exactly `quotes:create`, `quotes:read` and `quotes:document:read`. Nothing sends email, shares the document, creates orders, charges, cancels or applies discounts.

## 6. Workspace and shipping choice

| Operation | Rule |
|---|---|
| `select_shipping_offer {carrierName, serviceType, ownerNetClp}` | Only in its own update and only with a destination. The capability re-quotes Shipping for the current selection and destination and refuses an offer the owner does not make at that NET (`shipping_offer_not_offered`). It applies only at the verified workspace version (`requireVersion`). |
| `exclude_shipping` | Only without a destination. |
| `record_quote_request {previewId, customerWords}` | Binds the request to one snapshot. |
| Item, quantity or destination change | Clears the shipping choice and the quote request (transitions record both). |

States written by version 1 keep their exact shape (no new keys; test B3). The context projection adds `shippingChoice`/`quoteRequest` only for states that have them.

## 7. Execution and reconciliation (reused)

`quote.create@3` calls the shared, unchanged machinery of `@2`, now exported from `quote-v2.ts` by a pure extraction:
- `classifySend`;
- `settle`;
- `reconcileQuoteV2Command`.

This covers the stable execution key, the frozen CreateQuoteRequest (never re-quoted on retry: a replayed key skips the decision), `expectedTotals`, 201/202, `unknown`, reconciliation by idempotency lookup, no duplicates, PDF SHA-256 and persisted results. Success is reported only for an owner-`issued` quote that matches the snapshot.

## 8. Tests (LOCAL)

| Suite | Result |
|---|---|
| `tests/integration/sales-autonomous-quote.test.ts` (new) | 17/17 |
| `tests/contract/sales-autonomous-quote.test.ts` (new) | 12/12 |
| `tests/integration/sales-autonomous-canary.test.ts` (new) | 3/3 |
| `npm run build`, `npm run lint`, `npm run typecheck` | exit 0 |
| `test:unit` | 71 files; 974 passed, 1 skipped (pre-existing POSIX-only skip) |
| `test:contract` | 24 files, 309 passed |
| `test:sales` / `test:shadow` | 29 / 5 passed |
| `test:recovery` | 17 passed, **1 pre-existing failure**: `production-bootstrap-process.test.ts` expects only `sales@3`, stale since J2D (J3D report §8.3). Unchanged here. |
| integration (`--no-file-parallelism`) | 32 files passed, 1 skipped; 392 passed, 12 skipped (pre-existing skips). The first full run had 4 failures, all pins of the definition list (`loaded: 3`, latest `sales@4`, bootstrap output). They were updated for `sales@5` and re-run green. |

Coverage by required case:

| Required case | Test |
|---|---|
| Valid autonomous quote | C1; canary E2E |
| Deterministic preview | A1 (same id twice, same content in another conversation) |
| Variants and quantity | A3 (variant required refused; variant attributes); A2 |
| Price tiers | A2 (tier price follows quantity; new snapshot) |
| Shipping selected | A1, B1 |
| Stale or invalid shipping | B1 (offer not offered, other carrier, no destination, batch), C4 (`shipping_offer_changed`) |
| Incorrect totals | C3 (no totals argument; fabricated id → `preview_stale`); `expected_totals_mismatch` guard |
| No stock | A4, C4 (`insufficient_stock`) |
| No intent to quote | C2 (`quote_not_requested`) |
| Duplicate requests | C5 (same key replays; new key → `duplicate_quote`; 3 concurrent → 1 issued) |
| Autonomy limits | A5, C6 (amount, lines, quantity, conversation, hour) |
| Unsellable products | A4 |
| Unauthorized discounts | C3 (`discount`, `unitPrice`, `expectedTotals` refused by the schema); D (no discount write is allowed by the policy) |
| Nonexistent customer data | C1 (frozen `customer = guest`), C3 (customer argument refused) |
| Manipulation attempts | C3, B1, C4 (preview stale), canary stale scenario |
| Retries and idempotency | C5, C7, C8 |
| HTTP 202 and recovery | C7 |
| 422 | C8 (`quote_arithmetic_mismatch`, nothing issued) |
| Invalid PDF | C8 (`verification: mismatch`, never `verified`) |
| Quote service failure | C8 (`quote_service_unavailable`, retryable, then the same key issues once); Catalog outage → `quote_evidence_unavailable`, nothing decided |
| Harness invariance | contract D (only `@r4/capability-runtime` and `@r4/contracts` imported); `git status -- packages apps adapters` empty |
| `@3`/`@4` regression | contract A (pinned fingerprints and policy hash; `@3`/`@4` compositions), existing suites |

An issued quote with incorrect commercial information is never counted as success. `settle` reports `unknown` for an issued quote whose totals or correlation differ from the frozen snapshot, and the tests assert the owner's real quote count.

## 9. Autonomy canary

**LOCAL (PASS).** `tests/integration/sales-autonomous-canary.test.ts` runs the real canary runtime for `sales-production@5`:
- the real `ChannelIngress` on the synthetic channel;
- the production worker composition;
- the Policy Engine;
- the ActionExecutor;
- persistence;
- the delivery owner with local capture.

The owners are fixtures bound as HTTP-kind ports, and a scripted stand-in model drives three customer turns:
1. selection + destination → `shipping.quote` → reply;
2. choice → `quote.preview` → reply with totals;
3. request → `quote.create` proposal citing the preview observation → reply with the owner's number.

Asserted:
- 1 quote, 1 create call;
- task on definition v5;
- `policy_decisions`: `quote.create` v3, `allow`, `autonomous`, `sales-production-autonomous-policy`;
- 0 `human_requests`;
- `action_executions` and `action_receipts` succeeded (v3);
- the decision authorized;
- PDF verified;
- 3 replies captured on `r4-synthetic`, 0 non-synthetic outbound.

A second scenario raises a Catalog price before the confirmation: the Policy Engine allows, the commercial decision refuses (`preview_stale`), nothing is issued, and the agent explains.

**EC2: NOT RUN.** Running it there means placing this unreviewed, uncommitted code on the production host. That has to be a separate checkout: the production checkout must not change, and the root filesystem has about 1 GB free. It also needs real-model calls against Quote V2 integration. Both need the owner's go. The isolated canary database and environment from J3D are in place (`r4-sales-canary-postgres`, `~/.config/r4-canary/canary.env`, `@4`). Running `@5` needs:
- `R4_PROD_POLICY_PROFILE=sales-production@5` and the five `R4_AUTONOMOUS_QUOTE_*` limits in that file;
- `sales:canary init`, which applies `0008` and registers `sales@5` in the canary database only.

## 10. Compatibility with @3 and @4

`@1–@4` fingerprints and the hash of `SALES_PRODUCTION_ACTION_POLICY` were computed on this branch and on `main` (temporary worktree) and are identical:

| Item | Hash |
|---|---|
| `@1` | `bd30523f…` |
| `@2` | `2430a3e0…` |
| `@3` | `847aa0ef…` (= EC2 worker) |
| `@4` | `c905ca76…` |
| policy | `5dbbd0f2…` |

They are pinned in the new contract test. `@3`/`@4` compose `workspace.update@1`, no `quote.preview` and (`@4`) `quote.create@2` with approval, under the same policy object. Sales definitions v3/v4 are byte-identical.

**Deployment note.**
- Code from this branch would register `sales@5` on the next `production:sales:bootstrap`, as J2D did with v4.
- It needs Sales migration `0008` applied before restart: the bootstrap and the gateway check the Sales schema.
- With `sales.v5.agent.json` registered, the registry's *latest* Sales version becomes 5. Only tasks created **without** a pinned version (the generic API) would run it. Production channel tasks are pinned by the profile (`@3` → v4), the mechanism J2D introduced for exactly this case.

None of this was done.

## 11. Code and migration changes

New:
- `agents/sales/migrations/0008_sales_autonomous_quote_decisions.sql`: one append-only table; unique authorized `(task_id, preview_id)`; no change to existing objects.
- `agents/sales/sales.v5.agent.json`
- `agents/sales/src/capabilities/{commercial-snapshot,autonomy-limits,quote-preview,quote-v3,workspace-v2}.ts`
- `agents/sales/src/production/profile-v5.ts`
- `docs/adr/ADR-034-autonomous-quote-issuance.md`
- three test files

Modified (Sales pack only):
- `capabilities/quote-v2.ts`: export plus extraction of the shared send, settle and reconcile functions; `@2` behavior unchanged.
- `capabilities/workspace.ts`: export `outputOf`.
- `workspace/{model,store,context-source}.ts`: v2 operations and optional state; `requireVersion`; decision ledger methods; conditional projection.
- `ids.ts`: `AUTONOMOUS_QUOTE_CAPABILITY_IDS`.
- `index.ts`
- `definition.ts`: v5 file.
- `production/{profile-v4,composition,bootstrap,control,index}.ts`: the registry moved to `profile-v5.ts`, the same move J3B made.
- `cli/{production,operator-command}.ts`, `cli/canary/{runtime,command}.ts`
- `evaluations/evaluators.ts`: the two new change kinds.
- Pinned lists in existing tests (migrations, definitions, profiles, canary message).

Harness paths (`packages/`, `apps/`, `adapters/`): **0 changes**. No dependency added. Quote V2, Catalog and Shipping were not touched.

## 12. Pending limitations for automatic PDF delivery

Issuance and delivery are separate operations, and only issuance is in scope. Automatic delivery would need, each as its own decision:
- a channel or email delivery capability (EXTERNAL_COMMUNICATION, which stays `require_approval` under the autonomous policy);
- a principal with `quotes:delivery:email`, which is **not** granted to R4;
- a verified recipient: Customer is UNAVAILABLE, so no address is known;
- a validated channel for documents: WhatsApp media is not supported;
- a document-verification policy for `mismatch` and `unavailable`.

The `@5` instructions tell the agent it cannot send or share the quote.
