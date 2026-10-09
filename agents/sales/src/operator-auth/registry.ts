import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { OidcError } from './oidc.js';

/**
 * (R4-J3D-S, ADR-033) Authorized operators. An identity verified by the
 * IdP is an operator only when its STABLE identifier — the pair
 * (issuer, subject) — is listed here; an email is never a key (it can be
 * renamed or reassigned). Roles map to platform human scopes (RBAC):
 *
 *   approver  approval.decide
 *
 * The file is owner-provisioned on the host, outside Git, readable only by
 * its owner (mode 0600/0400 on POSIX). Loaded once per process.
 */
export const OPERATOR_ROLES = Object.freeze({ approver: Object.freeze(['approval.decide'] as const) });
export type OperatorRole = keyof typeof OPERATOR_ROLES;

const registrySchema = z.strictObject({
  version: z.literal(1),
  operators: z
    .array(
      z.strictObject({
        operatorRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
        issuer: z.string().min(1).max(256),
        subject: z.string().min(1).max(255),
        roles: z.array(z.enum(Object.keys(OPERATOR_ROLES) as [OperatorRole, ...OperatorRole[]])).max(8),
        displayName: z.string().min(1).max(120).optional(),
        disabled: z.boolean().optional(),
      }),
    )
    .max(200),
});

export interface AuthorizedOperator {
  readonly operatorRef: string;
  readonly roles: readonly OperatorRole[];
  readonly scopes: readonly string[];
}

export class OperatorRegistry {
  readonly #byIdentity: ReadonlyMap<string, AuthorizedOperator>;

  constructor(document: unknown) {
    const parsed = registrySchema.safeParse(document);
    if (!parsed.success) throw new OidcError('operator_registry_invalid', 'the operator registry does not match its schema');
    const map = new Map<string, AuthorizedOperator>();
    const refs = new Set<string>();
    for (const o of parsed.data.operators) {
      const key = identityKey(o.issuer, o.subject);
      if (map.has(key) || refs.has(o.operatorRef)) throw new OidcError('operator_registry_invalid', 'the operator registry lists an identity or operatorRef twice');
      refs.add(o.operatorRef);
      if (o.disabled) continue;
      const roles = [...new Set(o.roles)];
      map.set(key, { operatorRef: o.operatorRef, roles, scopes: [...new Set(roles.flatMap((r) => OPERATOR_ROLES[r]))] });
    }
    this.#byIdentity = map;
  }

  /** The authorized operator behind a verified (issuer, subject), or null. */
  find(issuer: string, subject: string): AuthorizedOperator | null {
    return this.#byIdentity.get(identityKey(issuer, subject)) ?? null;
  }
}

function identityKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

/** Loads the registry file; refuses one that group or others can read or write (POSIX). */
export function loadOperatorRegistry(file: string): OperatorRegistry {
  let raw: string;
  try {
    if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) throw new OidcError('operator_registry_insecure', 'the operator registry must not be accessible to group or others (chmod 600)');
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError('operator_registry_unreadable', 'the operator registry file cannot be read');
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new OidcError('operator_registry_invalid', 'the operator registry is not JSON');
  }
  return new OperatorRegistry(document);
}
