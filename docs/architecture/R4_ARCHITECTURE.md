---
title: R4 — Arquitectura implementada (R4-B + R4-C1)
status: implemented (R4-B, R4-C1)
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
  - ../adr/ADR-006-worker-task-claiming.md
  - ../adr/ADR-007-lease-heartbeat-fencing.md
  - ../adr/ADR-008-agent-decision-protocol.md
  - ../adr/ADR-009-agent-kernel-boundary.md
---

# R4 — Arquitectura implementada (R4-B + R4-C1)

Este documento describe lo que **existe** en el repositorio tras R4-B (Platform
Skeleton) y R4-C1 (Execution Kernel). No describe la arquitectura final de R4:
la Constitución y el PRD siguen siendo la autoridad (Constitución > PRD > ADR >
tarea). Lo que aquí figura como "seam" es un punto de extensión deliberado, no
una funcionalidad implementada. Las secciones 1–10 describen R4-B, actualizadas
donde C1 las cambió; la sección 11 describe R4-C1.

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
│   └── worker/                 (C1) Proceso worker: claim, lease/heartbeat, ejecución del kernel.
├── packages/
│   ├── contracts/              Esquemas Zod + tipos de las primitivas. Sin lógica de dominio.
│   ├── observability/          Logger estructurado (pino), correlación (AsyncLocalStorage), eventos.
│   ├── model-gateway/          Interfaz ModelGateway provider-neutral + FakeModelProvider.
│   ├── capability-runtime/     Registry, discovery, invocación validada, creación de observations.
│   ├── task-runtime/           Ciclo de vida de AgentTask/AgentRun/Goal sobre ports de persistencia.
│   ├── agent-registry/         Carga, valida y registra AgentDefinitions inmutables y versionadas.
│   ├── agent-kernel/           (C1) Loop model → decisión → READ → observation. Sin estado ni persistencia.
│   └── persistence-postgres/   Migraciones + implementación PostgreSQL de los ports.
├── agents/
│   └── platform-probe/         Única definición de agente: sonda sin dominio para R4-B.
├── tests/{unit,contract,integration,recovery,support,fixtures}
└── docs/{architecture,adr,roadmap}
```

Paquetes del árbol sugerido que **no** se crearon porque no corresponden a
R4-B/C1: `context-compiler`, `memory`, `artifacts`,
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
   ▲                   ▲                  ▲              ▲
agent-kernel (C1)      └──────── persistence-postgres ───┘
   ▲                                      ▲
   │                                 apps/api  (también usa task-runtime, agent-registry)
   └──────────── apps/worker (C1): kernel + task-runtime + capability-runtime +
                                   agent-registry + persistence-postgres + model-gateway
```

`agent-kernel` depende sólo de `contracts`, `observability` y la interfaz de
`model-gateway`; `apps/worker` no depende de `apps/api` ni de Fastify.

Reglas duras (fallan el build si se violan):

| Regla | Dónde se verifica |
|---|---|
| Ningún paquete depende de Next.js, React, CRM, LangChain/LangGraph | `eslint.config.js`, `tests/contract/dependency-boundaries.test.ts` |
| Sólo `persistence-postgres` habla con PostgreSQL | ESLint `no-restricted-imports` + allow-list de dependencias |
| `model-gateway` no alcanza estado ni ejecución de capabilities | ESLint + allow-list |
| `agent-kernel` no alcanza PostgreSQL, task/capability runtime, registry, transportes | ESLint + allow-list + `tests/contract/execution-kernel-boundaries.test.ts` |
| `apps/worker` independiente de `apps/api` y de HTTP | `dependency-boundaries.test.ts` |
| Un único call site de handlers de capability (el invoker); sin bypass de writes | `execution-kernel-boundaries.test.ts` |
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
`status (running|completed|failed|cancelled|abandoned)`, `contextSnapshotRef`
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
por composición (`WorkerBindings`).

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
| `agent_tasks.lease_*` (C1) | — | sí (sin `version`) | owner, generation (fencing), expiración en reloj de BD; ADR-007 |
| `agent_run_steps` (C1) | `step_id` | sólo `pending → observed` | una fila por iteración; `unique(run_id, iteration)`, `invocation_id` único, un `pending` por run |

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
  `db.migration.applied`, `db.migrations.completed`. Eventos de C1 en §11.9.
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
| Checkpointing | (C1) Cada iteración es un step durable (`agent_run_steps`); el loop se reconstruye desde ahí. Checkpoints de efectos (writes) son R4-D. |
| Estado en memoria | Sólo configuración reconstruible de forma determinista (capability registry desde código; definiciones desde archivos, verificadas contra la BD). |

## 10. Qué queda fuera (deliberadamente)

Context Compiler, memoria, artifacts, ActionProposal/Receipt, Policy Engine,
scheduler, consultation/approval/handoff, delegación, evaluation runtime,
llamadas LLM reales, autenticación, outbox de eventos, MCP, Sales y cualquier
write. Ver [roadmap](../roadmap/R4_DELIVERY_ROADMAP.md) §4.

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
  cada iteración; futuro input del Context Compiler.
- Un READ recibe su `invocationId` de la plataforma **antes** de ejecutarse
  (step `pending`). La Observation se inserta y liga al step en una sola
  transacción fenced: es la única evidencia del resultado y la siguiente
  iteración la lee de PostgreSQL.
- Sólo `READ` es ejecutable: el kernel rechaza otras clases
  (`capability_not_permitted`) y el invoker también (`execution_not_permitted`).
  El invoker es el único call site de handlers.

### 11.6 Budgets y terminación

Límites = `ExecutionPolicy` del worker (`R4_EXEC_*`) acotada por el budget de la
task; consumo derivado del step log. Chequeo antes de cada llamada al modelo
(duración, iteraciones, llamadas, tokens si la task los declara) y antes de cada
READ.

| Razón | Clase | Run | Task |
|---|---|---|---|
| `completed` | — | completed | completed |
| `model_failure` | model | failed | failed |
| `invalid_decision` | protocol | failed | failed |
| `capability_failure` | capability | failed | failed |
| `budget_exhausted` | budget | failed | failed |
| `internal_failure` | platform | failed | failed |
| `lease_lost` | lease | abandoned | failed |
| `cancelled` | — | cancelled | cancelled |

`code` precisa la causa (`timeout`, `unknown_capability`, `max_model_calls`,
`max_run_recoveries_exceeded`, …); `details` guarda datos estructurados.

### 11.7 Recuperación

| Muerte del worker… | Estado durable | Qué hace el siguiente dueño |
|---|---|---|
| antes/durante el claim | nada, o lease + run `running` sin steps | reanuda y llama al modelo |
| durante la llamada al modelo | steps previos | repite la llamada (sin efectos; uso no registrado) |
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
