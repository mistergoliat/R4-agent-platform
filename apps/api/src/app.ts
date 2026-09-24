import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PlatformError,
  agentIdSchema,
  createTaskRequestSchema,
  idempotencyKeySchema,
  uuidSchema,
  handoffTakeoverSchema,
  inputSubmissionSchema,
  humanResponseSchema,
  trustedHumanContextSchema,
  type TrustedHumanContext,
} from '@r4/contracts';
import type { AgentRegistry } from '@r4/agent-registry';
import type { TaskRuntime, TemporalRuntime } from '@r4/task-runtime';
import type { ProductionOperator } from '@r4/live-ops';
import { resolveCorrelationId, runWithCorrelation } from '@r4/observability';
import { toErrorResponse } from './errors.js';
import { unauthenticatedPrincipalResolver, type PrincipalResolver } from './principal.js';

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, unknown>>;
}

export interface AppDependencies {
  readonly logger: FastifyBaseLogger;
  readonly tasks: TaskRuntime;
  readonly agents: AgentRegistry;
  readonly readiness: () => Promise<ReadinessReport>;
  readonly principal?: PrincipalResolver;
  readonly temporal?: TemporalRuntime;
  /** Auth adapter seam: absent by default; no header/body impersonation fallback. */
  readonly humanContext?: (request: FastifyRequest) => TrustedHumanContext | null;
  /** (R4-I) Operator plane of production conversations (thread, delivery, manual reply, autonomy controls). */
  readonly production?: ProductionOperator;
}

export const CORRELATION_HEADER = 'x-correlation-id';
const MAX_BODY_BYTES = 256 * 1024;

const taskParams = z.strictObject({ id: uuidSchema });
const runParams = z.strictObject({ id: uuidSchema });
const agentParams = z.strictObject({ id: agentIdSchema });
const agentQuery = z.strictObject({ version: z.coerce.number().int().positive().optional() });

/**
 * HTTP transport for the R4 public API (v1). Routes only validate input,
 * resolve the caller and delegate to runtime services — no business logic
 * lives here. Only endpoints for implemented features exist.
 */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const resolvePrincipal = deps.principal ?? unauthenticatedPrincipalResolver;
  const app = Fastify({
    loggerInstance: deps.logger,
    // Request logging is done once, structured, in the onResponse hook below.
    logController: new Fastify.LogController({ disableRequestLogging: true, requestIdLogLabel: 'correlationId' }),
    bodyLimit: MAX_BODY_BYTES,
    genReqId: (request) => resolveCorrelationId(request.headers[CORRELATION_HEADER]),
  });

  // The API speaks JSON only; other media types are refused with 415.
  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', async (request, reply) => {
    reply.header(CORRELATION_HEADER, request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        event: 'http.request.completed',
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'http.request.completed',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    const { status, body, internal } = toErrorResponse(error, request.id);
    if (internal) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.info({ errorCode: body.error.code, statusCode: status }, 'request rejected');
    }
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: { code: 'route_not_found', message: `no route for ${request.method} ${request.url.split('?')[0]}`, correlationId: request.id },
    });
  });

  // Liveness: the process is up and serving. Deliberately no dependency checks.
  app.get('/health', (_request, reply) => reply.send({ status: 'ok' }));

  // Readiness: dependencies are reachable and the schema/config are in place.
  app.get('/ready', async (_request, reply) => {
    const report = await deps.readiness();
    return reply.status(report.ready ? 200 : 503).send({ status: report.ready ? 'ready' : 'not_ready', checks: report.checks });
  });

  app.post('/v1/tasks', (request, reply) =>
    inContext(request, async () => {
      const body = parse(createTaskRequestSchema, request.body ?? undefined, 'body');
      const rawKey = request.headers['idempotency-key'];
      const idempotencyKey = rawKey === undefined ? undefined : parse(idempotencyKeySchema, rawKey, 'Idempotency-Key header');
      const { view, replayed } = await deps.tasks.createTask({
        request: body,
        requestedBy: resolvePrincipal(request),
        correlationId: request.id,
        idempotencyKey,
      });
      return reply
        .status(replayed ? 200 : 201)
        .header('location', `/v1/tasks/${view.task.taskId}`)
        .header('idempotency-replayed', String(replayed))
        .send(view);
    }),
  );

  app.get('/v1/tasks/:id', (request) =>
    inContext(request, async () => {
      const { id } = parse(taskParams, request.params, 'path');
      return deps.tasks.getTask(id);
    }),
  );

  app.get('/v1/agents', (request) =>
    inContext(request, async () => ({ agents: await deps.agents.list() })),
  );

  app.get('/v1/agents/:id', (request) =>
    inContext(request, async () => {
      const { id } = parse(agentParams, request.params, 'path');
      const { version } = parse(agentQuery, request.query, 'query');
      return deps.agents.get(id, version);
    }),
  );

  app.get('/v1/runs/:id', (request) =>
    inContext(request, async () => {
      const { id } = parse(runParams, request.params, 'path');
      return deps.tasks.getRun(id);
    }),
  );

  if (deps.temporal) {
    // R4-E. Operator-plane seams (no UI): every human operation needs a
    // TrustedHumanContext from the authentication adapter. There is no
    // production IAM yet, so without an adapter these routes refuse (422
    // trusted_human_required) — identity is never read from headers or bodies.
    const temporal = deps.temporal;
    const human = (request: FastifyRequest): TrustedHumanContext => {
      const context = deps.humanContext?.(request);
      if (!context) throw new PlatformError('precondition', 'trusted_human_required', 'an authenticated human context adapter is required');
      return parse(trustedHumanContextSchema, { ...context, correlationId: request.id }, 'trusted human context');
    };
    const executionParams = z.strictObject({ id: uuidSchema });
    const responseKeyBody = z.strictObject({ responseKey: z.string().min(1).max(256) });

    // Canonical inbound input (any channel adapter): the caller is the resolved principal.
    app.post('/v1/tasks/:id/inputs', (request, reply) =>
      inContext(request, async () => {
        const { id } = parse(taskParams, request.params, 'path');
        const result = await temporal.submitInput(id, parse(inputSubmissionSchema, request.body ?? undefined, 'body'), resolvePrincipal(request), request.id);
        return reply.status(result.replayed ? 200 : 201).header('idempotency-replayed', String(result.replayed)).send(result);
      }),
    );
    app.post('/v1/tasks/:id/cancel', (request) =>
      inContext(request, async () => {
        parse(z.strictObject({}), request.body ?? {}, 'body');
        return { task: await temporal.cancelTask(parse(taskParams, request.params, 'path').id, human(request)) };
      }),
    );
    // Operator-initiated handoff: a human takes ownership without the agent asking.
    app.post('/v1/tasks/:id/handoff', (request) =>
      inContext(request, async () => {
        const { id } = parse(taskParams, request.params, 'path');
        return { request: await temporal.takeOver(id, parse(handoffTakeoverSchema, request.body ?? undefined, 'body'), human(request)) };
      }),
    );
    app.get('/v1/tasks/:id/temporal', (request) =>
      inContext(request, async () => {
        human(request);
        return temporal.inspect(parse(taskParams, request.params, 'path').id);
      }),
    );
    app.get('/v1/attention', (request) =>
      inContext(request, async () => {
        human(request);
        return temporal.attention();
      }),
    );
    // Consultation answer, approve / reject, handoff accept / release, withdraw.
    app.post('/v1/human-requests/:id/respond', (request) =>
      inContext(request, async () => {
        const { id } = parse(taskParams, request.params, 'path');
        return { request: await temporal.respondHuman(id, parse(humanResponseSchema, request.body ?? undefined, 'body'), human(request)) };
      }),
    );
    // Exhausted reconciliation: a fresh attempt budget. The outcome stays unknown until evidence exists.
    app.post('/v1/executions/:id/reconciliation/reschedule', (request) =>
      inContext(request, async () => {
        const { id } = parse(executionParams, request.params, 'path');
        return { schedule: await temporal.rescheduleReconciliation(id, parse(responseKeyBody, request.body ?? undefined, 'body'), human(request)) };
      }),
    );

    if (deps.production) {
      // R4-I operator plane (API-only): the proven operator semantics of the channel operation, on R4's owners.
      const production = deps.production;
      const outboundParams = z.strictObject({ id: uuidSchema });
      const threadQuery = z.strictObject({ after: z.string().min(1).max(200).optional() });
      const listQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(500).optional() });
      app.get('/v1/production/conversations', (request) =>
        inContext(request, async () => {
          human(request);
          return { conversations: await production.conversations(parse(listQuery, request.query, 'query').limit) };
        }),
      );
      app.get('/v1/production/attention', (request) =>
        inContext(request, async () => {
          human(request);
          return production.attention();
        }),
      );
      app.get('/v1/production/metrics', (request) =>
        inContext(request, async () => {
          human(request);
          return { metrics: await production.metrics() };
        }),
      );
      app.get('/v1/production/controls', (request) =>
        inContext(request, async () => {
          human(request);
          return production.controls();
        }),
      );
      app.post('/v1/production/controls', (request) =>
        inContext(request, async () => {
          const body = parse(z.strictObject({ scope: z.string().min(1).max(80), autonomyEnabled: z.boolean(), reason: z.string().trim().min(1).max(500) }), request.body ?? undefined, 'body');
          return { control: await production.setControl(body, human(request)) };
        }),
      );
      // Thread with an incremental cursor: operators poll for new entries (the channel operation's "live" thread).
      app.get('/v1/tasks/:id/thread', (request) =>
        inContext(request, async () => {
          human(request);
          const { id } = parse(taskParams, request.params, 'path');
          return production.thread(id, parse(threadQuery, request.query, 'query').after);
        }),
      );
      app.get('/v1/tasks/:id/outbound', (request) =>
        inContext(request, async () => {
          human(request);
          return { outbound: await production.outboundForTask(parse(taskParams, request.params, 'path').id) };
        }),
      );
      app.get('/v1/outbound/:id', (request) =>
        inContext(request, async () => {
          human(request);
          return production.outbound(parse(outboundParams, request.params, 'path').id);
        }),
      );
      // Manual reply: takes human ownership (if needed), supersedes pending agent sends, queues the operator's text.
      app.post('/v1/tasks/:id/operator-messages', (request, reply) =>
        inContext(request, async () => {
          const { id } = parse(taskParams, request.params, 'path');
          const body = parse(z.strictObject({ responseKey: z.string().min(1).max(128), text: z.string().trim().min(1).max(4096) }), request.body ?? undefined, 'body');
          const result = await production.manualReply(id, body, human(request));
          return reply.status(result.replayed ? 200 : 201).send(result);
        }),
      );
      // Settles an UNKNOWN delivery outcome with out-of-band evidence (never a resend).
      app.post('/v1/outbound/:id/resolve', (request) =>
        inContext(request, async () => {
          const { id } = parse(outboundParams, request.params, 'path');
          const body = parse(z.strictObject({ outcome: z.enum(['delivered', 'failed']), note: z.string().trim().min(1).max(1000) }), request.body ?? undefined, 'body');
          return { outbound: await production.resolveOutbound(id, body, human(request)) };
        }),
      );
      app.post('/v1/outbound/:id/cancel', (request) =>
        inContext(request, async () => {
          parse(z.strictObject({}), request.body ?? {}, 'body');
          return { outbound: await production.cancelOutbound(parse(outboundParams, request.params, 'path').id, human(request)) };
        }),
      );
    }
  }

  return app;
}

function inContext<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  return runWithCorrelation({ correlationId: request.id }, fn);
}

function parse<T extends z.ZodType>(schema: T, value: unknown, where: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PlatformError('validation', 'validation_failed', `invalid ${where}: ${z.prettifyError(parsed.error)}`, {
      location: where,
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
