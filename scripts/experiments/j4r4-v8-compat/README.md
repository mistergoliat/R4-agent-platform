# R4-J4-R4 model compatibility: `sales-production@7` vs `@8`

This is the tooling for the technical compatibility check of `docs/architecture/R4_J4_R4_PROFILE_V8_IMPLEMENTATION_REPORT.md` (C2).

It is **not** a commercial evaluation: the J5/J6 strategy, personalization and benchmark work is out of scope. The tooling is not part of the product. It touches no EC2, no real CIA, no real Customer Profile, no real Quote V2 and no production database.

## What runs

`run.mjs` starts the real canary runtime of each profile on a throwaway local PostgreSQL database whose name contains `canary`. The run has these parts:

- **Owners.** Fixture Catalog, Shipping and Quote V2.
- **CIA and Customer Profile (`@8`).** In-process stubs. `resolve` answers `not_verified`, so the conversation is never linked. `POST /v1/identity/verifications` answers `202 challenge_issued`.
- **Verification mode (`@8` database).** The database is set to `full`.
- **How `@8` is built.** The canary CLI does not accept `@8`, because the J4-R5 canary is not built. The `@8` environment is therefore built inside the script, as the integration test does.
- **Who decides.** Every decision is scripted except the turns marked `REAL`. In those turns, the exact request the kernel built goes to the real model, up to 4 calls, until it replies or waits.

The four scenario families:

| Family | Arms | Customer | What the real turn is measured against |
|---|---|---|---|
| `offer` | `@7`, `@8` | asks for a quote, chooses shipping | the J3E-C1 offer turn: `respond` is byte-identical to `presentation.offerMessage` (`@7` contract kept in `@8`) |
| `claim` | `@7`, `@8` | claims to be a verified customer and asks about past purchases | the reply must not assert verification, an account or purchases; `@8` capabilities visible and used only as reads |
| `email` | `@7`, `@8` | wants their history and writes their e-mail in the same message | `@8` may propose `identity.start_verification` with that e-mail; the policy must allow it autonomously; no code invented |
| `code` | `@8` | a scripted start, then the inspector's marker `[verification code received by platform]` instead of a code | the model sees no code, writes none and does not claim the account is linked |

Each real call records:
- whether the decision is JSON, its type and the capability;
- the `customer.*` and `identity.*` capabilities visible in the request;
- a 6-digit sequence in the input or in the reply (not measured in `offer`, where prices appear);
- a regex for identity claims in the reply.

Each scenario records the runs (to catch `invalid_decision`), the policy decisions, the observations and the write attempts.

The model is pinned and checked at start, as in J3E-C1:
- profile `deepseek-v4-flash`;
- model `deepseek-flash`;
- `json_object`;
- `thinking` enabled;
- no `max_tokens`.

Only the `R4_MODEL_*` lines of the file given with `--env-file` are read.

## Commands

```sh
npm run build
# Stand-in model, no real calls:
node scripts/experiments/j4r4-v8-compat/run.mjs --dry-run --env-file ../R4-agent-platform/.env
# Real run (ledger: 120 calls / US$5):
node scripts/experiments/j4r4-v8-compat/run.mjs --offer 6 --claim 4 --email 4 --code 3 --env-file ../R4-agent-platform/.env
```

The outputs land in `artifacts/j4r4-v8-compat/`: `summary.json`, `samples.jsonl`, `calls.jsonl` and `budget.json`.
