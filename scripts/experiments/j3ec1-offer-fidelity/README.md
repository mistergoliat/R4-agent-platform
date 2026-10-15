# R4-J3E-C1 offer experiments

Tools to rebuild the model experiments of `docs/architecture/R4-J3E_C1_IMPLEMENTATION_REPORT.md`:

- **copy fidelity** of `sales-production@7`: phases A, B0 and C, 108 samples (report §8);
- **paired control** of `@6` (the model writes the offer) against `@7` (the model copies the Sales offer): phase AB, 20 scenarios (report §8.7);
- the **historical baseline** of the J3E-A/J3E-B EC2 canaries (report §9).

These tools are not part of the product. Nothing here touches EC2, the real Quote V2 or a production database.

## What runs

`run.mjs` starts the **real canary runtime** of the profile on a throwaway local PostgreSQL database whose name contains `canary`, as the canary guard requires. It uses:

- synthetic ChannelIngress, the kernel and the context compiler;
- the Policy Engine and the ActionExecutor;
- the real `ProductionStore.thread` and the delivery owner, capturing to a temporary file;
- **fixture** Catalog, Shipping and Quote V2.

Every decision is scripted **except** the turn where the model writes the offer. With an ambiguous confirmation, the re-presentation turn is also left to the model. At those points, the exact request the kernel built goes to the real model and its decision returns to the kernel. The verdicts therefore come from `quote.create` itself:

- `@4` for `@6`;
- `@5` for `@7`.

Both arms see the same scripted history, the same scenario and the same model configuration. Only the profile changes, and with it the presentation strategy:

| | `sales-production@6` | `sales-production@7` |
|---|---|---|
| Profile fingerprint | `5ce5f371…` | `dc4d82dc…` |
| Agent definition | v6 | v7 |
| `quote.preview` | `@2` (snapshot + reference + total) | `@3` (+ `offerMessage` rendered by Sales) |
| Who writes the offer | the model (free text) | Sales (the model copies) |
| `quote.create` checks | `@4`: the reference and the total are in the message | `@5`: the message is byte-identical to the Sales rendering |

The model configuration is pinned and checked at start:

- `deepseek-v4-flash` profile;
- `deepseek-flash` model;
- `json_object` response format;
- `thinking: enabled`;
- no `max_tokens`.

This is the production profile pinned by `tests/unit/sales/openai-compatible-provider.test.ts` and verified on the EC2 canaries. Only the `R4_MODEL_*` lines of the local `.env` (endpoint and key) are read. Nothing from them is written to the outputs; `summary.json` records only `authenticated: true`.

## Requirements

1. `npm run db:up`, which starts the local PostgreSQL of `docker-compose.yml` on `127.0.0.1:55432`. To use another server, set `R4_EXPERIMENT_ADMIN_DATABASE_URL` to its `postgres` database. The tool creates and drops its own databases.
2. `npm run build`, because the tools import the built workspace packages.
3. A local `.env` with `R4_MODEL_BASE_URL`, `R4_MODEL_API_KEY` and the other `R4_MODEL_*` values. It is never committed.

## Commands

```sh
# Check the harness without real calls: a stand-in model that copies the Sales rendering; separate root, budget untouched.
node scripts/experiments/j3ec1-offer-fidelity/run.mjs --dry-run --label AB --profiles sales-production@6,sales-production@7 --first 500 --count 2

# Copy fidelity (@7): the phases of the report
node scripts/experiments/j3ec1-offer-fidelity/run.mjs --label A --first 0 --count 30
node scripts/experiments/j3ec1-offer-fidelity/run.mjs --label C --first 100 --count 55 --ambiguous-every 3
node scripts/experiments/j3ec1-offer-fidelity/analyze.mjs A B0 C

# Paired control @6 vs @7 (40 calls)
node scripts/experiments/j3ec1-offer-fidelity/run.mjs --label AB --profiles sales-production@6,sales-production@7 --first 500 --count 20 --max-calls 40
node scripts/experiments/j3ec1-offer-fidelity/analyze.mjs AB

# Historical baseline (input: the whitelisted EC2 extract, see Custody)
node scripts/experiments/j3ec1-offer-fidelity/baseline-analyze.mjs
```

Outputs go to `artifacts/j3ec1-fidelity/` (`--root` overrides it), which is git-ignored:

- `phase-<label>/calls.jsonl`: one line per real call;
- `phase-<label>/samples.jsonl`: one line per conversation;
- `phase-<label>/summary.json`: commit, dirty flag, Node, model configuration, profile fingerprints and arguments;
- `analysis-<labels>.json`.

**Budget.** `budget.json` is the cumulative ledger of the original authorization: 150 calls or US$10, estimated with every input token billed as a cache miss at peak price. `--max-calls` caps one invocation. A paired scenario starts only if every arm can still make its call, so pairs are never left half-done by the cap.

**Scenarios.** `scenario(n)` depends only on `n`. It draws products from the fixture catalog, quantities, a destination among 12 communes or no shipping, catalog variants, names rewritten with special characters, a tax rate of 0.1 in one of six, and the confirmation text. Phase A is n 0–29, phase C is n 100–154 (an ambiguous confirmation every third), and phase AB is n 500–519.

Phase **B0** ran an earlier generator that used the low bits of the LCG. This tool cannot regenerate it; its stored outputs are analyzed as they are.

**Counterbalancing.** In a paired run, the arm that goes first alternates with `n`.

## Metrics (`analyze.mjs`)

A **sample** is a copy point: the offer, or its re-presentation after an ambiguous reply. The first real call at a copy point decides the following metrics.

- **JSON valid**: the response is a parseable decision. Its complement is `invalid_structured_output`.
- **Exact**: the decision is `respond` and its text is byte-identical to `renderOfferMessage(snapshot, reference)`, the Sales rendering of the snapshot in the preview the model saw. This is fidelity for `@7`; for `@6` it is shown for information only.
- **Commercial integrity**: every part below holds.
  - **reference**: the preview's reference appears as a token.
  - **figures**: every amount of the Sales rendering appears in the text as a number, and no `$` amount in the text is foreign to it. The amounts are the unit prices, subtotals, shipping, net, VAT and total. Quantities are covered through the subtotals.
  - **names**: every line description appears verbatim.

  Phases A–C predate this field. For them, an exact copy counts as intact on every part.
- **Retries**: further real calls at the same copy point, meaning the platform asked again.
- **Issuance**: the decisions `quote.create` recorded in `sales.quote_autonomous_decisions`. `rejected:offer_not_presented` is a refusal because of the offer.
- **Tokens and latency** per real call, as reported by the provider and measured around the call.

**Statistics.**

- Rates carry exact Clopper-Pearson 95 % intervals.
- Paired binary outcomes (JSON, integrity, issuance) use McNemar's exact test on the discordant pairs.
- Paired tokens and latency use the median difference and a two-sided sign test.

With 20 pairs, only very large differences can be detected; no result here is a rollout criterion.

## Custody

| What | Where | Notes |
|---|---|---|
| Experiment outputs (phases P, A, B0, C, AB) | `artifacts/j3ec1-fidelity/` on the workstation that ran them (git-ignored) | Synthetic conversations and fixture data only: no customer, no PII, no production data. `calls.jsonl` keeps offer text only as a ±40-character diff, or the first 600 characters of an unparseable response. `texts.jsonl` (phase AB onwards) keeps the Sales rendering and the model's text of each real call, so integrity can be recomputed; `analyze.mjs` checks both against the hashes in `calls.jsonl`. Phase AB's `texts.jsonl` was rebuilt from the run's delivery captures, and each text was accepted only when its hash matched (report §8.8). |
| EC2 baseline extract | `artifacts/j3ec1-baseline/` (git-ignored) | Read-only extraction from `~/r4-j3d/j3e{,b}-canary-run.log` on the EC2 canary host. Fields come from an allowlist: times, ids, provider, model, finishReason, tokens, latency, decision type and outcome, run status, recovery events. `canary-config.txt` holds the `R4_MODEL_*`/`R4_EXEC_*`/`R4_PROD_POLICY_PROFILE` settings of the canary env files: settings, not secrets. |
| Original tools of phases P–C | session scratchpad `…/4c36bb87-dc4c-4dd7-ab8c-b4323e81bb0a/scratchpad/j3ec1-tools/` (outside Git) | `fidelity-run.mjs` `6b46eaa6…`, `fidelity-analyze.mjs` `8073b31a…`, `baseline-analyze.mjs` `5f5950b4…`. The tools here are those, made lint-clean, with `--profiles`, `--dry-run` and the integrity metric added. The scenario generator and the scripted turns are unchanged. `analyze.mjs A B0 C` reproduces the report's figures from the stored outputs, and `baseline-analyze.mjs` reproduces `baseline.json` byte for byte. |

The SHA-256 of every evidence file is in the report, §8.8.

## Validity limits

- **Partially scripted context.** The agent's earlier turns are short scripted texts.
- **Fixture data.**
- **One model, one configuration, one time window.**
- **Model sampling is not deterministic.** A rerun produces new samples, not the same outputs. The analyses can be recomputed exactly from the stored outputs.
