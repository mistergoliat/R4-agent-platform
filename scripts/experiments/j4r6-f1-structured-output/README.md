# R4-J4-R6 F-1: one decision document per turn

Tooling for `docs/architecture/R4_J4_R6_F1_STRUCTURED_OUTPUT_CORRECTION_REPORT.md`. It measures how often the pinned
production model profile answers a decision turn with something the strict parser rejects (ADR-008, no repair):
several concatenated JSON documents, or a document with prose. It is not a commercial evaluation. It touches no EC2,
no real CIA, no real Customer Profile, no real Quote V2 and no production database. All data is synthetic.

## Modes

- **`capture`.** Runs the real canary runtime of `sales-production@7` and `@8` on throwaway local databases whose
  names contain `canary`. The owners are fixture Catalog, Shipping and Quote V2. The CIA and Customer Profile are
  in-process stubs serving synthetic fixtures (a verified grant, and CP v1-rc2 `available`). Decisions are scripted.
  At each REAL turn, the exact `ModelRequest` the kernel built is saved under
  `artifacts/j4r6-f1-structured-output/requests/` and the turn ends. No model call is made.
- **`replay`.** Sends every saved request to the real model `--repeat` times, through the adapter of the current
  build. It records the parser verdict and the shape of each answer (`shapeOf`: document types and the count of
  characters outside them), never the answer text.
  - `malformed` means a reject code of `invalid_structured_output`, `invalid_decision_schema` or
    `unknown_decision_type`.
  - `semantic` means a structurally valid decision that the platform facts reject.
- **`summary`.** Prints the malformed rate per arm and request family, and the shapes.

The baseline and the candidate use **the same saved requests**. The only difference between arms is the adapter
build that renders them. The kernel's request (protocol v5, context and schema) is identical.

## Request families (21 requests)

| Family | Profile | What the turn invites |
|---|---|---|
| `multi` / `multi-after-read` | `@7`, `@8` guest | Several products and a shipping quote; first decision, or after one catalog read |
| `linked` / `linked-after-history` | `@8`, CIA verified | History plus current stock; first decision, or after the history read |
| `history` | `@7` | Purchase history, which `@7` cannot read |

## Model

The model is pinned and checked at start, as in J3E-C1 and J4-R4:
- profile `deepseek-v4-flash`;
- model `deepseek-flash`;
- `json_object`;
- `thinking` enabled;
- no `max_tokens`.

`--thinking-disabled` is an informational arm only. Only the `R4_MODEL_*` lines of `--env-file` are read.

## Commands

```sh
npm run build
node scripts/experiments/j4r6-f1-structured-output/run.mjs capture
node scripts/experiments/j4r6-f1-structured-output/run.mjs replay --arm baseline --repeat 3 --env-file ../R4-agent-platform/.env
# after the adapter change and a rebuild:
node scripts/experiments/j4r6-f1-structured-output/run.mjs replay --arm candidate --repeat 3 --env-file ../R4-agent-platform/.env
node scripts/experiments/j4r6-f1-structured-output/run.mjs summary
```

Hard stops: the cumulative ledger (`budget.json`: 400 calls / US$6) and `--max-calls`.
