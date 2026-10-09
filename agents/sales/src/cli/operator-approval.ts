import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { createPlatform } from '@r4/api';
import { PostgresExecutionStore, createPool } from '@r4/persistence-postgres';
import { SALES_MIGRATIONS_DIR } from '../definition.js';
import type { ApprovalView } from '../production/approvals.js';
import { NonceLedger, OidcError, OidcVerifier, createOidcHumanContext, loadOperatorRegistry, loopbackLogin, type OperatorAuthConfig } from '../operator-auth/index.js';
import { openApprovalInspection } from './approval-inspection.js';

/**
 * (R4-J3D-S, ADR-033) A human operator's approval decision, end to end:
 *
 *   1 inspect   the open request, its exact validated arguments and hash; the
 *               stored hash must still match the arguments, and the operator
 *               must name the hash they reviewed (--arguments-hash)
 *   2 sign in   OIDC Authorization Code + PKCE + state + nonce (loopback)
 *   3 verify    signature, issuer, audience, expiry, freshness, nonce, Workspace
 *               domain; the (issuer, subject) must be a registered operator
 *               holding approval.decide — refused here, before the runtime
 *   4 re-check  the request is still open with the same hash (the sign-in took time)
 *   5 decide    the platform's own route POST /v1/human-requests/:id/respond,
 *               composed with the OIDC humanContext adapter (createPlatform; never
 *               listening, no agent definitions registered). The Temporal Runtime
 *               records the decision (actor = oidc:<operatorRef>), wakes the task,
 *               and the Policy Engine re-evaluates the same proposal on the next run
 *   6 audit     the runtime's decision event is read back and returned
 *
 * Nothing here writes state itself.
 */
export class DecisionRefused extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DecisionRefused';
    this.code = code;
  }
}

export interface DecisionInput {
  readonly databaseUrl: string;
  readonly decision: 'approve' | 'reject';
  readonly requestId: string;
  readonly reason: string;
  /** The argument hash the operator reviewed (from `approvals show`). */
  readonly argumentsHash: string;
  readonly auth: OperatorAuthConfig;
  readonly logger: Logger;
  readonly openUrl: (url: string) => void | Promise<void>;
  /** Called with the request before sign-in (the CLI prints it). */
  readonly onInspected?: (approval: ApprovalView) => void;
  readonly fetchImpl?: typeof fetch;
  readonly nowS?: () => number;
  readonly loginTimeoutMs?: number;
}

export interface DecisionResult {
  readonly requestId: string;
  readonly taskId: string;
  readonly capability: string;
  readonly argumentsHash: string;
  readonly decision: 'approve' | 'reject';
  readonly status: string;
  readonly audit: { readonly actorRef: string; readonly event: string; readonly occurredAt: string; readonly responseKey: string | null; readonly content: unknown };
}

async function inspect(databaseUrl: string, requestId: string, logger: Logger): Promise<ApprovalView> {
  const { inspection, close } = await openApprovalInspection({ databaseUrl, migrationDirectories: [SALES_MIGRATIONS_DIR], logger });
  try {
    return await inspection.show(requestId);
  } finally {
    await close();
  }
}

function assertSameArguments(approval: ApprovalView, reviewedHash: string): void {
  if (!approval.arguments.hashVerified) throw new DecisionRefused('approval_arguments_tampered', 'the stored argument hash does not match the stored arguments; this request must not be decided');
  if (approval.arguments.hash !== reviewedHash) throw new DecisionRefused('arguments_hash_mismatch', 'the request\'s argument hash is not the one you reviewed (--arguments-hash); inspect it again with "approvals show"');
}

/** Signs one operator in and returns the verified authentication plus the adapter that will accept it once. */
export async function authenticateOperator(input: Pick<DecisionInput, 'auth' | 'openUrl' | 'fetchImpl' | 'nowS' | 'loginTimeoutMs'>) {
  const verifier = await OidcVerifier.discover(input.auth, input.fetchImpl);
  const registry = loadOperatorRegistry(input.auth.registryFile);
  const nonces = new NonceLedger();
  const nonce = nonces.issue();
  const token = await loopbackLogin({ verifier, nonce, openUrl: input.openUrl, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}), ...(input.loginTimeoutMs ? { timeoutMs: input.loginTimeoutMs } : {}) });
  const adapter = createOidcHumanContext({ verifier, registry, nonces, ...(input.nowS ? { nowS: input.nowS } : {}) });
  return { token, nonce, adapter, verifier, registry };
}

export async function decideApproval(input: DecisionInput): Promise<DecisionResult> {
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 2000) throw new DecisionRefused('reason_required', 'a decision needs a reason (1-2000 characters); it is recorded in the audit');
  const before = await inspect(input.databaseUrl, input.requestId, input.logger);
  assertSameArguments(before, input.argumentsHash);
  input.onInspected?.(before);

  const { token, adapter } = await authenticateOperator(input);
  const auth = adapter.diagnose(token);
  if (!auth.operator.scopes.includes('approval.decide')) throw new DecisionRefused('operator_not_authorized', `operator ${auth.operator.operatorRef} does not hold the approver role`);

  const after = await inspect(input.databaseUrl, input.requestId, input.logger);
  assertSameArguments(after, input.argumentsHash);

  const definitions = mkdtempSync(join(tmpdir(), 'r4-operator-'));
  const platform = await createPlatform(
    { databaseUrl: input.databaseUrl, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: definitions, dbPoolMax: 2 },
    { logger: input.logger, humanContext: adapter.resolve },
  );
  const responseKey = `oidc-decision:${randomUUID()}`;
  try {
    const response = await platform.app.inject({
      method: 'POST',
      url: `/v1/human-requests/${input.requestId}/respond`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { responseKey, outcome: input.decision, content: reason },
    });
    if (response.statusCode !== 200) {
      const error = (response.json<{ error?: { code?: string; message?: string } }>().error) ?? {};
      throw new DecisionRefused(error.code ?? `http_${response.statusCode}`, error.message ?? 'the runtime refused the decision');
    }
    const decided = response.json<{ request: { status: string; taskId: string } }>().request;
    const event = await decisionEvent(input.databaseUrl, decided.taskId, input.requestId, responseKey, input.logger);
    return {
      requestId: input.requestId, taskId: decided.taskId, capability: `${after.action.capabilityId}@${after.action.capabilityVersion}`, argumentsHash: after.arguments.hash,
      decision: input.decision, status: decided.status, audit: event,
    };
  } finally {
    await platform.close().catch(() => undefined);
    rmSync(definitions, { recursive: true, force: true });
  }
}

/** The runtime's own record of this decision (read-only). */
async function decisionEvent(databaseUrl: string, taskId: string, requestId: string, responseKey: string, logger: Logger): Promise<DecisionResult['audit']> {
  const pool = createPool({ connectionString: databaseUrl, logger, applicationName: 'r4-operator-audit', max: 1 });
  try {
    const events = await new PostgresExecutionStore(pool).transaction(async (uow) => {
      if (!uow.temporal) throw new DecisionRefused('temporal_unavailable', 'temporal persistence is required');
      return uow.temporal.events(taskId);
    });
    const event = events.find((e) => e.entityId === requestId && e.responseKey === responseKey);
    if (!event) throw new DecisionRefused('decision_not_recorded', 'the runtime accepted the decision but its event was not found');
    return { actorRef: event.actorRef, event: event.type, occurredAt: event.occurredAt, responseKey: event.responseKey, content: event.data.content ?? null };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Who the IdP says the operator is, and whether the registry authorizes them (for provisioning). */
export async function whoAmI(input: Pick<DecisionInput, 'auth' | 'openUrl' | 'fetchImpl' | 'nowS' | 'loginTimeoutMs'>): Promise<Record<string, unknown>> {
  const { token, nonce, verifier, registry } = await authenticateOperator(input);
  const identity = verifier.verify(token, { nonce, ...(input.nowS ? { nowS: input.nowS() } : {}) });
  const operator = registry.find(identity.issuer, identity.subject);
  return {
    issuer: identity.issuer, subject: identity.subject, email: identity.email, hostedDomain: identity.hostedDomain,
    registered: operator !== null, operatorRef: operator?.operatorRef ?? null, roles: operator?.roles ?? [],
    provisioning: operator ? 'authorized' : 'add {"operatorRef", "issuer", "subject", "roles": ["approver"]} to the operator registry to authorize this identity',
  };
}

export { OidcError };
