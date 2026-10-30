# R4-J4-R7 G-sem: semantic validation of the Turn Completion Guard

Tooling for `docs/architecture/R4_J4_R7_GSEM_PREREGISTRATION.md`. It measures how the production model interprets
customer messages with `R4_TURN_GUARD=enforce`. The runtime suites already prove what the platform does with any
decision; this measures which decision the real model takes. It touches no EC2, no production database and no customer
data. All data is synthetic.

- Runtime: the real canary runtime of `sales-production@8` on one throwaway local `canary` database per arm.
- Owners: fixture Catalog, Shipping and Quote V2; in-process CIA and Customer Profile stubs; fake WhatsApp.
- Earlier turns are scripted. From the message under test on, the real model decides, up to 6 calls per case.
- Arm A uses the v8 instructions. Arm B replaces one v8 sentence with the v9 draft (`R4_J4_R7_DESIGN.md` §3.4), only in
  the request sent by this experiment. The Sales pack does not change.

## Commands

```sh
npm run build
node scripts/experiments/j4r7-gsem/run.mjs run --dry-run                  # no network: every case and the summary
node scripts/experiments/j4r7-gsem/run.mjs run --arm A --env-file ../R4-agent-platform/.env
node scripts/experiments/j4r7-gsem/run.mjs summary
node scripts/experiments/j4r7-gsem/run.mjs run --arm B --env-file ../R4-agent-platform/.env   # refused unless activated
```

Only the `R4_MODEL_*` lines of `--env-file` are read. A run refuses uncommitted changes under `adapters`, `packages`,
`apps` or `agents`.

## Budget

`<root>/budget.json` is written before every real call, and a failed call stays counted. Limits: 500 calls / US$8 in
total, arm A at most 300 calls / US$4.5. Finished replicas are not repeated. A replica lost to the network gets one
more attempt, within the ledger.

## Output

- `samples.jsonl`: the durable trajectory of each replica (decisions, events, outbound, policy). No reasoning is kept.
- `summary.md`: metrics M1–M7 and the per-case table.
- `review/closures-<arm>.md`: every ratified closing, for the designated human reviewer.
- `review/text-sample-<arm>.md`: reply texts of C03, C09, C10 and C12, plus candidate effect claims.
- `review/REVIEWED`: the reviewer creates this file when the verdicts are recorded. Until then, a run with closings
  cannot be `G_SEM_PASS`.
