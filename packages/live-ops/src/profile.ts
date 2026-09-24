import { z } from 'zod';
import { fingerprint } from '@r4/contracts';

/**
 * Production profile (R4-I): what one production deployment of an agent pack
 * is allowed to touch, declared, versioned and fingerprinted — never inferred.
 *
 *   domains        every external owner the pack talks to, with the status of
 *                  its binding in THIS deployment:
 *                    REAL         a documented, configured live owner
 *                    SANDBOX      a documented non-operational environment of the owner
 *                    INTERNAL     state R4 itself owns durably (e.g. a pack's working state)
 *                    UNAVAILABLE  no binding: its capabilities are not offered at all
 *                    FIXTURE / SHADOW  test/shadow stand-ins — REFUSED in production
 *   capabilities   every capability of the pack, the domain it reaches and, for
 *                  writes, the governance decision the deployment adopts
 *                  (ALLOW / REQUIRE_APPROVAL / DENY). The action policy that
 *                  enforces them is still R4-D's Policy Engine; the profile
 *                  documents and checks it, it does not replace it.
 *   channel        REAL | SANDBOX delivery binding of the conversation channel
 *   unsupportedContent  what happens with inbound content R4 cannot represent
 *
 * A capability is AVAILABLE only when its domain is REAL or INTERNAL (reads)
 * — or REAL/SANDBOX/INTERNAL for writes that are not DENY. Anything else is
 * not registered and never shown to the model.
 */
export const DOMAIN_BINDING_STATUSES = ['REAL', 'SANDBOX', 'INTERNAL', 'UNAVAILABLE', 'FIXTURE', 'SHADOW'] as const;
export type DomainBindingStatus = (typeof DOMAIN_BINDING_STATUSES)[number];
export const WRITE_DECISIONS = ['ALLOW', 'REQUIRE_APPROVAL', 'DENY'] as const;
export type WriteDecision = (typeof WRITE_DECISIONS)[number];

const slug = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);

export const productionCapabilitySchema = z.discriminatedUnion('effect', [
  z.strictObject({ capabilityId: z.string().min(1).max(256), domain: slug, effect: z.literal('read') }),
  z.strictObject({ capabilityId: z.string().min(1).max(256), domain: slug, effect: z.literal('write'), decision: z.enum(WRITE_DECISIONS) }),
]);
export type ProductionCapability = z.infer<typeof productionCapabilitySchema>;

export const productionProfileSchema = z.strictObject({
  profileId: slug,
  version: z.int().positive(),
  description: z.string().min(1).max(500),
  domains: z.record(slug, z.strictObject({ status: z.enum(DOMAIN_BINDING_STATUSES), contractRef: z.string().min(1).max(300).nullable(), note: z.string().max(300) })),
  channel: z.strictObject({ id: slug, status: z.enum(['REAL', 'SANDBOX']), contractRef: z.string().min(1).max(300) }),
  capabilities: z.array(productionCapabilitySchema).min(1),
  /** Inbound content the channel delivers but R4 cannot represent (media, reactions…): hold for humans, or tell the agent. */
  unsupportedContent: z.enum(['handoff', 'inform_agent']),
});
export type ProductionProfile = z.infer<typeof productionProfileSchema>;

export class ProductionProfileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProductionProfileError';
    this.code = code;
  }
}

export function profileLabel(profile: Pick<ProductionProfile, 'profileId' | 'version'>): string {
  return `${profile.profileId}@${profile.version}`;
}

export function profileFingerprint(profile: ProductionProfile): string {
  return fingerprint(productionProfileSchema.parse(profile));
}

/**
 * Validates a profile for production. Refused: any FIXTURE or SHADOW domain
 * (production never serves fictitious business data), REAL/SANDBOX domains
 * without a documented contract, capabilities of undeclared domains, a
 * duplicated capability.
 */
export function assertProductionProfile(raw: ProductionProfile): ProductionProfile {
  const profile = productionProfileSchema.parse(raw);
  const problems: string[] = [];
  for (const [domain, binding] of Object.entries(profile.domains)) {
    if (binding.status === 'FIXTURE' || binding.status === 'SHADOW') problems.push(`non_production_binding: domain ${domain} is ${binding.status}; production never uses fixture or shadow owners`);
    if ((binding.status === 'REAL' || binding.status === 'SANDBOX') && binding.contractRef === null) problems.push(`undocumented_binding: domain ${domain} is ${binding.status} without a documented contract`);
  }
  const seen = new Set<string>();
  for (const capability of profile.capabilities) {
    if (seen.has(capability.capabilityId)) problems.push(`duplicate_capability: ${capability.capabilityId}`);
    seen.add(capability.capabilityId);
    if (!Object.hasOwn(profile.domains, capability.domain)) problems.push(`undeclared_domain: ${capability.capabilityId} reaches undeclared domain ${capability.domain}`);
  }
  if (problems.length > 0) throw new ProductionProfileError('production_profile_refused', `refusing production profile ${profileLabel(profile)}: ${problems.join('; ')}`);
  return profile;
}

/** Whether a capability of the profile may be registered (offered to the model) in this deployment. */
export function capabilityAvailability(profile: ProductionProfile, capabilityId: string): { available: boolean; reason: string } {
  const capability = profile.capabilities.find((c) => c.capabilityId === capabilityId);
  if (!capability) return { available: false, reason: 'not_in_profile' };
  const status = profile.domains[capability.domain]?.status ?? 'UNAVAILABLE';
  if (capability.effect === 'read') {
    return status === 'REAL' || status === 'INTERNAL' ? { available: true, reason: `read_${status.toLowerCase()}` } : { available: false, reason: `domain_${status.toLowerCase()}` };
  }
  if (capability.decision === 'DENY') return { available: false, reason: 'write_denied' };
  return status === 'REAL' || status === 'SANDBOX' || status === 'INTERNAL' ? { available: true, reason: `write_${capability.decision.toLowerCase()}` } : { available: false, reason: `domain_${status.toLowerCase()}` };
}

export function availableCapabilities(profile: ProductionProfile): string[] {
  return profile.capabilities.filter((c) => capabilityAvailability(profile, c.capabilityId).available).map((c) => c.capabilityId);
}

/** How an implementation plugged into a production composition declares what it is. */
export interface ProductionBindingDeclaration {
  readonly domain: string;
  /** What the implementation itself says it is (fixtures declare `fixture`, stand-ins `shadow`, real adapters `real`). */
  readonly bindingKind: 'real' | 'sandbox' | 'internal' | 'unavailable' | 'fixture' | 'shadow';
}

export interface ProductionCompositionReport {
  readonly profile: string;
  readonly profileFingerprint: string;
  readonly domains: Readonly<Record<string, DomainBindingStatus>>;
  readonly capabilities: readonly { readonly capabilityId: string; readonly available: boolean; readonly reason: string }[];
  readonly writes: { readonly allow: readonly string[]; readonly requireApproval: readonly string[]; readonly deny: readonly string[] };
}

/**
 * Startup gate of a production composition: the profile is valid, every
 * domain implementation actually is what the profile declares (a fixture
 * cannot be presented as REAL by editing a descriptor), and the registered
 * capabilities are exactly a subset of the available ones.
 */
export function assertProductionComposition(profile: ProductionProfile, implementations: readonly ProductionBindingDeclaration[], registeredCapabilityIds: readonly string[]): ProductionCompositionReport {
  const valid = assertProductionProfile(profile);
  const problems: string[] = [];
  const expected: Record<DomainBindingStatus, ProductionBindingDeclaration['bindingKind'] | null> = { REAL: 'real', SANDBOX: 'sandbox', INTERNAL: 'internal', UNAVAILABLE: 'unavailable', FIXTURE: null, SHADOW: null };
  for (const impl of implementations) {
    if (impl.bindingKind === 'fixture' || impl.bindingKind === 'shadow') problems.push(`non_production_implementation: ${impl.domain} is implemented by a ${impl.bindingKind}`);
    const declared = valid.domains[impl.domain];
    if (!declared) {
      problems.push(`undeclared_implementation: ${impl.domain}`);
      continue;
    }
    if (expected[declared.status] !== impl.bindingKind) problems.push(`binding_mismatch: profile declares ${impl.domain}=${declared.status} but the implementation is ${impl.bindingKind}`);
  }
  for (const id of registeredCapabilityIds) {
    const availability = capabilityAvailability(valid, id);
    if (!availability.available) problems.push(`unavailable_capability_registered: ${id} (${availability.reason})`);
  }
  if (problems.length > 0) throw new ProductionProfileError('production_composition_refused', `refusing production composition ${profileLabel(valid)}: ${problems.join('; ')}`);
  const writes = valid.capabilities.filter((c): c is Extract<ProductionCapability, { effect: 'write' }> => c.effect === 'write');
  return {
    profile: profileLabel(valid),
    profileFingerprint: profileFingerprint(valid),
    domains: Object.fromEntries(Object.entries(valid.domains).map(([d, b]) => [d, b.status])),
    capabilities: valid.capabilities.map((c) => ({ capabilityId: c.capabilityId, ...capabilityAvailability(valid, c.capabilityId) })),
    writes: {
      allow: writes.filter((w) => w.decision === 'ALLOW').map((w) => w.capabilityId),
      requireApproval: writes.filter((w) => w.decision === 'REQUIRE_APPROVAL').map((w) => w.capabilityId),
      deny: writes.filter((w) => w.decision === 'DENY').map((w) => w.capabilityId),
    },
  };
}
