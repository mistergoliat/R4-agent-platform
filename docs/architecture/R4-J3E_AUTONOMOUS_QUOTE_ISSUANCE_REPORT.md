# R4-J3E — Autonomous Quote Issuance Report

Date: 2026-10-13 · Branch: `r4-j3e-autonomous-quote-issuance`, commit **`cc1e6c33f3b61cfc38d1b9809c73bfd61465873b`** (from `main` `ef5a354`), **not pushed, not merged, not deployed to production** · Decision: ADR-034, **accepted for experimentation and canary only**

**Final flags (after the owner-authorized EC2 canary, §13–§16):**

```
R4_J3E_COMMIT=cc1e6c33f3b61cfc38d1b9809c73bfd61465873b
R4_AUTONOMOUS_EC2_CANARY=PASS
R4_REAL_MODEL_USED=YES                   (openai-compatible.deepseek-v4-flash; 34 model calls across 3 scenarios)
R4_QUOTE_ISSUED_COUNT=1                  (PC-000004; Quote V2 4 → 5 quotes)
R4_AUTONOMOUS_POLICY=PASS                (quote.create@3 allow/autonomous, sales-production-autonomous-policy@1, hash 515ce98f…)
R4_CUSTOMER_INTENT_EVIDENCE=MODEL_ATTESTED
R4_PDF_SHA256=PASS                       (3685d137…; owner manifest = stored artifact = R4 receipt; 29 590 bytes)
R4_PRODUCTION_PROFILE=@3
R4_PRODUCTION_SCHEMA_UNCHANGED=YES       (production ledger fingerprint identical; no 0008)
R4_HARNESS_MODIFIED=NO
R4_WHATSAPP_UNCHANGED=YES                (0 production outbound during the canary window)
QUOTE_GMAIL_DISABLED=YES
CUSTOMER_ROLLOUT_AUTHORIZED=NO
AUTONOMOUS_QUOTE_CANARY_APPROVED
AUTONOMOUS_QUOTE_CUSTOMER_ROLLOUT_NOT_APPROVED
CUSTOMER_INTENT_INDEPENDENT_EVIDENCE_REQUIRED   (production blocker; proposal in ADR-034)
```

The flags below are the state **before** the EC2 canary (implementation and local validation).

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

**EC2: run on 2026-10-13 with owner authorization; see §13.** The paragraph below records the state before that authorization. Running it there means placing this unreviewed, uncommitted code on the production host. That has to be a separate checkout: the production checkout must not change, and the root filesystem has about 1 GB free. It also needs real-model calls against Quote V2 integration. Both need the owner's go. The isolated canary database and environment from J3D are in place (`r4-sales-canary-postgres`, `~/.config/r4-canary/canary.env`, `@4`). Running `@5` needs:
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

## 13. Reproducible commit (owner authorization of 2026-10-13, §1)

| Check | Result |
|---|---|
| Diff review | 41 files, +2 636 / −118. Harness, owner and adapter paths (`packages/`, `apps/`, `adapters/`): **0 files**. No `.env`, credential, token or private data (pattern scan: no matches). No dependency change: `package.json` and `package-lock.json` are identical to `ef5a354`. |
| `@1–@4` | Fingerprints and policy hash equal `main` (§10), pinned in `tests/contract/sales-autonomous-quote.test.ts`. |
| Migration `0008` | Append-only (trigger). `check ((outcome = 'authorized') = (reason_code = 'eligible'))`. An authorized decision needs a snapshot and a request. Unique partial index `(task_id, preview_id) where outcome = 'authorized'`. Index on `decided_at` for the hourly count. Nothing outside `sales`; no existing object altered. |
| Recovery failure | `tests/recovery/production-bootstrap-process.test.ts` **fails identically on `main` `ef5a354`** (a temporary worktree without J3E, same assertion). It is pre-existing and not a J3E regression. |
| Commit | **`cc1e6c33f3b61cfc38d1b9809c73bfd61465873b`** on `r4-j3e-autonomous-quote-issuance`. Not pushed, not merged. |

## 14. previewId audit (§2)

| Identity | Carrier | Finding |
|---|---|---|
| Commercial content | `previewId = sha256(canonical snapshot)`. Excludes task, time and owner timestamps. | Identical content in two conversations has the **same id by design**: it names content, not a request. |
| Conversation | `task_id` (decision row, frozen request `externalCorrelation.externalReference`, Quote `externalCorrelation`) | Separates otherwise identical quotes. |
| Customer request | `workspace.quoteRequest` of **that** conversation, cleared by any commercial change | A request cannot be borrowed from another conversation. Reverting to identical content needs a new request (test C12). |
| Issuance idempotency | Platform execution key = Quote `Idempotency-Key`, with the body frozen per key | A retry of one command replays; a new command is a new key. |
| PostgreSQL uniqueness | Unique `(task_id, preview_id)` for authorized decisions, plus a global advisory lock | One issuance per snapshot **per conversation**; no cross-conversation collision. |
| Preview validity | Recomputed at issuance (fresh owner reads). The Observation bounds what the model may present (earliest owner validity). | The id has no expiry by design: an identical recomputation is current by construction; any price, offer or stock change yields `preview_stale` or a blocker. |

New tests (`sales-autonomous-quote.test.ts`, now 20/20):
- **C10:** two conversations with identical snapshots produce the same `previewId` and **two** quotes (PC-000001, PC-000002), each correlated to its task with its own key; both authorized rows coexist.
- **C11:** repeated requests in one conversation produce one quote, then `duplicate_quote` twice.
- **C12:** a request cleared by intermediate changes is not revived by identical content.

**No uniqueness defect found; no code change was needed.**

## 15. EC2 canary (§3–§7)

### 15.1 Budget and limits

| Owner value | Variable (real name) | Set |
|---|---|---|
| Gross ≤ 250 000 CLP | `R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP` | 250000 |
| ≤ 3 lines | `R4_AUTONOMOUS_QUOTE_MAX_LINES` | 3 |
| ≤ 5 **total** units | `R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE` | 5 |
| ≤ 1 per conversation | `R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION` | 1 |
| ≤ 2 per hour | `R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR` | 2 |

**Semantic gap (reported, not changed).** The implementation limits units **per line**, not in total. With 3 lines, up to 15 units would pass the code. The "5 total units" budget was held **operationally**: the positive scenario has 1 unit. A total-units limit is a follow-up decision.

The absolute maximum of **one** real quote was enforced operationally: one positive scenario, the Quote V2 count checked before and after, and the canary runtime stopped (SIGTERM) right after the issuance.

### 15.2 Preflight and setup (EC2)

- **Disk:** 961 MB free before setup.
  - Separate checkout `~/r4-j3e-canary`, cloned from a git bundle of the branch: HEAD = `cc1e6c3…`, clean, 11 MB.
  - `npm ci --prefer-offline` (offline cache, no download), then `npm run build`: checkout 163 MB.
  - **768 MB free after preparation** (≥ 700). npm's temporary cache dipped free space to 672 MB during install, recovered right after.
  - 764 MB free at the end. EBS untouched; no other service's files deleted.
- **Production preserved:**
  - checkout `~/R4-agent-platform` at `ef5a354`, clean;
  - PM2 `r4-sales-worker`/`r4-channel-gateway`/`r4-scheduler` online, restart counters 16/11/0 before and after;
  - `production.env` `@3`, rollout 0 %, allowlist 1 key, unchanged;
  - production database not used.
- **Canary database** (`r4-sales-canary-postgres`, marker `r4-sales-canary:v1:50ea36160c0b`): `sales:canary init` with `@5` applied **only** `0008_sales_autonomous_quote_decisions` and registered **only** `sales@5` (`sales@3`/`@4` unchanged). Isolation `verified`, 0 foreign traffic.
- **Production ledger fingerprint** `f9c22251…` (11 migrations, no `0008`): identical before, after `init` and at the end.
- **Canary environment** `~/.config/r4-canary/canary-j3e.env` (0600): derived from the J3D canary env (no WhatsApp keys, no `R4_DATABASE_URL`), with:
  - `@5`, the limits above, and `R4_EXEC_MAX_WRITE_ACTIONS=6`;
  - its own allowlist of three synthetic conversation keys;
  - local capture `~/r4-j3d/j3e-canary-outbound.jsonl`.
- **Owners:** real Catalog (`127.0.0.1:4010`), real Shipping (pc-carrier), Quote V2 integration (`127.0.0.1:4020`, principal `r4-sales-integration`). Gmail **disabled** before and after.
- **Runtime:** `node agents/sales/dist/cli/canary.js run` (worker, scheduler, local capture) started detached, outside PM2, reporting `profile: sales-production@5`.

### 15.3 Products (read-only selection; nothing altered)

Selected with read-only Catalog calls:

| Product | Item context (quantity 1) | Use |
|---|---|---|
| `P229` "Par Mancuernas Hexagonales 12.5kg \| HWM®" | sellable, stock 143, 47 990 CLP incl., rate 0.19 | Positive |
| `P1543` "Power Rack Alpha \| HWM®" | sellable, stock 22, 414 990 CLP | Above the amount limit; **cannot** be issued |

No price, stock, Shipping quote or Quote V2 policy was changed.

### 15.4 Scenarios (real model, synthetic ingress)

| # | Conversation | What happened | Effect |
|---|---|---|---|
| 1 | `j3e-ro-1` (read-only) | "How much is the Power Rack Alpha and delivery to Ñuñoa? Just looking, no quote." The model answered with the real price and the two real shipping offers, and explicitly offered no quote. | 2 workspace updates; 0 `quote.create` |
| 2 | `j3e-reject-1` (rejection) | Quote request → shipping choice → **`quote.preview`**. The model presented Sales' totals (net 348 732, VAT 66 259, total 414 991) and said the total exceeds the 250 000 autonomous limit, offering a human. The customer insisted ("emítela tú ahora"). The model **declined to propose**, citing the limit. | 0 `quote.create` proposals; no autonomous decision |
| 3 | `j3e-pos-1` (single positive) | Turn 1: quote request → search, product context, workspace (P229 ×1, Ñuñoa), `shipping.quote` → two real offers presented. Turn 2: customer chose "Pesas Chile Despacho Directo" → `select_shipping_offer` (owner NET 4 193) → `quote.preview` → totals 44 521 / 8 459 / **52 980** presented, confirmation asked. Turn 3: "Sí, confirmo esa cotización. Emítela por favor." → `record_quote_request` → **`quote.create` {previewId}** → issued → reply "Cotización N° PC-000004 … Total: $52.980 … Validez: hasta el 17 de octubre de 2026." | **1 quote** |

Scenario 2 shows the model honoring the limit by itself. The platform-side refusal of an over-limit proposal (`autonomy_limit_amount`) was **not** exercised on EC2 because no proposal was made. It is covered by the local matrix (C6, A5).

**Real-model incident (handled, no effect).** In turn 2 of scenario 3, run 2 ended `failed` with `invalid_structured_output` ("model output is not a JSON document"), after the shipping choice and a preview. The existing ADR-028 recovery opened run 3, which replied correctly. Nothing was proposed twice and no quote was affected.

### 15.5 Evidence (canary DB, Quote V2, logs)

| Required evidence | Value |
|---|---|
| Effective profile | binding `r4-synthetic` / `sales-production@5`; runtime start record `profile: sales-production@5` |
| Sales definition | task `01a137a3-0415-7789-a31f-cf2ff24c8821` on `sales@5` |
| Effective policy | `sales-production-autonomous-policy@1`, hash `515ce98f81933f2dbbb1bb24530f24b85beea959c44d2cb6caa1c9f34aacdc4a`, identity `provisional` |
| Versioned capability | `quote.create@3` (decision, execution, receipt); `sales.workspace.update@2`; `quote.preview@1` |
| Real model | `providerId: openai-compatible.deepseek-v4-flash` (`R4_MODEL_NAME=deepseek-flash`); 34 `model.call.completed` across the canary; 13 model calls in the positive task (4 runs) |
| Tools selected (positive task) | `catalog.search` ×1, `catalog.get_product_context` ×1, `shipping.quote` ×1, `quote.preview` ×2, `sales.workspace.update` ×3, `quote.create` ×1, `respond` ×3 |
| Preview | `quote.preview@1` succeeded, `status: ready`, `previewId 5f57b2751489b1c0e82cb14423b583457fb932537e0a12e5570f0bc608332b1d`, totals 44 521 / 8 459 / 52 980, 0 limit breaches (both previews identical) |
| ActionProposal | `quote.create` `{ "previewId": "5f57b275…" }`, 2 evidence refs (`quote.preview` observations) |
| PolicyDecision | `quote.create@3` → **`allow` / `autonomous`**, rule `capabilities.quote.create.autonomy` (the 3 workspace updates: `allow`/`autonomous`) |
| Autonomous decision (0008) | `authorized` / `eligible`. Limits as configured. Measurements: gross 52 980, 1 line, 1 unit, 0 earlier in conversation, 0 in the last hour, no same snapshot. Customer words "Sí, confirmo esa cotización. Emítela por favor." (model-attested) |
| ActionExecution | `quote.create@3` `succeeded`, `reconcile_before_retry`, execution key `r4x_01a137a7e6097cf680d2469d4c1d3492`, **1 attempt** (`execute` → `applied`) |
| Receipt | `succeeded`, v3, `quote:ba360fce-2754-41dd-8a85-403a640e7875`, `PC-000004`, `replayed: false`, totals 44 521 / 8 459 / 52 980, validity through 2026-10-17 |
| Totals | Owner quote: gross 52 980, net 44 521, tax 8 459 (line 47 990 incl.; freight NET 4 193 excl. 19 %) = snapshot = `expectedTotals` = receipt |
| Idempotency | Frozen request `request_sha256 41bb1e00…`, customer `{kind: guest}`, 1 line, carrier Pesas Chile NET 4 193; **1 send**. Quote V2: 1 idempotency binding (`r4-sales-integration`, `quote.create_and_issue`), 1 issuance operation `succeeded` |
| Quotes created in Quote V2 | **4 → 5** (PC-000004 only; `r4-sales-integration` 1 → 2); the runtime was stopped right after |
| PDF integrity | Manifest `3685d137e816999c6d2bee5ec06597599041819d7332d4b6576e7caa29e51315`, 29 590 bytes. The stored artifact re-hashes to the same value. R4 receipt `verification: verified`; `sales.quote_v2_issued` `verified` |
| Human approval requests | **0** (whole canary database) |
| Deliveries and external contact | Quote V2 deliveries 1 → 1 (the W10 row only; **0** for PC-000004). Canary outbound: 7 messages, all `r4-synthetic` / `accepted` (local capture). Production outbound during the window: **0**. Gmail disabled. |

**What this canary does not prove.** The customer's intent is **model-attested**: the agent recorded the customer's words, and nothing compared them with the inbound text at runtime. The canary validates the governed autonomous path, the commercial determinism, the limits, idempotency and PDF integrity. It does **not** validate independent evidence of customer intent, which does not exist yet.

### 15.6 State left on EC2

- **Canary runtime:** stopped.
- **Separate checkout `~/r4-j3e-canary`:** about 163 MB, kept for reproducibility; it can be removed at the owner's request.
- **`canary-j3e.env`:** 0600, kept.
- **Canary database:** now has `0008`, `sales@5`, 3 synthetic tasks and the decision row.
- **Logs:** run log `~/r4-j3d/j3e-canary-run.log` (0600) and capture `~/r4-j3d/j3e-canary-outbound.jsonl`, kept on the host.
- **PC-000004:** remains in the Quote V2 *integration* deployment (synthetic-only, Gmail disabled).

## 16. Customer-intent evidence (§8)

ADR-034 is **accepted for experimentation and canary only**:
- `AUTONOMOUS_QUOTE_CANARY_APPROVED`
- `AUTONOMOUS_QUOTE_CUSTOMER_ROLLOUT_NOT_APPROVED`

The production blocker `CUSTOMER_INTENT_INDEPENDENT_EVIDENCE_REQUIRED` remains.

**Can Sales resolve it with existing contracts? Yes.** `ProductionStore.thread(taskId)` is a public `@r4/live-ops` port, already passed to `composeSalesProductionWorker` as `options.store`. It returns the conversation's authenticated customer messages (`contact`: text, `inputId`, time) and the agent's replies (`agent`: text, delivery status).

The concrete proposal in ADR-034 (§"Evidencia independiente de intención") is a deterministic confirmation protocol:
- the preview exposes a `confirmationCode`;
- the agent must present it together with the total;
- a new `quote.create@4` issues only when a delivered agent reply carrying the code and total is followed by a **customer** message containing that code;
- the confirming input's id, time and hash are recorded.

It needs no harness change. Its dependencies and the required tests are listed in the ADR. It is not implemented: it needs the owner's UX decision (the customer must type a code) and a new profile/capability version.
