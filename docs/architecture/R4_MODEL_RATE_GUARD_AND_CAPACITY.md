---
title: R4 — Model request-rate guard and lane capacity estimate
status: IMPLEMENTED (branch feat/r4-model-rate-guard, review round 1 applied); not deployed; off unless configured
mandate: owner, 2026-11-18 — protect provider capacity (20 RPM) before the first real-customer cohort
---

# Model request-rate guard and lane capacity

## 1. Facts (measured 2026-11-18)

- The production model is `openai/gpt-6-luna` through OpenRouter. Its limit is **20 requests per minute, per
  model** (`new-account-rpm/openai/gpt-6-luna`). A burst of 25 got 20 × 200, then 429 with
  `x-ratelimit-limit: 20`.
- Luna is shared by four processes:
  - the main worker (`r4-sales-worker`, almost idle);
  - the WhatsApp lane worker (`r4-sales-worker-lane`, the commercial traffic);
  - the web QA worker (`r4-web-qa-worker`);
  - image perception in the channel gateway (`r4-channel-gateway`), which uses vision on the same model.

  Speech-to-text runs on another model, `openai/whisper-large-v3-turbo`, which has its own per-model limit.
- In production, `R4_EXEC_MODEL_CALL_TIMEOUT_MS`, `R4_EXEC_MAX_RUN_DURATION_MS` and
  `R4_EXEC_MAX_RUN_FAILURE_RECOVERIES` are unset, so the code defaults apply: 60 s per call, 15 min per run, and 1
  recovery run.
- Today a 429 is classified `rate_limited` and is retryable. The call fails, the run becomes recoverable, and a new
  run makes its model calls again. A burst therefore stalls customer turns and can cascade.
- A customer turn makes a mean of 3.3 model calls (p90 7, max 16), at 3–8 s each.
- **A worker runs one task at a time** (`apps/worker/src/worker.ts`), and a run makes its model calls one after
  another. So each worker process has at most one model call in flight.

## 2. Design

**Where.** `DefaultModelGateway` (`packages/model-gateway`) takes an optional `RequestRateLimiter`. The worker
platform (`apps/worker/src/platform.ts`) builds one limiter per process from `R4_MODEL_MAX_REQUESTS_PER_MINUTE`.
Every worker composition goes through it: production, lane, web QA, canary and harness. Unset means no limiter,
which is today's behaviour.

**What it enforces.** At most N calls *start* in any rolling 61 s window. It is a rolling window, not a token bucket:
a bucket of capacity N refilled at N/min admits up to 2N starts in one minute, and a provider that counts N per
rolling or calendar minute answers the extra ones with 429. The extra second is margin for network jitter.

**How a call behaves.**

1. It reserves the earliest start that keeps the window. Reservations are taken in arrival order (FIFO), so no
   caller is overtaken or starved.
2. If that start is within the call's own timeout or one window, whichever is longer, the call sleeps on one timer
   until then (no polling) and then calls the provider. The provider still gets its full timeout, as without a
   budget. `latencyMs` does not include the wait.
3. Otherwise nothing is reserved and the call fails at once as `rate_limited` (retryable), exactly as a 429 does
   today, without reaching the provider.
4. A call cancelled while it waits returns `cancelled`, and nothing is sent.
5. When the provider answers 429 anyway, the limiter marks its window as full (`saturate`). The next call then waits
   one window instead of meeting another 429 at once.

**A worker is never refused.** Because a worker has one call in flight, its next start is never more than one window
away. The bound in step 2 is at least one window, so a worker's own calls only ever wait, whatever its budget or its
timeout. Two earlier versions of this bound were wrong:

- *Half the timeout* refused the 4th call of every long turn on a small budget. The retried run spent its first
  calls again and failed in the same place, which is a livelock.
- *The timeout alone* (60 s, shorter than the 61 s window) refused a call that started less than 1 s after the
  previous one. On a budget of 1 that is exactly the main worker's recovery run after a fast failure. The refused
  call used up its single recovery and handed the conversation to a person.

A test now reproduces that case: budget 1, a second call 400 ms after a fast failure must wait, not be refused.

**Telemetry.**

- `model.call.throttled` is logged for every call that waited (`outcome: "waited"`, with `waitMs`) or was refused
  (`outcome: "refused"`), along with the correlation ids, `maxRequests` and `windowMs`.
- A refused call also logs the usual `model.call.failed` with `errorKind: "rate_limited"`.
- At boot, every worker logs `model.rate_guard` with `maxRequestsPerMinute`, or `unlimited`. The WhatsApp gateway
  logs `model.rate_guard` with `perceptionVisionMaxRequestsPerMinute`.

**Monitor.** `ops/r4-provider-budget/check.mjs` counts `model.call.throttled` events in its window: waited, refused
and total wait. It adds `throttled <waited>+<refused>` to its status line and snapshot. It raises a WARN at
`WARN_THROTTLED` waits (default 30 per 60 min), which means sustained saturation. Refused calls are already counted
by the existing `rate_limited` thresholds.

**Perception: vision only, with its own share.**

- Provider limits are per model, and speech runs on whisper, so only **vision** calls count against the Luna budget.
  They are budgeted by `R4_PERCEPTION_VISION_MAX_REQUESTS_PER_MINUTE`.
- Speech is not budgeted. Voice notes are rare and whisper has its own limit; a 429 there degrades as it does today.
  If whisper ever needs a budget, it gets its own variable and never shares Luna's.
- Vision runs in the gateway process, so it cannot share a worker's limiter.
- A vision call waits at most half of its perception timeout, because the perceiver's outer deadline must still fit
  the request. If no start fits, it fails as `perception_rate_limited`, and the perceiver degrades it to
  `perception_failed`. That marker is durable, so the photo is never perceived. With a share of 4, a burst of 5 or
  more photos within about half a minute loses the 5th onward. With a share of 2, the 3rd photo in a minute was
  already lost: that is why the share went from 2 to 4.

**Restarts and crashes reset the window.** A restarted process forgets its earlier starts, so in the first window
after a restart it may start its full share again: up to twice its share, if it was busy just before. The provider
then answers some calls with 429, and step 5 makes the process back off for one window after the first one. This
costs at most one rejected call per restarted process. Restarts happen only at deploy (`ops/r4-inbound-media/deploy.sh`
restarts every worker) or after a crash, so this is accepted rather than persisted.

**What is unchanged:** the provider adapter, how a real 429 is classified, retries and recovery, and every process
that does not set the variables.

## 3. Configuration

### Values (per process; the total per model stays at or under the provider's limit)

| Process | Variable | 20 RPM (now) | 50 RPM | 100 RPM |
|---|---|---|---|---|
| `r4-sales-worker-lane` | `R4_MODEL_MAX_REQUESTS_PER_MINUTE` | **12** | 42 | 92 |
| `r4-channel-gateway` | `R4_PERCEPTION_VISION_MAX_REQUESTS_PER_MINUTE` | **4** | 4 | 4 |
| `r4-web-qa-worker` | `R4_MODEL_MAX_REQUESTS_PER_MINUTE` | **3** | 3 | 3 |
| `r4-sales-worker` (main) | `R4_MODEL_MAX_REQUESTS_PER_MINUTE` | **1** | 1 | 1 |
| Luna total | | **20** | 50 | 100 |

Lane 12 serves the same 3 concurrent conversations as lane 14 (p90 54 s, §5). With a single lane worker, the lane is
limited by the worker, not by its share.

### Which file each value goes in (on the host)

| Process | Loads | Put the value in |
|---|---|---|
| `r4-sales-worker-lane` | `production.env`, then `production-lane.env` (overrides) | `production-lane.env`: `R4_MODEL_MAX_REQUESTS_PER_MINUTE=12` |
| `r4-channel-gateway` | `production.env`, `secrets/perception.env` | `secrets/perception.env`: `R4_PERCEPTION_VISION_MAX_REQUESTS_PER_MINUTE=4` |
| `r4-web-qa-worker` | its own env files | its own env file: `R4_MODEL_MAX_REQUESTS_PER_MINUTE=3` |
| `r4-sales-worker` (main) | `production.env` only | **not** `production.env` (see below): a main-only source, e.g. a `production-main.env` loaded after `production.env` (the lane's pattern) or the pm2 process env of `r4-sales-worker` |

**Never put `R4_MODEL_MAX_REQUESTS_PER_MINUTE` in `production.env`.** The lane loads it too. Without its override,
the lane would be capped at main's value of 1, so one missing line would turn a customer turn into minutes. Main
therefore needs a source of its own.

Until main has one, leave main unset (unlimited). That is the risk accepted today: main is almost idle, and
because it is serial it can only exceed its share while it is actually serving a turn. The vision variable is read
only by the gateway, so it cannot cap a worker, but it still belongs in `secrets/perception.env`.

### Main at budget 1: what it costs

On a budget of 1, every call after a turn's first waits about one window, 61 s minus the previous call:

| Calls in the turn | Turn time at budget 1 | At budget 2 |
|---|---|---|
| Mean, 3.3 | about 2.5 min | about 1–1.5 min |
| p90, 7 | about 6 min | about 3 min |
| Max, 16 | about 15 min | about 7 min |

A 16-call turn at budget 1 does not fit in the 15 min run limit (`R4_EXEC_MAX_RUN_DURATION_MS` default). That is
acceptable only while main serves no real contact. **If main ever serves a real contact, use main 2 / web QA 2.**

### Operator steps (when a deployment is authorized)

1. Set each value in the file named above, then restart the processes.
2. Check the boot logs:
   - each worker logs `model.rate_guard` with the expected `maxRequestsPerMinute`; the lane must show 12, not 1 and
     not `unlimited`;
   - the gateway logs `model.rate_guard` with `perceptionVisionMaxRequestsPerMinute: "4"`.
3. Keep the budget monitor's `WARN_THROTTLED` at the default of 30.
4. After that, `model.call.failed` with `rate_limited` should stay near zero, apart from at most one per process
   after a restart. Anything else that uses the same key and model, such as an ad hoc probe or an evaluation run,
   counts against the 20 too: run it when the lane is quiet.

## 4. Static split or a shared limiter?

**Static split, for now.**

- It costs the lane nothing today. One lane worker saturates at about 11 calls/min, below its share of 12. The share
  binds only on short bursts of fast calls, which is exactly when today's 429s happen (the lane together with QA or
  perception).
- A shared limiter is new infrastructure without a demonstrated need (AGENTS.md).
- The idle shares cost the lane at most 8 RPM. That only matters once there are several lane workers.

**Trigger to revisit:** two or more lane workers below 50 RPM (§5: two workers each holding 6 at 20 RPM do *worse*
than one), or sustained `throttled` waits on one process while the others are idle.

### Future option: one budget per model in PostgreSQL (sketch, not built)

- **Table:** `model_rate_starts(model_key text, started_at timestamptz)`, indexed on `(model_key, started_at desc)`.
  This needs a Core migration.
- **Per call**, in one short transaction on the database clock:
  1. `pg_advisory_xact_lock(hashtext(model_key))`;
  2. read the N-th most recent `started_at`;
  3. compute `start = greatest(now(), nth + window)`, refusing when it is beyond the call's bound;
  4. insert `start`;
  5. commit, then sleep until `start` outside the transaction.
- **Housekeeping:** delete rows older than the window from time to time.
- **Cost:** one round trip (about 1 ms) per model call of 3–8 s. FIFO order is then across processes too, and the
  window survives restarts.
- **Open decision:** what to do when the database is unavailable. Fail closed: no model calls, but the worker
  cannot work without the database anyway. Fail open: use a local static share. The static split in §3 is the
  natural fallback.

## 5. Capacity estimate

### Model

A closed queueing system, simulated with discrete events using the shipped `RequestRateLimiter`. The script is
`scripts/experiments/model-rate-capacity/run.mjs`; it uses deterministic seeds and needs `npm run build` first.

- **Conversations.** N concurrently active conversations. A customer reads the reply and writes again after a think
  time `Z ~ Exp(60 s)`; sensitivity is shown for 30, 120 and 300 s.
- **Workers.** k lane workers, each serving one turn at a time, with turns queued FIFO. **Each worker is its own
  process with its own limiter**, holding `floor(lane budget / k)`.
- **Calls per turn.** `C ~ Geometric(1/3.3)`, truncated at 16, which gives mean 3.3 and p90 7 as in production.
- **Latency.** Each call takes `U(3, 8) s`. The service time is `S = Σ latency`, with E[S] ≈ 18 s and sd ≈ 15 s; an
  unloaded turn has a p90 of about 37 s.
- **Lane budget.** The model's RPM minus 8 (vision 4, QA 3, main 1). A call refused under the gateway's bound is
  counted; none occurred in the rows below.
- **Acceptable latency.** Turn latency (message in → reply) with **p90 ≤ 60 s and mean ≤ 30 s**, and refusals
  ≤ 0.1 %.

**Closed-form check.** One worker saturates at 1/E[S] ≈ 3.3 turns/min, about 11 calls/min. A worker whose share is
below the length of a long turn stretches that turn by a full window per extra call. At 20 RPM with two workers,
each holds 6, so every turn of more than 6 calls (about 10 % of turns) waits at least 61 s.

### Result: maximum concurrently active conversations at acceptable latency (Z = 60 s)

| Model RPM | Lane budget | 1 lane worker | 2 workers | 4 workers | 8 workers |
|---|---|---|---|---|---|
| 20 | 12 | **3** (p90 54 s) | **0**, worse than 1 worker (6 each; p90 64 s already at 1 conversation) | — | — |
| 50 | 42 | 3 | 8 (21 each; p90 58 s) | **16** (10 each; p90 58 s) | — |
| 100 | 92 | 3 | 8 | 18 (23 each; p90 53 s) | **36** (11 each; p90 54 s) |
| unlimited | — | 3 | | | |

One conversation more than each cell crosses the line. For example, 4 conversations on one worker give a p90 of
71 s and a mean of 34 s.

**Sensitivity to think time Z:**

| Z | 20 RPM, 1 worker | 50 RPM, 2 workers | 50 RPM, 4 workers | 100 RPM, 8 workers |
|---|---|---|---|---|
| 30 s | 2 | 6 | 11 | 24 |
| 60 s | 3 | 8 | 16 | 36 |
| 120 s | 4 | 13 | 25 | 60 |
| 300 s | 8 | 25 | 51 | ≥ 120 (scan limit) |

### Reading

- **Today the bottleneck is the single lane worker, not the 20 RPM.** With one worker, 20, 50, 100 RPM and unlimited
  all give the same 3 conversations at Z = 60 s. The guard does not add capacity. It removes the failure mode where
  bursts from the lane, QA and vision together exceed 20 and turns stall on 429 retries.
- **Do not add a second lane worker at 20 RPM.** Split per process, each worker would hold 6, and every long turn
  would wait a whole window. Two workers there need either a shared budget (§4) or more RPM.
- From 50 RPM upward, capacity grows with workers, at roughly one worker per 10–11 RPM of lane budget.
- Shorter turns raise every number in proportion. Fewer calls per turn or faster calls reduce E[S], so the latency
  work (F-E1-2) is worth as much as more RPM.

### Recommendation for the first cohort

Keep **one lane worker**, apply the split (lane 12, vision 4, QA 3, main 1 from its own source), and size the cohort
so that the **expected peak of concurrently active conversations is about 1, and 3 or fewer 98 % of the time**.

How the cohort size follows, as an assumption to replace with measured data:

- each customer has about one 10-minute conversation per day, over 10 opening hours, with the peak hour at twice the
  average;
- then a cohort of M customers has a mean peak concurrency of M / 30;
- **M ≈ 30 customers** gives a mean of 1 and P(≥ 4) ≈ 2 %;
- M = 60 gives a mean of 2 and P(≥ 4) ≈ 14 %, which is too high.

Before growing past that, get the provider limit raised to at least 50 RPM **and** add lane workers. At 50 RPM, 4
workers support about 16 concurrent conversations, roughly 150–250 customers. During the cohort, watch the monitor's
`throttled` count and turn latency (`scripts/r4-f1-latency.mjs`). Sustained throttling, or a p90 above 60 s, is the
signal to stop growing.

## 6. Not done (on purpose)

- No cross-process limiter (§4, sketch only).
- No persistence of the window across restarts. The 429 back-off covers it (§2).
- No adaptive limiting from the provider's `x-ratelimit-*` headers, beyond the back-off after a 429.
- An aborted waiter keeps its reservation, so one start of the window is lost. That is negligible at a few aborts
  per hour.
