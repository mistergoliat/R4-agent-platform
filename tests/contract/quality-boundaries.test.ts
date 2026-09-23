import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_RUBRICS,
  assertArtifactSafe,
  assertDefinition,
  assertDescriptor,
  freezeSubject,
  genericDeterministicEvaluators,
  modelProfileFingerprint,
  type ModelProfile,
} from '@r4/evaluation';
import { SALES_RUBRICS, SALES_RUBRIC_LOCK, SalesFixture, evaluateFixtureCorpus, salesEvaluationDefinition } from '@r4-sales/agent/evaluations';
import { checkRubricLock } from '@r4/evaluation';

/**
 * R4-G architecture boundaries (ADR-025, ADR-026):
 *   Core execution → no Quality dependency
 *   Quality framework → no Sales dependency, no runtime, no I/O
 *   Sales evaluators → Quality contracts + Sales contracts, outside the deployed pack runtime
 *   Evaluators → read-only trajectory; Quality observes and reports, never modifies the agent
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const rel = (file: string) => relative(ROOT, file).split('\\').join('/');

function files(dir: string, ext = '.ts'): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, ext));
    else if (name.endsWith(ext)) out.push(path);
  }
  return out;
}
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
const text = (list: readonly string[]) => list.map((f) => readFileSync(f, 'utf8')).join('\n');

const FRAMEWORK = files(join(ROOT, 'packages/evaluation/src'));
const RUNTIME = files(join(ROOT, 'apps/evaluator/src'));
const QUALITY = [...FRAMEWORK, ...RUNTIME];
const CORE_EXECUTION = [...files(join(ROOT, 'packages')), ...files(join(ROOT, 'apps'))].filter((f) => !QUALITY.includes(f));
const SALES_EVALUATIONS = files(join(ROOT, 'agents/sales/src/evaluations'));
const SALES_EVAL_CLIS = ['eval.ts', 'benchmark.ts', 'experiment.ts', 'promote.ts'].map((f) => join(ROOT, 'agents/sales/src/cli', f));
const SALES_RUNTIME = files(join(ROOT, 'agents/sales/src')).filter((f) => !/[\\/](harness|cli|evaluations)[\\/]/.test(f));

describe('Core execution never depends on Quality', () => {
  it('no Core package or app (AgentKernel, ExecutionRuntime, ActionRuntime, ContextCompiler, Scheduler, …) imports Quality', () => {
    expect(CORE_EXECUTION.length).toBeGreaterThan(50);
    const violations = CORE_EXECUTION.flatMap((f) => importsOf(f).filter((s) => /^@r4\/evaluat(ion|or)$/.test(s) || /evaluation\//.test(s)).map((s) => `${rel(f)}: ${s}`));
    expect(violations).toEqual([]);
    for (const file of ['packages/agent-kernel/src/kernel.ts', 'packages/task-runtime/src/action-runtime.ts', 'packages/task-runtime/src/execution-runtime.ts', 'packages/context-compiler/src/compiler.ts', 'apps/scheduler/src/scheduler.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(/@r4\/evaluat|Finding|Evaluator|RegressionCase/);
    }
  });

  it('claim detection and judge deadlines exist only in post-hoc Quality, never in runtime code', () => {
    const detectors = /unbacked|success.?claim|claims?.?detector|textual.?success/i;
    expect(CORE_EXECUTION.filter((f) => detectors.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
    expect(QUALITY.filter((f) => detectors.test(readFileSync(f, 'utf8'))).map(rel).length).toBeGreaterThan(0);
  });
});

describe('the Quality framework is generic, pure and read-only', () => {
  it('the framework imports only contracts, zod and node:crypto', () => {
    const allowed = /^(@r4\/contracts|zod|node:crypto|\.\.?\/[\w/.-]+\.js)$/;
    expect(FRAMEWORK.flatMap((f) => importsOf(f).filter((s) => !allowed.test(s)).map((s) => `${rel(f)}: ${s}`))).toEqual([]);
  });

  it('the evaluation runtime reaches only read APIs, the gateway interface and the file system for artifacts', () => {
    const allowed = /^(@r4\/(contracts|evaluation|model-gateway|persistence-postgres|context-compiler)|node:(fs|path|child_process)|\.\.?\/[\w/.-]+\.js)$/;
    expect(RUNTIME.flatMap((f) => importsOf(f).filter((s) => !allowed.test(s)).map((s) => `${rel(f)}: ${s}`))).toEqual([]);
    // The trajectory reader calls no write operation of any store.
    const reader = readFileSync(join(ROOT, 'apps/evaluator/src/trajectory-reader.ts'), 'utf8');
    expect(reader).not.toMatch(/\.(insert|update|append|register|expire|claim|finish|release|renew|complete|transition|lock)\w*\(|\.record\(/);
    expect(reader).not.toMatch(/\b(insert|update|delete)\s+(into|from)?\s*\w/i);
  });

  it('contains no Sales (or other domain) concept', () => {
    expect(text(QUALITY)).not.toMatch(/\b(sales|quote|cotizaci|product|catalog|customer|workspace|presupuesto|cart|campaign|payment)\b/i);
    expect(QUALITY.flatMap((f) => importsOf(f).filter((s) => /@r4-(sales|adapters)|agents\//.test(s)))).toEqual([]);
  });

  it('Sales evaluators live in the pack, outside the deployed runtime of the agent', () => {
    expect(SALES_EVALUATIONS.length).toBeGreaterThan(5);
    expect(SALES_EVALUATIONS.some((f) => importsOf(f).includes('@r4/evaluation'))).toBe(true);
    const leaks = SALES_RUNTIME.flatMap((f) => importsOf(f).filter((s) => /evaluations\/|^@r4\/evaluat/.test(s)).map((s) => `${rel(f)}: ${s}`));
    expect(leaks).toEqual([]);
  });
});

describe('Quality observes and reports; it never modifies the agent', () => {
  const QUALITY_CODE = [...QUALITY, ...SALES_EVALUATIONS, ...SALES_EVAL_CLIS];

  it('no Quality code imports agent definitions, registries, capability registration, policies or runtimes', () => {
    const forbidden = /^(@r4\/(agent-registry|policy-engine|capability-runtime|task-runtime|worker|api|scheduler)|\.\.\/(definition|policy|composition|migrate)\.js|\.\.\/capabilities\/|\.\.\/\.\.\/(definition|policy|composition)\.js)$/;
    expect(QUALITY_CODE.flatMap((f) => importsOf(f).filter((s) => forbidden.test(s)).map((s) => `${rel(f)}: ${s}`))).toEqual([]);
  });

  it('writes nothing but artifacts: no instruction, registry, policy, deployment or environment file', () => {
    const src = text(QUALITY_CODE);
    expect(src).not.toMatch(/\.agent\.json|loadSalesAgentDefinition|registerWrite|\.register\(|process\.env\.\w+\s*=|\.env['"]/);
    const writers = QUALITY_CODE.filter((f) => /\b(writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|writeFile|appendFile)\b/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(writers).toEqual(['apps/evaluator/src/artifact-store.ts']);
  });

  it('an evaluator receives a deeply frozen copy of the trajectory', () => {
    const f = new SalesFixture({ id: 'frozen' });
    f.turn('hola');
    f.respond('hola');
    f.wait();
    const subject = f.build();
    const frozen = freezeSubject(subject);
    expect(frozen).not.toBe(subject);
    expect(Object.isFrozen(frozen.runs[0]!.steps[0]!)).toBe(true);
    expect(() => {
      (frozen.responses[0] as { text: string }).text = 'rewritten';
    }).toThrow(TypeError);
    expect(subject.responses[0]!.text).toBe('hola');
  });
});

describe('versioned, reproducible evaluation', () => {
  it('every evaluator declares id and version; every semantic evaluator a locked rubric', () => {
    const definition = salesEvaluationDefinition();
    expect(() => assertDefinition(definition)).not.toThrow();
    for (const e of [...definition.evaluators, ...genericDeterministicEvaluators()]) expect(() => assertDescriptor(e.descriptor)).not.toThrow();
    expect(definition.evaluators.filter((e) => e.descriptor.kind === 'semantic').every((e) => e.descriptor.rubric !== undefined)).toBe(true);
    expect(checkRubricLock(SALES_RUBRICS, SALES_RUBRIC_LOCK)).toEqual([]);
    for (const r of GENERIC_RUBRICS) expect(r.version).toBeGreaterThan(0);
    expect(() => assertDescriptor({ ref: { id: 'x.y', version: 1 }, kind: 'semantic', description: 'x', emits: [], authoritativeFor: ['a'], rubric: GENERIC_RUBRICS[0]! })).toThrow(/authoritative/);
  });

  it('the model profile fingerprint is stable (golden value)', () => {
    const profile: ModelProfile = { role: 'under_test', provider: 'adapter', profile: 'default', host: 'model.example.test', model: 'model-x', maxOutputTokens: 8192, contextWindowTokens: 1_000_000, temperature: null, responseFormat: 'json_object', extras: { thinking: { type: 'enabled' } } };
    expect(modelProfileFingerprint(profile)).toBe(GOLDEN_FINGERPRINT);
  });

  it('artifacts of the whole offline corpus carry no secret, credential header or reasoning text', async () => {
    const { results } = await evaluateFixtureCorpus({ repro: { gitSha: 'unknown' } });
    const secret = 'sk-contract-SECRET-0123456789abcdef';
    for (const r of results) {
      for (const [name, content] of Object.entries(r.files)) {
        expect(() => assertArtifactSafe(content, [secret]), `${r.fixtureId}/${name}`).not.toThrow();
        expect(content).not.toMatch(/R4_MODEL_API_KEY|"authorization"/i);
      }
    }
  });
});

const GOLDEN_FINGERPRINT = 'b55431508dc45484563cf22fac61fc9bc5a25873d15c21ebc5b6d04875da962f';
