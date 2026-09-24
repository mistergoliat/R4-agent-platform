import { emitTelemetry, type StructuredLogger } from '@r4/observability';
import type { AutonomyControls } from './controls.js';

/**
 * Production write guard (R4-I): the last check before a REAL external
 * mutation. It wraps the declared write operations of a domain port and,
 * immediately before each call, re-reads the autonomy controls: with the
 * kill switch engaged the owner is never called and the caller gets the
 * pack's own "definitely not applied" error (so R4-D records a known,
 * non-applied outcome instead of an uncertain one). It does not authorize
 * anything — R4-D's Policy Engine still does; ALLOW never overrides this.
 */
export function guardProductionWrites<T extends object>(
  port: T,
  options: {
    readonly domain: string;
    readonly writeOperations: readonly (keyof T & string)[];
    readonly controls: AutonomyControls;
    readonly logger: StructuredLogger;
    /** The pack's error meaning "refused before any effect" (e.g. temporarily unavailable). */
    readonly blocked: (operation: string) => Error;
  },
): T {
  const writes = new Set<string>(options.writeOperations);
  return new Proxy(port, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !writes.has(property) || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const state = await options.controls.state();
        if (!state.globalEnabled) {
          emitTelemetry(options.logger, 'production.effect.blocked', { domain: options.domain, operation: property, reason: 'autonomy_disabled' });
          throw options.blocked(property);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
