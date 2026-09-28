---
title: R4 — Arquitectura implementada (R4-B + R4-C1 + R4-C2 + R4-D + R4-E), R4-F (Sales Reference Application), R4-G y R4-H
status: implemented (R4-B … R4-E, published at 74ed8e7); R4-F published at 1927499 (R4-F BASELINE); R4-G Quality & Learning COMPLETED (on 001b7a8); R4-H Shadow / E2E CLOSED; GAP-H-001 / ADR-028 RESOLVED (dd06a68); R4-I Governed Production IN PROGRESS (on dd06a68, pending audit)
owner: architecture
last_reviewed: 2026-09-24
depends_on:
  - R4_AGENTIC_PLATFORM_MOTIVATION_AND_CONSTRAINTS.md
  - R4_AGENTIC_PLATFORM_PRD_AND_ROADMAP.md
  - ../adr/ADR-001-r4-separated-from-crm.md
  - ../adr/ADR-002-agent-cognition-vs-platform-authority.md
  - ../adr/ADR-003-postgresql-durable-runtime-state.md
  - ../adr/ADR-004-provider-neutral-model-gateway.md
  - ../adr/ADR-005-domain-capabilities-outside-core.md
  - ../adr/ADR-006-worker-task-claiming.md
  - ../adr/ADR-007-lease-heartbeat-fencing.md
  - ../adr/ADR-008-agent-decision-protocol.md
  - ../adr/ADR-009-agent-kernel-boundary.md
  - ../adr/ADR-010-context-compiler-boundary.md
  - ../adr/ADR-011-context-authority-model.md
  - ../adr/ADR-012-context-snapshot-semantics.md
  - ../adr/ADR-013-memory-classification.md
  - ../adr/ADR-014-compaction-is-non-authoritative.md
  - ../adr/ADR-015-context-budget-policy-and-measurement.md
  - ../adr/ADR-016-action-proposal-receipt-boundary.md
  - ../adr/ADR-017-policy-engine-boundary.md
  - ../adr/ADR-018-write-idempotency-and-reconciliation.md
  - ../adr/ADR-019-external-side-effect-recovery.md
  - ../adr/ADR-020-receipt-immutability.md
  - ../adr/ADR-021-temporal-human-runtime.md
  - ../adr/ADR-022-scheduler-reconciliation-and-time-authority.md
  - ../adr/ADR-023-sales-reference-application.md
  - ../adr/ADR-024-openai-compatible-model-provider.md
  - ../adr/ADR-025-post-hoc-evaluation-boundary.md
  - ../adr/ADR-026-learning-as-regression-knowledge.md
  - ../adr/ADR-027-shadow-execution-boundary.md
  - ../adr/ADR-028-recoverable-run-failures.md
  - ../adr/ADR-029-governed-production-channel-delivery-rollout.md
---

# R4 — Arquitectura implementada (R4-B + R4-C1 + R4-C2 + R4-D + R4-E) y R4-F

Este documento describe lo que **existe** en el repositorio tras R4-B (Platform
Skeleton), R4-C1 (Execution Kernel), R4-C2 (Context Compiler & Memory
Boundaries), R4-D (Governed Execution) y R4-E (Temporal + Human Runtime). No describe la arquitectura final de R4: la Constitución y el PRD
siguen siendo la autoridad (Constitución > PRD > ADR > tarea). Lo que aquí
figura como "seam" es un punto de extensión deliberado, no una funcionalidad
implementada. Las secciones 1–10 describen R4-B, actualizadas donde C1/C2 las
cambiaron; la sección 11 describe R4-C1, la 12 R4-C2, la 13 R4-D y la 14 R4-E.
La sección 15 describe R4-F: el primer workload (Sales Reference Application),
que vive **fuera** de Core (`agents/sales`, `adapters/*`) y usa las fronteras
anteriores sin moverlas. La sección 16 describe R4-G (Quality & Learning,
completado): evaluación post-hoc de trayectorias terminadas, fuera de la
ejecución de Core. La sección 17 describe R4-H (Shadow / E2E, en progreso):
workloads realistas sobre el runtime real con modelo real y efectos sólo
shadow, evaluados por R4-G. La sección 18 describe la corrección post-H
(ADR-028) y la 19 R4-I (Governed Production, en progreso): frontera de canal,
entrega durable e idempotente, rollout y kill switch, fuera de la ejecución
de Core salvo operaciones genéricas mínimas del Task/Temporal Runtime.

## 1. Objetivo de R4-B

Demostrar un runtime independiente del CRM con contratos correctos:

```text
Dynamic Agency            → todavía no (Agent Kernel es R4-C)
Deterministic Authority   → Task Runtime, Capability Runtime, Agent Registry
Durable State             → PostgreSQL, migraciones, invariantes en el esquema
Verifiable Execution      → Observations inmutables; ninguna afirmación sin evidencia
Continuous Evaluation     → tests unitarios, contrato, integración y recuperación
```

R4-B **no** contiene cognición. Contiene las fronteras dentro de las cuales la
cognición de R4-C operará sin poder moverlas. R4-C1 (§11) agrega el primer loop
cognitivo — worker, leases, Agent Kernel y `AgentDecision` — dentro de esas
fronteras.

## 2. Topología del repositorio

```text
R4-agent-platform/
├── apps/
│   ├── api/                    HTTP /v1 (Fastify). Transporte + composition root.
│   ├── worker/                 (C1) Proceso worker: claim, lease/heartbeat, ejecución del kernel; (E) reconciliación despachada.
│   ├── evaluator/              (G) Runtime de evaluación: lector de trayectorias (sólo lectura), artifacts, juez sobre el ModelGateway. Nunca importado por Core.
│   └── scheduler/              (E) Proceso scheduler: reclama schedules vencidos y despierta/despacha. Sin modelo ni capabilities.
├── packages/
│   ├── contracts/              Esquemas Zod + tipos de las primitivas. Sin lógica de dominio.
│   ├── observability/          Logger estructurado (pino), correlación (AsyncLocalStorage), eventos.
│   ├── model-gateway/          Interfaz ModelGateway provider-neutral + FakeModelProvider.
│   ├── capability-runtime/     Registry, discovery, invocación validada, creación de observations.
│   ├── task-runtime/           Ciclo de vida de AgentTask/AgentRun/Goal sobre ports de persistencia.
│   ├── agent-registry/         Carga, valida y registra AgentDefinitions inmutables y versionadas.
│   ├── agent-kernel/           (C1) Loop model → decisión → READ → observation. Sin estado ni persistencia.
│   ├── context-compiler/       (C2) Contexto estructurado por decisión: sources, autoridad, frescura, budget, compaction.
│   ├── policy-engine/          (D) Autorización determinista de acciones: reglas tipadas, versionadas y con hash. Pura.
│   ├── evaluation/             (G) Framework de Quality: subject, findings, taxonomía, outcomes, evaluadores, benchmark, experiment. Puro y sin dominio.
│   ├── shadow/                 (H) Framework Shadow / E2E: modo shadow, bindings declarados, guard, manifest, outbound sink, WorkloadCase, ShadowRun/Suite sobre R4-G. Puro y sin dominio.
│   └── persistence-postgres/   Migraciones + implementación PostgreSQL de los ports.
├── agents/
│   ├── platform-probe/         Sonda sin dominio (R4-B).
│   └── sales/                  (F) Sales Agent Pack: definición, capabilities, estado Sales (esquema `sales`, 0006 propia), harness. Fuera de Core.
│                               (G) `src/evaluations`: evaluadores, rúbricas, fixtures y regresiones de Sales (entrada `@r4-sales/agent/evaluations`).
│                               (H) `src/shadow`: bindings shadow, corpus de workloads + lock, ejecutor, worker de proceso (entrada `@r4-sales/agent/shadow`).
├── adapters/                   (F) Fuera de Core.
│   ├── domains/                Ports Customer/Catalog/Shipping/Quote + fixtures deterministas (sin dependencia de R4).
│   └── models/openai-compatible/  Primer ModelProvider real (protocolo chat-completions genérico).
├── tests/{unit,contract,integration,recovery,support,fixtures}
└── docs/{architecture,adr,roadmap}
```

Paquetes del árbol sugerido que **no** se crearon porque no corresponden a
R4-B/C1/C2/D/E: `memory` (la memoria de C2 es un contrato + tabla + source, sin
runtime propio; ADR-013), `artifacts`, `human-collaboration` y `scheduler` como paquetes (E: el
runtime temporal/humano vive en `task-runtime` porque comparte el lock de la task; el scheduler
es una app/composition root — ADR-021/022) (G crea `evaluation` y la app `evaluator`, §16),
`agents/quality-auditor` (G: la frontera semántica es su seam; ADR-026), `agents/marketing-analyst`, `adapters/channels/*`,
`adapters/protocols/*` (F crea `agents/sales`, `adapters/domains` y `adapters/models/*`, §15). Ver
[roadmap](../roadmap/R4_DELIVERY_ROADMAP.md).

`persistence-postgres` no está en el árbol sugerido del PRD. Existe porque los
paquetes de runtime dependen de **ports** y alguien debe implementarlos; aislar
el driver en un adapter es lo que permite que `task-runtime` sea testeable y
agnóstico de persistencia.

### 2.1 Grafo de dependencias (verificado por test)

```text
contracts  ◄───────────────────────────────────────────────────────────┐
   ▲                                                                    │
observability                                                           │
   ▲        ▲               ▲               ▲              ▲            │
model-gateway   capability-runtime   task-runtime   agent-registry   context-compiler (C2)
   ▲                   ▲                  ▲              ▲              ▲
agent-kernel (C1)      └──────── persistence-postgres ───┴──────────────┘ (MemoryReader)
   ▲                                      ▲
   │                                 apps/api  (también usa task-runtime, agent-registry)
   └──────────── apps/worker (C1/C2/D): kernel + context-compiler + task-runtime +
                 capability-runtime + agent-registry + persistence-postgres + model-gateway +
                 policy-engine (D; sólo contracts + zod: pura)

apps/scheduler (E): contracts + observability + persistence-postgres + task-runtime + pino + zod
                 — nunca model-gateway, capability-runtime, policy-engine, agent-kernel,
                   context-compiler ni apps/worker
```

`agent-kernel` depende sólo de `contracts`, `observability` y la interfaz de
`model-gateway` — no del compilador de contexto. `context-compiler` depende sólo
de `contracts` y `observability`. (D) `policy-engine` depende sólo de `contracts`
y `zod`; `task-runtime` usa el puerto `ActionAuthorizer` de `contracts`, nunca el
motor. `apps/worker` no depende de `apps/api` ni de Fastify.

Reglas duras (fallan el build si se violan):

| Regla | Dónde se verifica |
|---|---|
| Ningún paquete depende de Next.js, React, CRM, LangChain/LangGraph | `eslint.config.js`, `tests/contract/dependency-boundaries.test.ts` |
| Sólo `persistence-postgres` habla con PostgreSQL | ESLint `no-restricted-imports` + allow-list de dependencias |
| `model-gateway` no alcanza estado ni ejecución de capabilities | ESLint + allow-list |
| `agent-kernel` no alcanza PostgreSQL, task/capability runtime, registry, transportes | ESLint + allow-list + `tests/contract/execution-kernel-boundaries.test.ts` |
| `agent-kernel` no conoce `context-compiler`; el compilador no alcanza almacenamiento, runtimes, kernel ni modelos | ESLint + allow-list + `tests/contract/context-boundaries.test.ts` |
| Sólo fuentes de plataforma producen ítems `AUTHORITATIVE`; ninguna memoria es autoritativa; el modelo no escribe memoria ni estado | `context-boundaries.test.ts` |
| `apps/worker` independiente de `apps/api` y de HTTP | `dependency-boundaries.test.ts` |
| Un único call site de handlers de capability (el invoker); sin rutas de desarrollo para writes | `execution-kernel-boundaries.test.ts` |
| (D) Handlers de escritura: único call site = `ActionExecutor`; política sólo evaluada por `ActionRuntime`; única fuente de execution keys; kernel sin acceso a writes; ningún campo confiable en `AgentDecision`; sin detector textual | `tests/contract/governed-execution-boundaries.test.ts` |
| (D) `policy-engine` puro (sin I/O, runtimes, modelo ni observabilidad); runtimes independientes del motor | ESLint + allow-list + `dependency-boundaries.test.ts` |
| (E) El scheduler sólo posee el tiempo: sin modelo, capabilities, policy, kernel ni worker; claims con SKIP LOCKED + generación sobre `r4_now()`; ningún timer en memoria es autoridad | `dependency-boundaries.test.ts`, `tests/contract/temporal-boundaries.test.ts` |
| (E) La colaboración humana no evalúa política ni crea comandos/intentos/receipts; los intentos (también de reconciliación) sólo los crea `ActionRuntime`; identidad humana sólo desde el adapter confiable | `temporal-boundaries.test.ts`, `governed-execution-boundaries.test.ts` |
| (E) Guardas durables: sin ejecución autónoma bajo handoff, sin estado terminal con efecto incierto, sin `needs_reconciliation` sin trabajo | triggers de `0005`; `temporal-boundaries.test.ts` |
| Paquetes Core no importan transportes ni apps | ESLint |
| Grafo interno acíclico | `dependency-boundaries.test.ts` |
| Core sin términos de dominio/canal/CRM/vendor | `tests/contract/core-purity.test.ts` |
| Contratos públicos sin campos de proveedor ni de dominio | `tests/contract/provider-neutrality.test.ts` |
| (H) Core no depende de Shadow; `shadow` sólo contracts + evaluation + la SPI de modelo + zod, sin I/O ni términos de dominio; el runtime del Sales pack no conoce el modo shadow; ningún binding `production` ni outbound que entregue puede componerse; cada binding declara todas las operaciones de su port | `dependency-boundaries.test.ts`, `tests/contract/shadow-boundaries.test.ts` |
| (G) Core no depende de Quality; `evaluation` sólo contracts + zod; `evaluator` sólo APIs de lectura, gateway y FS de artifacts; Quality sin términos de dominio; evaluadores de Sales fuera del runtime del pack; Quality no importa definiciones/registry/política ni escribe fuera de artifacts | `dependency-boundaries.test.ts`, `tests/contract/quality-boundaries.test.ts` |

## 3. Flujo de una petición

```text
HTTP request
  │  x-correlation-id validado o generado (UUIDv7)
  ▼
apps/api  ── valida body/params/headers (Zod, estricto) ── resuelve Principal (seam de auth)
  │
  ▼
TaskRuntime (task-runtime)
  │  valida de nuevo · resuelve AgentDefinition (versión fijada) · budget efectivo
  │  aplica lifecycle · concurrencia optimista · idempotencia
  ▼
TaskRuntimeStore.transaction(uow)  ── port
  ▼
PostgresTaskRuntimeStore  ── una transacción; row locks; constraints del esquema
  ▼
PostgreSQL (autoritativo)
```

La telemetría se emite **después** del commit, con el contexto de correlación.

## 4. Primitivas implementadas

Todas las definiciones viven en `packages/contracts/src`. Los tipos TypeScript se
infieren de los esquemas: una sola fuente de verdad.

### 4.1 AgentDefinition — configuración, nunca ejecución

`agentId` (slug), `version` (entero), `displayName`, `description`,
`instructions`, `taskTypes` (namespaced), `capabilityScopes`, `skills`,
`modelRequirements` (abstractos: `reasoningLevel`, `latencySensitivity`,
`costSensitivity`, `structuredOutput`, `toolUse`, `minContextTokens`),
`contextPolicy`, `budgets` (techos), `delegationPolicy`, `evaluationProfile`.

- Se declaran en archivos `*.agent.json` (`R4_AGENT_DEFINITIONS_DIR`).
- Al arrancar se validan todos (errores agregados; nada se carga parcialmente) y
  se registran en `agent_definitions`.
- `(agentId, version)` es **inmutable**: se guarda un `contentHash`; editar una
  versión ya registrada hace fallar el arranque (`agent_definition_version_immutable`).
- Las tasks fijan `agentVersion`; publicar v2 no altera tasks existentes.
- No existe ningún campo `provider`/`model` (test de contrato).

### 4.2 AgentTask — unidad durable de trabajo

Estados: `pending, running, waiting, blocked, requires_approval, completed, failed, cancelled`.

```text
pending            → running | blocked | cancelled | failed
running            → waiting | blocked | requires_approval | completed | failed | cancelled
waiting            → running | blocked | cancelled | failed
blocked            → pending | running | cancelled | failed
requires_approval  → running | cancelled | failed
completed/failed/cancelled → (terminal, sin salidas)
```

- Transiciones inválidas → `409 invalid_transition`; el estado durable no cambia.
- Cada transición incrementa `version` y agrega una fila append-only en
  `agent_task_transitions` (`from`, `to`, `reason`, `actor`, `taskVersion`,
  `correlationId`). `unique(task_id, task_version)` impide historia ambigua.
- `expectedVersion` opcional en toda mutación → `409 version_conflict`.
- Invariante: una task sólo abandona `running` si no tiene run activo, salvo
  `cancelled`, que cancela el run activo en la misma transacción.
- Sólo los campos de ciclo de vida son mutables (`status`, `status_reason`,
  `current_goal_id`, `result`, `version`, `updated_at`); identidad, asignación e
  input son write-once (el `UPDATE` no los toca).
- `requires_approval` sólo es alcanzable desde `running` y no puede reanudarse
  con `startRun`: la resolución de approvals llega en R4-E.
- Creación idempotente con `Idempotency-Key`, con alcance por principal.
  Mismo key + mismo request (hash canónico) → `200` + la task original.
  Mismo key + request distinto → `409 idempotency_key_reused`. Concurrencia
  resuelta con `INSERT … ON CONFLICT DO NOTHING` sobre índice único parcial.
- Budget efectivo = pedido acotado por los techos del agente; pedir más que el
  techo → `422 budget_exceeds_agent_limit`. No existen límites globales arbitrarios.

### 4.3 AgentRun — ejecución cognitiva acotada

`runId`, `taskId`, `sequence` (1..n por task), `agentId/agentVersion`,
`status (running|completed|failed|cancelled|abandoned|suspended [D])`, `contextSnapshotRef`
(seam R4-C2), `usage` (columnas: modelCalls, inputTokens, outputTokens,
capabilityCalls), `result` (JSON estructurado), `failure {code,message}`,
`termination {reason, failureClass, code, message, details}` (C1),
`recoveries` (C1), timestamps, `version`.

- `startRun` pasa la task a `running` y crea el run **atómicamente**.
- A lo sumo un run activo por task: verificado en servicio **y** por índice
  único parcial `agent_runs_one_active_per_task` (probado con 5 starts concurrentes).
- `failure` presente sí y sólo sí `status = failed` (servicio + `CHECK`).
- (C1) `termination` presente sí y sólo sí el run no está `running`, coherente
  con `status` (servicio + `CHECK`). `finishRun` sin razón explícita la deriva
  del status (`failed` → `internal_failure`). Ciclo de vida completo en §11.3.
- No se almacena chain-of-thought: sólo resultado estructurado y uso.

### 4.4 Goal — estado cognitivo, no verdad de negocio

- Root goal: creado con la task (`origin = requester`), único por task
  (`goals_one_root_per_task`).
- Subgoal: `parentGoalId` del mismo task, garantizado por FK compuesta
  `(task_id, parent_goal_id) → goals(task_id, goal_id)`.
- Current goal: puntero `agent_tasks.current_goal_id` con FK compuesta diferida.
  Se mueve **explícitamente** (`setCurrentGoal`, o `makeCurrent` al crear un
  subgoal). Cerrar un goal nunca mueve el puntero: decidir el foco es cognición.
- Estados `active → achieved | abandoned | superseded`; un goal cerrado no se reabre.

### 4.5 CapabilityDefinition y Observation

Metadata suficiente para policy futura: `riskClass` (`READ`,
`REVERSIBLE_WRITE`, `IRREVERSIBLE_WRITE`, `FINANCIAL`, `EXTERNAL_COMMUNICATION`,
`PRIVILEGED`), `requiredScopes`, `identityRequirement`, `confirmationPolicy`,
`approvalPolicy`, `idempotency`, `retryPolicy`, `timeoutMs`, `freshnessTtlMs`,
`auditLevel`, `inputSchema`/`outputSchema` (JSON Schema derivado de Zod), `owner`.

Invariante de contrato: un no-`READ` con `retryPolicy.maxAttempts > 1` exige
`idempotency = key_required` (retries ciegos de writes prohibidos).

Pipeline de invocación (`CapabilityInvoker`):

```text
request (no confiable) + TrustedExecutionContext (construido por la plataforma)
  → resolve            (capability_not_found)
  → authorize scopes   (scope_denied)        ← antes de mirar argumentos
  → permit             (execution_not_permitted: R4-B sólo ejecuta READ)
  → validate args      (invalid_arguments, con issues estructurados)
  → execute + timeout  (handler_error | timeout)
  → validate output    (invalid_capability_output)   ← la salida también es no confiable
  → Observation inmutable, persistida, idempotente por invocationId
```

**Toda** invocación — válida o no — produce exactamente una Observation. Un
agente siempre puede saber qué ocurrió realmente y replantear; nada se infiere
del texto del modelo.

La capability de prueba `platform_test.get_test_fact` vive en
`tests/fixtures/capabilities/` (no en Core) y demuestra registro, discovery,
validación de schema, contrato de invocación y creación de observations.

## 5. Model Gateway

`ModelGateway.generate(request) → ModelResult` (valor discriminado, nunca excepción).

- `ModelRequest`: `correlation {correlationId, taskId, runId, agentId}`,
  `requirements` (los de la AgentDefinition), `messages`, `tools`,
  `outputContract (text | json+schema)`, `limits {timeoutMs, maxOutputTokens}`.
- `ModelResponse`: `content`, `toolCalls`, `structuredData` (**no confiable**),
  `usage`, `finishReason`, `latencyMs`, `provider {providerId, modelId, requestId}`.
- Errores clasificados: `provider_error`, `rate_limited`, `timeout`, `cancelled`,
  `invalid_provider_response`, con `retryable`.
- `DefaultModelGateway` impone el timeout **aunque el proveedor ignore el abort**,
  valida la respuesta del adapter y emite telemetría sólo de metadata.
- `parseStructuredOutput(response, schema)` es la única vía sancionada para
  convertir salida del modelo en un valor tipado (`invalid_model_output` si no encaja).
- `ModelProvider` es la SPI para adapters de vendor. En R4-B existe sólo
  `FakeModelProvider` (scripts: `text`, `structured`, `tool_calls`,
  `provider_error`, `timeout` [con/sin respeto del abort], `malformed`).
- El gateway no depende de persistencia ni de capability-runtime: estructuralmente
  no puede escribir estado ni ejecutar efectos.

En R4-B el gateway no estaba cableado. Desde C1 lo invoca únicamente el Agent
Kernel dentro del worker (§11); la API sigue sin acceso al modelo. No existe
todavía ningún adapter de proveedor real: el worker recibe su `ModelProvider`
por composición (`WorkerBindings`). (F) El primero, `OpenAICompatibleModelProvider`,
vive fuera de Core (`adapters/models/openai-compatible`, ADR-024, §15.8).

## 6. Persistencia

PostgreSQL 16 es autoritativo. Migraciones forward-only en
`packages/persistence-postgres/migrations`, con:

- tabla `r4_schema_migrations (id, checksum, applied_at)`;
- advisory lock (migradores concurrentes seguros);
- una transacción por migración;
- detección de migraciones editadas por checksum (`migration_modified`).

La API **no migra implícitamente**: si el esquema no está al día, el arranque
falla con `schema_not_current` y `/ready` reporta las migraciones pendientes.

| Tabla | Clave | Mutable | Notas |
|---|---|---|---|
| `agent_definitions` | `(agent_id, version)` | no | `content_hash`; sub-documentos de config en JSONB |
| `agent_tasks` | `task_id` | sí (`version`) | lifecycle en columnas; `input/constraints/budget/result` JSONB object-checked |
| `agent_task_transitions` | `transition_id` | no (append-only) | `unique(task_id, task_version)` |
| `goals` | `goal_id` | sí (`version`) | FK compuestas; una raíz por task |
| `agent_runs` | `run_id` | sí (`version`) | uso en columnas; un run activo por task |
| `observations` | `observation_id` | no (trigger desde D) | `invocation_id` único (READ) / `proposal_id` único (acción, D); frescura (`valid_until`) |
| `agent_tasks.lease_*` (C1) | — | sí (sin `version`) | owner, generation (fencing), expiración en reloj de BD; ADR-007 |
| `agent_run_steps` (C1) | `step_id` | sólo `pending → observed` | una fila por iteración; `unique(run_id, iteration)`, `invocation_id` único, un `pending` por run; (C2) `context_snapshot_id` con FK compuesta a su run+iteración |
| `memory_entries` (C2) | `entry_id` | sólo `expired_at` una vez (trigger) | task-scoped; supersession (misma task+tipo, un sucesor); `unique(task_id, derivation_key)` para summaries; sin `SECRET` |
| `context_snapshots` (C2) | `snapshot_id` | no (trigger) | `unique(run_id, iteration, attempt)`; `supersedes_snapshot_id` único; `compiled_context` JSONB; `budget_mode` + `max_estimated_tokens` (null ⇔ unbounded) |
| `context_snapshot_items` (C2) | `(snapshot_id, position)` | no (trigger) | decisión por **cada** ítem evaluado, compactados incluidos (sin contenido); `SECRET` sólo como excluido; fuente única de la contabilidad (ADR-015) |
| `action_proposals` (D) | `proposal_id` | no (trigger) | una por step `propose_action` (`unique(step_id)`); `evidence_refs`; `context_snapshot_id` |
| `policy_decisions` (D) | `decision_id` | no (trigger) | una por propuesta; `policy_id/version/hash/engine_version`, `risk_class`, `reason_code`, `rule`, `identity_assurance` |
| `action_executions` (D) | `execution_id` | sólo `status` (trigger: comando inmutable, transiciones válidas) | comando: `execution_key` único, argumentos validados, contexto confiable, semántica; FK compuesta sólo a decisiones `allow`; resuelto ⇒ receipt (constraint trigger diferido) |
| `action_execution_attempts` (D) | `attempt_id` | outcome una vez (trigger) | `unique(execution_id, attempt_number)`; fila escrita antes de la llamada externa |
| `action_receipts` (D) | `receipt_id` | no (trigger) | uno por ejecución; clave = clave del comando (FK compuesta); `obtained_via`, `replayed` |

JSONB sólo donde el esquema es genuinamente extensible (input de task,
constraints, result, provenance, payloads, sub-documentos de configuración).
Todo lo que la plataforma aplica o consulta es columna tipada con `CHECK`.

Todas las filas durables tienen ID estable (UUIDv7, ordenado por tiempo),
`created_at`, `updated_at` y `version` si son mutables, `status` si tienen
ciclo de vida y `correlation_id`.

## 7. Observabilidad

- Cada request tiene `x-correlation-id` (el del cliente si es válido
  `[A-Za-z0-9._:-]{1,128}`, si no un UUIDv7); se devuelve en la respuesta y en el
  envelope de error.
- `AsyncLocalStorage` propaga `{correlationId, taskId?, runId?, agentId?}`; el
  logger lo agrega a cada línea automáticamente (`mixin`).
- Logs JSON (pino), `redact` para credenciales.
- Eventos (`event` en la línea de log): `agent_definitions.synced`,
  `task.created`, `task.idempotent_replay`, `task.transitioned`, `goal.created`,
  `goal.updated`, `run.started`, `run.finished`, `model.call.completed`,
  `model.call.failed`, `capability.invocation.completed`,
  `http.request.completed`, `service.started`, `service.stopping`,
  `db.migration.applied`, `db.migrations.completed`. Eventos de C1 en §11.9, de C2
  en §12.9 y de D en §13.9.
- La telemetría registra **sólo metadata** (IDs, estados, conteos, latencias,
  códigos). Nunca prompts, texto de salida del modelo, goals, input de tasks ni
  chain-of-thought (verificado por tests).

Estos eventos son señales de observabilidad, **no** un outbox durable ni el
catálogo público de eventos del PRD §5.2 (diferido).

## 8. Seguridad: entradas no confiables

| Entrada | Tratamiento |
|---|---|
| Body/params/query/headers HTTP | Esquemas estrictos (`strictObject`); campos desconocidos → 400; límite 256 KiB; sólo JSON (415 en otro caso); JSON extensible ≤ 64 KiB |
| Identidad del solicitante | Nunca del body (`requestedBy` en body → 400). Resuelta por `PrincipalResolver` (seam; R4-B = `unauthenticated/anonymous`) |
| Salida del modelo | `structuredData: unknown`; validación obligatoria con el esquema del llamador; tool calls son propuestas |
| Respuesta del adapter de proveedor | Validada por el gateway (`invalid_provider_response`) |
| Argumentos de capability | Validados contra el esquema registrado; scopes antes que argumentos |
| Salida de capability | Validada contra el esquema declarado + JSON-serializable |
| Nombre de capability propuesto | Puede no existir; se registra truncado como evidencia del rechazo |
| Correlation id del cliente | Sólo si cumple el alfabeto/longitud; si no, se reemplaza |
| Errores internos | Nunca se filtra el mensaje; `internal_error` + correlationId |

`ModelGateway` no tiene ninguna ruta hacia la persistencia de dominio ni de
runtime (ADR-004), y la única escritura derivada de una capability es la
Observation que produce la propia plataforma.

## 9. Semántica de recuperación

| Propiedad | Estado en R4-B |
|---|---|
| Restart | Todo el estado requerido vive en PostgreSQL. Probado: una instancia nueva ve task, goals, runs, transiciones y observations idénticos, y las invariantes siguen vigentes (`restart-persistence.test.ts`). |
| Caída de la BD | Probado deteniendo el contenedor real: `/health` 200, `/ready` 503, datos 503 `database_unavailable`, el proceso no cae y se recupera solo (`tests/recovery`). |
| Resume | (C1) Un run huérfano se detecta por expiración del lease y otro worker lo reanuda desde su step log (§11.7). |
| Idempotencia | Creación de tasks (por principal) e invocaciones de capability (por `invocationId`), ambas persistentes a través de reinicios. |
| Checkpointing | (C1) Cada iteración es un step durable (`agent_run_steps`); el loop se reconstruye desde ahí. (D) Checkpoints de efectos: propuesta, decisión, comando, intentos y receipt durables (§13.7). |
| Estado en memoria | Sólo configuración reconstruible de forma determinista (capability registry desde código; definiciones desde archivos, verificadas contra la BD). (C2) El compilador no tiene estado; la sesión guarda sólo el último `load()` de la iteración en curso. |
| Contexto y memoria | (C2) Memoria de task, snapshots y summaries viven en PostgreSQL; sobreviven reinicio de worker, de API y de PostgreSQL (§12.8). |

## 10. Qué queda fuera (deliberadamente)

Memoria de largo plazo/organización/semántica, retrieval vectorial, artifacts,
(scheduler, consultation/approval/handoff y reconciliador: implementados en R4-E, §14),
delegación, evaluation runtime, llamadas LLM reales,
autenticación y verificación de identidad, outbox de eventos, MCP, Sales y
cualquier write de dominio de producción. (ActionProposal/Receipt, Policy
Engine y writes gobernados: §13, R4-D.) Ver
[roadmap](../roadmap/R4_DELIVERY_ROADMAP.md) §4.

## 11. R4-C1 — Execution Kernel

Pregunta que responde C1: ¿puede R4 tomar una `AgentTask` durable, reclamarla de
forma segura, ejecutar un loop cognitivo mediante `ModelGateway`, invocar una
capability read-only, convertir el resultado en `Observation`, continuar
razonando y completar la task de forma durable y recuperable?

```text
AgentTask pending ─► worker claim (lease gen N, misma tx: task running + run)
   ─► load (fenced) ─► ExecutionContext ─► ModelGateway ─► AgentDecision (validada)
   ─► READ: step pending + invocationId ─► CapabilityInvoker ─► Observation (fenced, liga step)
   ─► load ─► ... ─► COMPLETE: step final + run completed + task completed + lease liberado (una tx)
```

### 11.1 Componentes

| Componente | Paquete | Rol |
|---|---|---|
| `Worker` | `apps/worker` | Poll, claim, heartbeat, correr el kernel, liberar el lease. Ejecutor sin autoridad. |
| `createWorkerPlatform` / `runWorkerProcess` | `apps/worker` | Composition root del proceso (sólo comparte PostgreSQL con la API). Recibe `ModelProvider` y capabilities por `WorkerBindings`. |
| `DurableKernelSession` | `apps/worker` | Implementa el port `KernelSession` sobre `ExecutionRuntime` + `CapabilityInvoker`. Pegamento sin reglas. |
| `ExecutionRuntime` | `task-runtime` | Autoridad sobre ownership (claim, renew, release, fencing) y ciclo de vida del run durante la ejecución. |
| `PostgresExecutionStore` | `persistence-postgres` | SQL de claim (`SKIP LOCKED`), lease, steps y observations fenced. |
| `AgentKernel` | `agent-kernel` | Loop iterativo, validación de decisiones, budgets, mapeo de terminación. |
| `AgentDecision`, `RunStep`, `TaskLease`, `RunTermination` | `contracts` | Contratos tipados (Zod). |

### 11.2 Claim y lease (ADR-006, ADR-007)

- Claim: un `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` sobre tasks
  `pending|running` sin lease vivo; incrementa `lease_generation`.
- Lease en la fila de la task; expiración con `clock_timestamp()` de PostgreSQL.
- Heartbeat: `UPDATE` condicionado (owner, generation, no expirado, `running`)
  cada `R4_WORKER_HEARTBEAT_MS` (≤ lease/2). No toca `version` ni negocio. Si
  es rechazado, `ownershipOf` distingue task fuera de `running` (cancelación →
  `task_not_runnable`, se libera el lease) de lease perdido (`lease_lost`).
- Fencing: toda escritura de dueño bloquea la fila de la task y verifica owner +
  generation + no expirado + task `running` en la misma transacción.

### 11.3 Ciclo de vida del run

```text
             claim de task pending, o running sin run activo
                              │
                              ▼
   ┌──────────────────── running ◄────────── takeover (lease expirado): mismo run, recoveries+1
   │                          │               release ordenado: mismo run
   │   completed ◄── complete │
   │   failed    ◄── model_failure | invalid_decision | capability_failure |
   │                 budget_exhausted | internal_failure
   │   cancelled ◄── task cancelada (API)
   └─► abandoned ◄── takeover con recoveries ≥ maxRunRecoveries (lease_lost)
```

- **Se crea**: al reclamar una task `pending` (atómico con `pending → running`)
  o `running` sin run activo. No existe estado `created`: el run nace con dueño.
- **Running**: desde su creación hasta su terminación; puede cambiar de dueño.
- **Si el worker desaparece**: el run sigue `running` (huérfano) hasta que el
  lease expira; el siguiente claim lo **reanuda** (mismo `runId`).
- **Abandoned**: sólo por límite de recoveries (poison task), decidido por el
  claimer; la task pasa a `failed`.
- **Termina**: con `finishExecution` (fenced), que cierra run, task y lease en
  una transacción. Toda terminación tiene `termination.reason` (§11.6).

### 11.4 AgentDecision (ADR-008)

`read_capability {capabilityId, arguments}` · `respond {content}` ·
`complete {result: {summary, evidence[], data?}}`. Objetos estrictos. Pipeline
parse → tipo → esquema → semántica contra hechos de plataforma (capability
concedida y `READ`; evidencia = observations de la task).

### 11.5 Kernel, contexto y observations (ADR-009)

- El kernel no persiste: usa `KernelSession` (`load`, `recordStep`,
  `executeRead`, `finish`) e interrupciones (`KernelInterrupt`).
- `ExecutionContext` = definición · task · goal actual · observations de la
  task · respuestas del run · budget · capabilities por scope. Reconstruido en
  cada iteración. Desde C2 el kernel lo usa para budgets y validación; lo que
  ve el modelo es el `CompiledContext` que devuelve `prepareContext` (§12).
- Un READ recibe su `invocationId` de la plataforma **antes** de ejecutarse
  (step `pending`). La Observation se inserta y liga al step en una sola
  transacción fenced: es la única evidencia del resultado y la siguiente
  iteración la lee de PostgreSQL.
- Sólo `READ` es **invocable** con `read_capability`: el kernel rechaza otras
  clases (`capability_not_permitted`) y el invoker también
  (`execution_not_permitted`). El invoker es el único call site de handlers
  READ. (R4-D: los writes se *proponen* y siguen el camino gobernado de §13;
  sus handlers están fuera del alcance del invoker.)

### 11.6 Budgets y terminación

Límites = `ExecutionPolicy` del worker (`R4_EXEC_*`) acotada por el budget de la
task; consumo derivado del step log. Chequeo antes de cada llamada al modelo
(duración, iteraciones, llamadas, tokens si la task los declara) y antes de cada
READ.

| Razón | Clase | Run | Task |
|---|---|---|---|
| `completed` | — | completed | completed |
| `model_failure` | model | failed | failed → **ADR-028:** `running` (retryable, recuperación acotada) o `blocked` + handoff de plataforma (no reintentable / agotada) |
| `invalid_decision` | protocol | failed | failed → **ADR-028:** `running` (recuperación acotada) o `blocked` + handoff de plataforma (agotada) |
| `capability_failure` | capability | failed | failed |
| `budget_exhausted` | budget | failed | failed |
| `internal_failure` | platform | failed | failed |
| `lease_lost` | lease | abandoned | failed |
| `cancelled` | — | cancelled | cancelled |

`code` precisa la causa (`timeout`, `unknown_capability`, `max_model_calls`,
`max_run_recoveries_exceeded`, …); `details` guarda datos estructurados.

> **Post-H (ADR-028, GAP-H-001).** La tabla de C1 llevaba toda run fallida a
> una task `failed`. Para `invalid_decision` y `model_failure` la task ya no
> es terminal: ver §18. La run sigue terminando igual (ADR-008 intacto).

### 11.7 Recuperación

| Muerte del worker… | Estado durable | Qué hace el siguiente dueño |
|---|---|---|
| antes/durante el claim | nada, o lease + run `running` sin steps | reanuda y llama al modelo |
| durante la llamada al modelo | steps previos + (C2) snapshot de la iteración | repite la llamada (sin efectos; uso no registrado) con el **mismo** snapshot si sus inputs no cambiaron (ADR-012) |
| tras decidir READ, antes de la observation | step `pending` con `invocationId` | ejecuta ese READ con el mismo `invocationId`, sin llamar al modelo |
| tras persistir la observation | step `observed` | llama al modelo con la observation en el contexto |
| tras decidir complete/invalid/budget | nada parcial: step final + cierre son atómicos | — |

Un worker que vuelve tarde es rechazado por fencing en cualquier escritura.

### 11.8 Endpoints

Sin endpoints nuevos: `GET /v1/tasks/:id` y `GET /v1/runs/:id` exponen estado,
`termination`, `recoveries` y uso. El worker no expone HTTP (sin consumidor aún);
su vida es observable por telemetría y por `last_heartbeat_at`.

### 11.9 Telemetría (C1)

`worker.started`, `worker.stopped`, `task.claimed`, `task.lease.renewed`,
`task.lease.expired`, `task.lease.released`, `lease.lost`, `worker.recovery`,
`run.started`, `run.resumed`, `run.step.recorded`, `run.completed`,
`run.failed`, `run.cancelled`, `run.abandoned`, `agent.decision`,
`capability.invoked`, `observation.persisted`, `budget.exhausted`. Metadata:
`correlationId`, `taskId`, `runId`, `agentId`, `workerId`, `iteration` (por
contexto de correlación o campos explícitos). Nunca prompts, contenido de
decisiones, payloads de observations, goals ni input (verificado por tests).

## 12. R4-C2 — Context Compiler & Memory Boundaries

Pregunta que responde C2: ¿puede R4 construir, para cada decisión del agente,
un contexto mínimo, estructurado, reproducible, acotado por presupuesto y
consciente de autoridad y frescura, sin convertir transcript, summaries,
observations, memoria y estado de negocio en una sola fuente de verdad?

```text
load (fenced) ─► ExecutionContext ─► KernelSession.prepareContext
   ├─ ContextCompiler.compile: sources → admisión → selección → CompiledContext
   ├─ ¿snapshot de (run, iteración) con el mismo inputFingerprint? → reutilizar
   └─ si no: ExecutionRuntime.recordContextSnapshot (fenced, ANTES del modelo)
─► AgentKernel.decide(context, compiled) ─► ModelRequest { messages:[protocolo], context }
─► step registrado con contextSnapshotId
```

### 12.1 Componentes

| Componente | Paquete | Rol |
|---|---|---|
| `ContextItem`, `CompiledContext`, `ContextSnapshot`, `ContextItemDecision`, `MemoryEntry` | `contracts` | Contratos estrictos, versionados, neutrales de proveedor y dominio |
| `ContextCompiler` | `context-compiler` | Admisión, frescura, selección por política, compaction, conflictos, hash, telemetría. No escribe, no decide acciones (ADR-010) |
| `ContextSource` + fuentes `platform.*` | `context-compiler` | agent, task, run (restricciones + respuestas), goal, capability, observation, memory |
| `ContextSizer` / `Utf8BytesSizer` | `context-compiler` | Port de tamaño determinístico (sin tokenizer de proveedor) |
| `ContextCompactor` / `DeterministicCompactor` | `context-compiler` | Seam de compaction; sólo la implementación determinística (ADR-014) |
| `ExecutionRuntime.recordContextSnapshot` / `latestContextSnapshot` | `task-runtime` | Persistencia fenced del snapshot (+ summaries) antes del modelo (ADR-012) |
| `PostgresMemoryStore`, `PostgresContextSnapshotStore` | `persistence-postgres` | Memoria append-only (`MemoryReader`) y lectura de snapshots para auditoría |
| `DurableKernelSession.prepareContext` | `apps/worker` | Pegamento: arma el request del compilador, reutiliza o persiste |

### 12.2 Autoridad, frescura y conflictos (ADR-011)

Cada ítem lleva `authority` (AUTHORITATIVE · OBSERVED · CONVERSATIONAL ·
DERIVED · COGNITIVE), restringida por `kind`; `freshness` (fresh · stale ·
expired · unknown) calculada con reloj inyectado; `provenance`
(`recordType/recordId/recordVersion/producedBy/derivedFrom`) y `sensitivity`.
Lo expirado nunca es actual: sólo evidencia en `history`. Los desacuerdos entre
`assertions` se exponen como `conflicts` con todas las posiciones; sólo una
posición AUTHORITATIVE vigente puede prevalecer.

### 12.3 Estructura del contexto compilado

`sections` = `agent` · `task` (task + restricciones de ejecución) · `goals` ·
`capabilities` (visibles; ejecutable sigue decidiéndolo C1) ·
`authoritativeState` · `observations` · `conversation` · `workingMemory` ·
`episodicMemory` · `derivedMemory` · `history`; más `conflicts`, `omissions`
(conteo por motivo) y `budget`. El esquema prohíbe `SECRET`, ítems fuera de su
sección, `expired` fuera de `history` y presupuestos excedidos.

### 12.4 Selección y presupuesto (ADR-010, ADR-015)

**Budgeting es un mecanismo. La política de presupuesto es una decisión
empírica. La política por defecto en esta etapa es UNBOUNDED. El modo acotado
sigue disponible para experimentos y futuros controles productivos.**

Política `ContextCompilationPolicy` (worker `R4_CONTEXT_*`) con
`budget: ContextBudgetPolicy`:

| Modo | Qué hace |
|---|---|
| `unbounded` (default) | R4 no impone límite propio (no significa contexto infinito). Se aplican todas las reglas de autoridad, frescura, supersession, `SECRET`, duplicados, conflictos y orden; ningún ítem se excluye por `budget`, no hay compaction, `budget_exhausted` no ocurre. |
| `fixed(N)` | Selección acotada, compaction por presión, `kindLimits`, `omissions`, `budget_exhausted` (`max_context_tokens`). Tests, benchmarks, experimentos, protección futura. |

El `contextPolicy.maxContextTokens` del agente sólo ajusta
(unbounded + N → fixed(N)). A futuro:
`input efectivo = min(límite físico del modelo, presupuesto opcional de R4)`;
C2 no modela límites de proveedor.

Requeridos por tipo (agent_definition, task, execution_constraints, goal,
capability) o por la fuente (última observation del run); luego `state →
observation → conversation_turn → working_note → episode → derived_summary`,
más recientes primero; evidencia expirada al final. `kindLimits` es política
de selección (motivo `policy`). Motivos de exclusión: `expired`,
`superseded`, `budget`, `policy`, `sensitivity`, `duplicate`,
`not_relevant_to_scope`, `compacted`.

**Comportamiento observado, no veredicto:** con FIXED(6000) y este orden de
selección, el corpus largo deja working y episodic memory en 0 ítems
incluidos. Definir una asignación productiva requiere evaluación empírica.

### 12.4b Contabilidad del contexto (ADR-015)

`ContextComposition` = proyección determinística (no persistida) de las
decisiones por ítem + `estimated_tokens` + budget del snapshot
(`snapshotComposition`):
`raw = included + excluded`, `compiled = included + overhead`; desgloses por
kind, autoridad, fuente, sección y motivo; métricas de compaction (input,
output, ratio, ítems). Consultas de percentiles por agente/tipo de
task/kind/autoridad/fuente: `GROUP BY` sobre `context_snapshot_items`.

### 12.5 Memoria (ADR-013)

`WORKING` (COGNITIVE), `CONVERSATIONAL` (CONVERSATIONAL), `EPISODIC` (OBSERVED),
`DERIVED_SUMMARY` (DERIVED): task-scoped, append-only, supersede/expire sin
destruir procedencia, sin `SECRET`. El modelo no tiene decisión que escriba
memoria ni estado; la plataforma sólo escribe summaries de compaction.

### 12.6 Compaction (ADR-014)

Sólo bajo presupuesto FIXED y presión de presupuesto (nunca en UNBOUNDED): el prefijo antiguo (en bloques) se resume en
un `DERIVED_SUMMARY` con derivación completa, persistido junto al snapshot y
reutilizado después; la cola reciente queda cruda; las fuentes nunca se borran.

### 12.7 ContextSnapshot (ADR-012)

Persistido antes de cada llamada al modelo, inmutable (triggers), ligado al step
por FK compuesta. Reutilización en recuperación si el `inputFingerprint`
(ítems evaluados + frescura + política y presupuesto efectivos) no cambió; si
cambió, attempt nuevo que supersede al anterior. Reconstrucción exacta:
`step.contextSnapshotId → compiledContext`; contabilidad:
`snapshotComposition(snapshot)`.

### 12.8 Durabilidad y recuperación

| Evento | Resultado verificado |
|---|---|
| Worker muere durante la llamada (SIGKILL real) | el siguiente worker reutiliza el snapshot de esa iteración byte a byte (`worker-process-crash.test.ts`) |
| Transición durable mientras la iteración está huérfana | attempt 2 que supersede, attempt 1 intacto (`context-snapshots.test.ts`) |
| Cambio de presupuesto efectivo entre el worker caído y el que reanuda | attempt 2 con el nuevo budget; nunca reutiliza un snapshot incompatible (`context-snapshots.test.ts`) |
| Observation nueva | snapshot nuevo en la siguiente iteración que la incluye |
| Reinicio de worker / API / PostgreSQL | memoria y snapshots intactos (`context-snapshots`, `restart-persistence`, `database-restart`) |
| Upgrade C1 → C2 | steps C1 con `contextSnapshotId = null`; el run continúa con snapshots (`migration-upgrade-c2.test.ts`) |

### 12.9 Telemetría (C2)

`context.compile.started`, `context.source.loaded`, `context.item.included`,
`context.item.excluded` (agregados por fuente/tipo/autoridad/frescura/sección o
motivo, con `count` y `estimatedTokens`: volumen acotado; el detalle por ítem vive
en el snapshot), `context.compacted`, `context.conflict.detected`,
`context.budget.exhausted`, `context.snapshot.persisted`,
`context.snapshot.reused`, `context.compile.completed` (una vez por snapshot
usado: `budgetMode`, raw/compiled/included/excluded tokens, conteos,
compaction input/output, tokens incluidos por kind y por autoridad — enums
cerrados; por fuente y por ítem sólo en persistencia). Sólo metadata: nunca
contenido de ítems (verificado por tests con marcadores y secretos).

## 13. R4-D — Governed Execution

Pregunta que responde D: ¿puede un agente proponer una mutación, permitir que
la plataforma determine si está autorizada, ejecutarla de manera durable e
idempotente y volver a observar un resultado verificable, sin que el modelo
controle permisos, ejecución ni verdad transaccional?

```text
model ─► propose_action {capabilityId, arguments, evidenceRefs?}   (intención; sin campos confiables)
   ─► step pending + ActionProposal                      (1 tx fenced; evidencia verificada)
   ─► ActionExecutor.prepare: resolver + validar argumentos
        ├─ inválido ─► observation write_validation_failure ─► el agente sigue
        └─ ActionRuntime.authorizeAction ─► Policy Engine (pura) ─► PolicyDecision
             ├─ DENY             ─► observation policy_denied ─► el agente sigue
             ├─ REQUIRE_APPROVAL ─► observation + run suspended + task requires_approval (1 tx)
             └─ ALLOW            ─► ActionCommand (executionKey de plataforma) (misma tx)
   ─► advanceAction: fila de intento (fenced) ─► ActionExecutor.attempt ─► write handler (misma clave)
   ─► recordAttempt: receipt + estado + observation + step observed (1 tx)
        └─ desconocido ─► replay / reconcile según el log de intentos, o
                           needs_reconciliation + run suspended + task blocked
   ─► load ─► ContextSnapshot con la observation ─► model
```

Invariante: **el modelo propone; la plataforma autoriza; la capability/dominio
ejecuta; el receipt prueba lo que ocurrió.**

### 13.1 Componentes

| Componente | Paquete | Rol |
|---|---|---|
| `ProposeActionDecision`, `ActionProposal`, `PolicyDecision`, `ActionCommand`/`ActionExecution`, `ActionAttempt`, `ActionReceipt`, `TrustedActionContext`, `ActionAuthorizer` (puerto) | `contracts` | Contratos estrictos (ADR-016) |
| `ActionPolicyEngine`, `DEFAULT_ACTION_POLICY` | `policy-engine` | Autorización determinista, versionada y con hash (ADR-017) |
| `CapabilityRegistry.registerWrite`, `ActionExecutor` | `capability-runtime` | Registro de writes con estrategia declarada; único call site de handlers de escritura; clasificación conservadora (ADR-018) |
| `ActionRuntime`, `nextActionStep` | `task-runtime` | Autoridad durable y fenced sobre el ciclo de vida del efecto; regla única del siguiente intento (ADR-018/019) |
| `ExecutionRuntime.recordStep` | `task-runtime` | Persiste la propuesta con su step |
| Métodos del ledger en `PostgresExecutionStore`; `PostgresActionLedgerStore` | `persistence-postgres` | SQL del ledger; lectura para auditoría y métricas |
| `DurableKernelSession.executeAction` | `apps/worker` | Secuenciación sin reglas: preparar → autorizar → avanzar → intentar → registrar |
| `AgentKernel` (`propose_action`, `pendingAction`) | `agent-kernel` | Budget de writes; entrega la propuesta al puerto; nunca ve un handler |

### 13.2 AgentDecision

`propose_action` se agrega sin tocar `read_capability`, `respond` ni `complete`
(protocolo `r4.agent_decision.v2`). El parser exige capability concedida y no
READ (`unknown_capability`, `capability_not_permitted`) y `evidenceRefs` ⊆
observations de la task (`unknown_evidence`). Cualquier campo extra — clave de
idempotencia, decisión de política, riesgo, permiso, identidad, receipt,
estado, lease — es `invalid_decision_schema`.

### 13.3 Política (ADR-017)

Reglas tipadas en orden fijo; entradas sólo de plataforma (los argumentos no
entran). `TrustedActionContext` = contexto de ejecución C1 + `actor`
(`task.requestedBy`) + `identityAssurance` (`unauthenticated → none`; resto
`provisional`; nada es `verified` en D). Cada decisión persiste política
(`id`, `version`, `hash`, `engineVersion`), capability y versión, clase de
riesgo, agente/task, resultado, `reasonCode`, `rule` e `identityAssurance`.

### 13.4 Execution identity e idempotencia (ADR-018)

`executionKey = r4x_<executionId>`: generado y persistido con el comando,
antes de cualquier llamada; lo usan todas las ejecuciones, replays y
reconciliaciones de ese comando, por cualquier worker. Estrategias
`idempotent_replay` y `reconcile_before_retry`; sin estrategia, la capability
es visible pero no ejecutable (`unsafe_write_semantics`). Resultado del
dominio: `applied | rejected | failed | unknown` (+ `not_applied` sólo en
reconciliación). Timeout, excepción o salida inválida ⇒ `unknown`.

### 13.5 Ciclo de vida de `ActionExecution`

```text
prepared ──► executing ──► succeeded | rejected | failed     (siempre con receipt)
                 └───────► needs_reconciliation              (resultado desconocido; resolución: R4-E+)
```

Los intentos (`execute` = el primero, `replay`, `reconcile`) son append-only y
se escriben antes de la llamada; su outcome se registra una vez. Desde el
estado durable se reconstruye: qué se pretendía (propuesta), qué decidió la
política, qué comando se generó, si empezó la ejecución, qué intentos
corrieron y qué resultado se observó.

### 13.6 Receipt y observation

El receipt (`succeeded | rejected | failed`) es evidencia inmutable del
resultado **conocido**: `resourceRef`, `externalOperationRef`, `result`
(validado contra el esquema de salida), `error`, `executedAt`, `evidence`
(`obtainedVia`, intento, número de intentos, `replayed`). La observation de
acción (`source.kind = 'action'`) se persiste en la misma transacción, con
`validUntil = null`: el receipt prueba qué ocurrió, no el estado actual del
recurso. Un resultado desconocido no produce observation ni receipt.

### 13.7 Transacciones y recuperación (ADR-019)

| Muere el worker… | Estado durable | Qué hace el siguiente dueño |
|---|---|---|
| tras la propuesta, antes de la política (A) | step `pending` + propuesta | evalúa la política; sin llamada al modelo |
| tras ALLOW (B) | comando `prepared` | ejecuta con la misma clave |
| tras la fila de intento, antes de la llamada (B′) | intento sin outcome | replay/reconcile por la regla del log |
| tras el efecto, antes del receipt (C) | intento sin outcome; efecto aplicado | misma clave → replay idempotente o reconciliación → un efecto, un receipt |
| tras receipt + observation (D) | step `observed` | no re-ejecuta; snapshot nuevo con la observation |

La llamada externa nunca está dentro de una transacción. Un worker que perdió
el lease no puede registrar intento, receipt, observation, step ni transición
(fencing C1 reutilizado vía `lockOwnedExecution`). Todo fin de run deja las
ejecuciones `executing` como `needs_reconciliation`.

### 13.8 Budget de writes y terminación

`ExecutionPolicy.maxWriteActions` (`R4_EXEC_MAX_WRITE_ACTIONS`, **0 por
defecto**: sin writes salvo opt-in del operador), acotado por `budget.maxWrites`
de la task; consumo = comandos creados para la task (task-scoped). Se chequea
antes de registrar la propuesta; agotado ⇒ step `refused` +
`budget_exhausted` / `max_write_actions`. Con límite 0 las capabilities de
escritura tampoco se ofrecen al modelo.

| Situación | Resultado |
|---|---|
| argumentos inválidos / no-write | observation `write_validation_failure`; continúa |
| política DENY | observation `policy_denied`; continúa |
| REQUIRE_APPROVAL | run `suspended` (`approval_required`, clase null), task `requires_approval` |
| conflicto de concurrencia / rechazo del dominio | receipt `rejected`, observation `action_rejected`; continúa |
| fallo definitivo del dominio | receipt `failed`, observation `write_execution_failure`; continúa |
| resultado desconocido | run `suspended` (`write_outcome_uncertain`, código `write_outcome_uncertain` o `write_reconciliation_failure`, clase `action`), task `blocked` |
| budget de writes | `budget_exhausted` / `max_write_actions` |
| fallo de plataforma no clasificado | `internal_failure` / `action_execution_error` (ejecución en vuelo ⇒ `needs_reconciliation`) |

### 13.9 Telemetría (D)

`action.proposed`, `policy.evaluated`, `action.command.created`,
`action.execution.started`, `action.execution.replayed`,
`action.attempt.recorded`, `action.reconciliation.started`,
`action.reconciliation.completed`, `action.receipt.persisted` (con
`receiptLatencyMs`), `action.observation.persisted`, `action.denied`,
`action.approval_required`, `action.failed`, `action.outcome_uncertain`,
`run.suspended`. Metadata: `correlationId`, `taskId`, `runId`, `agentId`,
`proposalId`, `executionId`, `capabilityId`, `riskClass`, `workerId`,
`attempt`. Nunca argumentos, resultados ni secretos.

### 13.10 Métricas (fundamento, sin dashboards)

`PostgresActionLedgerStore.metrics(taskId?)` deriva del ledger: propuestas,
allow/deny/approval, rechazos de validación, ejecuciones, intentos por tipo
(execute/replay/reconcile), receipts por estado, resultados inciertos,
duplicados evitados (`replayed` en intentos no iniciales) y latencia
comando→receipt.

### 13.11 Fixture de prueba (fuera de Core)

`tests/fixtures/capabilities/test-ledger.ts`: ledger genérico de registros de
prueba en el esquema `platform_test` (creado por el test, no por migraciones
R4), a lo sumo un efecto por clave, replay idempotente, reconciliación por
clave, `expectedVersion` opcional y ganchos de fallo. Agente de prueba
`tests/fixtures/agents/action-probe` (el `platform-probe` del repo sigue sin
scopes de escritura).

## 14. R4-E — Temporal + Human Runtime

Pregunta que responde E: ¿puede una AgentTask permanecer coherente durante
minutos, horas o días; esperar tiempo, input o intervención humana;
reanudarse después de crashes; preservar su objetivo; resolver ejecuciones
inciertas y transferir temporalmente autoridad a humanos, sin convertir el
runtime en un workflow determinístico? Diseño: ADR-021 (runtime temporal y
humano) y ADR-022 (scheduler, reconciliación y autoridad del tiempo).

No es un workflow engine: es un runtime durable capaz de esperar. La
plataforma gobierna durabilidad, ownership, transiciones válidas, tiempo,
permisos, autoridad humana y recuperación; el agente decide qué intenta
lograr, cuándo necesita información o ayuda humana y qué hacer con evidencia
nueva. Un wake no decide nada: sólo vuelve runnable la task; el kernel de la
siguiente run decide desde un ContextSnapshot nuevo.

```text
work ─► wait {WAIT_FOR_INPUT | WAIT_UNTIL} ─► run suspended (waiting) ─► task waiting (TaskWait)
          ├─ input (idempotente) ─────────────┐   (WAIT_UNTIL es interrumpible: su timer se cancela)
          └─ scheduler: schedule vencido ─────┴─► wake (una vez) ─► task running ─► run nueva ─► snapshot nuevo
work ─► request_consultation ─► WAIT_FOR_HUMAN ─► respuesta humana (texto + procedencia) ─► wake
propose_action ─► REQUIRE_APPROVAL ─► ApprovalRequest (propuesta + versión + hash de argumentos)
          ├─ approve ─► run nueva: la MISMA propuesta vuelve a Policy ─► nueva decisión ─► ALLOW ─► ejecuta 1 vez
          └─ reject/expire/withdraw ─► Observation approval_* ligada a proposalId + approvalRequestId
work ─► request_handoff / takeover del operador ─► humano dueño (task blocked, sin claims) ─► release ─► wake
efecto desconocido ─► needs_reconciliation + trabajo de reconciliación (misma tx, trigger)
          ─► scheduler (política durable) ─► dispatched ─► worker: ActionRuntime reconcile (misma executionKey)
          ├─ conocido ─► receipt + observation ─► task runnable (o su estado terminal diferido)
          └─ desconocido ─► backoff durable ─► ... ─► exhausted ─► operador re-arma (nunca "asumir")
```

### 14.1 Componentes

| Componente | Paquete | Rol |
|---|---|---|
| `wait`, `request_consultation`, `request_handoff`, `manage_goal` (AgentDecision, protocolo `r4.agent_decision.v3`); `TaskWait`, `Schedule`, `HumanRequest`, `TrustedHumanContext`, `InputSubmission`, `ReconciliationPolicy`, `TaskOwnership` | `contracts` | Contratos estrictos; el modelo sólo *pide* |
| `TemporalRuntime` | `task-runtime` | Autoridad durable de esperas, wakes, input, colaboración humana, takeover, cancelación, goals y disparo de schedules (una tx por operación, lock de la task primero) |
| `ActionRuntime.claimReconciliation` / `recordReconciliation` / `observeApprovalOutcome` / `pendingApproval` / `deferRetry` | `task-runtime` | Única autoridad de intentos, también de reconciliación (fenced por el token del schedule) |
| `transitionTaskWithin` (intención terminal diferida) | `task-runtime` | Ninguna task queda `cancelled`/`failed` con un efecto incierto |
| `PostgresTemporalPersistence` | `persistence-postgres` | SQL temporal sobre `r4_now()`; claims SKIP LOCKED + generación |
| `interactionSource`, `goalSource` (E) | `context-compiler` | Proyección cross-run de interacción; goals raíz/foco vivos, cerrados como historia |
| `Scheduler`, `createSchedulerPlatform`, `main.ts` | `apps/scheduler` | Proceso independiente: reclama y dispara; nunca razona ni ejecuta capabilities |
| `Reconciler` | `apps/worker` | Secuencia claim → `reconcile` (ActionExecutor) → registro; antes de cualquier claim de task |
| Rutas `/v1/tasks/:id/{inputs,cancel,handoff,temporal}`, `/v1/human-requests/:id/respond`, `/v1/executions/:id/reconciliation/reschedule`, `/v1/attention` | `apps/api` | Seams del Operator Plane; identidad humana sólo vía adapter (`humanContext`) |

### 14.2 Autoridad del tiempo

| Concepto | Reloj |
|---|---|
| Leases, heartbeat y fencing de C1 | PostgreSQL `clock_timestamp()` (sin cambios) |
| Due de schedules, leases de schedules, esperas, registros humanos, eventos temporales | PostgreSQL `r4_now()` (reloj temporal; = `clock_timestamp()` en producción) |
| Reconciliación: backoff, deadline, attempts | `r4_now()` + política durable en el schedule |
| Timestamps del ledger D escritos por `ActionRuntime` (decisiones, comandos, intentos, receipts, observations de acción) | `r4_now()` cuando hay persistencia temporal (una sola fuente por transacción) |
| Steps, runs y snapshots escritos por `ExecutionRuntime` (C1/C2) | Reloj inyectado del proceso (sin cambios) |
| Frescura del contexto (C2) | Reloj inyectado del proceso (sin cambios) |

Dentro de una transacción de E todos los timestamps salen de una única
lectura de `r4_now()`. Una base de prueba desechable puede redefinir
`r4_now()` (`tests/support/temporal.ts`) para avanzar el tiempo temporal sin
sleeps; los leases de C1 no se ven afectados. Ningún timer en memoria es
autoridad: el del scheduler y el del worker sólo marcan el ritmo de sondeo.

### 14.3 Esperas, input y wakes

Una espera cierra su run como `suspended` (`waiting` o `human_handoff`) y
abre un único `TaskWait` (índice único parcial). Una task puede existir sin
run activa mientras espera, requiere aprobación, está bloqueada o es de un
humano; al reanudarse, el claim crea **una run nueva** (una run caída a mitad
sigue la recuperación same-run de C1). El input canónico (`POST
/v1/tasks/:id/inputs`) es idempotente por (task, source, externalKey): el
mismo evento re-entregado es un input durable y un wake efectivo; su texto es
memoria CONVERSATIONAL (el seam de ingestión de C2). `WAIT_UNTIL` es
interrumpible por input: el input despierta ahora, la espera se cierra con
`resolution = input` y el timer se cancela, así que no puede despertarla otra
vez. Un input que llega mientras el modelo decide esperar no queda varado: si
el snapshot de esa decisión no lo evaluó, la espera se satisface al abrirse.
Si un evento satisface una espera pero la task tiene un efecto incierto, la
espera se cierra (queda registrado qué la satisfizo) y la task pasa a esperar
la reconciliación.

### 14.4 Scheduler

`apps/scheduler` es un composition root separado (`npm run start:scheduler`)
que comparte sólo PostgreSQL. Cada ciclo reclama un schedule vencido (SKIP
LOCKED, lease + generación sobre `r4_now()`) y lo dispara por el Temporal
Runtime: `wake` despierta su espera, `human_expiry` expira su request,
`action_retry` libera la task para el claim (backoff durable de D) y
`reconciliation` queda `dispatched` para los workers. Un scheduler que muere
tras el claim deja un lease que expira; otro reclama con generación mayor y el
token viejo es rechazado. La política de reconciliación (intentos, backoff,
deadline) es configuración explícita sin default productivo: el proceso no
arranca sin ella, y la estampa en el trabajo la primera vez que lo reclama.

### 14.5 Reconciliación

El trabajo nace con la incertidumbre, por cualquier camino (intento con
resultado desconocido, run que termina con una llamada en vuelo, run
abandonada por límite de recuperación, cancelación durante una acción), en la
misma transacción: un trigger sobre `action_executions` crea el schedule y un
constraint trigger diferido hace irrepresentable `needs_reconciliation` sin
trabajo. El scheduler lo despacha; un worker (que tiene las capabilities) lo
reclama con el lease del schedule y `ActionRuntime` concede un intento
`reconcile` del **mismo comando** (misma execution key, número de intento
siguiente). Resultado conocido → receipt + observation (+ el step de la
propuesta) y la task vuelve a ser runnable, o alcanza su estado terminal
diferido; `not_applied` se registra como "no aplicado" (la reconciliación
nunca re-ejecuta). Resultado desconocido → el intento queda desconocido y el
trabajo se reprograma con la política durable, hasta `exhausted`. Mientras un
efecto es ambiguo no hay claim ni llamada al modelo. Un trabajo agotado
aparece en `/v1/attention` y sólo un operador con `reconciliation.manage`
puede re-armarlo (presupuesto y deadline nuevos); nadie puede declarar el
resultado.

### 14.6 Colaboración humana

`TrustedHumanContext` (referencia + scopes cerrados) lo construye el adapter
de autenticación de la API; sin adapter, toda operación humana responde 422
`trusted_human_required` (no hay IAM productivo). Consultation y approval
conservan la ownership semántica del agente; el handoff la transfiere. Toda
respuesta es idempotente por (request, responseKey) y hay una sola decisión
terminal por request (el lock de la task serializa carreras). El texto humano
es evidencia durable con procedencia humana (`temporal_events`), proyectada
como CONVERSATIONAL — nunca estado canónico. La aprobación no ejecuta nada:
es evidencia para una **nueva** evaluación de política de la misma propuesta
(la decisión `REQUIRE_APPROVAL` original no se modifica); cualquier cambio de
capability, versión o argumentos la invalida (`approval_scope_mismatch`) y el
resto de las reglas sigue aplicando. Rechazo, expiración o retiro producen una
Observation `approval_rejected|expired|cancelled` ligada a `proposalId` y
`approvalRequestId`, antes de que el agente vuelva a razonar.

### 14.7 Handoff y ownership

El handoff puede pedirlo el agente (`request_handoff`) o iniciarlo un
operador (`POST /v1/tasks/:id/handoff`) sobre una task en cualquier estado no
terminal: la run activa se suspende en la misma transacción (el worker falla
en su siguiente escritura fenced o heartbeat), la espera abierta se
reemplaza y la task queda `blocked` con `statusReason = human_handoff`.
Mientras hay un handoff pedido o activo, un trigger impide `running` y claims
autónomos, y el runtime rechaza wakes. `release` (sólo el humano dueño)
despierta la task; la run nueva ve el resumen, las notas del humano y el
input recibido durante el período humano. `GET /v1/tasks/:id/temporal`
devuelve `ownership = {owner, humanRef, blockedBy[], terminalIntent}`, que
distingue sin ambigüedad `human_handoff` de `uncertain_action`.

### 14.8 Cancelación

`POST /v1/tasks/:id/cancel` cancela durablemente la run, la espera, las
requests humanas abiertas y los timers. Si hay un efecto en vuelo o incierto,
la cancelación **no** afirma que no ocurrió: la task queda `blocked` con una
intención terminal durable y pasa a `cancelled` cuando la reconciliación
establece el resultado. La misma regla vale para cualquier estado terminal
(p. ej. la falla de una run abandonada), impuesta también por trigger.

### 14.9 Goals

La extensión es mínima sobre la primitiva existente (raíz, foco actual,
padre). `manage_goal` (`create` con padre, `focus`, `complete`, `abandon`) es
estado cognitivo: no pasa por la Policy Engine, sí por la validación del
Temporal Runtime (el goal existe, es de esta task, está activo; el foco nunca
se mueve implícitamente al cerrar un goal). Una referencia inválida u obsoleta
del modelo se rechaza de forma recuperable (step `refused` + episodio
`goal.change.rejected` en el contexto siguiente), nunca falla la task. Toda
transición queda en `goal_transitions` (append-only, con backfill). Un goal
nunca es verdad de negocio ni prueba de efecto.

### 14.10 Contexto

Toda continuidad entra por durable records → ContextSource → Context
Compiler → ContextSnapshot. `platform.interaction` proyecta, desde el log de
steps de todas las runs, `human_requests`, las decisiones humanas y las
esperas: lo que el agente dijo en runs anteriores, las preguntas que hizo a
humanos, las respuestas y notas humanas, cómo terminó cada espera (con la
razón declarada) y los cambios de goal rechazados. Los turnos compiten por el
presupuesto de conversación (y la compaction) como cualquier otro; con
`FIXED(N)` los viejos se excluyen o compactan. `platform.goal` expone raíz y
foco como goals vivos y los goals cerrados como episodios de historia. Tras
una espera larga, la run nueva compila con el reloj actual: la frescura se
recalcula y la evidencia expirada pasa a `history`.

### 14.11 Persistencia (0005)

`r4_now()`; `task_waits`, `human_requests`, `schedules`, `temporal_events`
(inmutable), `task_inputs` (inmutable), `task_terminal_intents` (inmutable),
`goal_transitions` (inmutable, con backfill); triggers de guarda de task,
historia de goals, reconciliación nacida con la incertidumbre (+ backfill de
`needs_reconciliation` preexistentes) y constraint diferido; `policy_decisions`
admite una segunda decisión por propuesta (a lo sumo un ALLOW) y
`observations` una por evidencia (`action_evidence_key`, `approval_request_id`).
Índices por los accesos reales: schedules vencidos, reconciliación
despachada, `schedules(task_id)`, esperas y requests por task. 0001–0004
intactas. 0005 pertenece a R4-E no publicado y se corrigió en su lugar durante
el milestone; queda congelada al hacer commit.

### 14.12 Telemetría y métricas

Eventos (sólo metadata; nunca texto humano o de input): `task.wait.*`,
`task.woken`, `task.input.received`, `task.cancelled`, `task.terminal.*`,
`schedule.*`, `goal.*`, `consultation.*`, `approval.*`, `handoff.*`,
`reconciliation.*`. Derivables de `temporal_events`, `task_waits` y
`schedules`: duración de esperas (`durationMs`), tiempo a respuesta humana y a
aprobación (`latencyMs`), duración de handoff, lag del scheduler (`lagMs`),
latencia de wake, intentos y tiempo de reconciliación (`elapsedMs`), tasks
bloqueadas y reanudadas, vida de goals (`lifetimeMs`) y transiciones de goal.

## 15. R4-F — Sales Reference Application (fuera de Core)

Pregunta que responde F: ¿puede la plataforma sostener una conversación
comercial natural, mantener el objetivo del cliente, consultar sistemas reales
mediante capabilities, construir progresivamente una solución y producir una
cotización gobernada sin codificar el flujo comercial como workflow? Diseño:
ADR-023 (Agent Pack, estado Sales, adapters de dominio) y ADR-024 (primer
adapter de modelo). Baseline R4-E: `74ed8e7`.

F es un **workload**, no una fase de Core: todo vive en `agents/sales`,
`adapters/domains` y `adapters/models/openai-compatible`, y se conecta por los
seams que ya existían (`WorkerBindings.capabilities`, `.contextSources`,
`.actionPolicy`, `.modelProvider`; input canónico; migrador genérico). Los
únicos cambios de Core son dos extensiones genéricas de clasificación de
errores (ADR-023, tabla).

```text
turno del cliente ─► input canónico (POST /v1/tasks/:id/inputs; el harness lo llama in-process)
   ─► wake ─► run nueva ─► ContextSnapshot { agent, task, goals, capabilities,
        authoritativeState: sales.workspace (estado Sales, sin precios),
        observations (catálogo / envío / cliente, con frescura), conversation (cross-run) }
   ─► modelo (Fake en CI | OpenAI-compatible en live) ─► AgentDecision v3
        ├─ read_capability catalog.* | shipping.quote | customer.get_context ─► Observation
        ├─ propose_action sales.workspace.update ─► policy ALLOW (REVERSIBLE) ─► receipt
        ├─ manage_goal (objetivo del cliente bajo la raíz; foco explícito)
        ├─ request_consultation (conocimiento humano no disponible por capability)
        ├─ propose_action quote.create ─► SALES_ACTION_POLICY (evidencia + identidad)
        │     ─► comando (executionKey) ─► Quote owner (idempotency key = executionKey)
        │     ─► receipt ─► Observation ─► el agente informa número y total desde ella
        └─ respond ─► wait WAIT_FOR_INPUT (fin del turno; nunca "entregado")
```

### 15.1 Componentes

| Componente | Dónde | Rol |
|---|---|---|
| `sales.agent.json` | `agents/sales` | AgentDefinition: instrucciones pequeñas (criterios, no pasos), 5 scopes, sin proveedor/modelo/secreto, sin delegación |
| `SalesWorkspace` (modelo puro) | `agents/sales/src/workspace/model.ts` | Hechos declarados, destino, selección; operaciones explícitas y atómicas |
| `PostgresSalesStore` | `agents/sales/src/workspace/store.ts` | Esquema `sales` (0006 del pack); idempotente por execution key; historia append-only |
| `SalesWorkspaceContextSource` | `agents/sales/src/workspace/context-source.ts` | Ítem `state` AUTHORITATIVE (owner: el pack) + anotación determinista de evidencia aplicable |
| Capabilities | `agents/sales/src/capabilities/*` | `customer.get_context`, `catalog.search`, `catalog.get_product_context`, `shipping.quote` (READ); `sales.workspace.update` (REVERSIBLE_WRITE); `quote.create` (IRREVERSIBLE_WRITE) |
| `SALES_ACTION_POLICY` | `agents/sales/src/policy.ts` | Default de la plataforma + `quote.create` autónomo con evidencia e identidad ≥ provisional |
| `composeSales` | `agents/sales/src/composition.ts` | Registry + fuente de contexto + política → `WorkerBindings` |
| Ports + fixtures | `adapters/domains` | Customer, Catalog (sólo lectura), Shipping, Quote; `DomainError` clasificado; adapters live pendientes |
| `OpenAICompatibleModelProvider` | `adapters/models/openai-compatible` | Primer adapter real (ADR-024) |
| Harness | `agents/sales/src/harness/*`, `agents/sales/src/cli/*` | `SalesHarness` (API + worker in-process), escenarios, invariantes, reporte, `sales:e2e`, `sales:live` |

### 15.2 Qué sabe el agente y qué debe recuperar

| Dato | Owner / autoridad | Cómo llega al agente |
|---|---|---|
| Objetivo del cliente | Cognición (goal del agente bajo la raíz del requester) | sección `goals` (raíz + foco) |
| Presupuesto, espacio, preferencias, correcciones | Pack Sales (hecho declarado) | `sales.workspace`; historia en `sales.workspace_transitions` |
| Productos seleccionados y cantidades | Pack Sales | `sales.workspace` |
| Precio y stock actuales, specs | Catalog owner | observation con `validUntil` (15 min); expirada → `history` |
| Costo de envío | Shipping owner | observation por destino + selección; el workspace marca la que ya no aplica |
| Identidad del cliente | Binding del ingress + Customer owner | `customer.get_context` (sin argumentos) |
| Identidad, número, totales, validez del quote | Quote owner | receipt + observation de acción |
| Lo que se dijo antes | Memoria CONVERSATIONAL + `platform.interaction` | sección `conversation` (cross-run) |

Ninguna memoria, resumen ni texto del modelo puede escribir las filas
AUTHORITATIVE: la conversación no sobrescribe precio, stock, selección ni quote.

### 15.3 Selección y correcciones

`add_item` sobre algo ya seleccionado → `item_already_selected`;
`remove_item` / `set_item_quantity` / `replace_item` sobre algo no
seleccionado → `item_not_selected`; ids que el Catalog owner no conoce →
`unknown_product`; lotes atómicos; `expectedVersion` opcional. `record_fact`
sobre una clave existente reemplaza el valor vigente (una sola restricción
actual); la historia conserva ambos. Claves de precio/stock/costo/total/quote
se rechazan por esquema.

### 15.4 Cotización gobernada

`quote.create {workspaceVersion, customer}` → validación estricta (el modelo
no puede poner id, número, líneas, precios ni totales) → `SALES_ACTION_POLICY`
→ comando con `executionKey` → el handler toma selección y destino del
workspace en esa versión, los registra con la clave (`quote_requests`) y llama
al Quote owner con **idempotency key = executionKey** → receipt.
`workspace_version_mismatch` / `workspace_incomplete` son rechazos (receipt
`rejected`, nada emitido); owner caído antes de enviar → receipt `failed`;
timeout / conexión perdida → `unknown` → reconciliación por clave
(`findByIdempotencyKey`) en la misma run, o `needs_reconciliation` + task
`blocked` + trabajo del scheduler si no puede establecerse. Nunca hay número
de cotización sin receipt.

### 15.5 Harness conversacional

`SalesHarness` compone la API (Task/Temporal Runtime) y un worker real con el
pack sobre PostgreSQL, en un proceso. Un turno = input canónico → ciclos del
worker hasta quedar ocioso → estado durable inspeccionable (`inspect`). Puede
reemplazar el worker entre turnos (frontera de proceso), matar al worker a
mitad de una llamada (pool cerrado; lease expirado en el reloj de la BD) y
adelantar el reloj de proceso (frescura). `npm run sales:e2e` (interactivo con
modelo real, o escenario scripted offline) y `npm run sales:live` (escenarios
representativos con el modelo configurado; artifacts en `artifacts/sales-live/`,
ignorado por git; sin credenciales informa "not executed").

### 15.6 Escenarios e invariantes

S01–S17 + CENTRAL (`agents/sales/src/harness/scenarios.ts`): turnos del cliente
(lo que `sales:live` envía), trayectoria scripted (sólo CI) e invariantes
mecánicas sobre estado durable (`capability_used`, `quotes_issued`,
`no_unbacked_quote_claim`, `goal_kept`, `fact_history`, `selection_equals`,
`refreshed_after_expiry`, `waited_and_resumed`, `prior_response_in_context`,
`one_receipt_per_execution`, …). El orden se toma del log de steps, nunca de
timestamps de relojes distintos. El reporte estructurado (turnos, decisiones,
capabilities, observations, goals, workspace, receipts, runs, tokens, contexto
por kind y fuente) es la entrada reutilizable de R4-G. La trayectoria scripted
no prueba calidad del modelo.

### 15.7 Contexto y telemetría

Sin cambios de presupuesto (UNBOUNDED, ADR-015: medir primero). El reporte
incluye, por snapshot, tokens estimados por kind y por fuente (incl.
`sales.workspace`) y compaction. La telemetría del gateway (perfil de
proveedor, modelo, tokens, latencia, finish reason, llamadas) queda en los
artifacts live (sólo metadata).

### 15.8 Adapter de modelo

ADR-024: `OpenAICompatibleModelProvider`, configuración `R4_MODEL_*`, render
del `CompiledContext` como JSON, envelope físico explícito, errores
clasificados, secretos sólo en el header saliente.

## 16. R4-G — Quality & Learning (completado)

Pregunta: ¿cómo sabemos sistemáticamente si un agente hizo un buen trabajo,
por qué falló y si una versión nueva realmente mejora? Diseño: ADR-025
(evaluación post-hoc, determinista antes que semántica) y ADR-026 (learning =
conocimiento de regresión; artifacts, no tablas). Baseline: R4-F
LIVE-VALIDATED `001b7a8`. Sin cambios de Core de ejecución ni migraciones.

```text
trayectoria durable (tablas existentes, sin copia)
   ─► PostgresTrajectoryReader (apps/evaluator, sólo lectura) + proyecciones del pack
   ─► EvaluationSubject (r4.evaluation_subject.v1, congelado)
   ─► evaluadores deterministas (autoritativos para lo que R4 puede probar)
   ─► evaluadores semánticos (juez sobre proyección de privacidad; fallo ⇒ inconclusive)
   ─► merge/dedupe ─► EvaluationRun { TaskOutcome, vector, findings, evaluadores, reproducibilidad }
   ─► artifacts inmutables ─► RegressionCase (humano) ─► BenchmarkRun (N repeticiones) ─► Experiment (deltas, sin ganador)
```

### 16.1 Componentes

| Componente | Dónde | Rol |
|---|---|---|
| `EvaluationSubject`, `buildEvaluationSubject` | `packages/evaluation` | Trayectoria canónica: runs/steps, metadata de snapshots, turnos (inputs y respuestas humanas, ordenados por el reloj temporal), respuestas con la evidencia que cada una vio, observations, ledger, goals/transiciones, esperas, dominio y llamadas grabadas por un harness (opcional, rotulado) |
| `PostgresTrajectoryReader` | `apps/evaluator` | Llena `TrajectoryRecords` con las APIs de lectura existentes; no escribe (test de conteo de filas) |
| `FindingTaxonomy` | `packages/evaluation` | 10 categorías (PLATFORM, PROVIDER, MODEL_PROTOCOL, CONTEXT, CAPABILITY, DOMAIN, GOAL, STATE, GOVERNANCE, BEHAVIOR_QUALITY); códigos desde evidencia R4-F; extensible por packs, sin redefinir |
| `Finding` | `packages/evaluation` | categoría (de la taxonomía) ≠ severidad; fuente determinista/semántica; confianza y rúbrica sólo semánticas; rationale ≤ 280; id estable; sin razonamiento |
| `TaskOutcome` | `packages/evaluation` | technical / goal / business / quality / governance separados; esperar input es una parada válida |
| Evaluadores deterministas genéricos | `packages/evaluation/src/evaluators` | protocolo (con forma de salida si hay grabación), resultados de runs y dominio, invariantes de gobierno, afirmaciones respaldadas por receipt (detector del pack), continuidad de goal, continuidad de estado, preguntas ya conocidas, uso de capabilities, eficiencia, composición de contexto |
| Frontera semántica | `semantic.ts`, `RubricEvaluator`, `GroundingEvaluator` | juez como puerto, rúbricas versionadas, validación estricta, inconclusive honesto |
| `ModelGatewayJudge` | `apps/evaluator` | juez sobre el `ModelGateway` existente; perfil de evaluador distinto del evaluado |
| `RegressionCase`, `BenchmarkRun`, `Experiment` | `packages/evaluation` | casos versionados con revisión humana; N repeticiones con resultados individuales y agregados honestos; comparación controlada sin ganador |
| Sales evaluator pack | `agents/sales/src/evaluations` | taxonomía (`quote_claim_without_receipt`, `quote_figure_not_from_receipt`, `quote_without_catalog_evidence`, `nonexistent_product_or_category_claim`), proyección del workspace, verificador de claims contra el catálogo observado, quote, corrección de presupuesto, preguntas, rúbricas + lock, fixtures, 12 regresiones + lock, corpus y productores |
| CLIs | `agents/sales/src/cli` | `eval:sales`, `eval:sales:live`, `benchmark:sales`, `experiment:sales`, `regression:promote` |

### 16.2 Qué es determinista y qué semántico

| Pregunta | Cómo se responde |
|---|---|
| ¿La decisión respetó el protocolo? ¿dos documentos o texto extra? | Determinista (step log + forma grabada por el harness, nunca el texto) |
| ¿Hubo efecto sin propuesta, comando sin ALLOW, receipt duplicado, clave cambiada? | Determinista (ledger) |
| ¿Se afirmó un quote sin receipt visible? ¿el total coincide? | Determinista (detector del pack + receipts) |
| ¿El goal raíz existe y siguió válido? | Determinista (no premia `manage_goal`) |
| ¿La corrección reemplazó el valor vigente? | Determinista (transiciones del workspace) |
| ¿Se preguntó algo ya registrado? | Determinista sólo con clasificación inequívoca; si no, rúbrica |
| ¿Qué se afirmó en cada respuesta? | Juez (extracción); la verificación contra la evidencia es determinista |
| ¿Se preservó el objetivo? ¿preguntas innecesarias? ¿timing de writes? ¿elección de capability? | Rúbrica semántica versionada |

### 16.3 Artifacts

`artifacts/evaluations/<ts>/<evaluationRunId>/` (`manifest.json`, `summary.json`,
`findings.jsonl`, `metrics.json`, `data.json`, `report.md`, `subject.json`),
`artifacts/benchmarks/<benchmarkRunId>/` (`benchmark/` con `manifest.json`,
`aggregate.json`, `scenario-results.jsonl`, `report.md`, más una evaluación por
repetición) y `artifacts/experiments/<id>_<ts>/`. Serialización estable;
directorios inmutables; privacidad verificada al producir y al escribir.
Todos ignorados por git.

## 17. R4-H — Shadow / E2E (en progreso)

Pregunta: ¿qué ocurre cuando R4 ejecuta workloads completos, repetidos y
suficientemente realistas con el runtime verdadero, un modelo real y los
límites reales de integración, pero sin efectos de producción sobre clientes
o negocio? Diseño: ADR-027. Baseline R4-G: `4a54b2c`. Sin cambios en Core de
ejecución y sin migración (0001–0006 congeladas; no hay 0007).

```text
WorkloadCase (evento) ─► ingress canónico (TemporalRuntime.submitInput) ─► AgentTask / Goal
   ─► worker real: ContextCompiler ─► ModelProvider (scripted | real, con registro de llamadas)
   ─► AgentKernel ─► AgentDecision ─► capabilities del pack ─► ports GUARDADOS
        ├─ read  ─► fixture (o live-read documentado + opt-in) ──────────────► Observation
        └─ write ─► propose_action ─► Policy (R4-D) ─► comando ─► handler
                    ─► ShadowExecutionPolicy: SHADOW_WRITE ─► owner record-only ─► Receipt ─► Observation
   ─► wait / resume (scheduler real: esperas, reconciliación) · operador simulado (approve, handoff, cancel)
   ─► respond (step log) ─► ShadowOutboundSink (wouldDeliver, actualDelivery = false)
   ─► trayectoria durable ─► R4-G (runBenchmark sobre los subjects producidos) ─► EvaluationRun
   ─► side-effect manifest (guard + ledger + sink) ─► chequeos de seguridad ─► ShadowRun
```

### 17.1 Componentes

| Componente | Dónde | Rol |
|---|---|---|
| Modo shadow (`loadShadowExecutionConfig`, `assertShadowMode`) | `packages/shadow` | Declaración explícita (`R4_EXECUTION_MODE=shadow` / `--execution-mode shadow`); fail-closed; opt-ins de red separados |
| `DomainBindingDescriptor`, `ShadowExecutionPolicy`, `assertShadowComposition`, `guardPort` | `packages/shadow` | Bindings declarados (kind, operaciones con clase de efecto, contrato); clasificación `READ_ALLOWED / SHADOW_WRITE / SANDBOX_WRITE / BLOCKED`; gate de arranque y re-chequeo por llamada |
| `SideEffectRecorder`, `buildSideEffectManifest`, `evaluateShadowSafety` | `packages/shadow` | Registro de toda llamada externa (metadata); manifest unido al ledger por execution key; chequeos deterministas |
| `ShadowOutboundSink` | `packages/shadow` | Única implementación de `OutboundDelivery`; registra, redacta, seudonimiza; nunca entrega |
| `ShadowRecordingModelProvider` | `packages/shadow` | Metadata por llamada (latencia, tokens, finish, clase de error), sin texto; fallas de proveedor controladas y rotuladas (`injected`) |
| `WorkloadCase`, corpus + lock, `workloadFromReplay` | `packages/shadow` (esquema) + pack (corpus) | Trayectorias como datos: inputs, tiempo, procesos, fallas, operador, cambios del owner; propiedades, nunca secuencias de tools |
| `runShadowSuite`, `ShadowRun`, `ShadowSuiteRun`, agregados, observaciones, artifacts, reporte | `packages/shadow` | Corpus × repeticiones × perfil de modelo; cost guard; stop conditions; evaluación con R4-G; sin score |
| `SALES_SHADOW_BINDINGS`, `composeShadowSalesDomains`, fallas/cambios del owner | `agents/sales/src/shadow` | Bindings del pack: customer/catalog/shipping `fixture`, quote `shadow` |
| `ShadowQuoteService` | `adapters/domains/src/quote/shadow.ts` | Owner record-only del Quote port (rango `COT-9xxxxx`, `shadow-record:`) |
| `SalesShadowExecutor` | `agents/sales/src/shadow/executor.ts` | Ejecuta un caso: API + worker + scheduler reales sobre BD desechable; operador simulado; lectura canónica de la trayectoria |
| `worker-process.ts` | `agents/sales/src/shadow` | Worker Sales shadow como proceso del SO (E2E multi-proceso) |
| CLI | `agents/sales/src/cli/shadow.ts` | `shadow:sales` (offline), `shadow:sales:smoke` / `:live` (modelo real, opt-in), `--plan` |

### 17.2 Qué hace "shadow" a una ejecución

1. El modo está declarado y probado (`ShadowExecutionConfig` parseado); si no, nada se compone.
2. Todo owner externo se alcanza por un binding declarado y guardado; ningún
   binding `production` puede componerse ni llamarse; un `live-read` exige
   opt-in, contrato documentado y cero operaciones de escritura.
3. Toda escritura externa pasa primero por R4-D (Policy, comando, receipt) y
   luego se materializa sólo como `SHADOW_WRITE`/`SANDBOX_WRITE`.
4. `respond` sólo llega al sink (`actualDelivery = false`).
5. Cada ejecución produce su manifest y sus chequeos; `productionEffects` y
   `realOutboundDeliveries` se cuentan, no se suponen.

### 17.3 Integración de dominio en R4-H

| Dominio | Binding | Estado |
|---|---|---|
| Customer | `fixture:fixture-customer@1` | FIXTURE (sin contrato configurado en R4) |
| Catalog | `fixture:fixture-catalog@1` | FIXTURE — live-read UNAVAILABLE: el contrato del servicio existe sólo de segunda mano fuera del repo; sin endpoint ni credencial en R4 |
| Shipping | `fixture:fixture-shipping@1` | FIXTURE (sin contrato configurado en R4) |
| Quote | `shadow:shadow-quote-owner@1` | SHADOW (record-only; no hay modo sandbox/preview documentado) |
| Outbound | `shadow-sink:shadow-outbound-sink@1` | shadow-only |

### 17.4 Ejecución y procesos

`controlled-shadow` es el único modo ejecutado (`live-read-shadow` existe en
el framework pero ningún binding live-read está disponible). Cada ejecución
corre en su propia BD desechable (migraciones Core + Sales). El ejecutor
compone la API (`createPlatform`), un worker real (`SalesHarness`, que puede
reemplazarse entre turnos: frontera de proceso con pool y registries nuevos)
y la composición real del scheduler (`createSchedulerPlatform`) sobre la misma
BD; el tiempo simulado mueve el reloj de proceso y, si el caso lo pide,
`r4_now()` de esa BD desechable. El worker no se ejecuta antes del primer
input (un ingress real crea la conversación junto con su primer mensaje). El
E2E multi-proceso (`tests/recovery/shadow-process.test.ts`) usa procesos
reales del SO: worker Sales shadow (SIGKILL + reemplazo) y el `main` del
scheduler.

### 17.5 Métricas

Además del vector de R4-G (misma definición y denominador de adherencia de
protocolo): latencia percibida (input recibido → respuesta lista), latencia de
turno, de llamada al modelo, de llamada a dominio y de evaluación; tokens y
llamadas por turno de input; lecturas por turno, duplicadas (aún frescas) y de
refresco (tras expirar); propuestas de escritura por task; crecimiento de
contexto; fallas de proveedor por clase (reales vs. inyectadas) y de dominio
por categoría (incl. `rate_limited`); gobierno (ALLOW/DENY/REQUIRE_APPROVAL,
receipts, reconciliaciones); colaboración humana; cobertura semántica
(solicitada / completada / inconclusive). Tokens de razonamiento: no expuestos
por `ModelUsage` (se reporta así). Sin precios en el runtime.

### 17.6 Artifacts

`artifacts/shadow/<suiteRunId>/`: `manifest.json`, `plan.json`,
`workload-results.jsonl`, `side-effects.jsonl`, `outbound.jsonl`,
`model-calls.jsonl`, `evaluation-summary.json`, `aggregates.json`,
`architecture-gap-candidates.jsonl`, `report.md`, `benchmark/` (BenchmarkRun de
R4-G) y `evaluations/<id>/` (una EvaluationRun por ejecución). Inmutables
(nuevo id por corrida), serialización estable, gate de privacidad de R4-G más
gate de datos personales en outbound/efectos/llamadas. Ignorados por git.

## 18. Post-H — Recuperación a nivel de run (ADR-028, GAP-H-001)

Corrección arquitectónica aprobada por el Architecture Gap Review posterior a
R4-H (gate humano, **no** una fase del roadmap). Baseline R4-H: `80a1733`.
Sin migración (0001–0006 congeladas); protocolo `r4.agent_decision.v4` sin
cambio; kernel, parser y gateway sin cambio.

**Regla:** una run fallida no termina el trabajo durable salvo que el fallo
mismo establezca que el trabajo es terminal. Implementada sólo para las clases
que la evidencia de H justifica.

```text
salida inválida ─► step invalid ─► run failed                       (ADR-008, igual)
                                     │ runFailureDisposition
      ┌──────────────────────────────┼──────────────────────────────────┐
  recoverable, ≤ max           recoverable, > max                 human (no reintentable)
  (invalid_decision,           (agotada)                          (model_failure no retryable)
   model_failure retryable)
      │                              │                                  │
  task sigue running,          task blocked +                      task blocked +
  sin run activa;              handoff requested                   handoff requested
  claim normal ─► run n+1      initiatedBy=platform                initiatedBy=platform
  ─► ContextSnapshot nuevo     reason=run_failure_recovery_exhausted reason=non_retryable_model_failure
                               (visible en /v1/attention; release o cancel ⇒ autonomía; el conteo vuelve a 1)
```

| Aspecto | Decisión |
|---|---|
| Dueño | `ExecutionRuntime.finishExecution` (ciclo de vida de run y transición de task); el fallback humano lo realiza el `TemporalRuntime` (R4-E), que se adjunta al construirse |
| Clasificación | `runFailureDisposition` en `@r4/contracts` (pura; la usan runtime y Quality) |
| Presupuesto | `maxRunFailureRecoveries` (`R4_EXEC_MAX_RUN_FAILURE_RECOVERIES`, default 1, finito) |
| Contador | Derivado de `agent_runs`: runs `continued` consecutivas; una run `exhausted`/`handed_off` corta la secuencia (tras ella sólo hay otra run si un humano resolvió el handoff) |
| Registro durable | `termination.details.runFailureRecovery` en la run fallida, en la misma transacción |
| Contexto | Run nueva ⇒ snapshot nuevo (C2); incluye inputs llegados entre runs; sin pistas de reparación |
| Budgets | Los de una run normal; los de alcance task (`maxWriteActions`) no se reinician |
| Fuera de alcance | `capability_failure`, fallas de dominio, reintentos por calidad, fallback de modelo |

Invariantes preservados: ninguna reparación de salida inválida; decisiones
aceptadas finales; sin re-ejecución de propuestas ni nuevos `executionKey`;
reconciliación antes que cognición (claim); ownership humano bloquea el claim;
un crash durante una run de recuperación es un takeover de la misma run
(fencing C1). Telemetría: `task.run_failure.recoverable`,
`.recovery_started`, `.recovered`, `.recovery_exhausted`,
`.non_retryable` y `handoff.requested` (`initiatedBy: platform`).
Quality (`r4.execution_outcomes` v2) mide `recoverableRunFailures`,
`recoveredRunFailures`, `exhaustedRecoveries`, `nonRetryableHandoffs` y
`attemptsToRecovery`; nunca inicia recuperación.

**Pendiente para R4-I (no resuelto):** un `respond` entregado por un canal
real antes de un fallo podría repetirse en la run de recuperación.


**Resuelto en R4-I (ADR-029, §19):** la identidad de la respuesta es su step;
reprocesar ese step reutiliza el mismo `OutboundMessage` por
`UNIQUE(response_step_id)` y `r4-out:<stepId>`. Un step nuevo sólo nace
cancelado como `duplicate_content` si representa el mismo Task, el mismo
último input inbound evaluado y el mismo texto que un outbound agente no
cancelado. Los estados `accepted`, `delivered`, `read`, `unknown` y `failed`
con `provider_message_id` conservan evidencia de entrega; un fallo definitivo
sin ID no. El snapshot candidato debe incluir todos los inputs durables en el
momento de materializar. El texto por sí solo no identifica un duplicado.

## 19. R4-I — Governed Production (en progreso — pendiente de auditoría)

Pregunta: ¿puede R4 operar contra usuarios e integraciones reales bajo una
frontera de producción explícita, reversible y auditable, sin perder
idempotencia, ownership humano, privacidad ni control de efectos? Diseño:
ADR-029. Prerrequisito: [auditoría del WhatsApp de CRM-Customer-360](R4-I_CRM_WHATSAPP_AUDIT.md).
Baseline: R4 POST-H RECOVERY BASELINE `dd06a68`. Migración nueva: 0007
(0001–0006 intactas). Protocolo `r4.agent_decision.v4`, kernel, parser y
gateway de modelo sin cambio.

```text
Meta (número canary) ─► apps/channel-gateway: webhook ─► WhatsAppInboundAdapter (firma, canonicaliza)
   ─► ChannelIngress: inbound_events (UNIQUE provider id) ─► ConversationBinding (1 abierta por conversación)
   ─► decideInboundAutonomy (kill switch > deny > rollout > contenido) ─► TemporalRuntime.createTaskWithInput | submitInput
        └─ hold? ─► handoff de plataforma (blocked, /v1/attention): el input queda durable, sin trabajo autónomo
   ─► worker de producción (admisión = kill switch) ─► kernel ─► respond (step durable)          ← Core sin cambio
   ─► OutboundDeliveryRuntime (único dueño): materialize (1 por step) ─► claim SKIP LOCKED + lease + generación
        ─► decideDispatch (gate) ─► intento durable ─► WhatsAppOutboundAdapter.submit (una vez)
        ─► accepted | not_sent (reintento acotado) | rejected | unknown (nunca reintento ciego)
   ─► status callbacks ─► outbound_delivery_events (idempotentes) ─► statusAfterEvidence (monótono)
   ─► DeliveryStateContextSource ─► la cognición siguiente sabe qué NO se confirmó
   ─► R4-G post-hoc sobre la misma verdad durable
```

**Autoridad de conversación:** CRM-Customer-360 conserva el número productivo
existente y su historia operacional. En el número canary recibido directamente
por R4, `channel_conversation_bindings`, el inbound canónico, los Task inputs,
el hilo operacional y el ciclo outbound viven en la persistencia de R4 que
ejecuta esa conversación. La identidad maestra del cliente y el historial CRM
de largo plazo siguen externos; R4-I no sincroniza hilos con CRM. Migrar el
número productivo queda sujeto a un gate posterior de paridad de operador/UI.

### 19.1 Componentes

| Componente | Dónde | Rol |
|---|---|---|
| Modo de ejecución, `loadProductionConfig` | `packages/live-ops` | `test / shadow / production`; producción fail-closed (perfil, rollout explícito, llave de identidad, opt-in de red) |
| `ProductionProfile`, `assertProductionComposition`, `capabilityAvailability` | `packages/live-ops` | Estado de cada dominio (REAL/SANDBOX/INTERNAL/UNAVAILABLE; FIXTURE/SHADOW rechazados), decisiones de escritura, capabilities disponibles |
| `conversationKey`, `rolloutEligibility` | `packages/live-ops` | Identidad HMAC; allowlist/denylist como hashes; bucket estable |
| `decideInboundAutonomy`, `decideDispatch`, `dispositionAfterSubmission`, `statusAfterEvidence` | `packages/live-ops` | Reglas puras: precedencia, gate de entrega, reintento sólo "no enviado", evidencia monótona |
| Contratos de canal (`CanonicalInbound`, `Inbound/OutboundChannelAdapter`) | `packages/live-ops` | Frontera neutral |
| `ChannelIngress`, `OutboundDeliveryRuntime`, `DeliveryDispatcher`, `AutonomyControls`, `ProductionOperator`, `DeliveryStateContextSource`, `guardProductionWrites` | `packages/live-ops` | Ingress canónico, dueño de la entrega, kill switch, plano del operador, contexto honesto, guard de escrituras reales |
| `PostgresProductionStore` + 0007 | `packages/persistence-postgres` | Unicidad, locks, fencing, historia append-only |
| `createTaskWithInput`, `holdForHumansWithin`, `releasePlatformHold`, `submitInput(hold)`; `prepareCreate`/`createWithin` | `packages/task-runtime` | Cambios mínimos y genéricos de Core (sin canal ni dominio) |
| `ProductionAdministration`, `PRODUCTION_CONTROL_ACTOR`; `openProductionAdministration` | `packages/live-ops`; `apps/channel-gateway` (composición, sin canal ni HTTP) | Administración productiva (D-5/D-6): kill switch global y liberación explícita de retenciones `autonomy_disabled`; atribuida a `platform:production-control`, nunca a un humano |
| `WorkerAdmission` | `apps/worker` | Hook genérico opcional antes de cada claim |
| `apps/channel-gateway` | app | Único proceso que habla con el proveedor: webhooks + dispatcher; `/health`, `/ready` |
| Rutas `/v1/production/*`, `/v1/tasks/:id/{thread,outbound,operator-messages}`, `/v1/outbound/:id/{resolve,cancel}` | `apps/api` | Plano del operador (sólo API) |
| `@r4-adapters/whatsapp-cloud` | `adapters/channels/whatsapp-cloud` | Verificación, `X-Hub-Signature-256`, canonicalización por change, sólo el número canary, clasificación honesta; `./testing`: proveedor fake local |
| `SALES_PRODUCTION_PROFILE`, `SALES_PRODUCTION_ACTION_POLICY`, `composeSalesProductionWorker`, `composeSalesGateway` | `agents/sales/src/production` | Composición de producción del pack |
| CLI `production:sales:{plan,validate,smoke,gateway,worker}` | `agents/sales/src/cli/production.ts` | Plan sin efectos, validación offline con artifacts, smoke real con opt-ins, entrypoints |
| CLI `production:sales:control` | `agents/sales/src/cli/production-control.ts` → `production/control.ts` | Herramienta de host (no del operador): `autonomy status|on|off`, `holds list|release`; fail-closed sin producción declarada o esquema al día; sin canal ni modelo |

### 19.2 Qué hace "producción" a una ejecución

1. El modo `production` está declarado y probado, y el perfil compuesto es el declarado.
2. El canal tiene adapters del tipo declarado (REAL ⇒ `real`; un fake local nunca).
3. Sólo se registran capabilities disponibles según el perfil; nada FIXTURE/SHADOW.
4. Toda salida al cliente pasa por el único dueño de la entrega y su gate; toda escritura propuesta sigue R4-D.
5. Kill switch y rollout se leen de la BD en cada decisión (sin caché).

### 19.3 Integración de dominio en R4-I

| Dominio | Estado | Por qué |
|---|---|---|
| Customer | UNAVAILABLE | Sin contrato/endpoint en R4; clientes anónimos/desconocidos |
| Catalog | UNAVAILABLE | Contrato sólo de segunda mano fuera de R4 (H); sin endpoint ni credencial |
| Shipping | UNAVAILABLE | Sin contrato en R4 |
| Quote | UNAVAILABLE (+ `quote.create` REQUIRE_APPROVAL) | Sin sandbox/producción documentado en R4 |
| Sales workspace | INTERNAL | Estado del pack en R4 |
| Canal | WhatsApp Cloud API REAL (canary) | Contrato oficial verificado; validación live pendiente de credenciales |

### 19.4 Estado de entrega y lo que ve el agente

`accepted` = el proveedor aceptó; `delivered`/`read` = evidencia del
proveedor; `unknown` = no se sabe (nunca reintentado); `failed` = no llegó;
`cancelled` = nunca se envió (razón explícita). El contexto de la run
siguiente incluye un episodio OBSERVED por cada respuesta no confirmada.

### 19.5 Métricas y artifacts

Derivadas del estado durable (`ProductionStore.metrics`,
`GET /v1/production/metrics`): `inbound_received`, `inbound_duplicate`,
`task_created`, `task_continued`, `outbound_created`,
`outbound_dispatch_attempted`, `outbound_accepted/delivered/read/failed/unknown`,
`outbound_cancelled` por razón, `kill_switch_blocks`, `rollout_blocks`,
`human_handoffs`, `approvals`, `run_failure_recoveries`, `model_calls`,
escrituras por capability y latencias separadas (despacho, confirmación de
entrega, turno del cliente). Telemetría `inbound.*`, `outbound.*`,
`worker.admission.*`, `autonomy.control.changed` (sólo metadata).
`artifacts/production-validation/<id>/`: manifest, bindings, results,
effects, metrics, evaluation-summary, report (sin secretos ni PII).
