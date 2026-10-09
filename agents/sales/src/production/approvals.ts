import { PlatformError, fingerprint, type ApprovalRequest, type HumanRequest, type JsonObject } from '@r4/contracts';
import type { ProductionStore } from '@r4/live-ops';
import type { StructuredLogger } from '@r4/observability';

/**
 * (R4-J3D-R) Read-only inspection of open approval requests, for the
 * production host (`production:sales:control approvals list|show`) and the
 * isolated Sales canary (`sales:canary approvals list|show`).
 *
 * It shows what an approver would decide on: the exact validated arguments
 * the Policy Engine bound to the request, their hash, and whether that hash
 * still matches the arguments (recomputed here with the platform's own
 * fingerprint). It reads only the Temporal Runtime's attention view and the
 * production store's binding/task facts.
 *
 * It never decides. Approving or rejecting needs a trusted human identity
 * (an authenticated operator context for the Temporal Runtime), and R4 has
 * no operator IAM (ADR-021 §5; roadmap §4 "(E) IAM productivo de
 * operadores: no simularlo"; R4-I D-5 rejected a host-declared identity).
 * Host access is not a verified individual, so nothing here builds an
 * operator context or writes anything.
 */
export const APPROVAL_DECISION_BLOCKER =
  'approving or rejecting needs a trusted human identity (an authenticated operator context); R4 has no operator IAM and host access is not a verified individual (ADR-021 §5, R4-I D-5). See docs/architecture/R4-J3D-R_SALES_APPROVAL_CLI_REPORT.md';

/** What the inspection reads from the Temporal Runtime (its attention view). */
export interface ApprovalAttentionSource {
  attention(): Promise<{ readonly requests: readonly HumanRequest[] }>;
}

export interface ApprovalView {
  readonly requestId: string;
  readonly status: HumanRequest['status'];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly task: { readonly taskId: string; readonly runId: string | null; readonly status: string | null };
  readonly conversation: { readonly channel: string; readonly bindingId: string; readonly profile: string } | null;
  readonly action: { readonly capabilityId: string; readonly capabilityVersion: number; readonly proposalId: string; readonly policyDecisionId: string };
  readonly arguments: {
    readonly hash: string;
    /** The recorded hash equals the platform fingerprint of the recorded arguments. */
    readonly hashVerified: boolean;
    /** Exactly what the Policy Engine bound to this request (the command an approval would authorize). */
    readonly validated: JsonObject;
  };
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ApprovalInspection {
  readonly #temporal: ApprovalAttentionSource;
  readonly #store: Pick<ProductionStore, 'bindingByTask' | 'taskState'>;

  constructor(options: { temporal: ApprovalAttentionSource; store: Pick<ProductionStore, 'bindingByTask' | 'taskState'> }) {
    this.#temporal = options.temporal;
    this.#store = options.store;
  }

  /** Open (`requested`) approval requests, oldest first. */
  async list(): Promise<ApprovalView[]> {
    const open = (await this.#temporal.attention()).requests.filter(isOpenApproval);
    const out: ApprovalView[] = [];
    for (const request of [...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId))) out.push(await this.#view(request));
    return out;
  }

  /** One open approval request with its exact arguments; a decided or unknown request is refused. */
  async show(requestId: string): Promise<ApprovalView> {
    if (!REQUEST_ID.test(requestId)) throw new PlatformError('validation', 'invalid_request_id', 'the approval request id must be a UUID');
    const request = (await this.#temporal.attention()).requests.find((r) => r.requestId === requestId);
    if (!request || !isOpenApproval(request)) throw new PlatformError('not_found', 'approval_not_open', 'no open approval request with this id (unknown, not an approval, or already decided)');
    return this.#view(request);
  }

  async #view(request: ApprovalRequest): Promise<ApprovalView> {
    const binding = await this.#store.bindingByTask(request.taskId);
    const { payload } = request;
    return {
      requestId: request.requestId,
      status: request.status,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      task: { taskId: request.taskId, runId: request.runId, status: (await this.#store.taskState(request.taskId))?.status ?? null },
      conversation: binding ? { channel: binding.channel, bindingId: binding.bindingId, profile: binding.profile } : null,
      action: { capabilityId: payload.capabilityId, capabilityVersion: payload.capabilityVersion, proposalId: payload.proposalId, policyDecisionId: payload.policyDecisionId },
      arguments: { hash: payload.argumentsHash, hashVerified: fingerprint(payload.validatedArguments) === payload.argumentsHash, validated: payload.validatedArguments },
    };
  }
}

function isOpenApproval(request: HumanRequest): request is ApprovalRequest {
  return request.kind === 'approval' && request.status === 'requested';
}

/** Opens an inspection over a deployment database (composed by the host CLI). */
export type OpenApprovalInspection = (options: { readonly databaseUrl: string; readonly migrationDirectories: readonly string[]; readonly logger: StructuredLogger }) => Promise<{
  readonly inspection: ApprovalInspection;
  readonly close: () => Promise<void>;
}>;
