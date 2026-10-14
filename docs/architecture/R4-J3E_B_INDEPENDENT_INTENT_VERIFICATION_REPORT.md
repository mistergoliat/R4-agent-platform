# R4-J3E-B — Independent Customer Intent Verification Report

Date: 2026-10-14 · Branch: `r4-j3e-b-independent-intent` (from J3E `4fc071a`), **not pushed, not merged, not deployed** · Decision: ADR-035 (proposed)

Evidence labels: **SOURCE** = verified in code; **LOCAL** = executed on the workstation (Docker PostgreSQL, fixture owners, scripted model, the real canary runtime); **EC2 (read-only)** = existing J3E canary records read without running anything; **NOT RUN**.

```
R4_INTENT_EVIDENCE_@6=INDEPENDENTLY_VERIFIED   (LOCAL; read from the platform's conversation records, conditional on the
                                                single-input-producer topology, see §1)
R4_INTENT_EVIDENCE_@5=MODEL_ATTESTED           (unchanged)
R4_CONFIRMATION_GRAMMAR=r4-sales-confirmation-es-v1 (closed; no numeric codes)
R4_QUOTE_CREATE_V4=PASS (LOCAL)
R4_TOTAL_UNITS_LIMIT=PASS (LOCAL; @6 only, @5 unchanged)
R4_LEGACY_UNCHANGED=YES                        (@1–@5 fingerprints, both policy hashes, quote.create@2/@3, quote.preview@1 pinned)
R4_HARNESS_MODIFIED=NO
R4_EC2_EXECUTED=NO                             (read-only queries of existing canary evidence for §7 only)
R4_PRODUCTION_PROFILE=@3
CUSTOMER_ROLLOUT_AUTHORIZED=NO
```

Acceptance criterion: *a quote may be issued autonomously only with independent, verifiable evidence that the customer confirmed the current commercial proposal.* **Met locally for `@6`**: the evidence is the customer's own message as the platform recorded it, never an assertion of the model. One **condition** applies, stated in §1: in the current production topology, only the authenticated channel ingress creates customer inputs. Local acceptance is **not** a production authorization.

## 1. Audit of `ProductionStore.thread(taskId)` (SOURCE)

Implementation: `packages/persistence-postgres/src/production-store.ts` `thread()`. Port: `@r4/live-ops` `ProductionStore`.

| Property | Finding |
|---|---|
| `contact` entries | `task_inputs ⋈ memory_entries` (`content->>'text'`): every input the temporal runtime accepted into the task through `submitInput`. |
| Provenance and authenticity | **Producers of inputs:** (1) `ChannelIngress.receive`: `adapter.authenticate(rawBody, headers)` first (WhatsApp: webhook signature), then `parse`, dedupe by provider event, then `submitInput` with actor `user:<channel>:<conversationKey>` and `sourceRef channel:<channel>`. (2) The platform API `POST /v1/tasks/:id/inputs` with `deps.principal`, by default an *unauthenticated* principal. (3) The Sales test harness. **The model creates no input**: no agent decision type does. |
| Stable identifiers | `contact.refs.inputId` (UUIDv7, `task_inputs.input_id`); `agent.refs.stepId`; `agent.delivery.outboundId`. |
| Order and time | `cursor = <ISO>|<id>`, sorted. `task_inputs.received_at` and `agent_run_steps.created_at` both come from the database clock. |
| Outbound state | `pending`, `dispatching`, `accepted`, `delivered`, `read`, `failed`, `unknown`, `cancelled` (`@r4/live-ops` `OUTBOUND_STATUSES`). **`accepted`** = the provider took the message (WhatsApp returned a message id; the canary capture records it); it is **not** delivery. **`delivered` / `read`** exist only from provider status callbacks. `@4` requires `accepted`, `delivered` or `read`, and the evidence records which. **No delivery or reading is claimed.** |
| `taskId` ↔ conversation | One open binding per (channel, conversation key); the task is attached to it. Inputs are per task. |
| Protection from agent fabrication | `respond` produces `agent` entries only. An agent text that "quotes" the customer is an `agent` entry and is ignored as evidence (tests B2 and canary). |
| Availability in execute and recovery | Read from durable tables at every call, so it survives restarts (test D4). Reconciliation never needs it: the decision is already recorded. |
| **Gap** | `ThreadEntry` exposes no actor or `sourceRef` for inputs, so `thread()` cannot tell a channel message from an API-submitted input. |

**Verdict.** Provenance is reliable against the model (the acceptance criterion). It is conditional on topology for "only the customer". Today production runs gateway, worker and scheduler, and no API (PM2 inventory, J3D/J3E). Hence:
- gate `single-input-producer` in `SALES_PRODUCTION_PROFILE_V6_GATE`;
- to make it contractual: expose `actorKind` and `sourceRef` in `ThreadEntry.refs`. This is a small **harness** change, which needs an independent architectural decision and was **not** made.

This is a documented condition, not a missing provenance, so the work did not stop.

## 2. Protocol (natural confirmation)

```
quote.preview@2 ──► presentation.reference = Q-<6 hex of previewId>-<commercial version>, totalText
agent offer (respond) ──► must contain the reference token and the gross total; delivered (accepted|delivered|read)
customer reply (contact) ──► the FIRST customer message after the offer, the LAST in the thread,
                              with no agent message after it; parses under r4-sales-confirmation-es-v1;
                              within R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS of the offer
quote.create@4 {previewId} ──► recompute snapshot (same previewId) + limits + the above + single use
                                ──► decision (0008) + evidence (0009) + frozen request (0007), one transaction
```

- **The customer types nothing special.** "Sí, emítela." is enough. The reference is shown, never required back.
- **Grammar** (`capabilities/confirmation-grammar.ts`, version `r4-sales-confirmation-es-v1`): the **whole** normalized message must parse as `[AFFIRMATION] CONFIRMATION (CONNECTOR CONFIRMATION)* [COURTESY]`.
  - Affirmations: sí, ok, dale, perfecto, de acuerdo, listo, claro, sí por favor.
  - Confirmations: confirmo [la|esa|esta] [cotización], emítela/emítala, emite la/esa/esta cotización, ya emítela.
  - Courtesy: por favor, porfa, gracias.
  - Any `?`/`¿`, negation or condition (no, pero, cambia, otro, todavía, después, espera, mejor, creo, primero, …) disqualifies.
  - Messages over 160 characters are refused.
  - There is no keyword search: "¿qué pasa si confirmo?" and "confirmo, pero cambia la dirección" do not parse.
- **Ambiguity** (`customer_confirmation_not_explicit`): refused. The agent (v6 instructions) re-presents the offer (reference and total) and asks for an explicit confirmation, for example "CONFIRMO".

### Binding (§3 of the instruction)

| Element | Mechanism |
|---|---|
| Conversation and `taskId` | Thread of the task; the decision, evidence and Quote correlation carry `task_id` |
| `previewId` | Input; must equal the snapshot recomputed now |
| Workspace version | Commercial version in the reference (last applied item, quantity, destination or shipping change); the full workspace version is in the frozen request |
| Total and conditions presented | Reference token and gross total present in the offer text; offer text SHA-256 recorded |
| Offer message | `stepId`, time, outbound id, delivery state |
| Confirmation message | `inputId` (unique), time, text SHA-256, grammar version and rule |
| Validity | Confirmation within the configured window of the offer; the snapshot is recomputed at issuance (price, stock, shipping) |
| Execution identifier | `execution_key` (primary key of decision and evidence) |
| Ordering | Offer < confirmation (also a DB check); no customer message between them; no agent message after the confirmation; no commercial change after the offer (the reference carries the commercial version) |
| Single use | `confirmation_input_id unique`, plus a check under the decision lock (`customer_confirmation_used`) |
| PII | No customer text is copied into Sales: hashes and ids only (contract test plus integration A1) |

The model cannot fabricate, substitute or select the authorizing message: it supplies only `previewId`. The confirmation is always the latest customer input in the platform's records.

## 3. Versioning and composition (SOURCE)

| Artifact | Change |
|---|---|
| `quote.create@2`, `@3`; `quote.preview@1`; profiles `@1–@5` | **Unchanged** (fingerprints and policy hashes pinned in `tests/contract/sales-confirmed-intent.test.ts`) |
| `quote.preview@2` | `@1` output minus `quoteRequest`, plus `presentation` |
| `quote.create@4` | New; same input, Quote V2 machinery and recovery as `@3`; reads the thread through a structural port (`ConversationThreadReader`, satisfied by `ProductionStore`) |
| `sales-production@6` | `@5` domains, channel, capability list and `sales-production-autonomous-policy` (hash `515ce98f…`); Sales definition v6 |
| Composition | `@6` passes `options.store` (the existing `ProductionStore`) as the thread reader; refuses without the v6 limits |
| Sales definition v6 | Present the reference and total; propose on the customer's confirmation without re-reading the preview; never claim or record the confirmation; re-present when refused |
| Migration `0009_sales_quote_intent_evidence` | Append-only; unique `confirmation_input_id`; `check (confirmation_at > offer_at)` |
| Canary | Accepts `@4`, `@5` or `@6` |

No harness path changed (`packages/`, `apps/`, `adapters/`). Execution stays Policy Engine → ActionExecutor; no shortcut.

## 4. Total units (§5)

`R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS` (1..1980) caps all lines together. It is independent of `R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE`, required for `@6` and has no default. `@5` keeps exactly its five limits and semantics (contract A). Multi-line test E1:
- 3 + 2 units with a cap of 4 → `autonomy_limit_total_units` (preview not issuable; issuance refused);
- with a cap of 5 → issued.

## 5. Tests (LOCAL)

| Suite | Result |
|---|---|
| `tests/unit/sales/confirmation-grammar.test.ts` (new) | 45/45: 14 positives, 27 negatives, reference and total binding |
| `tests/integration/sales-confirmed-intent-quote.test.ts` (new) | 22/22 |
| `tests/integration/sales-confirmed-intent-canary.test.ts` (new; **real** `ProductionStore.thread`, real ingress, delivery owner, Policy Engine, ActionExecutor) | 5/5 |
| `tests/contract/sales-confirmed-intent.test.ts` (new) | 9/9 |
| `npm run build`, `npm run lint`, `npm run typecheck` | exit 0 |
| `test:unit` | 72 files; 1 019 passed, 1 skipped (pre-existing POSIX-only skip) |
| `test:contract` | 25 files, 318 passed |
| `test:sales` / `test:shadow` | 29 / 5 passed |
| `test:recovery` | 17 passed, **1 pre-existing failure** (`production-bootstrap-process.test.ts`; reproduced identically on `main` `ef5a354` without J3E, J3E report §13) |
| integration (`--no-file-parallelism`) | 34 files passed, 1 skipped; **422 passed**, 12 skipped (pre-existing). The full run had 1 failure: the canary's own message pin ("@4 or @5"), updated for `@6` and re-run green (15/15). |

Required cases → tests:

| Required | Test |
|---|---|
| Valid natural confirmation | A1, A2; canary "Sí, emítela." |
| Ambiguous confirmation refused | A3 ("Sí"); canary "Sí" → refused, re-presented, "CONFIRMO" → issued once |
| Negations | B1 (5 required phrases); canary "No confirmo, todavía lo estoy pensando", proposed anyway by the scripted model → refused |
| Product change | C1 (change → blocked; change and revert → same previewId, new commercial version, old offer void, new offer needed) |
| Shipping change | C2 (`preview_stale`) |
| Price or stock modified | C3 (`preview_stale`, `insufficient_stock`) |
| Expired preview or confirmation | B3 (`customer_confirmation_expired`) |
| Old message reused | D1 (`customer_confirmation_used`), D2 (an old confirmation never answers a newer offer) |
| Inbound replay | canary (same provider event → `duplicate`, no new input, one evidence row); D1 |
| Two concurrent conversations | D3 (two quotes) |
| Two simultaneous confirmations | D3 (three commands, one confirmation → one quote, two `customer_confirmation_used`) |
| Restart between confirmation and issuance | D4 (new capability instances, durable state only) |
| Quote `unknown` | D4 (lost answer → `unknown` → reconcile by the same key → one quote; replay does not decide again) |
| One issuance only | every case asserts the owner's quote count |
| No human approval | canary: 0 `human_requests`; policy `allow/autonomous` for `quote.create@4` |
| No external delivery | canary: outbound only `r4-synthetic`; no email route (contract) |
| Agent messages claiming confirmation | B2, contract C |
| Messages before the preview or offer; confirmation for another preview; undelivered offer | B2, B3 |
| Harness unchanged | contract C (imports), `git status -- packages apps adapters` empty |
| J3E-A controls kept | the J3E suites (`sales-autonomous-quote`, `sales-autonomous-canary`, `sales-autonomous-quote` contract) are green |

## 6. Security assessment

| Threat | Control | Residual |
|---|---|---|
| The model claims the customer confirmed | The confirmation is read from `contact` inputs only; the model supplies only `previewId` | — |
| The model presents one thing and issues another | The reference (previewId plus commercial version) and the total must be in the delivered offer; the snapshot is recomputed | The model's description of lines in the offer is not verified (only reference and total) |
| Replay or reuse of a confirmation | Unique `confirmation_input_id`; provider-event dedupe in ingress | — |
| Stale offer | Commercial version in the reference; window; snapshot recomputation | — |
| Confirmation of an outdated offer after a revert | Commercial version moves on any commercial change | — |
| Injected input not from the customer | Only the ingress produces inputs in the production topology | **API inputs indistinguishable through `thread()`** (gate; harness proposal) |
| Concurrency | Decision lock, unique (task, snapshot), unique confirmation | — |
| PII duplication | Hashes and ids only | — |

## 7. Performance and experience (EC2 read-only, J3E canary records)

**Measured.**
- All three J3E scenarios: **34** model calls, **270 s** of model time (p50 5.4 s, p90 17.0 s, max 40.1 s), all `finishReason: stop`.
- Positive scenario: **13** calls over 4 runs, **~166k input / ~10k output** tokens. Customer-message-to-reply latency: **19.5 s, 26.2 s, 25.8 s** per turn.
- Capability steps took 0.02–0.7 s each, so model inference dominates.
- Input per call grows with the turn, from 9k to 16k tokens: the full context is resent.
- Read-only scenario 1: one turn, 9 calls, **96.6 s**.

**`invalid_structured_output`.** In turn 2, the call after the preview returned 685 tokens of non-JSON text with `finishReason: stop` (not truncation). ADR-028 recovery resolved it with one extra run: 3 lost calls, about 14 s.

**Unnecessary steps found in the positive scenario:**
1. Turn 3 re-read `quote.preview` before proposing (about 6 s). Issuance recomputes everything. **Applied in v6** (safe: a stale preview is refused anyway).
2. Turn 3 recorded `record_quote_request` (about 7.5 s). **Removed in `@6`**: the confirmation is read from the conversation. Net, turn 3 goes from 4 to 2 model calls (propose, respond).

**Proposed, not implemented:**

| Proposal | Expected gain | Risk and condition |
|---|---|---|
| Provider JSON mode (`response_format`) for the structured decision, if the provider supports it, configured via `R4_MODEL_EXTRA_BODY` | Fewer `invalid_structured_output` failures | Validate on the canary; no correctness change |
| Provider prompt or context caching | Input-token cost, since about 90 % of input repeats per call | Provider-dependent; no correctness change |
| Allow the agent to batch the shipping choice and the preview read in one turn (already possible), and avoid `catalog.search` when the product key is known from context | 1–2 calls per conversation | Instruction-level only |
| Record `finishReason` and the parse failure reason on `invalid_structured_output` | Diagnosis | Harness logging change; separate decision |

## 8. UX

- The customer sees one message with lines, shipping, total and a short reference, then replies naturally: "Sí, emítela.", "Confirmo la cotización.", or "CONFIRMO" when asked.
- Only bare acknowledgements ("sí", "dale", "ok") or conditional replies get a second request.
- No numeric code is ever required.
- The extra request costs one model turn (about 20 s), only on ambiguity.

## 9. Compatibility and operations

**Compatibility.**
- `@1–@5` byte-identical (pinned).
- Deploying this code would register Sales definitions v5 and v6 on the next bootstrap and needs Sales migrations `0008` and `0009` before restart.
- Production tasks stay pinned by profile (`@3` → v4).

**Operational proposal (needs authorization; not executed):**
1. Owner accepts ADR-035 and approves the seven `@6` limits, including the total-units cap and the confirmation window (suggested for a canary: total units 5, window 900 s).
2. Owner decides on the input-provenance gap: accept the topology gate, or authorize the harness change that exposes the input actor in `ThreadEntry`.
3. EC2 canary of `@6` in the J3E isolated environment: a new checkout of the J3E-B commit, `sales:canary init` (`0009` and v6 in the canary database only), one natural-confirmation scenario, an ambiguity-then-CONFIRMO scenario, one negation, and at most one real quote.
4. Only then a production decision; customer rollout remains **not authorized**.

## 10. Change map

New:
- `agents/sales/migrations/0009_sales_quote_intent_evidence.sql`
- `agents/sales/sales.v6.agent.json`
- `agents/sales/src/capabilities/{confirmation-grammar,offer-presentation,quote-v4}.ts`
- `agents/sales/src/production/profile-v6.ts`
- `docs/adr/ADR-035-conversational-intent-verification.md`
- four test files

Modified (Sales pack only):
- `capabilities/autonomy-limits.ts`: v6 limits and the total-units check.
- `capabilities/quote-preview.ts`: `quote.preview@2` added; `@1` untouched.
- `workspace/store.ts`: optional intent evidence in `decideAutonomousQuote` (`@3` path unchanged), `intentEvidence()`, `commercialVersion()`.
- `production/{profile-v5,composition,bootstrap,control,index}.ts`: the registry moved to `profile-v6.ts`; `@6` composition.
- `cli/{production,operator-command}.ts`, `cli/canary/runtime.ts`, `definition.ts`, `index.ts`.
- Pinned lists in existing tests (migrations, definitions, profiles).

Harness, Quote V2, Catalog, Shipping: **0 changes**.
