---
title: R4 — Arquitectura del Platform Skeleton (R4-B)
status: implemented (R4-B)
owner: architecture
last_reviewed: 2026-09-22
depends_on:
  - R4_AGENTIC_PLATFORM_MOTIVATION_AND_CONSTRAINTS.md
  - R4_AGENTIC_PLATFORM_PRD_AND_ROADMAP.md
  - ../adr/ADR-001-r4-separated-from-crm.md
  - ../adr/ADR-002-agent-cognition-vs-platform-authority.md
  - ../adr/ADR-003-postgresql-durable-runtime-state.md
  - ../adr/ADR-004-provider-neutral-model-gateway.md
  - ../adr/ADR-005-domain-capabilities-outside-core.md
---

# R4 — Arquitectura del Platform Skeleton (R4-B)

Este documento describe lo que **existe** en el repositorio al cerrar R4-B. No
describe la arquitectura final de R4: la Constitución y el PRD siguen siendo la
autoridad (Constitución > PRD > ADR > tarea). Lo que aquí figura como "seam" es
un punto de extensión deliberado, no una funcionalidad implementada.

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
cognición de R4-C operará sin poder moverlas.

## 2. Topología del repositorio

```text
R4-agent-platform/
├── apps/
│   └── api/                    HTTP /v1 (Fastify). Transporte + composition root.
├── packages/
│   ├── contracts/              Esquemas Zod + tipos de las primitivas. Sin lógica de dominio.
│   ├── observability/          Logger estructurado (pino), correlación (AsyncLocalStorage), eventos.
│   ├── model-gateway/          Interfaz ModelGateway provider-neutral + FakeModelProvider.
│   ├── capability-runtime/     Registry, discovery, invocación validada, creación de observations.
│   ├── task-runtime/           Ciclo de vida de AgentTask/AgentRun/Goal sobre ports de persistencia.
│   ├── agent-registry/         Carga, valida y registra AgentDefinitions inmutables y versionadas.
│   └── persistence-postgres/   Migraciones + implementación PostgreSQL de los ports.
├── agents/
│   └── platform-probe/         Única definición de agente: sonda sin dominio para R4-B.
├── tests/{unit,contract,integration,recovery,support,fixtures}
└── docs/{architecture,adr,roadmap}
```

Paquetes del árbol sugerido que **no** se crearon porque no corresponden a R4-B:
`apps/worker`, `agent-kernel`, `context-compiler`, `memory`, `artifacts`,
`policy-engine`, `scheduler`, `human-collaboration`, `evaluation`, `agents/sales`,
`agents/quality-auditor`, `agents/marketing-analyst`, `adapters/*`. Ver
[roadmap](../roadmap/R4_DELIVERY_ROADMAP.md).

`persistence-postgres` no está en el árbol sugerido del PRD. Existe porque los
paquetes de runtime dependen de **ports** y alguien debe implementarlos; aislar
el driver en un adapter es lo que permite que `task-runtime` sea testeable y
agnóstico de persistencia.

### 2.1 Grafo de dependencias (verificado por test)

```text
contracts  ◄──────────────────────────────────────────────┐
   ▲                                                       │
observability                                              │
   ▲        ▲               ▲               ▲              │
model-gateway   capability-runtime   task-runtime   agent-registry
                       ▲                  ▲              ▲
                       └──────── persistence-postgres ───┘
                                          ▲
                                     apps/api  (también usa task-runtime, agent-registry)
```

Reglas duras (fallan el build si se violan):

| Regla | Dónde se verifica |
|---|---|
| Ningún paquete depende de Next.js, React, CRM, LangChain/LangGraph | `eslint.config.js`, `tests/contract/dependency-boundaries.test.ts` |
| Sólo `persistence-postgres` habla con PostgreSQL | ESLint `no-restricted-imports` + allow-list de dependencias |
| `model-gateway` no alcanza estado ni ejecución de capabilities | ESLint + allow-list |
| Paquetes Core no importan transportes ni apps | ESLint |
| Grafo interno acíclico | `dependency-boundaries.test.ts` |
| Core sin términos de dominio/canal/CRM/vendor | `tests/contract/core-purity.test.ts` |
| Contratos públicos sin campos de proveedor ni de dominio | `tests/contract/provider-neutrality.test.ts` |

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
`status (running|completed|failed|cancelled)`, `contextSnapshotRef` (seam R4-C),
`usage` (columnas: modelCalls, inputTokens, outputTokens, capabilityCalls),
`result` (JSON estructurado), `failure {code,message}`, timestamps, `version`.

- `startRun` pasa la task a `running` y crea el run **atómicamente**.
- A lo sumo un run activo por task: verificado en servicio **y** por índice
  único parcial `agent_runs_one_active_per_task` (probado con 5 starts concurrentes).
- `failure` presente sí y sólo sí `status = failed` (servicio + `CHECK`).
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

En R4-B el gateway **no está cableado** a la API: no hay kernel que lo invoque.
El test `capability-observations.test.ts` demuestra el recorrido completo offline:
FakeModel propone una lectura → la plataforma la valida → la capability produce
una Observation durable.

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
| `observations` | `observation_id` | no | `invocation_id` único; frescura (`valid_until`) |

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
  `db.migration.applied`, `db.migrations.completed`.
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
| Resume | Un run `running` sobrevive al reinicio y puede finalizarse; el siguiente run toma `sequence` n+1. La detección de runs huérfanos (leases/heartbeats) es R4-D. |
| Idempotencia | Creación de tasks (por principal) e invocaciones de capability (por `invocationId`), ambas persistentes a través de reinicios. |
| Checkpointing | Seams: `contextSnapshotRef`, historia de transiciones, `version` en cada entidad mutable. Checkpoints explícitos son R4-D. |
| Estado en memoria | Sólo configuración reconstruible de forma determinista (capability registry desde código; definiciones desde archivos, verificadas contra la BD). |

## 10. Qué queda fuera (deliberadamente)

Agent Kernel, Context Compiler, memoria, artifacts, ActionProposal/Receipt,
Policy Engine, scheduler, consultation/approval/handoff, worker, evaluation
runtime, llamadas LLM reales, autenticación, outbox de eventos, MCP, Sales y
cualquier write productivo. Ver [roadmap](../roadmap/R4_DELIVERY_ROADMAP.md) §4.
