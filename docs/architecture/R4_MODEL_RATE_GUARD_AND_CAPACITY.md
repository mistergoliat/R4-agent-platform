---
title: R4 — Model request-rate guard and lane capacity estimate
status: IMPLEMENTED (branch feat/r4-model-rate-guard); not deployed; off unless configured
mandate: owner, 2026-11-18 — protect provider capacity (20 RPM) before the first real-customer cohort
---

# Model request-rate guard and lane capacity

## 1. Facts (measured 2026-11-18)

- The production model (`openai/gpt-6-luna` through OpenRouter) is limited to **20 requests per minute per account**.
  A burst of 25 got 20 × 200, then 429 (`x-ratelimit-limit: 20`).
- One key is shared by the main worker (`r4-sales-worker`, almost idle), the WhatsApp lane worker
  (`r4-sales-worker-lane`, the commercial traffic) and the web QA worker (`r4-web-qa-worker`). Image perception and
  speech-to-text (`R4_PERCEPTION_*`) run in the channel gateway (`r4-channel-gateway`) and use the same account.
- Today a 429 is `rate_limited`, retryable: the call fails, the run becomes recoverable and is retried later, with its
  model calls made again. A burst therefore stalls a customer turn and can cascade.
- Per customer turn: mean 3.3 model calls, p90 7, max 16; 3–8 s per call.
- **A worker runs one task at a time** (`apps/worker/src/worker.ts`), and a run makes its model calls one after
  another. So each worker process has at most one model call in flight. This matters below.

## 2. Design

**Where.** `DefaultModelGateway` (`packages/model-gateway`) takes an optional `RequestRateLimiter`. The worker platform
(`apps/worker/src/platform.ts`) builds one per process from `R4_MODEL_MAX_REQUESTS_PER_MINUTE`. Every worker
composition (production, lane, web QA, canary, harness) goes through it. Unset = no limiter = today's behaviour.

**What.** At most N calls *start* in any rolling 61 s window. It's a rolling window and not a token bucket on purpose:
a bucket of capacity N that refills at N/min admits up to 2N starts in one minute, and a provider that counts N per
rolling or calendar minute answers the extra ones with 429. The extra second covers network jitter between our clock
and the provider's.

**How a call behaves.**

1. It reserves the earliest start that keeps the window. Reservations go in arrival order (FIFO), so no caller can be
   overtaken or starved.
2. If that start is within the call's own timeout (`limits.timeoutMs`, which is `R4_EXEC_MODEL_CALL_TIMEOUT_MS`,
   60 s by default), the call sleeps on one timer until then, with no polling, and then calls the provider. The
   provider still gets its full timeout, as without a budget. The wait is not counted in `latencyMs`.
3. If the start is further away than that, nothing is reserved and the call fails at once as `rate_limited`
   (retryable), exactly as a 429 does today, without reaching the provider. It doesn't wait in vain first.
4. If the call is cancelled while it waits, it returns `cancelled` and nothing is sent.

Why the bound is the call's timeout and not a fraction of it: a worker has one call in flight, so its own wait is
never longer than one window minus the duration of its previous call. With the default 60 s timeout, a worker's own
calls are therefore **never refused, even on a budget of 1**. They only slow down. A refusal means real overload
from concurrent callers. If the bound were shorter (for example half the timeout), a process with a small budget
would get its 4th call refused on every long turn. The retried run would spend its first calls again and fail again
in the same place: a livelock.

**Telemetry.** `model.call.throttled` is logged for every call that waited (`outcome: "waited"`, `waitMs`) or was
refused (`outcome: "refused"`), with the correlation ids, `maxRequests` and `windowMs`. A refused call also logs the
usual `model.call.failed` with `errorKind: "rate_limited"`. At boot, each worker logs `model.rate_guard` with its
`maxRequestsPerMinute` (or `unlimited`), so the operator can confirm the split from pm2 logs.

**Monitor.** `ops/r4-provider-budget/check.mjs` now counts `model.call.throttled` in its window (waited, refused,
total wait) and adds `throttled <waited>+<refused>` to its status line and snapshot. It raises a WARN at
`WARN_THROTTLED` waits (default 30 per 60 min): this is sustained saturation, meaning the split or the provider
limit is too small. Refused calls are already counted by the existing `rate_limited` thresholds.

**Perception.** It runs in another process (the channel gateway), so it can't share the workers' limiter. It gets
its own share through `R4_PERCEPTION_MAX_REQUESTS_PER_MINUTE`, with one limiter for vision and speech together. A
perception call waits at most half its perception timeout, because the perceiver's outer deadline must still fit
the request. If it gets no start in time, it fails `perception_rate_limited`, and the perceiver degrades it
(`perception_failed`) exactly as it does a 429 today. Volume is low: one call per image or voice note.

**What is unchanged.** The provider adapter, the classification of a real 429, retries and recovery, and every
process that does not set the variables.

## 3. Configuration

The budget is per process. Each process must get its value **in its own environment** (its pm2 env or its own env
file). A value placed in an env file that several processes load applies to *each* of them, so they would add up.

| Process | Variable | 20 RPM account (now) | 50 RPM | 100 RPM |
|---|---|---|---|---|
| `r4-sales-worker-lane` (WhatsApp lane) | `R4_MODEL_MAX_REQUESTS_PER_MINUTE` | **14** | 44 | 94 |
| `r4-web-qa-worker` | `R4_MODEL_MAX_REQUESTS_PER_MINUTE` | **3** | 3 | 3 |
| `r4-sales-worker` (main, @3, almost idle) | `R4_MODEL_MAX_REQUESTS_PER_MINUTE` | **1** | 1 | 1 |
| `r4-channel-gateway` (perception) | `R4_PERCEPTION_MAX_REQUESTS_PER_MINUTE` | **2** | 2 | 2 |
| Total | | **20** | 50 | 100 |

The rule is that the sum over every process holding the key must be at most the account limit. If more lane workers
are added (§5), the lane share is divided between them, for example 2 × 22 at 50 RPM. A budget of 1 on the main
worker is safe because its calls wait and are not refused (§2). A 3-call turn there takes about 2 minutes, which is
acceptable for a near-idle profile. If main starts carrying real traffic, move budget to it from QA.

Operator steps, when the deployment is authorized: set the variables per process, restart, then check that each
worker logged `model.rate_guard` with the expected value and that the gateway's pm2 environment carries
`R4_PERCEPTION_MAX_REQUESTS_PER_MINUTE`. The gateway does not log it at boot. In the budget monitor's env file, `WARN_THROTTLED=30` is the default. After that,
`model.call.failed` with `rate_limited` should stay at zero unless something outside R4 uses the same key, such as
an ad hoc probe or an evaluation run. Those must be counted in the split too, or run when the lane is quiet.

## 4. Static split or a shared limiter (PostgreSQL)?

**Static split, for now.** Reasons:

- It costs the lane nothing today. One lane worker serves turns one at a time and averages about 11 calls/min when
  saturated (60 s / 5.5 s per call), which is below its share of 14. The share binds only on short bursts of fast
  calls. That is exactly when the 429s happen today, when the lane coincides with QA or perception.
- A shared limiter needs a Core schema migration (a table of call starts plus an advisory lock per call), a database
  round trip before every model call, and a decision about what happens when the database is slow or down (stop
  all model calls, or fail open). That is new infrastructure without a demonstrated need (AGENTS.md).
- The idle shares (QA 3, main 1, perception 2) cost the lane at most 6 RPM. That only matters once there are several
  lane workers.

**Revisit when** there are two or more lane workers on a 20 RPM account, or when the monitor shows sustained
`throttled` waits on one process while the others are idle. Raising the provider's limit (OpenRouter's
`new-account-rpm` tier) is cheaper than either.

## 5. Capacity estimate

### Model

This is a closed queueing system, simulated with discrete events using the shipped `RequestRateLimiter`
(`scripts/experiments/model-rate-capacity/run.mjs`, deterministic seeds; run it with `npm run build` first):

- **N concurrently active conversations.** A customer reads the reply and writes again after a think time
  `Z ~ Exp(60 s)`. Sensitivity is shown for 30, 120 and 300 s.
- **k lane workers.** Each serves one turn at a time; turns wait FIFO.
- **Calls per turn** `C ~ Geometric(1/3.3)`, truncated at 16. This gives mean 3.3 and p90 7, matching production.
  **Per-call latency** `~ U(3, 8) s`. So the service time is `S = Σ latency`, with E[S] ≈ 18 s, sd ≈ 15 s, and an
  unloaded turn p90 of about 37 s.
- **Lane budget** = the account RPM minus 6 (QA 3, main 1, perception 2), enforced by the real limiter. A call
  refused after 60 s is counted (none occurred in any row below).
- **Acceptable**: turn latency (message in → reply) with **p90 ≤ 60 s and mean ≤ 30 s**, and refusals ≤ 0.1 %.
  That is at most about 1.6 times the unloaded latency.

Closed-form check. One worker saturates at 1/E[S] ≈ 3.3 turns/min, about 11 calls/min. A lane budget of R RPM
supports R / 3.3 turns/min (14 → 4.2; 44 → 13.3; 94 → 28.5). Under 20 RPM, one worker is therefore worker-bound and
two workers are budget-bound. A conversation keeps its worker busy E[S] / (Z + R) of the time: about 20 % at Z = 60 s.
The p90 limit is reached well before saturation, at a worker utilization of about 55–60 %.

### Result: maximum concurrently active conversations at acceptable latency (Z = 60 s)

| Account RPM | Lane budget | 1 lane worker | 2 workers | 4 workers | 8 workers |
|---|---|---|---|---|---|
| 20 | 14 | **3** (p90 55 s) | 4 (p90 52 s) | — (budget-bound) | — |
| 50 | 44 | 3 | 8 (p90 58 s) | **17** (p90 51 s) | — (budget-bound) |
| 100 | 94 | 3 | 8 | 18 (p90 53 s) | **38** (p90 52 s) |
| unlimited | — | 3 | | | |

One more conversation than each cell crosses the line: for example, 4 conversations on 1 worker give a p90 of 67 s
and a mean of 33 s.

Sensitivity to think time, best useful worker count per row:

| Think time Z | 20 RPM, 1 worker | 20 RPM, 2 workers | 50 RPM, 4 workers | 100 RPM, 8 workers |
|---|---|---|---|---|
| 30 s | 2 | 3 | 12 | 26 |
| 60 s | 3 | 4 | 17 | 38 |
| 120 s | 4 | 6 | 29 | 63 |
| 300 s | 8 | 13 | 60 | ≥ 120 (scan limit) |

### Reading

- **Today the bottleneck is the single lane worker, not the 20 RPM.** With one worker, 20, 50, 100 RPM and unlimited
  all give the same capacity: 3 concurrently active conversations at Z = 60 s. The guard does not add capacity. It
  removes the failure mode where bursts from the lane, QA and perception together exceed 20 and turns stall on 429
  retries.
- At 20 RPM, a second lane worker adds only one conversation (4), because two workers together would want about
  22 calls/min against a share of 14. More capacity needs **both** more lane workers **and** a higher provider limit:
  roughly one worker per 11 RPM of lane budget.
- Shorter turns raise every number in proportion. Fewer calls per turn or faster calls mean a lower E[S], and the
  latency work (F-E1-2) is worth as much as more RPM.

### Recommendation for the first cohort

Keep one lane worker, apply the 14/3/1/2 split, and size the cohort so that the **expected peak number of
concurrently active conversations is about 1, with at most 3 more than 98 % of the time**. As an assumption to
replace with measured data: if each customer has about one 10-minute conversation per day, spread over 10 opening
hours with a 2× peak hour, the mean peak concurrency is M / 30 for a cohort of M customers. So **M ≈ 30 customers**
gives a mean of 1 and P(≥ 4) ≈ 2 %. M = 60 gives a mean of 2 and P(≥ 4) ≈ 14 %, which is too high.

Before growing past that, add a second lane worker **and** get the provider limit raised, to at least 50 RPM. With
4 lane workers at 50 RPM, the same assumptions support about 17 concurrent conversations, or roughly 150–250
customers. Watch the monitor's `throttled` count and the turn latency (`scripts/r4-f1-latency.mjs`) during the
cohort. Sustained throttling, or a p90 above 60 s, is the signal to stop growing.

## 6. Not done (on purpose)

- No cross-process limiter (§4).
- No adaptive limiting from the provider's `x-ratelimit-*` headers. The static budget is meant to keep R4 below the
  limit, and a real 429 is still classified and retried as before.
- An aborted waiter keeps its reservation, so one start of the window is lost. That is negligible at a few aborts
  per hour.
