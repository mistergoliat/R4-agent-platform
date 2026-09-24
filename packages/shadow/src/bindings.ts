import { z } from 'zod';
import { fingerprint } from '@r4/evaluation';
import { assertShadowMode, type ShadowExecutionConfig } from './mode.js';

/**
 * Domain bindings (R4-H). A pack talks to external owners through ports; a
 * binding is one implementation of one port, and it DECLARES what it is:
 *
 *   kind          fixture | live-read | sandbox | shadow | production
 *   operations    every method it exposes, each with its effect class
 *                 (read | write) — declared, never inferred from an HTTP verb
 *   contractRef   the documented contract a live/sandbox binding follows
 *
 * The ShadowExecutionPolicy does not authorize anything (R4-D's Policy
 * Engine keeps that): it decides WHERE an effect the Policy already allowed
 * may materialize. Both must hold. In shadow:
 *
 *   READ_ALLOWED   reads of fixture / shadow / sandbox bindings; reads of a
 *                  live-read binding when live reads were opted into and the
 *                  binding cites a contract and has no write operation
 *   SHADOW_WRITE   writes of a fixture or shadow (record-only) binding
 *   SANDBOX_WRITE  writes of a sandbox binding with a documented contract
 *   BLOCKED        everything else — any production binding, an undeclared
 *                  operation, a live-read binding that can write, live reads
 *                  not opted into
 *
 * A composition with any BLOCKED binding is refused at startup; the port
 * guard re-checks every call at runtime (defense in depth) and records it.
 */
export const BINDING_KINDS = ['fixture', 'live-read', 'sandbox', 'shadow', 'production'] as const;
export type BindingKind = (typeof BINDING_KINDS)[number];
export const EFFECT_CLASSES = ['read', 'write'] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];
export const SHADOW_CLASSIFICATIONS = ['READ_ALLOWED', 'SHADOW_WRITE', 'SANDBOX_WRITE', 'BLOCKED'] as const;
export type ShadowClassification = (typeof SHADOW_CLASSIFICATIONS)[number];

const slug = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

export const operationDeclarationSchema = z.strictObject({
  effect: z.enum(EFFECT_CLASSES),
  /** Index of the argument carrying the caller's idempotency key (writes that take one). */
  idempotencyKeyArg: z.int().nonnegative().optional(),
});
export type OperationDeclaration = z.infer<typeof operationDeclarationSchema>;

export const domainBindingDescriptorSchema = z.strictObject({
  /** The external owner / port (e.g. an owner name a pack uses). */
  domain: slug,
  bindingId: slug,
  kind: z.enum(BINDING_KINDS),
  version: z.int().positive(),
  operations: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/), operationDeclarationSchema).refine((o) => Object.keys(o).length > 0, 'a binding declares at least one operation'),
  /** Documented contract (path or URL of the spec it follows). Required for live-read and sandbox. */
  contractRef: z.string().min(1).max(300).nullable(),
  description: z.string().min(1).max(300),
});
export type DomainBindingDescriptor = z.infer<typeof domainBindingDescriptorSchema>;

/** Where a `respond` would be delivered. Only the shadow sink exists as an implementation. */
export const OUTBOUND_BINDING_KINDS = ['shadow-sink', 'production-delivery'] as const;
export const outboundBindingDescriptorSchema = z.strictObject({
  bindingId: slug,
  kind: z.enum(OUTBOUND_BINDING_KINDS),
  version: z.int().positive(),
});
export type OutboundBindingDescriptor = z.infer<typeof outboundBindingDescriptorSchema>;

export interface Classification {
  readonly classification: ShadowClassification;
  readonly reason: string;
}

export class ShadowViolation extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ShadowViolation';
    this.code = code;
  }
}

/**
 * The shadow boundary as a pure function of (config, binding, operation).
 * It never looks at who asked or why — that is the Policy Engine's job.
 */
export class ShadowExecutionPolicy {
  readonly config: ShadowExecutionConfig;

  constructor(config: ShadowExecutionConfig) {
    this.config = assertShadowMode(config);
  }

  classify(binding: DomainBindingDescriptor, operation: string): Classification {
    const declared = Object.hasOwn(binding.operations, operation) ? binding.operations[operation] : undefined;
    if (!declared) return { classification: 'BLOCKED', reason: `undeclared_operation: ${binding.bindingId}.${operation} has no declared effect class` };
    const effect = declared.effect;
    switch (binding.kind) {
      case 'production':
        return { classification: 'BLOCKED', reason: `production_binding: ${binding.bindingId} is a production binding; shadow never calls one` };
      case 'live-read': {
        if (Object.values(binding.operations).some((o) => o.effect !== 'read')) return { classification: 'BLOCKED', reason: `live_read_binding_can_write: ${binding.bindingId} declares a write operation` };
        if (!this.config.allowLiveRead) return { classification: 'BLOCKED', reason: `live_read_not_enabled: R4_SHADOW_ALLOW_LIVE_READ is not true` };
        if (binding.contractRef === null) return { classification: 'BLOCKED', reason: `undocumented_live_binding: ${binding.bindingId} cites no documented contract` };
        return { classification: 'READ_ALLOWED', reason: 'live read-only binding with documented contract' };
      }
      case 'sandbox':
        if (binding.contractRef === null) return { classification: 'BLOCKED', reason: `undocumented_sandbox: ${binding.bindingId} cites no documented contract` };
        return effect === 'read' ? { classification: 'READ_ALLOWED', reason: 'sandbox read' } : { classification: 'SANDBOX_WRITE', reason: 'sandbox write (non-operational environment)' };
      case 'fixture':
      case 'shadow':
        return effect === 'read' ? { classification: 'READ_ALLOWED', reason: `${binding.kind} read` } : { classification: 'SHADOW_WRITE', reason: `${binding.kind} write (controlled, record-only)` };
    }
  }

  classifyOutbound(binding: OutboundBindingDescriptor): Classification {
    return binding.kind === 'shadow-sink' ? { classification: 'SHADOW_WRITE', reason: 'recorded, never delivered' } : { classification: 'BLOCKED', reason: `production_delivery: ${binding.bindingId} would deliver to a real recipient` };
  }
}

export interface ShadowCompositionReport {
  readonly bindings: readonly (DomainBindingDescriptor & { readonly fingerprint: string; readonly classifications: Readonly<Record<string, ShadowClassification>> })[];
  readonly outbound: OutboundBindingDescriptor & { readonly fingerprint: string };
}

/**
 * Startup gate: parses every descriptor, classifies every declared
 * operation, and refuses the whole composition if anything is BLOCKED or
 * if two bindings claim the same domain (no "maybe real" ambiguity).
 */
export function assertShadowComposition(config: ShadowExecutionConfig, bindings: readonly DomainBindingDescriptor[], outbound: OutboundBindingDescriptor): ShadowCompositionReport {
  const policy = new ShadowExecutionPolicy(config);
  const problems: string[] = [];
  const seen = new Set<string>();
  const described = bindings.map((raw) => {
    const binding = domainBindingDescriptorSchema.parse(raw);
    if (seen.has(binding.domain)) problems.push(`ambiguous_binding: more than one binding for domain ${binding.domain}`);
    seen.add(binding.domain);
    const classifications: Record<string, ShadowClassification> = {};
    for (const operation of Object.keys(binding.operations)) {
      const c = policy.classify(binding, operation);
      classifications[operation] = c.classification;
      if (c.classification === 'BLOCKED') problems.push(c.reason);
    }
    return { ...binding, fingerprint: bindingFingerprint(binding), classifications };
  });
  const out = outboundBindingDescriptorSchema.parse(outbound);
  const outboundClass = policy.classifyOutbound(out);
  if (outboundClass.classification === 'BLOCKED') problems.push(outboundClass.reason);
  if (problems.length > 0) throw new ShadowViolation('shadow_composition_refused', `refusing shadow composition: ${problems.join('; ')}`);
  return { bindings: described, outbound: { ...out, fingerprint: fingerprint(out) } };
}

export function bindingFingerprint(binding: DomainBindingDescriptor): string {
  return fingerprint(domainBindingDescriptorSchema.parse(binding));
}

/** `<domain>=<kind>:<bindingId>@<version>` — the unambiguous label artifacts print. */
export function bindingLabel(binding: Pick<DomainBindingDescriptor, 'domain' | 'kind' | 'bindingId' | 'version'>): string {
  return `${binding.domain}=${binding.kind}:${binding.bindingId}@${binding.version}`;
}
