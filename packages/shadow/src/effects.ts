import { z } from 'zod';
import { BINDING_KINDS, EFFECT_CLASSES, SHADOW_CLASSIFICATIONS, ShadowViolation, type DomainBindingDescriptor, type ShadowExecutionPolicy } from './bindings.js';

/**
 * Every call a shadow composition makes to an external owner, as a record:
 * which binding, which declared operation, its effect class, how the shadow
 * boundary classified it, and how it ended. Metadata only — never arguments
 * or answers (they can carry personal data); a write keeps the caller's
 * idempotency key, which for R4 writes is the platform execution key, so the
 * effect can be joined to the governed-action ledger.
 */
export const sideEffectRecordSchema = z.strictObject({
  seq: z.int().positive(),
  at: z.string(),
  domain: z.string(),
  bindingId: z.string(),
  bindingKind: z.enum(BINDING_KINDS),
  operation: z.string(),
  effect: z.enum(EFFECT_CLASSES),
  classification: z.enum(SHADOW_CLASSIFICATIONS),
  outcome: z.enum(['ok', 'error', 'blocked']),
  /** Classified failure of the owner (e.g. temporarily_unavailable, timeout, rate_limited); null on success. */
  errorCategory: z.string().max(64).nullable(),
  latencyMs: z.int().nonnegative(),
  idempotencyKey: z.string().max(200).nullable(),
  /** True only if a production binding was actually called (must never happen). */
  production: z.boolean(),
});
export type SideEffectRecord = z.infer<typeof sideEffectRecordSchema>;

export class SideEffectRecorder {
  readonly #records: SideEffectRecord[] = [];
  readonly #onRecord: ((record: SideEffectRecord) => void) | undefined;
  readonly #now: () => Date;

  constructor(options: { onRecord?: (record: SideEffectRecord) => void; now?: () => Date } = {}) {
    this.#onRecord = options.onRecord;
    this.#now = options.now ?? (() => new Date());
  }

  get records(): readonly SideEffectRecord[] {
    return [...this.#records];
  }

  record(fields: Omit<SideEffectRecord, 'seq' | 'at'>): SideEffectRecord {
    const record = sideEffectRecordSchema.parse({ seq: this.#records.length + 1, at: this.#now().toISOString(), ...fields });
    this.#records.push(record);
    this.#onRecord?.(record);
    return record;
  }
}

/** What a binding implementation says it is. The descriptor must agree with it. */
export interface SelfDescribingBinding {
  readonly bindingKind?: string;
}

/**
 * Wraps one port implementation so that every declared operation is
 * classified by the shadow boundary and recorded, and every undeclared or
 * BLOCKED call is refused before it reaches the implementation.
 *
 * The implementation must declare its own kind (`bindingKind`), and it must
 * equal the descriptor's: a fixture can never be presented as `live-read`
 * (or a production client as `shadow`) by editing a descriptor alone.
 */
export function guardPort<T extends object>(port: T & SelfDescribingBinding, descriptor: DomainBindingDescriptor, policy: ShadowExecutionPolicy, recorder: SideEffectRecorder): T {
  const implementationKind = port.bindingKind;
  if (implementationKind === undefined) throw new ShadowViolation('binding_kind_undeclared', `binding ${descriptor.bindingId}: the implementation does not declare its kind`);
  if (implementationKind !== descriptor.kind) {
    throw new ShadowViolation('binding_kind_mismatch', `binding ${descriptor.bindingId} is described as ${descriptor.kind} but its implementation is ${implementationKind}`);
  }
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(port, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string' || property === 'constructor') return value;
      if (wrapped.has(property)) return wrapped.get(property);
      const call = (...args: unknown[]): unknown => {
        const declared = Object.hasOwn(descriptor.operations, property) ? descriptor.operations[property] : undefined;
        const { classification, reason } = policy.classify(descriptor, property);
        const base = {
          domain: descriptor.domain,
          bindingId: descriptor.bindingId,
          bindingKind: descriptor.kind,
          operation: property,
          effect: declared?.effect ?? ('write' as const),
          classification,
          idempotencyKey: declared?.idempotencyKeyArg !== undefined && typeof args[declared.idempotencyKeyArg] === 'string' ? (args[declared.idempotencyKeyArg] as string).slice(0, 200) : null,
        };
        if (classification === 'BLOCKED') {
          recorder.record({ ...base, outcome: 'blocked', errorCategory: 'shadow_blocked', latencyMs: 0, production: false });
          throw new ShadowViolation('shadow_blocked_call', `shadow boundary refused ${descriptor.bindingId}.${property}: ${reason}`);
        }
        const started = Date.now();
        const production = descriptor.kind === 'production';
        const settle = (outcome: 'ok' | 'error', error: unknown) => {
          recorder.record({ ...base, outcome, errorCategory: outcome === 'ok' ? null : categoryOf(error), latencyMs: Math.max(0, Date.now() - started), production });
        };
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          settle('error', error);
          throw error;
        }
        if (result instanceof Promise) {
          return result.then(
            (answer: unknown) => {
              settle('ok', null);
              return answer;
            },
            (error: unknown) => {
              settle('error', error);
              throw error;
            },
          );
        }
        settle('ok', null);
        return result;
      };
      wrapped.set(property, call);
      return call;
    },
  });
}

/** An owner's classified failure category (duck-typed: ports classify, callers never parse messages). */
function categoryOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const category = (error as { category?: unknown }).category;
    if (typeof category === 'string' && category.length > 0) return category.slice(0, 64);
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return `unclassified:${name}`.slice(0, 64);
  }
  return 'unclassified';
}
