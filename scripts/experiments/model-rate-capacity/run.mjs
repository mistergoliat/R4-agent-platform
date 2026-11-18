#!/usr/bin/env node
// Lane capacity under a provider request-rate limit: a discrete-event simulation (no network, no database).
//
//   npm run build && node scripts/experiments/model-rate-capacity/run.mjs
//
// Model (docs/architecture/R4_MODEL_RATE_GUARD_AND_CAPACITY.md):
//   - N active conversations (closed system). Each customer thinks ~Exp(THINK_S) after a reply, then sends a turn.
//   - k lane workers; each runs ONE turn at a time (apps/worker: one task per worker), turns queue FIFO.
//   - A turn makes C sequential model calls, C ~ Geometric(1/3.3) on 1..16 (production: mean 3.3, p90 7, max 16).
//   - A call takes U(3, 8) s at the provider, after its worker's RequestRateLimiter (the shipped class, 61 s window;
//     one per process, so each of k workers gets floor(lane budget / k)) grants its start. A call whose start is more
//     than max(60 s timeout, 61 s window) away is refused: in production it fails rate_limited and the run is retried;
//     here it is counted and then waits for the next start.
// Prints, per (lane budget, workers), the largest N whose turn latency stays acceptable: p90 <= 60 s and mean <= 30 s
// (unloaded: mean ~18 s, p90 ~37 s), with no refusals above 0.1 % of calls.
import { RequestRateLimiter } from '@r4/model-gateway';

const THINK_S = Number(process.env.THINK_S ?? 60);
const HOURS = 8;
const SEEDS = [1, 2, 3];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0), (s >>> 8) / 2 ** 24);
}

function simulate({ conversations, workers, laneRpm, seed }) {
  const rand = rng(seed);
  const exp = (mean) => -Math.log(1 - rand()) * mean;
  const calls = () => Math.min(16, 1 + Math.floor(Math.log(1 - rand()) / Math.log(1 - 1 / 3.3)));
  let now = 0;
  const limiters = Array.from({ length: workers }, () => (laneRpm === Infinity ? null : new RequestRateLimiter(Math.floor(laneRpm / workers), { now: () => now })));
  const events = []; // [time, fn], kept sorted
  const at = (time, fn) => {
    let i = events.length;
    while (i > 0 && events[i - 1][0] > time) i--;
    events.splice(i, 0, [time, fn]);
  };
  const queue = [];
  const idle = limiters.map((_, i) => i);
  const latencies = [];
  let callCount = 0;
  let refused = 0;
  const warmup = 1_800_000;
  const end = warmup + HOURS * 3_600_000;

  const call = (turn) => {
    callCount++;
    const limiter = limiters[turn.worker];
    let wait = limiter ? limiter.reserve(61_000) : 0;
    if (wait === null) {
      refused++;
      wait = limiter.reserve(Infinity);
    }
    at(now + wait + (3 + 5 * rand()) * 1000, () => (--turn.left > 0 ? call(turn) : finish(turn)));
  };
  const start = () => {
    while (idle.length > 0 && queue.length > 0) {
      const turn = queue.shift();
      turn.worker = idle.shift();
      call(turn);
    }
  };
  const finish = (turn) => {
    if (turn.arrived >= warmup) latencies.push(now - turn.arrived);
    idle.push(turn.worker);
    at(now + exp(THINK_S * 1000), arrive);
    start();
  };
  const arrive = () => {
    queue.push({ arrived: now, left: calls() });
    start();
  };
  for (let i = 0; i < conversations; i++) at(exp(THINK_S * 1000), arrive);
  while (events.length > 0 && events[0][0] < end) {
    const [time, fn] = events.shift();
    now = time;
    fn();
  }
  return { latencies, calls: callCount, refused };
}

function measure(conversations, workers, laneRpm) {
  const all = [];
  let calls = 0;
  let refused = 0;
  for (const seed of SEEDS) {
    const r = simulate({ conversations, workers, laneRpm, seed });
    all.push(...r.latencies);
    calls += r.calls;
    refused += r.refused;
  }
  all.sort((a, b) => a - b);
  const mean = all.reduce((s, x) => s + x, 0) / all.length / 1000;
  const p90 = all[Math.floor(all.length * 0.9)] / 1000;
  const turnsPerMin = all.length / SEEDS.length / (HOURS * 60);
  return { mean, p90, turnsPerMin, callsPerMin: calls / SEEDS.length / (HOURS * 60 + 30), refusedPct: (100 * refused) / calls };
}

const ok = (m) => m.p90 <= 60 && m.mean <= 30 && m.refusedPct <= 0.1;
const fmt = (m) => `mean ${m.mean.toFixed(0)} s, p90 ${m.p90.toFixed(0)} s, ${m.callsPerMin.toFixed(1)} calls/min, refused ${m.refusedPct.toFixed(2)} %`;

const out = (line) => process.stdout.write(`${line}\n`);
out(`think time ${THINK_S} s; ${HOURS} h simulated x ${SEEDS.length} seeds per point`);
out(`unloaded: ${fmt(measure(1, 1, Infinity))}`);
const scenarios = [
  ['20 RPM', 12, [1, 2]],
  ['50 RPM', 42, [1, 2, 4]],
  ['100 RPM', 92, [1, 2, 4, 8]],
  ['unlimited', Infinity, [1]],
];
for (const [label, laneRpm, ks] of scenarios) {
  for (const k of ks) {
    let best = 0;
    let bestM = null;
    for (let n = 1; n <= 120; n++) {
      const m = measure(n, k, laneRpm);
      if (!ok(m)) break;
      best = n;
      bestM = m;
    }
    const over = measure(best + 1, k, laneRpm);
    out(`${label.padEnd(9)} lane ${String(laneRpm).padEnd(8)} workers ${k}: max ${String(best).padStart(3)} conversations (${bestM ? fmt(bestM) : '-'}) | at ${best + 1}: ${fmt(over)}`);
  }
}
