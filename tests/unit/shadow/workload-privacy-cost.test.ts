import { describe, expect, it } from 'vitest';
import {
  CostMeter,
  ShadowOutboundSink,
  WORKLOAD_CASE_SCHEMA_VERSION,
  assertPlanWithinGuard,
  assertWorkloadCorpus,
  parseGapCandidate,
  parseWorkloadCase,
  personalDataFound,
  pseudonymousRef,
  redactPersonalData,
  workloadFingerprint,
  workloadFromReplay,
  type WorkloadCaseInput,
} from '@r4/shadow';
import { H_REFERENCE_CASE_IDS, REVIEWED_GAP_CANDIDATES, SALES_SHADOW_CORPUS, SALES_SHADOW_CORPUS_LOCK } from '@r4-sales/agent/shadow';

const minimal: WorkloadCaseInput = {
  schemaVersion: WORKLOAD_CASE_SCHEMA_VERSION,
  id: 'T01',
  version: 1,
  title: 'test',
  sourceType: 'synthetic',
  source: { ref: 'unit' },
  initialContext: { subjectRef: null },
  events: [{ kind: 'input', text: 'hola' }],
  expectations: { acceptableStops: ['awaiting_input'] },
  privacy: { classification: 'synthetic', sanitized: false },
};

describe('WorkloadCase', () => {
  it('parses a minimal case with defaults and is agent-neutral', () => {
    const c = parseWorkloadCase(minimal);
    expect(c).toMatchObject({ initialContext: { channelRef: 'shadow', profiles: {} }, expectations: { invariants: [] }, tags: [] });
  });

  it('needs an input; a replay must be sanitized before it can become a workload', () => {
    expect(() => parseWorkloadCase({ ...minimal, events: [{ kind: 'process', process: 'worker', action: 'restart' }] })).toThrow(/at least one input/);
    expect(() => parseWorkloadCase({ ...minimal, sourceType: 'replay' })).toThrow(/sanitized/);
    expect(() => parseWorkloadCase({ ...minimal, sourceType: 'replay', privacy: { classification: 'sanitized_real', sanitized: true } })).not.toThrow();
  });

  it('has no field for a tool sequence or expected decisions (only events, properties and constraints)', () => {
    expect(() => parseWorkloadCase({ ...minimal, expectations: { acceptableStops: ['awaiting_input'], steps: ['read', 'quote'] } })).toThrow();
    expect(() => parseWorkloadCase({ ...minimal, script: [] })).toThrow();
  });

  it('a content change is detectable (fingerprint) and caught by the corpus lock unless the version changes', () => {
    const a = parseWorkloadCase(minimal);
    const b = parseWorkloadCase({ ...minimal, events: [{ kind: 'input', text: 'hola!' }] });
    expect(workloadFingerprint(a)).not.toBe(workloadFingerprint(b));
    expect(workloadFingerprint(parseWorkloadCase({ ...minimal, title: 'renamed' }))).toBe(workloadFingerprint(a));
    const lock = { 'T01@1': workloadFingerprint(a) };
    expect(assertWorkloadCorpus({ id: 'c', version: 1, cases: [a] }, lock).problems).toEqual([]);
    expect(assertWorkloadCorpus({ id: 'c', version: 1, cases: [b] }, lock).problems).toEqual([expect.stringContaining('changed without a new version')]);
  });

  it('the Sales shadow corpus: 20–30 locked cases, the H reference suite complete, natural language, no replay', () => {
    const { problems } = assertWorkloadCorpus(SALES_SHADOW_CORPUS, SALES_SHADOW_CORPUS_LOCK);
    expect(problems).toEqual([]);
    expect(SALES_SHADOW_CORPUS.cases.length).toBeGreaterThanOrEqual(20);
    expect(SALES_SHADOW_CORPUS.cases.length).toBeLessThanOrEqual(30);
    for (const id of ['H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08A', 'H08B', 'H09', 'H10', 'H11', 'H12', 'H12B', 'H13', 'H14']) expect(H_REFERENCE_CASE_IDS, id).toContain(id);
    expect(SALES_SHADOW_CORPUS.cases.every((c) => c.sourceType !== 'replay' && c.privacy.classification === 'synthetic')).toBe(true);
    const long = SALES_SHADOW_CORPUS.cases.find((c) => c.id === 'H13')!;
    expect(long.events.filter((e) => e.kind === 'input').length).toBeGreaterThanOrEqual(10);
    // Reused scenarios, regression-derived cases and every event kind are represented.
    expect(new Set(SALES_SHADOW_CORPUS.cases.map((c) => c.sourceType))).toEqual(new Set(['curated', 'synthetic', 'regression-derived']));
    expect(new Set(SALES_SHADOW_CORPUS.cases.flatMap((c) => c.events.map((e) => e.kind)))).toEqual(new Set(['input', 'advance_time', 'process', 'fault', 'operator', 'owner_change']));
  });
});

describe('sanitization boundary', () => {
  it('redacts structured personal data but keeps prices, dates and quote numbers', () => {
    const text = 'Soy Ana María Soto, mi mail es ana.soto@correo.cl y mi fono +56 9 8765 4321; RUT 12.345.678-5. Vivo en Avenida Grecia 1234. Mi pedido 88231 no llegó. La cotización COT-900001 por $1.100.000 vence el 2026-10-01.';
    const { text: out, redactions } = redactPersonalData(text, ['Ana María Soto']);
    expect(out).not.toMatch(/Ana María Soto|ana\.soto@|8765|12\.345\.678|Grecia 1234|88231/);
    expect(out).toContain('COT-900001');
    expect(out).toContain('$1.100.000');
    expect(out).toContain('2026-10-01');
    expect(redactions).toMatchObject({ known_identifier: 1, email: 1, phone: 1, national_id: 1, address: 1, order_id: 1 });
    expect(personalDataFound(out)).toEqual([]);
  });

  it('pseudonymous recipient references are stable within a suite and unlinkable across suites', () => {
    expect(pseudonymousRef('cust-1', 'a')).toBe(pseudonymousRef('cust-1', 'a'));
    expect(pseudonymousRef('cust-1', 'a')).not.toBe(pseudonymousRef('cust-1', 'b'));
    expect(pseudonymousRef('cust-1', 'a')).not.toContain('cust-1');
    expect(pseudonymousRef(null, 'a')).toBe('anonymous');
  });

  it('a replayed conversation becomes a sanitized workload: person turns only, redacted, subject dropped', () => {
    const w = workloadFromReplay(
      { ref: 'conv-9981 (juan.perez@correo.cl)', knownIdentifiers: ['Juan Pérez'], turns: [{ from: 'person', text: 'Hola, soy Juan Pérez, mi correo es juan.perez@correo.cl' }, { from: 'agent', text: 'Hola Juan' }, { from: 'person', text: 'Llámame al +56 9 1234 5678' }] },
      { id: 'RP01', version: 1, title: 'replay', acceptableStops: ['awaiting_input'] },
    );
    expect(w.sourceType).toBe('replay');
    expect(w.events).toHaveLength(2);
    expect(JSON.stringify(w)).not.toMatch(/Juan Pérez|juan\.perez|1234 5678/);
    expect(w.privacy).toMatchObject({ classification: 'sanitized_real', sanitized: true, redactions: { known_identifier: 1, email: 2, phone: 1 } });
    expect(w.initialContext.subjectRef).toBeNull();
  });

  it('the outbound sink records what would be sent — redacted, pseudonymous, never delivered, once per response', () => {
    const sink = new ShadowOutboundSink({ salt: 's' });
    const message = { taskRef: 't', turnIndex: 1, responseRef: 'step-1', recipient: 'cust-demo-001', text: 'Te escribo a camila.rojas@example.test o al +56 9 0000 0001', respondedAt: '2026-01-01T00:00:00.000Z' };
    const first = sink.deliver(message);
    sink.deliver(message);
    expect(sink.delivered).toHaveLength(1);
    expect(first).toMatchObject({ wouldDeliver: true, actualDelivery: false, redactions: { email: 1, phone: 1 } });
    expect(first.message).not.toMatch(/camila|0000 0001/);
    expect(first.recipientRef).toMatch(/^pseud_[0-9a-f]{16}$/);
  });
});

describe('cost guard', () => {
  const guard = { maxModelCalls: 100, maxInputTokens: 1_000, maxOutputTokens: null, maxCases: 30, maxRepetitions: 5 };

  it('refuses plans above the guard, and large live plans without an explicit opt-in', () => {
    expect(() => assertPlanWithinGuard({ cases: 31, repetitions: 1, live: false, allowLarge: false }, guard)).toThrow(/cases/);
    expect(() => assertPlanWithinGuard({ cases: 5, repetitions: 6, live: false, allowLarge: false }, guard)).toThrow(/repetitions/);
    expect(() => assertPlanWithinGuard({ cases: 5, repetitions: 4, live: true, allowLarge: false }, guard)).toThrow(/allow-large/);
    expect(() => assertPlanWithinGuard({ cases: 5, repetitions: 4, live: true, allowLarge: true }, guard)).not.toThrow();
    expect(() => assertPlanWithinGuard({ cases: 25, repetitions: 3, live: true, allowLarge: false }, guard)).toThrow(/allow-large/);
  });

  it('reports which limit was reached; nothing below it', () => {
    const meter = new CostMeter(guard);
    meter.add({ modelCalls: 50, inputTokens: 900, outputTokens: 10 });
    expect(meter.exhausted()).toBeNull();
    meter.add({ modelCalls: 10, inputTokens: 200, outputTokens: 10 });
    expect(meter.exhausted()).toMatch(/maxInputTokens/);
  });
});

describe('ArchitectureGapCandidate', () => {
  const base = { id: 'GAP-H-001', origin: 'reviewed', classification: 'architecture_gap_candidate', observation: 'x', frequency: { affected: 3, total: 10, unit: 'executions' }, affectedWorkloads: ['H01'], suspectedLayer: 'Context', evidenceRefs: ['evaluations/e1'], whyCurrentArchitectureIsInsufficient: 'the abstraction cannot represent the needed durable state', workaround: null, productionImpact: 'x', modelSpecific: null, scope: 'generic', blocksNextPhase: false } as const;

  it('only a reviewed, repeated, explained observation may be called an architecture gap', () => {
    expect(() => parseGapCandidate(base)).not.toThrow();
    expect(() => parseGapCandidate({ ...base, origin: 'observed' })).toThrow(/human-reviewed/);
    expect(() => parseGapCandidate({ ...base, frequency: { affected: 1, total: 10, unit: 'executions' } })).toThrow(/single failure/);
    expect(() => parseGapCandidate({ ...base, whyCurrentArchitectureIsInsufficient: null })).toThrow(/insufficient/);
    expect(() => parseGapCandidate({ ...base, evidenceRefs: [] })).toThrow();
    // Observations may be recorded freely — classified as something other than an architecture gap.
    expect(() => parseGapCandidate({ ...base, id: 'OBS-H-X-Y', origin: 'observed', classification: 'quality_issue', frequency: { affected: 1, total: 10, unit: 'executions' }, whyCurrentArchitectureIsInsufficient: null })).not.toThrow();
  });
});

describe('the reviewed Sales gap register', () => {
  it('parses; every architecture gap candidate is reviewed, repeated, explained and cites evidence', () => {
    expect(REVIEWED_GAP_CANDIDATES.length).toBeGreaterThan(0);
    for (const g of REVIEWED_GAP_CANDIDATES.filter((x) => x.classification === 'architecture_gap_candidate')) {
      expect(g, g.id).toMatchObject({ origin: 'reviewed' });
      expect(g.frequency.affected, g.id).toBeGreaterThanOrEqual(2);
      expect(g.evidenceRefs.length, g.id).toBeGreaterThan(0);
    }
    expect(new Set(REVIEWED_GAP_CANDIDATES.map((g) => g.id)).size).toBe(REVIEWED_GAP_CANDIDATES.length);
  });
});
