#!/usr/bin/env node
// Metrics of run.mjs output (README.md in this directory). One sample = one copy point (the offer, or its
// re-presentation after an ambiguous reply); its FIRST real call decides json / exact / integrity.
//
//   node scripts/experiments/j3ec1-offer-fidelity/analyze.mjs A B0 C      → analysis-AB0C.json (copy fidelity, @7)
//   node scripts/experiments/j3ec1-offer-fidelity/analyze.mjs AB          → analysis-AB.json   (paired @6 vs @7)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.env.R4_EXPERIMENT_ROOT ?? resolve(import.meta.dirname, '../../../artifacts/j3ec1-fidelity');
const phases = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['A', 'B0', 'C'];
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sha = (t) => createHash('sha256').update(t).digest('hex');
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUMBER = /\d{1,3}(?:\.\d{3})+|\d+/g;
const PESOS = /\$\s?(\d{1,3}(?:\.\d{3})+|\d+)/g;
const toInt = (s) => Number(s.replace(/\./g, ''));

/**
 * Commercial integrity of a presented offer against the Sales rendering (r4-sales-offer-es-v1) of the same snapshot:
 * the reference as a token; every distinct amount of the rendering present as a number, and no foreign $ amount; every
 * line description verbatim. Distinct amounts: a free text need not repeat a unit price equal to its subtotal.
 */
function integrity(expected, presented) {
  const want = new Set([...expected.matchAll(PESOS)].map((m) => toInt(m[1])));
  const numbers = new Set((presented.match(NUMBER) ?? []).map(toInt));
  const missing = [...want].filter((a) => !numbers.has(a));
  const unexpected = [...new Set([...presented.matchAll(PESOS)].map((m) => toInt(m[1])))].filter((a) => !want.has(a));
  const reference = new RegExp(`(^|[^0-9A-Za-z])${escape(expected.match(/\(Ref\. ([^)]+)\)/)[1])}($|[^0-9A-Za-z])`, 'i').test(presented);
  const missingNames = [...expected.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]).filter((name) => !presented.includes(name));
  const figures = missing.length === 0 && unexpected.length === 0;
  return { reference, figures, names: missingNames.length === 0, ok: reference && figures && missingNames.length === 0, missing, unexpected, missingNames };
}

const T = phases.flatMap((p) => read(join(ROOT, `phase-${p}`, 'texts.jsonl')));
/** Phases A–C predate the profile field (they ran @7 only) and the texts: there, a byte-exact copy has every part of integrity. */
function withProfile(x) {
  const profile = x.profile ?? 'sales-production@7';
  if (x.segmentCall === undefined) return { ...x, profile };
  const t = T.find((y) => y.scenario === x.scenario && y.profile === profile && y.kind === x.kind && y.segmentCall === x.segmentCall);
  if (!t) return { ...x, profile, integrity: x.exact ? { reference: true, figures: true, names: true, ok: true, derivedFromExact: true } : null };
  if (sha(t.expected) !== x.expectedSha256 || (t.presented !== null && sha(t.presented) !== x.presentedSha256)) throw new Error(`texts of ${x.scenario} ${profile} do not match the hashes in calls.jsonl`);
  return { ...x, profile, integrity: t.presented === null ? null : integrity(t.expected, t.presented) };
}
const S = phases.flatMap((p) => read(join(ROOT, `phase-${p}`, 'samples.jsonl'))).map(withProfile);
const C = phases.flatMap((p) => read(join(ROOT, `phase-${p}`, 'calls.jsonl'))).map(withProfile);

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };
const by = (xs, f) => xs.reduce((a, x) => ({ ...a, [f(x)]: (a[f(x)] ?? 0) + 1 }), {});
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// Exact binomial tools (small n: direct sums in log space).
const logFact = [0];
const lf = (n) => { while (logFact.length <= n) logFact.push(logFact.at(-1) + Math.log(logFact.length)); return logFact[n]; };
const pmf = (k, n, p) => (p === 0 ? +(k === 0) : p === 1 ? +(k === n) : Math.exp(lf(n) - lf(k) - lf(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p)));
const cdf = (k, n, p) => sum(Array.from({ length: k + 1 }, (_, i) => pmf(i, n, p)));
/** The p in (0, 1) where a function DECREASING in p equals target. */
const bisect = (f, target) => { let lo = 0; let hi = 1; for (let i = 0; i < 60; i += 1) { const mid = (lo + hi) / 2; if (f(mid) > target) lo = mid; else hi = mid; } return (lo + hi) / 2; };
/** Clopper-Pearson 95 % interval of k successes in n: P(X ≥ k | lower) = P(X ≤ k | upper) = 2.5 %. */
const ci = (k, n) => (n === 0 ? null : [k === 0 ? 0 : +bisect((p) => cdf(k - 1, n, p), 0.975).toFixed(4), k === n ? 1 : +bisect((p) => cdf(k, n, p), 0.025).toFixed(4)]);
/** Two-sided exact binomial (sign / McNemar) test: k of n discordant pairs one way, H0 p = 1/2. */
const signTest = (k, n) => (n === 0 ? 1 : Math.min(1, 2 * cdf(Math.min(k, n - k), n, 0.5)));
const rate = (k, n) => ({ k, n, rate: n === 0 ? null : +(k / n).toFixed(4), ci95: ci(k, n) });

function metrics(profile) {
  const s = S.filter((x) => x.profile === profile);
  const c = C.filter((x) => x.profile === profile);
  const firsts = c.filter((x) => x.segmentCall === 1);
  const responded = firsts.filter((x) => x.decisionType === 'respond');
  return {
    conversations: s.length, invalidScenarios: s.filter((x) => x.invalid).length, scenarioErrors: s.filter((x) => x.error).map((x) => `${x.id}: ${x.error}`),
    samples: firsts.length, byKind: by(firsts, (x) => x.kind),
    jsonValid: rate(c.filter((x) => x.json).length, c.length),
    respond: rate(responded.length, firsts.length),
    exactCopy: rate(firsts.filter((x) => x.exact).length, firsts.length),
    integrity: rate(firsts.filter((x) => x.integrity?.ok).length, firsts.length),
    integrityParts: { reference: firsts.filter((x) => x.integrity?.reference).length, figures: firsts.filter((x) => x.integrity?.figures).length, names: firsts.filter((x) => x.integrity?.names).length, of: firsts.length },
    integrityFailures: firsts.filter((x) => !x.integrity?.ok).map((x) => ({ scenario: x.scenario, decisionType: x.decisionType, integrity: x.integrity })),
    realCalls: c.length, retries: c.filter((x) => x.segmentCall > 1).length, providerErrors: c.filter((x) => x.error).length,
    finishReasons: by(c, (x) => x.finishReason), decisionTypes: by(c, (x) => x.decisionType ?? 'invalid'),
    verdicts: by(s.flatMap((x) => x.verdicts), (v) => v),
    issuanceRefusedForTheOffer: s.flatMap((x) => x.verdicts).filter((v) => v === 'rejected:offer_not_presented').length,
    conversationsIssued: rate(s.filter((x) => x.verdicts.includes('authorized:eligible')).length, s.length),
    runs: by(s.flatMap((x) => x.runs), (r) => r), handoffs: sum(s.map((x) => x.handoffs)),
    tokens: { inputP50: pct(c.map((x) => x.inputTokens), 0.5), inputMax: c.length ? Math.max(...c.map((x) => x.inputTokens)) : null, outputP50: pct(c.map((x) => x.outputTokens), 0.5), outputP90: pct(c.map((x) => x.outputTokens), 0.9), outputMax: c.length ? Math.max(...c.map((x) => x.outputTokens)) : null, input: sum(c.map((x) => x.inputTokens)), output: sum(c.map((x) => x.outputTokens)) },
    latencyMs: { p50: pct(c.map((x) => x.latencyMs), 0.5), p90: pct(c.map((x) => x.latencyMs), 0.9), max: c.length ? Math.max(...c.map((x) => x.latencyMs)) : null },
    offerChars: { expectedP50: pct(firsts.map((x) => x.expectedChars), 0.5), presentedP50: pct(responded.map((x) => x.presentedChars ?? 0), 0.5) },
    coverage: { lines: by(s, (x) => x.lines), delivery: s.filter((x) => x.delivery).length, excluded: s.filter((x) => !x.delivery).length, variant: s.filter((x) => x.variant).length, renamed: s.filter((x) => x.renamed).length, taxRate01: s.filter((x) => x.taxRate).length, ambiguous: s.filter((x) => x.ambiguous).length, communes: new Set(s.map((x) => x.delivery).filter(Boolean)).size },
  };
}

const profiles = [...new Set(S.map((x) => x.profile))].sort();
const out = { phases, root: ROOT, profiles: Object.fromEntries(profiles.map((p) => [p, metrics(p)])) };

if (profiles.length === 2) {
  // Paired by scenario number: the same products, quantities, destination, names, tax and confirmation.
  const [a, b] = profiles;
  const first = (p, n) => C.find((x) => x.profile === p && x.n === n && x.segmentCall === 1 && x.kind === 'offer');
  const sample = (p, n) => S.find((x) => x.profile === p && x.n === n);
  const ns = [...new Set(S.map((x) => x.n))].filter((n) => first(a, n) && first(b, n)).sort((x, y) => x - y);
  const outcome = {
    json: (p, n) => first(p, n).json,
    integrity: (p, n) => Boolean(first(p, n).integrity?.ok),
    issued: (p, n) => sample(p, n).verdicts.includes('authorized:eligible'),
  };
  const mcnemar = (f) => {
    const onlyA = ns.filter((n) => f(a, n) && !f(b, n)).length;
    const onlyB = ns.filter((n) => !f(a, n) && f(b, n)).length;
    return { [a]: ns.filter((n) => f(a, n)).length, [b]: ns.filter((n) => f(b, n)).length, of: ns.length, [`only ${a}`]: onlyA, [`only ${b}`]: onlyB, exactP: +signTest(onlyA, onlyA + onlyB).toFixed(4) };
  };
  const paired = (f) => {
    const d = ns.map((n) => f(first(b, n)) - f(first(a, n)));
    const up = d.filter((x) => x > 0).length;
    const down = d.filter((x) => x < 0).length;
    return { [`median ${b} − ${a}`]: pct(d, 0.5), [`${b} higher`]: up, [`${b} lower`]: down, signTestP: +signTest(up, up + down).toFixed(4) };
  };
  out.pairs = {
    n: ns.length, scenarios: ns,
    json: mcnemar(outcome.json), integrity: mcnemar(outcome.integrity), issued: mcnemar(outcome.issued),
    outputTokens: paired((x) => x.outputTokens), inputTokens: paired((x) => x.inputTokens), latencyMs: paired((x) => x.latencyMs),
    table: ns.map((n) => ({ n, ...Object.fromEntries(profiles.map((p) => [p, { json: first(p, n).json, decision: first(p, n).decisionType, exact: first(p, n).exact, integrity: first(p, n).integrity?.ok ?? null, verdicts: sample(p, n).verdicts.join(','), out: first(p, n).outputTokens, ms: first(p, n).latencyMs }])) })),
  };
}
out.usdEstimateUpperBound = +((sum(C.map((x) => x.inputTokens)) * 0.3 + sum(C.map((x) => x.outputTokens)) * 1.2) / 1e6).toFixed(4);
writeFileSync(join(ROOT, `analysis-${phases.join('')}.json`), JSON.stringify(out, null, 2));
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
