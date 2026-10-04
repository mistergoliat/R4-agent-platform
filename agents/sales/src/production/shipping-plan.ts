import type { ProductionProfile } from '@r4/live-ops';
import { describeShippingHttpConfig, loadShippingHttpConfig, shippingModeOf } from '@r4-adapters/shipping-http';
import { SALES_DOMAINS } from './profile.js';

/**
 * The Shipping section of `production:sales:plan` (R4-J2D): what the selected
 * profile does with Shipping and whether its configuration is usable.
 * Declarative only — nothing is probed, sent or mutated; connectivity is
 * never claimed from configuration.
 */
export function salesShippingPlan(profile: ProductionProfile, env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean }): Record<string, unknown> {
  const real = profile.domains[SALES_DOMAINS.shipping]?.status === 'REAL';
  const status = real ? 'REAL: pc-carrier over HTTP (read-only)' : 'UNAVAILABLE in this profile (not composed)';
  try {
    if (shippingModeOf(env) !== 'real') return { binding: real ? 'not usable: R4_SHIPPING_MODE is not "real"' : 'not configured (R4_SHIPPING_MODE unset)', profile: status };
    const described = describeShippingHttpConfig(loadShippingHttpConfig(env, options));
    return real ? { ...described, authentication: 'none', profile: status } : { binding: 'UNAVAILABLE', configured: described, profile: status };
  } catch (error) {
    return { configuration: `not usable: ${error instanceof Error ? error.message : String(error)}`, profile: status };
  }
}
