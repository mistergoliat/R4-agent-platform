# R4-J3E-B — Independent Customer Intent Verification Report

Date: 2026-10-14 · Branch: `r4-j3e-b-independent-intent`, commit **`a841adb3e25cc7395b96212cc6dfb44ef16c0f1e`** (from J3E `4fc071a`), **not pushed, not merged, not deployed to production** · Decision: ADR-035, **accepted for canary only**

**Final flags (after the owner-authorized EC2 canary, §11):**

```
R4_J3EB_COMMIT=a841adb3e25cc7395b96212cc6dfb44ef16c0f1e
ADR_035=ACCEPTED_FOR_CANARY
R4_EC2_CANARY_6=PASS                     (scenarios A and B and read/replay C; one format-failure retry disclosed, §11.4)
R4_REAL_MODEL_USED=YES                   (openai-compatible.deepseek-v4-flash, 31 calls)
R4_REAL_QUOTES_ISSUED=1                  (PC-000005; Quote V2 5 → 6 quotes, 4 → 5 issuance operations)
R4_INTENT_EVIDENCE=THREAD_VERIFIED       (confirmation inputId = the customer's last real input; offer stepId = the delivered offer)
R4_INPUT_PROVENANCE=TOPOLOGY_GATED       (canary inputs only from the operator's synthetic ingress; proves nothing about real WhatsApp)
R4_CONFIRMATION_SINGLE_USE=PASS          (unique index present; one evidence row; replay = duplicate; reuse refusal covered LOCAL D1/D3)
R4_PDF_SHA256=PASS                       (f18d92a0…: manifest = stored artifact = R4 receipt, 29 605 bytes)
R4_TOTAL_UNITS_LIMIT=PASS                (LOCAL E1; canary configured with total 5; the scenario used 1 unit)
R4_HARNESS_MODIFIED=NO
R4_PRODUCTION_PROFILE=@3
R4_PRODUCTION_DB_UNCHANGED=YES           (ledger fingerprint f9c22251… unchanged; no Sales 0008/0009 in production)
R4_WHATSAPP_UNCHANGED=YES                (0 production outbound during the canary)
QUOTE_GMAIL_DISABLED=YES
CUSTOMER_ROLLOUT_AUTHORIZED=NO
```

**Production blockers still open:**
1. Contractual provenance of customer messages (input actor not exposed by `ProductionStore.thread`).
2. Integrity of every commercial condition presented to the customer (Sales verifies only reference and total; §11.6).
3. Validation of production limits (the canary limits are not production limits).
4. Operational acceptance and observability of `@6`, including the structured-output failures at the offer step (§11.4).

The sections below up to §10 describe the implementation and the local validation.

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

## 11. EC2 canary of sales-production@6 (owner authorization of 2026-10-14)

### 11.1 Code preflight and commit

- **Diff vs J3E-A (`4fc071a`):**
  - 0 files under `packages/`, `apps/` or `adapters/`;
  - no change to `package.json` or `package-lock.json`;
  - no `.env`, credential or private file (pattern scan: no matches).
- **Regression:** green (§5), except the pre-existing recovery test, which fails identically on `main`.
- **ADR-035:** status set to "accepted for experimentation and canary only".
- **Commit:** **`a841adb3e25cc7395b96212cc6dfb44ef16c0f1e`**. Not pushed.

### 11.2 Provenance gate (`single-input-producer`), checked before the run

| Check | Finding |
|---|---|
| Who can reach the canary database | `r4-sales-canary-postgres` publishes `5432` only on `127.0.0.1:55434`. There is one login role (`r4canary`) and no other client was connected. Credentials exist only in `~/.config/r4-canary/*` (0600, `ec2-user`); `production.env` does not reference the canary. |
| Processes that could create inputs | No R4 API process runs on the host (no `apps/api`). The production gateway, worker and scheduler use the production database. The canary runtime (worker, scheduler, delivery) creates no inputs. During the run, the **only** producer was the operator's `sales:canary send` (real `ChannelIngress`, synthetic channel). |
| Existing inputs | All `channel:r4-synthetic`, actor kind `user` |
| Model | The `@6` composition registers no capability that creates inputs, and no agent decision type does |
| Conversation ↔ task | One binding per synthetic conversation (`channel_conversation_bindings`, profile `sales-production@6`) |

The gate held for the canary. **This canary proves nothing about real WhatsApp message provenance**; contractual provenance remains a production prerequisite.

### 11.3 Infrastructure

**Before:**
- PM2 `r4-*` online (16/11/0 restarts); `@3`, rollout 0 %, 1 allowlisted key, `/ready` `sales-production@3`.
- Production checkout `ef5a354`, clean; production ledger `f9c22251…` (11 migrations).
- Quote V2 ready; the R4 principal can read PC-000004 (200); Gmail disabled.
- The previous canary was stopped, with no open execution, human request, schedule or outbound, and every frozen request issued.

**Reuse.**
- The J3E-A evidence (run log and capture) was copied to the workstation and hashed.
- The stopped checkout `~/r4-j3e-canary` was moved to `a841adb` with an incremental git bundle and rebuilt (no dependency change, no second install).
- **767 MB free** after preparation (≥ 700); 764 MB at the end.

**Canary database.** `sales:canary init` with `@6` applied **only** `0009_sales_quote_intent_evidence` and registered **only** `sales@6`. Isolation verified.

**Environment.** `~/.config/r4-canary/canary-j3eb.env` (0600):
- the seven approved canary limits;
- per-hour limit **1**;
- `sales-production@6`;
- its own capture file;
- synthetic conversation keys only;
- no WhatsApp keys.

Effective profile at start: `sales-production@6`. Quote V2 baseline: **5 quotes** (latest PC-000004), 4 issuance operations, 7 idempotency bindings, 1 delivery.

### 11.4 Scenarios (real model DeepSeek V4 Flash, real Catalog, Shipping and Quote V2)

**A. Explicit negation.**

| Attempt | What happened |
|---|---|
| A-1 (`j3eb-neg-1`) | Turn 1 was fine. In turn 2, after `quote.preview`, the model twice returned non-JSON text instead of a decision (`invalid_structured_output`, `finishReason: stop`, 1 165 and 1 638 output tokens). ADR-028 recovery failed again, so the task was **handed to humans** (`handoff` human request; task `blocked`). No offer was sent and nothing could be issued. |
| A-2 (`j3eb-neg-2`, one retry) | The offer was presented with lines, quantities, shipping, net, VAT, total and `Q-5F57B2-2`. The customer said "No confirmo. Todavía lo estoy pensando." The model **did not propose** issuance and replied appropriately. 0 `quote.create` proposals, 0 decisions, Quote V2 unchanged. |

The capability-level refusal of a negation was not exercised by the real model, because it never proposed. It is covered by the scripted canary E2E and the local matrix (B1).

**B. Ambiguity, then natural confirmation (`j3eb-pos-1`).**
1. Request, then the shipping choice. The offer showed reference `Q-5F57B2-2`, total $52.980, 1 × Par Mancuernas Hexagonales 12.5kg | HWM®, and Pesas Chile – Despacho Directo to Ñuñoa.
2. "Sí." The model **proposed** `quote.create`. Policy decided `allow/autonomous`, and the **capability refused** it with `customer_confirmation_not_explicit` (`not_a_confirmation`); receipt `rejected`; Quote V2 unchanged. The model then re-presented the full offer (reference and total) and asked for an explicit confirmation.
3. "Sí, emítela." The model proposed `quote.create {previewId}`. Policy decided `allow/autonomous`; `quote.create@4` read the thread and authorized; the request was frozen and sent once; **PC-000005** was issued and replied. The canary was stopped right after.

**C. Recovery and duplicates (no second write).**
- The read-only Quote V2 idempotency lookup with the same execution key returns `state: bound` with quote `f73c3b4c…` (PC-000005). Reconciliation would settle to the same quote without a POST.
- Replay of the confirming provider event with the **original** id → `duplicate` (`duplicate_deliveries = 1`); no new input, no new evidence.
- The unique index `quote_intent_evidence_confirmation_input_id_key` is present.
- A real reuse refusal (`customer_confirmation_used`) or an ambiguous `unknown` would need a second write or a real ambiguity; they stay covered locally (D1, D3, D4).

**Operator error (disclosed).**
- My first replay attempt passed the event id already prefixed (`synthetic:…`). `sendSynthetic` adds the prefix itself, so the ingress correctly treated `synthetic:synthetic:…` as a **new** event: one extra synthetic input "Sí, emítela." in `j3eb-pos-1`, and the task became runnable.
- The canary runtime was already stopped: no run executed, no proposal, no decision, Quote V2 unchanged.
- It cannot issue even if the canary restarts: the per-conversation limit (1) is used and the snapshot is already authorized.
- **Recommendation:** cancel that canary task before any future canary run.

### 11.5 Evidence (canary database and Quote V2)

| Required evidence | Value |
|---|---|
| Profile and definition | binding `r4-synthetic` / `sales-production@6`; task `01a138aa-b3f9-797d-981f-20eea3a9273c` on `sales@6` |
| Policy | `quote.create@4` → `allow` / `autonomous` (twice: the refused and the authorized command), `sales-production-autonomous-policy@1`, hash `515ce98f…` |
| Executions | `r4x_01a138ab…` → `rejected` (attempt 1 `rejected`, receipt error `customer_confirmation_not_explicit`); `r4x_01a138ac41f67821a65d8a44f617973c` → `succeeded` (1 attempt `applied`, receipt `PC-000005`, `replayed: false`) |
| Decisions (0008) | `rejected:customer_confirmation_not_explicit`; then `authorized:eligible` (gross 52 980, 1 line, 1 unit, commercial version 2, 0 in the last hour, 0 in the conversation, confirmation not used) |
| **Intent evidence (0009)** | `confirmation_input_id 01a138ac-1f8f-70e2-a98f-f98e9574710b` = the task's **last real input**, whose platform text is "Sí, emítela.". `offer_ref 01a138ab-e32d-76c3-af15-b79433f2fa8c` = the agent step of the re-presented offer, outbound `accepted` (same outbound id). Offer 04:29:11.340, confirmation 04:29:26.797 (15 s, window 900 s). Reference `Q-5F57B2-2`, presented gross 52 980, rule `affirmation=si;courtesy=none`. |
| Totals | snapshot = request = owner = receipt: 44 521 / 8 459 / 52 980 |
| Idempotency | 1 send; Quote V2: 1 binding (`r4-sales-integration`, `quote.create_and_issue`), 1 operation `succeeded` |
| Quote V2 counts | quotes 5 → **6**, operations 4 → 5, bindings 7 → 8, deliveries 1 → 1 (0 for PC-000005) |
| PDF | manifest `f18d92a0203510c654c3b88bf38285c810b667e1e9a6d303c1d80e831de183dc`, 29 605 bytes; stored artifact re-hashes identically; R4 `verified` |
| Human intervention | **0** human requests in the issuing task. The only one in the canary database is the `handoff` of A-1 (format failure, §11.4). No approval request exists. |
| External contact | all canary outbound `r4-synthetic`/`accepted` (15); production outbound in the window **0**; Gmail disabled |
| Production | ledger `f9c22251…` unchanged (no Sales `0008`/`0009`); `@3`; PM2 counters unchanged; checkout `ef5a354` clean |
| Canary | stopped |

### 11.6 Offer audit (observational, §7)

Both offer messages of `j3eb-pos-1` (the first one and the re-presented one the customer confirmed) were compared with the preview snapshot:

| Element | Offer text | Snapshot | Match |
|---|---|---|---|
| Line | 1 × Par Mancuernas Hexagonales 12.5kg \| HWM® — $47.990 (IVA incluido) | quantity 1, description identical, line gross 47 990 | yes |
| Shipping | Pesas Chile – Despacho Directo (Ñuñoa, Metropolitana de Santiago) — $4.990 (IVA incluido) | Pesas Chile / Despacho Directo / Ñuñoa / Metropolitana de Santiago, gross 4 990 (net 4 193) | yes |
| Net / VAT | $44.521 / $8.459 | 44 521 / 8 459 | yes |
| Total | Total: $52.980 (IVA incluido) | 52 980 | yes |
| Reference | Q-5F57B2-2 | Q-5F57B2-2 | yes |

**No discrepancy in this canary.** Sales still verifies only the reference and the total, so the match of lines and shipping is observed here, **not** guaranteed by code.

### 11.7 Performance (vs J3E-A)

| Metric | J3E-A (`@5`, 3 scenarios) | J3E-B (`@6`, 3 conversations) |
|---|---|---|
| Model calls | 34 | 31 |
| Model time | 270 s (p50 5.4, p90 17.0, max 40.1) | 159 s (p50 4.2, p90 8.0, max 14.5) |
| Format errors | 1 (recovered) | 2 consecutive in A-1 (task handed off); 0 in A-2 and B |
| Positive conversation | 13 calls, ~166k in / 10k out, 3 turns (19.5 / 26.2 / 25.8 s) | 12 calls, 150k in / 11k out, 4 turns (17.2 / 15.4 / **31.9** / **13.9** s) |
| Confirmation turn | 4 calls, 25.8 s (preview re-read, `record_quote_request`, create, respond) | **2 calls, 13.9 s** (create, respond) |
| Capability invocations (reads) | — | 13 |
| First message → issued quote | ~3 min (with operator pauses) | ~1 min 47 s (with an extra ambiguity turn) |

The ambiguity turn (31.9 s) carries the refused proposal plus the re-presented offer. The confirmation turn halved, as intended. **Correctness was not traded**: the snapshot is still recomputed at issuance. The format failures concentrate on the call that writes the long offer message.

## 12. Proposals (not implemented; each needs independent approval)

### 12.1 Deterministic offer rendering (production blocker 2)

Make Sales the author of the commercial content the customer confirms.

1. `quote.preview@3` returns `presentation.offerText`: a fixed, versioned template (`r4-sales-offer-es-v1`) rendered from the snapshot. It contains every line (description, quantity, unit and line gross), shipping (carrier, service, destination, gross) or "sin despacho", net, VAT, total, validity policy and the reference. Sales also records the SHA-256 of that rendered text.
2. The agent must include `offerText` **verbatim** as one block. It may add its own words before or after it, never inside.
3. `quote.create@5` checks that the offer message contains the exact rendered block (or its normalized hash). That guarantees lines, quantities, shipping and total, not only reference and total.
4. Fallback if the model fails to copy the block: refuse with `offer_not_presented`, and the agent presents again.

Dependencies: new preview and capability versions, a template contract test, an instruction version, and a UX review of the fixed block.

### 12.2 Fewer model calls and tokens (bounded)

| Proposal | Expected effect | Correctness |
|---|---|---|
| The deterministic offer block (12.1) also removes the long free-form offer generation, which is where every format failure happened | Fewer `invalid_structured_output` failures; ~1 000 fewer output tokens per offer | Improves |
| Provider JSON mode for the decision envelope (`R4_MODEL_EXTRA_BODY`), validated on a canary | Fewer format failures | Neutral |
| Provider prompt or context caching (≈ 90 % of input repeats across a turn's calls) | Lower input cost | Neutral |
| Instruction: skip `catalog.get_product_context` when `catalog.search` already returned the exact item key and price (turn 1: 5 → 4 calls) | −1 call per conversation | Neutral (the snapshot reads Catalog anyway) |
| Record `finishReason` and the parse failure class on `invalid_structured_output` | Diagnosis of the A-1 failure mode | Harness logging change; separate decision |

None was activated during this canary: no JSON mode and no model change.

### 12.3 State left on EC2

- **Canary runtime:** stopped.
- **Checkout `~/r4-j3e-canary`:** at `a841adb`.
- **`canary-j3eb.env`:** 0600, kept.
- **Logs:** `~/r4-j3d/j3eb-canary-run.log` and `j3eb-canary-outbound.jsonl`.
- **Canary database:**
  - `0008`, `0009`, `sales@5`/`sales@6`;
  - the `j3eb-neg-1` task blocked with a handoff;
  - the `j3eb-pos-1` task runnable after the disclosed replay error (cancel before any future run).
- **PC-000005:** in the Quote V2 integration deployment (synthetic-only, Gmail disabled).
