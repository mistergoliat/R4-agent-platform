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
  type Principal,
  type TrustedHumanContext,
} from '@r4/contracts';
import type { AgentRegistry } from '@r4/agent-registry';
import type { TaskRuntime, TemporalRuntime } from '@r4/task-runtime';
import type { ProductionOperator } from '@r4/live-ops';
import { ARTIFACT_PROPOSAL_STATES, INCIDENT_SIGNATURE, type PostgresAgentDrafts, type PostgresArtifactFacts, type PostgresArtifacts, type PostgresConsoleReads, type PostgresFeedback, type PostgresIncidents, type PostgresTranscripts, type PostgresInsights, type PostgresKnowledge } from '@r4/persistence-postgres';
import { resolveCorrelationId, runWithCorrelation } from '@r4/observability';
import { toErrorResponse } from './errors.js';
import { unauthenticatedPrincipalResolver, type PrincipalResolver } from './principal.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** ADR-050: the exact bytes of a JSON body (the console assertion binds their SHA-256). */
    rawBody?: Buffer;
  }
}

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
  /** ADR-049: read-only service credential for operator-plane GETs. Never authorizes a write. */
  readonly serviceReader?: (request: FastifyRequest) => boolean;
  /** (R4-I) Operator plane of production conversations (thread, delivery, manual reply, autonomy controls). */
  readonly production?: ProductionOperator;
  /** (ADR-049 Phase 2) Console reads: run step trace, activity per day and agent, event feed. */
  readonly consoleReads?: PostgresConsoleReads;
  /** (ADR-051) Incident groups (read) and their human triage (write). */
  readonly incidents?: PostgresIncidents;
  /** (ADR-067) Contact satisfaction ratings (read). */
  readonly feedback?: PostgresFeedback;
  /** (ADR-069) Session (call) transcripts (read). */
  readonly transcripts?: PostgresTranscripts;
  /** (ADR-052) Releases, quality funnel, learning gaps and autonomy reads. */
  readonly insights?: PostgresInsights;
  /** (ADR-052) Curated knowledge entries (read; signed operator writes). */
  readonly knowledge?: PostgresKnowledge;
  /** (ADR-054) Agent drafts (read; signed operator writes with agent.draft). A draft never runs in production. */
  readonly drafts?: PostgresAgentDrafts;
  /** (ADR-058) Signed artifacts, opaque content (read: the current version and its signatures). */
  readonly artifacts?: PostgresArtifacts;
  /** (ADR-058 D10) Facts a person answered for an artifact kind (read; signed operator writes with artifact.curate). */
  readonly facts?: PostgresArtifactFacts;
  /** ADR-050: 'disabled' refuses unauthenticated callers on POST /v1/tasks and /v1/tasks/:id/inputs. Default 'enabled'. */
  readonly anonymousWrites?: 'enabled' | 'disabled';
}

/** (ADR-049 Phase 2) Local days of the activity read. */
export const CONSOLE_TIME_ZONE = 'America/Santiago';

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
  // ADR-050: keep the exact JSON body bytes next to the parsed value; parsing stays Fastify's default.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    void parseJson(request, request.rawBody.toString('utf8'), done);
  });

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

  // ADR-050: with anonymous writes disabled, the R4-B open writes refuse an unauthenticated caller.
  const writer = (request: FastifyRequest): Principal => {
    const principal = resolvePrincipal(request);
    if (deps.anonymousWrites === 'disabled' && principal.kind === 'unauthenticated') {
      throw new PlatformError('precondition', 'anonymous_writes_disabled', 'this API does not accept unauthenticated writes');
    }
    return principal;
  };

  // Liveness: the process is up and serving. Deliberately no dependency checks.
  app.get('/health', (_request, reply) => reply.send({ status: 'ok' }));

  // Readiness: dependencies are reachable and the schema/config are in place.
  app.get('/ready', async (_request, reply) => {
    const report = await deps.readiness();
    return reply.status(report.ready ? 200 : 503).send({ status: report.ready ? 'ready' : 'not_ready', checks: report.checks });
  });

  app.post('/v1/tasks', (request, reply) =>
    inContext(request, async () => {
      const requestedBy = writer(request);
      const body = parse(createTaskRequestSchema, request.body ?? undefined, 'body');
      const rawKey = request.headers['idempotency-key'];
      const idempotencyKey = rawKey === undefined ? undefined : parse(idempotencyKeySchema, rawKey, 'Idempotency-Key header');
      const { view, replayed } = await deps.tasks.createTask({
        request: body,
        requestedBy,
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
    // ADR-049: operator-plane READS also accept the read-only service credential. Writes keep `human`.
    const reader = (request: FastifyRequest): void => {
      if (deps.serviceReader?.(request)) return;
      human(request);
    };
    const executionParams = z.strictObject({ id: uuidSchema });
    const responseKeyBody = z.strictObject({ responseKey: z.string().min(1).max(256) });

    // Canonical inbound input (any channel adapter): the caller is the resolved principal.
    app.post('/v1/tasks/:id/inputs', (request, reply) =>
      inContext(request, async () => {
        const submittedBy = writer(request);
        const { id } = parse(taskParams, request.params, 'path');
        const result = await temporal.submitInput(id, parse(inputSubmissionSchema, request.body ?? undefined, 'body'), submittedBy, request.id);
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
        reader(request);
        return temporal.inspect(parse(taskParams, request.params, 'path').id);
      }),
    );
    app.get('/v1/attention', (request) =>
      inContext(request, async () => {
        reader(request);
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

    if (deps.consoleReads) {
      // ADR-049 Phase 2: console reads (no message text, no reasoning, no contact addresses).
      const reads = deps.consoleReads;
      const activityQuery = z.strictObject({ days: z.coerce.number().int().min(1).max(31).default(7) });
      const eventsQuery = z.strictObject({
        before: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f-]{36}$/, 'expected <iso>|<id>').refine((v) => !Number.isNaN(Date.parse(v.slice(0, 24))), 'invalid timestamp').optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      });
      app.get('/v1/runs/:id/steps', (request) =>
        inContext(request, async () => {
          reader(request);
          return reads.runSteps(parse(runParams, request.params, 'path').id);
        }),
      );
      app.get('/v1/production/activity', (request) =>
        inContext(request, async () => {
          reader(request);
          return reads.activity(parse(activityQuery, request.query, 'query').days, CONSOLE_TIME_ZONE);
        }),
      );
      app.get('/v1/events', (request) =>
        inContext(request, async () => {
          reader(request);
          const { before, limit } = parse(eventsQuery, request.query, 'query');
          const [at, id] = before?.split('|') ?? [];
          return reads.events(limit, at && id ? { at, id } : undefined);
        }),
      );
    }

    if (deps.incidents) {
      // ADR-051: incident groups (service reader or operator) and their triage (signed operator with incident.triage).
      const incidents = deps.incidents;
      const incidentsQuery = z.strictObject({ days: z.coerce.number().int().min(1).max(31).default(7) });
      const triageBody = z
        .strictObject({
          signature: z.string().max(300).regex(INCIDENT_SIGNATURE, 'not an incident signature'),
          state: z.enum(['ignored', 'requested']),
          note: z.string().trim().min(1).max(1000),
          requestUrl: z.url({ protocol: /^https$/ }).max(2000).optional(),
        })
        .refine((b) => b.state !== 'requested' || b.requestUrl !== undefined, { message: 'requestUrl is required when state is requested', path: ['requestUrl'] });
      app.get('/v1/incidents', (request) =>
        inContext(request, async () => {
          reader(request);
          return incidents.list(parse(incidentsQuery, request.query, 'query').days);
        }),
      );
      app.post('/v1/incidents/triage', (request) =>
        inContext(request, async () => {
          const operator = human(request);
          if (!operator.scopes.includes('incident.triage')) throw new PlatformError('precondition', 'human_scope_denied', 'operator lacks the incident.triage scope');
          const { signature, state, note, requestUrl } = parse(triageBody, request.body ?? undefined, 'body');
          return { signature, triage: await incidents.triage(signature, { state, note, requestUrl: requestUrl ?? null }, operator.humanRef, request.id) };
        }),
      );
    }

    if (deps.feedback) {
      // ADR-067 D3: satisfaction totals and the review list (service reader or operator, like a conversation thread).
      // The review comments are the contacts' own words: returned as data, never interpreted.
      const feedback = deps.feedback;
      const feedbackQuery = z.strictObject({ days: z.coerce.number().int().min(1).max(31).default(7) });
      app.get('/v1/feedback', (request) =>
        inContext(request, async () => {
          reader(request);
          return feedback.summary(parse(feedbackQuery, request.query, 'query').days);
        }),
      );
    }

    if (deps.transcripts) {
      // ADR-069 D3: one session transcript (service reader or operator, like the thread that references it). The lines are
      // the contact's words and model output: returned as data, never interpreted.
      const transcripts = deps.transcripts;
      app.get('/v1/session-transcripts/:id', (request) =>
        inContext(request, async () => {
          reader(request);
          const transcript = await transcripts.get(parse(taskParams, request.params, 'path').id);
          if (!transcript) throw new PlatformError('not_found', 'transcript_not_found', 'session transcript not found');
          return { transcript };
        }),
      );
    }

    if (deps.insights) {
      // ADR-052: deterministic reads (service reader or operator). Only the learning gaps carry text (masked).
      const insights = deps.insights;
      const windowQuery = (fallback: number) => z.strictObject({ days: z.coerce.number().int().min(1).max(31).default(fallback) });
      const stage = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/, 'expected a capability id prefix');
      const funnelQuery = z.strictObject({
        days: z.coerce.number().int().min(1).max(31).default(14),
        // One `stage` arrives as a string, several as an array.
        stage: z.union([stage.transform((s) => [s]), z.array(stage)]).pipe(z.array(z.string()).min(1).max(6)),
      });
      app.get('/v1/production/versions', (request) =>
        inContext(request, async () => {
          reader(request);
          return insights.versions(parse(windowQuery(14), request.query, 'query').days);
        }),
      );
      app.get('/v1/quality/funnel', (request) =>
        inContext(request, async () => {
          reader(request);
          const { days, stage: stages } = parse(funnelQuery, request.query, 'query');
          return insights.funnel(days, stages);
        }),
      );
      app.get('/v1/learning/gaps', (request) =>
        inContext(request, async () => {
          reader(request);
          return insights.gaps(parse(windowQuery(14), request.query, 'query').days);
        }),
      );
      app.get('/v1/autonomy', (request) =>
        inContext(request, async () => {
          reader(request);
          return insights.autonomy(parse(windowQuery(30), request.query, 'query').days);
        }),
      );
    }

    if (deps.knowledge) {
      // ADR-052: curated knowledge (no agent reads it). Writes: signed operator with knowledge.curate / knowledge.sign.
      const knowledge = deps.knowledge;
      const entryBody = z.strictObject({
        topic: z.string().trim().min(1).max(120),
        statement: z.string().trim().min(1).max(2000),
        source: z.string().trim().min(1).max(300),
        sourceRef: z.string().trim().min(1).max(300).optional(),
        expiresAt: z.iso.date().optional(),
      });
      const transitionBody = z.strictObject({ entryId: uuidSchema, to: z.enum(['verified', 'signed', 'retired']), note: z.string().trim().min(1).max(500) });
      app.get('/v1/learning/knowledge', (request) =>
        inContext(request, async () => {
          reader(request);
          parse(z.strictObject({}), request.query, 'query');
          return { entries: await knowledge.list() };
        }),
      );
      app.post('/v1/learning/knowledge', (request, reply) =>
        inContext(request, async () => {
          const operator = human(request);
          if (!operator.scopes.includes('knowledge.curate')) throw new PlatformError('precondition', 'human_scope_denied', 'operator lacks the knowledge.curate scope');
          const body = parse(entryBody, request.body ?? undefined, 'body');
          const entry = await knowledge.propose({ ...body, sourceRef: body.sourceRef ?? null, expiresAt: body.expiresAt ?? null }, operator.humanRef, request.id);
          return reply.status(201).send({ entry });
        }),
      );
      // The required scope depends on the entry's current state (proposed→verified and →retired: curate; verified→signed: sign).
      app.post('/v1/learning/knowledge/transition', (request) =>
        inContext(request, async () => {
          const operator = human(request);
          const { entryId, to, note } = parse(transitionBody, request.body ?? undefined, 'body');
          return { entry: await knowledge.transition(entryId, to, note, operator, request.id) };
        }),
      );
    }

    if (deps.artifacts) {
      // ADR-058: signed artifacts (opaque content and changes: Core never interprets them). Reads: service reader or person.
      // Writes: signed operator with artifact.curate (decide proposals) or artifact.sign (sign a version).
      const artifacts = deps.artifacts;
      const kindParams = z.strictObject({ kind: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/) });
      const operatorWith = (request: FastifyRequest, scope: 'artifact.curate' | 'artifact.sign') => {
        const operator = human(request);
        if (!operator.scopes.includes(scope)) throw new PlatformError('precondition', 'human_scope_denied', `operator lacks the ${scope} scope`);
        return operator;
      };
      app.get('/v1/artifacts/:kind/versions', (request) =>
        inContext(request, async () => {
          reader(request);
          parse(z.strictObject({}), request.query, 'query');
          return { versions: await artifacts.versions(parse(kindParams, request.params, 'path').kind) };
        }),
      );
      app.get('/v1/artifacts/:kind/proposals', (request) =>
        inContext(request, async () => {
          reader(request);
          const { state } = parse(z.strictObject({ state: z.enum(ARTIFACT_PROPOSAL_STATES).optional() }), request.query, 'query');
          return { proposals: await artifacts.proposals(parse(kindParams, request.params, 'path').kind, state) };
        }),
      );
      const decideBody = z.strictObject({ proposalIds: z.array(uuidSchema).min(1).max(1000), decision: z.enum(['approved', 'rejected']), note: z.string().trim().min(1).max(500).optional() });
      app.post('/v1/artifacts/:kind/proposals/decide', (request) =>
        inContext(request, async () => {
          const operator = operatorWith(request, 'artifact.curate');
          const { kind } = parse(kindParams, request.params, 'path');
          const body = parse(decideBody, request.body ?? undefined, 'body');
          return artifacts.decide({ kind, proposalIds: body.proposalIds, decision: body.decision, decidedBy: operator.humanRef, note: body.note ?? null, correlationId: request.id });
        }),
      );
      const signBody = z.strictObject({ version: z.number().int().positive(), note: z.string().trim().min(1).max(500).optional() });
      app.post('/v1/artifacts/:kind/sign', (request) =>
        inContext(request, async () => {
          const operator = operatorWith(request, 'artifact.sign');
          const { kind } = parse(kindParams, request.params, 'path');
          const body = parse(signBody, request.body ?? undefined, 'body');
          return { signature: await artifacts.sign({ kind, version: body.version, signedBy: operator.humanRef, note: body.note ?? null, correlationId: request.id }) };
        }),
      );
      if (deps.facts) {
        // ADR-058 D10: what a person answered once (subject, field, value: opaque). Writes need artifact.curate.
        const facts = deps.facts;
        const text = (max: number) => z.string().trim().min(1).max(max);
        const factBody = z.strictObject({ subject: text(120), field: text(120), value: text(500), source: text(200).optional(), note: text(500).optional() });
        app.get('/v1/artifacts/:kind/facts', (request) =>
          inContext(request, async () => {
            reader(request);
            const { subject } = parse(z.strictObject({ subject: text(120).optional() }), request.query, 'query');
            return { facts: await facts.current(parse(kindParams, request.params, 'path').kind, subject) };
          }),
        );
        app.post('/v1/artifacts/:kind/facts', (request, reply) =>
          inContext(request, async () => {
            const operator = operatorWith(request, 'artifact.curate');
            const { kind } = parse(kindParams, request.params, 'path');
            const body = parse(factBody, request.body ?? undefined, 'body');
            const fact = await facts.record(kind, { subject: body.subject, field: body.field, value: body.value, source: body.source ?? 'console', note: body.note ?? null }, operator.humanRef, request.id);
            return reply.status(201).send({ fact });
          }),
        );
      }
      app.get('/v1/artifacts/:kind/current', (request) =>
        inContext(request, async () => {
          reader(request);
          parse(z.strictObject({}), request.query, 'query');
          return { artifact: await artifacts.current(parse(kindParams, request.params, 'path').kind) };
        }),
      );
      app.get('/v1/artifacts/:kind/signatures', (request) =>
        inContext(request, async () => {
          reader(request);
          parse(z.strictObject({}), request.query, 'query');
          return { signatures: await artifacts.signatures(parse(kindParams, request.params, 'path').kind) };
        }),
      );
    }

    if (deps.drafts) {
      // ADR-054 (W1): agent drafts. Reads: service reader or person; writes: signed operator with agent.draft.
      const drafts = deps.drafts;
      const slug = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
      const edits = {
        displayName: z.string().trim().min(1).max(120),
        description: z.string().trim().min(1).max(2000),
        instructions: z.string().trim().min(1).max(50_000),
        capabilityScopes: z.array(z.string().min(1).max(128)).max(64),
        budgets: z.record(z.string().min(1).max(64), z.number().int().nonnegative()),
        note: z.string().trim().min(1).max(500).optional(),
      };
      const createBody = z.strictObject({
        agentId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64),
        base: z.strictObject({ agentId: z.string().min(1).max(64), version: z.number().int().positive() }),
        template: slug,
        channel: slug.optional(),
        label: z.string().trim().min(1).max(60).optional(),
        ...edits,
      });
      const draftParams = z.strictObject({ id: uuidSchema });
      const operatorWith = (request: FastifyRequest) => {
        const operator = human(request);
        if (!operator.scopes.includes('agent.draft')) throw new PlatformError('precondition', 'human_scope_denied', 'operator lacks the agent.draft scope');
        return operator;
      };
      app.get('/v1/agent-drafts', (request) =>
        inContext(request, async () => {
          reader(request);
          parse(z.strictObject({}), request.query, 'query');
          return { drafts: await drafts.list() };
        }),
      );
      app.get('/v1/agent-drafts/:id', (request) =>
        inContext(request, async () => {
          reader(request);
          return drafts.get(parse(draftParams, request.params, 'path').id);
        }),
      );
      app.post('/v1/agent-drafts', (request, reply) =>
        inContext(request, async () => {
          const operator = operatorWith(request);
          const { agentId, base, template, channel, label, note, ...rest } = parse(createBody, request.body ?? undefined, 'body');
          const created = await drafts.create({ agentId, base, template, channel: channel ?? null, label: label ?? null, edits: rest, note: note ?? null }, operator.humanRef, request.id);
          return reply.status(201).send(created);
        }),
      );
      app.post('/v1/agent-drafts/:id/revisions', (request, reply) =>
        inContext(request, async () => {
          const operator = operatorWith(request);
          const { id } = parse(draftParams, request.params, 'path');
          const { note, ...rest } = parse(z.strictObject(edits), request.body ?? undefined, 'body');
          return reply.status(201).send(await drafts.revise(id, rest, note ?? null, operator.humanRef, request.id));
        }),
      );
      app.post('/v1/agent-drafts/:id/discard', (request) =>
        inContext(request, async () => {
          const operator = operatorWith(request);
          parse(z.strictObject({}), request.body ?? {}, 'body');
          return { draft: await drafts.discard(parse(draftParams, request.params, 'path').id, operator.humanRef) };
        }),
      );
    }

    if (deps.production) {
      // R4-I operator plane (API-only): the proven operator semantics of the channel operation, on R4's owners.
      const production = deps.production;
      const outboundParams = z.strictObject({ id: uuidSchema });
      const threadQuery = z.strictObject({ after: z.string().min(1).max(200).optional() });
      const listQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(500).optional() });
      app.get('/v1/production/conversations', (request) =>
        inContext(request, async () => {
          reader(request);
          return { conversations: await production.conversations(parse(listQuery, request.query, 'query').limit) };
        }),
      );
      app.get('/v1/production/attention', (request) =>
        inContext(request, async () => {
          reader(request);
          return production.attention();
        }),
      );
      app.get('/v1/production/metrics', (request) =>
        inContext(request, async () => {
          reader(request);
          return { metrics: await production.metrics() };
        }),
      );
      app.get('/v1/production/controls', (request) =>
        inContext(request, async () => {
          reader(request);
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
          reader(request);
          const { id } = parse(taskParams, request.params, 'path');
          return production.thread(id, parse(threadQuery, request.query, 'query').after);
        }),
      );
      app.get('/v1/tasks/:id/outbound', (request) =>
        inContext(request, async () => {
          reader(request);
          return { outbound: await production.outboundForTask(parse(taskParams, request.params, 'path').id) };
        }),
      );
      app.get('/v1/outbound/:id', (request) =>
        inContext(request, async () => {
          reader(request);
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
