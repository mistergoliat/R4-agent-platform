import { describe, expect, it } from 'vitest';
import {
  ShadowExecutionPolicy,
  ShadowModeError,
  ShadowViolation,
  SideEffectRecorder,
  assertShadowComposition,
  assertShadowMode,
  bindingLabel,
  createOutboundDelivery,
  guardPort,
  loadShadowExecutionConfig,
  type DomainBindingDescriptor,
  type OutboundBindingDescriptor,
} from '@r4/shadow';

const SHADOW = loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'shadow' });
const LIVE_READ = loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'shadow', R4_SHADOW_ALLOW_LIVE_READ: 'true' });
const SINK: OutboundBindingDescriptor = { bindingId: 'sink', kind: 'shadow-sink', version: 1 };

const binding = (fields: Partial<DomainBindingDescriptor>): DomainBindingDescriptor => ({
  domain: 'owner',
  bindingId: 'owner-binding',
  kind: 'fixture',
  version: 1,
  operations: { get: { effect: 'read' }, put: { effect: 'write', idempotencyKeyArg: 1 } },
  contractRef: null,
  description: 'test binding',
  ...fields,
});

describe('explicit shadow execution mode (fail closed)', () => {
  it('refuses when the mode is not declared — missing config is never "safe"', () => {
    expect(() => loadShadowExecutionConfig({})).toThrow(ShadowModeError);
    expect(() => loadShadowExecutionConfig({ R4_EXECUTION_MODE: '' })).toThrow(/not set/);
  });

  it('accepts only "shadow"; there is no production mode in R4-H', () => {
    for (const mode of ['production', 'prod', 'live', 'SHADOW', 'test']) expect(() => loadShadowExecutionConfig({ R4_EXECUTION_MODE: mode }), mode).toThrow(/only "shadow"/);
  });

  it('records where the declaration came from, and refuses conflicting declarations', () => {
    expect(loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'shadow' }).declaredBy).toBe('environment');
    expect(loadShadowExecutionConfig({}, 'shadow').declaredBy).toBe('command');
    expect(() => loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'production' }, 'shadow')).toThrow(/conflict|declares/);
  });

  it('network opt-ins are explicit, default off, and strictly boolean', () => {
    expect(SHADOW).toMatchObject({ allowLiveModel: false, allowLiveRead: false });
    expect(loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'shadow', R4_SHADOW_ALLOW_LIVE_MODEL: 'true' }).allowLiveModel).toBe(true);
    expect(() => loadShadowExecutionConfig({ R4_EXECUTION_MODE: 'shadow', R4_SHADOW_ALLOW_LIVE_MODEL: 'yes' })).toThrow(/true.*false/);
  });

  it('a composition cannot proceed with an object that merely looks like a config', () => {
    expect(() => assertShadowMode({ mode: 'production', declaredBy: 'environment', allowLiveModel: false, allowLiveRead: false })).toThrow(/no proven shadow/);
    expect(() => assertShadowMode(undefined)).toThrow(ShadowModeError);
    expect(() => new ShadowExecutionPolicy({} as never)).toThrow(ShadowModeError);
  });
});

describe('ShadowExecutionPolicy: where an allowed effect may materialize', () => {
  const policy = new ShadowExecutionPolicy(SHADOW);

  it('classification matrix', () => {
    expect(policy.classify(binding({ kind: 'fixture' }), 'get').classification).toBe('READ_ALLOWED');
    expect(policy.classify(binding({ kind: 'fixture' }), 'put').classification).toBe('SHADOW_WRITE');
    expect(policy.classify(binding({ kind: 'shadow' }), 'put').classification).toBe('SHADOW_WRITE');
    expect(policy.classify(binding({ kind: 'sandbox', contractRef: 'docs/sandbox.md' }), 'put').classification).toBe('SANDBOX_WRITE');
    expect(policy.classify(binding({ kind: 'sandbox', contractRef: null }), 'get').classification).toBe('BLOCKED');
    expect(policy.classify(binding({ kind: 'production' }), 'get').classification).toBe('BLOCKED');
    expect(policy.classify(binding({ kind: 'production' }), 'put').classification).toBe('BLOCKED');
    expect(policy.classify(binding({}), 'delete')).toMatchObject({ classification: 'BLOCKED', reason: expect.stringContaining('undeclared_operation') });
  });

  it('live reads need the opt-in, a documented contract, and a binding with no write operation', () => {
    const readOnly = binding({ kind: 'live-read', operations: { get: { effect: 'read' } }, contractRef: 'docs/owner-api.md' });
    expect(policy.classify(readOnly, 'get')).toMatchObject({ classification: 'BLOCKED', reason: expect.stringContaining('live_read_not_enabled') });
    const withOptIn = new ShadowExecutionPolicy(LIVE_READ);
    expect(withOptIn.classify(readOnly, 'get').classification).toBe('READ_ALLOWED');
    expect(withOptIn.classify({ ...readOnly, contractRef: null }, 'get').reason).toContain('undocumented_live_binding');
    // A live binding that can write is refused entirely — even its reads.
    expect(withOptIn.classify(binding({ kind: 'live-read', contractRef: 'docs/owner-api.md' }), 'get').reason).toContain('live_read_binding_can_write');
  });

  it('startup gate refuses any composition with a BLOCKED binding, an ambiguous domain or a delivering outbound', () => {
    expect(() => assertShadowComposition(SHADOW, [binding({ kind: 'production' })], SINK)).toThrow(/production_binding/);
    expect(() => assertShadowComposition(SHADOW, [binding({}), binding({ bindingId: 'other' })], SINK)).toThrow(/ambiguous_binding/);
    expect(() => assertShadowComposition(SHADOW, [binding({})], { bindingId: 'real', kind: 'production-delivery', version: 1 })).toThrow(/production_delivery/);
    const report = assertShadowComposition(SHADOW, [binding({})], SINK);
    expect(report.bindings[0]).toMatchObject({ classifications: { get: 'READ_ALLOWED', put: 'SHADOW_WRITE' }, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(bindingLabel(report.bindings[0]!)).toBe('owner=fixture:owner-binding@1');
  });

  it('only the shadow sink can be obtained as outbound delivery', () => {
    expect(() => createOutboundDelivery(SHADOW, { bindingId: 'real', kind: 'production-delivery', version: 1 }, { salt: 's' })).toThrow(ShadowViolation);
    expect(createOutboundDelivery(SHADOW, SINK, { salt: 's' }).descriptor.kind).toBe('shadow-sink');
  });
});

describe('guardPort: every call classified and recorded; blocked calls never reach the implementation', () => {
  class Owner {
    readonly bindingKind: string;
    calls = 0;
    constructor(kind = 'fixture') {
      this.bindingKind = kind;
    }
    get(): Promise<string> {
      this.calls += 1;
      return Promise.resolve('value');
    }
    put(_value: string, _key: string): Promise<string> {
      this.calls += 1;
      return Promise.reject(Object.assign(new Error('owner down'), { category: 'temporarily_unavailable' }));
    }
    drop(): string {
      this.calls += 1;
      return 'dropped';
    }
  }
  const policy = new ShadowExecutionPolicy(SHADOW);

  it('records reads and writes (with the idempotency key and the owner’s error category)', async () => {
    const owner = new Owner();
    const recorder = new SideEffectRecorder();
    const port = guardPort(owner, binding({}), policy, recorder);
    await expect(port.get()).resolves.toBe('value');
    await expect(port.put('x', 'r4x_0123')).rejects.toThrow('owner down');
    expect(recorder.records).toMatchObject([
      { seq: 1, operation: 'get', effect: 'read', classification: 'READ_ALLOWED', outcome: 'ok', idempotencyKey: null, production: false },
      { seq: 2, operation: 'put', effect: 'write', classification: 'SHADOW_WRITE', outcome: 'error', errorCategory: 'temporarily_unavailable', idempotencyKey: 'r4x_0123' },
    ]);
  });

  it('an undeclared operation is refused and recorded as blocked, without calling the implementation', () => {
    const owner = new Owner();
    const recorder = new SideEffectRecorder();
    const port = guardPort(owner, binding({}), policy, recorder);
    expect(() => port.drop()).toThrow(ShadowViolation);
    expect(owner.calls).toBe(0);
    expect(recorder.records).toMatchObject([{ operation: 'drop', outcome: 'blocked', classification: 'BLOCKED' }]);
  });

  it('the descriptor must agree with what the implementation says it is (a fixture cannot be presented as live-read)', () => {
    expect(() => guardPort(new Owner('fixture'), binding({ kind: 'live-read', operations: { get: { effect: 'read' } }, contractRef: 'x' }), new ShadowExecutionPolicy(LIVE_READ), new SideEffectRecorder())).toThrow(/binding_kind_mismatch|described as live-read/);
    expect(() => guardPort({ get: () => 1 } as never, binding({}), policy, new SideEffectRecorder())).toThrow(/does not declare its kind/);
  });

  it('a production binding is refused at runtime even if a composition skipped the startup gate', () => {
    const owner = new Owner('production');
    const recorder = new SideEffectRecorder();
    const port = guardPort(owner, binding({ kind: 'production' }), policy, recorder);
    expect(() => port.get()).toThrow(/production_binding/);
    expect(owner.calls).toBe(0);
    expect(recorder.records.every((r) => !r.production)).toBe(true);
  });
});
