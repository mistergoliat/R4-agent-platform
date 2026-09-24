---
title: R4 — Ownership Matrix
status: implemented (R4-B … R4-E); R4-F (outside Core, published at 1927499); R4-G (completed, outside Core execution); R4-H Shadow / E2E (IN PROGRESS, outside Core execution) + planned rows
owner: architecture
last_reviewed: 2026-09-24
---

# R4 — Ownership Matrix

Cada primitiva tiene un único owner, una clase de autoridad, un ciclo de vida
definido y una semántica ante reinicio. Si una abstracción nueva no puede llenar
una fila de esta tabla, no entra en Core (PRD §43, Constitución §25.14).

Clases de autoridad:

- **Cognición** — lo decide el agente (modelo); nunca es verdad de negocio.
- **Autoridad de plataforma** — lo decide R4 de forma determinista.
- **Configuración** — declarado por humanos/packs; inmutable una vez registrado.
- **Evidencia** — registro inmutable de lo que ocurrió.
- **Dominio** — verdad de negocio; vive fuera de R4, detrás de capabilities.

## 1. Implementado en R4-B

| Concepto | Owner (paquete) | Autoridad | Almacenamiento | Mutabilidad | Ciclo de vida | Ante reinicio | Evaluación |
|---|---|---|---|---|---|---|---|
| AgentDefinition | `agent-registry` | Configuración | `agent_definitions` | Inmutable por `(agentId, version)`; `contentHash` | registrada → (nueva versión) | Re-sync verifica hash; tasks fijan versión | `unit/agent-registry`, `integration/agent-registry` |
| AgentTask | `task-runtime` | Autoridad de plataforma | `agent_tasks` | Sólo campos de lifecycle; `version` optimista | 8 estados, 3 terminales (ver arquitectura §4.2) | Durable; invariantes en esquema | `unit/task-runtime/lifecycle`, `integration/task-runtime` |
| Transición de task | `task-runtime` | Evidencia | `agent_task_transitions` | Append-only | — | Durable | `integration/task-runtime` |
| Idempotencia de creación | `task-runtime` (+ índice único) | Autoridad de plataforma | `agent_tasks.idempotency_*` | Write-once | — | Persiste entre reinicios | `integration/task-runtime`, `integration/restart-persistence` |
| Budget efectivo | `task-runtime` | Autoridad de plataforma | `agent_tasks.budget` | Write-once | — | Durable | `unit/task-runtime/budget` |
| AgentRun | `task-runtime` | Autoridad de plataforma (estado); cognición (contenido de `result`) | `agent_runs` | `running` → terminal una vez; `termination` estructurada | `running → completed/failed/cancelled/abandoned` (C1) | Run huérfano reanudado por el siguiente dueño (C1) | `integration/task-runtime`, `integration/execution-leases` |
| Goal | `task-runtime` (persistencia) | **Cognición** (contenido); plataforma (integridad) | `goals` | Estado una vez; texto inmutable | `active → achieved/abandoned/superseded` | Durable | `integration/task-runtime` |
| Current goal | `task-runtime` | Cognición (qué foco); plataforma (que sea un goal activo de la misma task) | `agent_tasks.current_goal_id` | Explícito | — | Durable | `integration/task-runtime` |
| CapabilityDefinition | Owner declarado (`owner`), gobernada por `capability-runtime` | Configuración | En memoria (desde código) | Inmutable por `(id, version)` | registrada en boot | Reconstruida deterministamente | `unit/capability-runtime/registry` |
| Autorización por scopes | `capability-runtime` | Autoridad de plataforma | — | — | — | Sin estado | `unit/capability-runtime/invoker` |
| TrustedExecutionContext | Plataforma (quien invoca) | Autoridad de plataforma | Derivado de task/run/definición durables | — | Por invocación | Reconstruible | `integration/capability-observations` |
| Observation | `capability-runtime` (crea), `persistence-postgres` (guarda) | Evidencia | `observations` | Inmutable; única por `invocationId` | — | Durable; replay idempotente | `unit/.../invoker`, `integration/capability-observations` |
| Salida de modelo | Modelo, vía `model-gateway` | **Cognición no confiable** | Nunca en crudo; sólo la `AgentDecision` validada (C1, `agent_run_steps.decision`) | — | — | — | `unit/model-gateway`, `unit/agent-kernel/decision-parser` |
| Selección de proveedor | `model-gateway` | Autoridad de plataforma | Configuración de proceso | — | — | Sin estado | `unit/model-gateway` |
| Correlación | `observability` | Autoridad de plataforma | Columnas `correlation_id` + logs | Write-once | Por request | En filas durables | `unit/observability`, `integration/api` |
| Principal / identidad | `apps/api` (`PrincipalResolver`) | Autoridad de plataforma | `requested_by_*`, `actor_*` | Write-once | Por request | Durable | `integration/api` |
| Esquema de BD | `persistence-postgres` | Autoridad de plataforma | `r4_schema_migrations` | Forward-only; checksums | — | Verificado en boot y `/ready` | `integration/migrations` |

## 1b. Implementado en R4-C1

| Concepto | Owner (paquete) | Autoridad | Almacenamiento | Mutabilidad | Ciclo de vida | Ante reinicio | Evaluación |
|---|---|---|---|---|---|---|---|
| TaskLease (ownership de ejecución) | `task-runtime` (`ExecutionRuntime`) | Autoridad de plataforma | `agent_tasks.lease_*` | Owner/expiración mutables; `generation` sólo crece | claim → renew* → release \| expira | Expira en reloj de BD; otro worker toma el relevo | `unit/task-runtime/execution-lifecycle`, `integration/execution-leases` |
| Fencing token | `task-runtime` | Autoridad de plataforma | `agent_tasks.lease_generation` | Monótono | +1 por claim | Durable | `integration/execution-leases` |
| RunStep (iteración del loop) | `task-runtime` (escribe), `agent-kernel` (propone) | Evidencia (qué se decidió y qué hizo la plataforma) | `agent_run_steps` | Append-only salvo `pending → observed` | `pending → observed`; resto terminal | Base de la reconstrucción del loop | `unit/contracts/...`, `integration/worker-*` |
| AgentDecision | Modelo (propone), `agent-kernel` (valida) | Cognición validada por plataforma | En su step | Inmutable | — | Durable | `unit/agent-kernel/decision-parser` |
| RunTermination | `task-runtime` | Autoridad de plataforma | `agent_runs.termination_*` | Write-once | al terminar el run | Durable | `unit/.../execution-lifecycle`, `integration/worker-kernel` |
| ExecutionContext (contexto mínimo) | `agent-kernel` (`buildExecutionState`) | Autoridad de plataforma (qué se muestra) | Derivado; no se persiste | — | Por iteración | Reconstruido desde estado durable | `unit/agent-kernel/context-and-request` |
| ExecutionPolicy (límites) | `apps/worker` (config) + budget de la task | Configuración | Entorno (`R4_EXEC_*`) | Por proceso | — | Recargada al arrancar; consumo en el step log | `unit/agent-kernel/budget`, `unit/worker/config` |
| Worker | `apps/worker` | Ejecutor (sin autoridad) | Ninguno propio (lease en BD) | — | start → poll/claim/execute → stop (libera lease) | Reemplazable; otro worker reanuda | `integration/worker-*`, `recovery/worker-process-crash` |

## 1c. Implementado en R4-C2

| Concepto | Owner (paquete) | Autoridad | Almacenamiento | Mutabilidad | Ciclo de vida | Ante reinicio | Evaluación |
|---|---|---|---|---|---|---|---|
| ContextItem | Fuente que lo aporta (`platform.*` o externa); compilador (sella `sourceId`) | La declarada y restringida por `kind` (ADR-011) | Derivado; decisión por ítem en `context_snapshot_items` | — | Por compilación | Recompilado desde estado durable | `unit/context-compiler/*` |
| CompiledContext | `context-compiler` | Plataforma (qué ve el modelo y por qué) | `context_snapshots.compiled_context` | Inmutable una vez persistido | Por llamada al modelo | Reutilizado o recompilado (ADR-012) | `unit/context-compiler/compiler`, `integration/context-snapshots` |
| ContextSnapshot | `task-runtime` (`ExecutionRuntime`, fenced) | Evidencia (input exacto de cada llamada) | `context_snapshots` + `context_snapshot_items` | Inmutable (triggers); attempts nuevos lo superseden | antes del modelo → referenciado por el step | Durable; base de la reutilización en recovery | `integration/context-snapshots`, `recovery/worker-process-crash` |
| ContextCompilationPolicy / ContextBudgetPolicy | `apps/worker` (config) + `contextPolicy` del agente (sólo ajusta) | Configuración (presupuesto = decisión empírica; default UNBOUNDED, ADR-015) | Entorno (`R4_CONTEXT_*`) | Por proceso; versión = fingerprint | — | Recargada; un cambio material produce un attempt nuevo | `unit/worker/context-config`, `unit/context-compiler/budget-accounting` |
| ContextComposition (contabilidad) | `context-compiler` (proyección) | Evidencia derivada | No persistida: derivada de `context_snapshot_items` | — | Por snapshot | Recalculable desde persistencia | `unit/context-compiler/budget-accounting`, `integration/context-snapshots` |
| MemoryEntry (WORKING/CONVERSATIONAL/EPISODIC) | Quien la registra (principal resuelto por plataforma); `persistence-postgres` (guarda) | COGNITIVE / CONVERSATIONAL / OBSERVED — nunca AUTHORITATIVE | `memory_entries` | Append-only; supersede; expire una vez | append → (superseded \| expired) | Durable | `unit/context-compiler/contracts`, `integration/context-snapshots`, `integration/restart-persistence`, `recovery/database-restart` |
| DERIVED_SUMMARY | `context-compiler` (produce), `task-runtime` (persiste con el snapshot) | DERIVED — nunca verdad | `memory_entries` (`derivation_key` único por task) | Inmutable; reemplazado por un summary que lo cubre | por presión de presupuesto (sólo FIXED) | Reutilizado sin recompactar | `unit/context-compiler/compaction`, `integration/context-snapshots` |
| Conflicto de contexto | `context-compiler` (detecta) | Plataforma expone; sólo AUTHORITATIVE vigente prevalece | En el `compiled_context` | — | Por compilación | Recompilado | `unit/context-compiler/compiler`, `long-context` |

## 1d. Implementado en R4-D

| Concepto | Owner (paquete) | Autoridad | Almacenamiento | Mutabilidad | Ciclo de vida | Ante reinicio | Evaluación |
|---|---|---|---|---|---|---|---|
| `propose_action` (AgentDecision) | Modelo (propone), `agent-kernel` (valida estructura) | Cognición validada por plataforma | En su step (`agent_run_steps.decision`) | Inmutable | — | Durable | `unit/agent-kernel/kernel-actions`, `contract/governed-execution-boundaries` |
| ActionProposal | `task-runtime` (`ExecutionRuntime.recordStep`) | Evidencia de intención (nunca de ejecución) | `action_proposals` | Inmutable (trigger) | con su step, antes de toda autorización | Base de la recuperación (ventana A) | `integration/governed-execution*` |
| PolicyDecision | `policy-engine` (decide), `task-runtime` (`ActionRuntime`, persiste) | Autoridad de plataforma | `policy_decisions` | Inmutable (trigger) | una por propuesta | Explicable tras cambios de política (id, versión, hash) | `unit/policy-engine`, `integration/governed-execution` |
| ActionPolicyConfiguration | `apps/worker` (binding) + `DEFAULT_ACTION_POLICY` | Configuración | Proceso; identidad en cada decisión | Por versión (hash) | — | Recargada; decisiones pasadas conservan su versión | `unit/policy-engine` |
| TrustedActionContext | `task-runtime` (`ActionRuntime`) desde task/run/agente durables | Autoridad de plataforma | En el comando (`trusted_context`) | Inmutable | por comando | La recuperación ejecuta con el mismo contexto | `integration/governed-execution` (escalamiento) |
| ActionCommand / ActionExecution | `task-runtime` (`ActionRuntime`) | Autoridad de plataforma | `action_executions` | Comando inmutable; `status` por transiciones válidas | `prepared → executing → succeeded \| rejected \| failed`, o `needs_reconciliation` | Mismo comando y misma clave tras crash/takeover | `unit/task-runtime/action-lifecycle`, `integration/governed-execution-recovery` |
| Execution key | `task-runtime` (`executionKeyFor`) | Autoridad de plataforma | `action_executions.execution_key` (único) | Write-once | con el comando | Nunca regenerada | `contract/governed-execution-boundaries`, SIGKILL |
| ActionAttempt | `task-runtime` (escribe), `capability-runtime` (`ActionExecutor`, realiza la llamada) | Evidencia operacional | `action_execution_attempts` | Append-only; outcome una vez | fila antes de la llamada → outcome | Intento sin outcome = desconocido ⇒ replay/reconcile por regla | `integration/governed-execution-recovery` |
| ActionReceipt | `task-runtime` (`ActionRuntime`) | Evidencia (resultado conocido; no verdad de dominio actual) | `action_receipts` | Inmutable (trigger) | uno por ejecución, con la observation | Durable | `integration/governed-execution`, `recovery/governed-write-crash` |
| Observation de acción | `task-runtime` (`ActionRuntime`) | Evidencia (`OBSERVED`) | `observations` (`source_kind = action`) | Inmutable (trigger, también para READ) | con receipt/decisión/rechazo | Llega al siguiente ContextSnapshot | `integration/governed-execution*` |
| Write capability (handlers de escritura) | Owner declarado (dominio / pack), gobernada por `capability-runtime` | Dominio (ejecuta) | En memoria (`registerWrite`) | Inmutable por `(id, version)` | registrada en boot con estrategia | Reconstruida deterministamente | `unit/capability-runtime/action-executor` |
| Budget de writes | `apps/worker` (`R4_EXEC_MAX_WRITE_ACTIONS`, default 0) + `budget.maxWrites` | Configuración | Entorno; consumo = comandos de la task | Por proceso | — | Consumo derivado del ledger | `unit/agent-kernel/kernel-actions`, `integration/governed-execution` |
| Resultado incierto | `task-runtime` | Plataforma (declara que no sabe) | `action_executions.status = needs_reconciliation` | Hasta resolución por reconciliación (R4-E, §1e) | run `suspended`, task `blocked` | Nunca se asume éxito ni fallo | `integration/governed-execution-recovery`, `integration/reconciliation` |

## 1e. Implementado en R4-E (publicado, baseline `74ed8e7`)

| Concepto | Owner (paquete) | Autoridad | Almacenamiento | Mutabilidad | Ciclo de vida | Ante reinicio | Evaluación |
|---|---|---|---|---|---|---|---|
| `wait` / `request_consultation` / `request_handoff` / `manage_goal` (AgentDecision v3) | Modelo (pide), `agent-kernel` (valida), `task-runtime` (`TemporalRuntime`, aplica) | Cognición validada por plataforma | En su step | Inmutable | — | Durable | `contract/temporal-boundaries`, `integration/temporal-waits` |
| TaskWait | `task-runtime` (`TemporalRuntime`) | Autoridad de plataforma | `task_waits` | Una abierta por task; sólo su cierre (status, resolution) | `waiting → completed \| cancelled` con `resolution` | Durable; el wake la cierra en la misma tx | `integration/temporal-waits`, `recovery/temporal-process-crash` |
| Input canónico | `task-runtime` (`TemporalRuntime.submitInput`) | Evidencia (texto CONVERSATIONAL) | `task_inputs` (inmutable) + `memory_entries` | Write-once; idempotente por (task, source, externalKey) | — | Durable | `integration/temporal-waits`, `integration/temporal-api` |
| Schedule (wake, expiry, retry, reconciliation) | `task-runtime` (decide), `apps/scheduler` (reclama y dispara) | Autoridad de plataforma (cuándo; nunca qué) | `schedules` | Lease + generación; transiciones por tipo | `pending → claimed → fired \| cancelled`; reconciliación: `→ dispatched → in_progress → pending \| completed \| exhausted` | Lease expira en `r4_now()`; otro reclama | `integration/temporal-waits`, `integration/reconciliation`, `recovery/temporal-process-crash` |
| Reloj temporal | PostgreSQL (`r4_now()`) | Autoridad de plataforma | Función de 0005 | Sólo redefinible en BD de prueba desechable | — | — | `contract/temporal-boundaries` |
| Política de reconciliación | `apps/scheduler` (config explícita) | Configuración | Estampada en el schedule | Por schedule | — | Durable | `unit/scheduler/config` |
| Trabajo de reconciliación | trigger de 0005 (nace) + `ActionRuntime` (intentos) + worker (`Reconciler`, secuencia) | Plataforma (nunca adivina) | `schedules` + `action_execution_attempts` | Append-only de intentos | nace con `needs_reconciliation` (misma tx) | Lease del schedule; otro worker retoma | `integration/reconciliation`, `recovery/temporal-process-crash` |
| HumanRequest (consultation / approval / handoff) | `task-runtime` (`TemporalRuntime`) | Humano (decisión) + plataforma (estado) | `human_requests` | Sólo transiciones válidas (trigger) | consultation `requested → answered \| cancelled \| expired`; approval `→ approved \| rejected \| cancelled \| expired`; handoff `requested → active → released`, `→ cancelled` | Durable | `integration/human-collaboration` |
| Decisión humana (texto + procedencia) | Humano vía `TrustedHumanContext` | Evidencia (CONVERSATIONAL; nunca AUTHORITATIVE) | `temporal_events` (inmutable) | Idempotente por (request, responseKey) | — | Durable | `integration/human-collaboration`, `integration/temporal-api` |
| TrustedHumanContext | `apps/api` (adapter `humanContext`) | Autoridad de plataforma | No persistido (se registra `humanRef`) | — | Por request | — | `integration/temporal-api`, `contract/temporal-boundaries` |
| Observation de aprobación | `task-runtime` (`ActionRuntime.observeApprovalOutcome`) | Evidencia (`OBSERVED`) | `observations` (`approval_request_id`) | Inmutable | antes de la siguiente cognición | Durable | `integration/human-collaboration` |
| Ownership (agente / humano) | `task-runtime` (proyección) + trigger de 0005 | Autoridad de plataforma | Derivada de `human_requests`, `task_waits`, ledger, intents | — | — | Recalculada | `integration/human-collaboration`, `integration/reconciliation` |
| Intención terminal diferida | `task-runtime` (`transitionTaskWithin`) | Autoridad de plataforma | `task_terminal_intents` (inmutable) | Write-once | aplicada tras la reconciliación | Durable | `integration/reconciliation`, `integration/governed-execution-recovery` |
| Transición de goal | `task-runtime` (`TemporalRuntime`) + trigger | Evidencia | `goal_transitions` (inmutable) | Append-only | created / focused / achieved / abandoned / superseded | Durable | `integration/temporal-waits` |
| Proyección de interacción cross-run | `context-compiler` (`platform.interaction`) | CONVERSATIONAL / OBSERVED | Derivada (no se persiste aparte) | — | Por compilación | Recompilada | `unit/context-compiler/temporal-sources`, `integration/temporal-waits` |

## 1f. R4-F — Sales Reference Application (fuera de Core; publicado, R4-F BASELINE `1927499`)

Ninguna de estas filas es una primitiva de Core: pertenecen al Agent Pack
`agents/sales` o a `adapters/*` (ADR-023, ADR-024).

| Concepto | Owner (paquete) | Autoridad | Almacenamiento | Mutabilidad | Ciclo de vida | Ante reinicio | Evaluación |
|---|---|---|---|---|---|---|---|
| Sales AgentDefinition + instrucciones | `agents/sales` (`sales.agent.json`) | Configuración | `agent_definitions` (vía API) | Inmutable por versión | registrada al arrancar la API | Re-sync con hash | `contract/sales-boundaries`, `integration/agent-registry` |
| Binding conversación → cliente | Ingress Sales (harness / futuro channel adapter) | Plataforma del pack (nunca el modelo) | `sales.conversations` | Write-once (trigger) | al abrir la conversación | Durable | `unit/sales/domain-fixtures`, `integration/sales-reference` |
| SalesWorkspace (hechos declarados, destino, selección) | `agents/sales` (`PostgresSalesStore`) | Pack Sales — AUTHORITATIVE sólo sobre estado Sales; **nunca** verdad de dominio (sin precio/stock/totales) | `sales.workspaces` | Sólo por `sales.workspace.update` gobernado; `version` +1 por comando | vacío (v0) → v1…n | Durable; sobrevive reinicio de worker, esperas y runs nuevas | `unit/sales/workspace-model`, `integration/sales-reference`, `sales/*` |
| Transición del workspace | `agents/sales` | Evidencia (auditoría + idempotencia por execution key) | `sales.workspace_transitions` | Append-only (trigger) | una por comando (applied/rejected) | Durable; replay devuelve la respuesta original | `integration/sales-reference` |
| Proyección del workspace en el contexto | `agents/sales` (`SalesWorkspaceContextSource`) | AUTHORITATIVE (estado Sales) + anotaciones deterministas de evidencia | Derivada; decisión por ítem en `context_snapshot_items` | — | por compilación | Recompilada | `unit/sales/workspace-projection` |
| Precio, stock, specs | Catalog owner (`adapters/domains/catalog`) | **Dominio** | Fuera de R4 (fixture en memoria; live pendiente) | Del owner | — | — | `unit/sales/domain-fixtures` |
| Costo de envío | Shipping owner | **Dominio** | Fuera de R4 | Del owner | — | — | `unit/sales/domain-fixtures` |
| Cliente (perfil, contacto) | Customer owner | **Dominio** (identidad provisional) | Fuera de R4 | Del owner | — | — | `unit/sales/domain-fixtures` |
| Quote (id, número, líneas, totales, validez, documento) | Quote owner | **Dominio** | Fuera de R4; en R4 sólo su receipt | Emitido = inmutable; cambios ⇒ quote nuevo | emitido | Idempotente por execution key | `integration/sales-reference`, `sales/*` (S07, S11–S13, S17) |
| Solicitud de quote (selección + destino enviados) | `agents/sales` (`quote.create`) | Evidencia de lo pedido (sin precios) | `sales.quote_requests` | Write-once por execution key | antes de la primera llamada | Replays y reconciliación la reutilizan | `integration/sales-reference` |
| Referencia de quote | `agents/sales` (desde la respuesta del owner) | Puntero; la verdad es del Quote owner | `sales.quote_references` | Write-once | con el receipt | Durable | `integration/sales-reference` |
| `SALES_ACTION_POLICY` | `agents/sales` | Configuración (identidad en cada PolicyDecision) | Proceso | Por versión (hash) | — | Recargada | `contract/sales-boundaries`, `integration/sales-reference` |
| Configuración de modelo (`R4_MODEL_*`) | Despliegue (proceso del worker) | Configuración (nunca en la AgentDefinition) | Entorno | Por proceso | — | Recargada | `unit/sales/openai-compatible-provider` |
| `OpenAICompatibleModelProvider` | `adapters/models/openai-compatible` | Adapter de proveedor (SPI `ModelProvider`) | Sin estado | — | por llamada | — | `unit/sales/openai-compatible-provider`, `integration/sales-reference` |
| Escenarios S01–S17 + CENTRAL, invariantes, reporte | `agents/sales/src/harness` | Evaluación (semántica, no calidad) | Artifacts locales (`artifacts/`, git-ignored) | — | por ejecución | — | `tests/sales` |

## 1g. R4-G — Quality & Learning (completado; fuera de la ejecución de Core)

**El evaluador no es dueño de la verdad de ejecución.** La trayectoria sigue
perteneciendo a sus owners (tablas de R4 y del pack); Quality sólo la lee y
produce evidencia derivada, versionada y reproducible.

| Concepto | Owner (paquete) | Autoridad | Almacenamiento | Mutabilidad | Ciclo de vida | Ante reinicio | Evaluación |
|---|---|---|---|---|---|---|---|
| Verdad de trayectoria (steps, observations, ledger, goals, esperas, workspace) | Sus owners de siempre (`task-runtime`, `persistence-postgres`, pack) | Autoridad de plataforma / Evidencia | Tablas existentes (sin copia) | Sin cambios | — | Durable | `integration/evaluation-trajectory` (lectura sin escrituras) |
| EvaluationSubject | `@r4/evaluation` (forma), `@r4/evaluator` (lector) | Evidencia derivada (proyección de lectura) | En memoria; copia inmutable opcional en `subject.json` | Congelado para los evaluadores | por evaluación | Reconstruible desde BD | `integration/evaluation-trajectory`, `sales/evaluation-durable` |
| EvaluationRun (TaskOutcome, vector, findings, resultados por evaluador, reproducibilidad) | `@r4/evaluation` (`runEvaluation`) | Evaluación (nunca verdad de ejecución) | Artifacts inmutables (`artifacts/evaluations`) | Inmutable (directorio no se sobrescribe) | por evaluación | Reproducible: subject + definición versionada | `unit/evaluation/*` |
| Finding | Evaluador que lo emite (id@versión) | Determinista: plataforma; semántico: juicio con confianza y rúbrica | `findings.jsonl` | Inmutable; id por contenido | — | Reproducible | `unit/evaluation/taxonomy-and-findings` |
| Taxonomía | `@r4/evaluation` (genérica) + packs (extensión) | Configuración versionada | Código | Sólo adición; nunca redefinición | — | — | `unit/evaluation/taxonomy-and-findings` |
| Salida de evaluador semántico | Juez (modelo) vía `SemanticJudge` | **Juicio no confiable**, validado; nunca anula lo determinista | En el finding (sin razonamiento) | — | — | — | `unit/evaluation/semantic-and-pipeline` |
| Rúbrica | Pack / `@r4/evaluation` (genéricas) | Configuración (id@versión + hash + lock) | Código | Cambio ⇒ nueva versión | — | — | `unit/sales/evaluation/corpus`, `contract/quality-boundaries` |
| RegressionCase | Pack (corpus); propuesto por `regression:promote`; activo sólo con revisión humana | Conocimiento revisado | Código (`agents/sales/src/evaluations/regressions.ts` + lock); propuestas en `artifacts/regression-proposals` | Cambio de expectativas ⇒ nueva versión | proposed → active → retired | — | `unit/evaluation/privacy-regression`, `unit/sales/evaluation/corpus` |
| BenchmarkRun | `@r4/evaluation` (`runBenchmark`) + productor del pack | Evaluación | Artifacts (`artifacts/benchmarks`) con cada repetición | Inmutable | por corrida | Reproducible (fixture/scripted); live registra perfiles | `unit/evaluation/benchmark-experiment`, `unit/sales/evaluation/reference` |
| Experiment | `@r4/evaluation` (`compareBenchmarks`) | Evaluación (deltas; sin ganador) | Artifacts (`artifacts/experiments`) | Inmutable | por comparación | Reproducible | `unit/evaluation/benchmark-experiment` |
| Perfil de modelo (evaluado / juez) | Despliegue (config) → `@r4/evaluation` (fingerprint) | Configuración (sin secretos) | En manifests | — | — | — | `contract/quality-boundaries` (golden) |

## 1h. R4-H — Shadow / E2E (en progreso; fuera de la ejecución de Core)

**Shadow no es dueño de la verdad de ejecución ni de la de evaluación.** La
trayectoria sigue en sus owners (tablas de R4 y del pack); la evaluación sigue
siendo de R4-G. Shadow es dueño de las condiciones de la ejecución (modo,
bindings, corpus) y de la evidencia de sus efectos hacia afuera (ADR-027).

| Concepto | Owner (paquete) | Autoridad | Almacenamiento | Mutabilidad | Ciclo de vida | Ante reinicio | Evaluación |
|---|---|---|---|---|---|---|---|
| Verdad de ejecución (task, runs, steps, observations, ledger D, esperas, goals, workspace) | Sus owners de siempre (`task-runtime`, `persistence-postgres`, pack) | Autoridad de plataforma / Evidencia | Tablas existentes; una BD desechable por ejecución shadow | Sin cambios | — | Durable (el E2E mata procesos reales) | `shadow/shadow-suite`, `recovery/shadow-process` |
| Verdad de evaluación (EvaluationRun, findings, BenchmarkRun) | `@r4/evaluation` (R4-G) | Evaluación | Artifacts bajo `artifacts/shadow/<suite>/{evaluations,benchmark}` | Inmutable | por suite | Reproducible | `unit/shadow/suite-and-model` |
| Modo de ejecución shadow | Despliegue/comando (`R4_EXECUTION_MODE=shadow` / `--execution-mode shadow`) → `@r4/shadow` | Configuración explícita; fail-closed | En cada ShadowRun (fingerprint) | — | por proceso | Se re-declara | `unit/shadow/mode-and-bindings`, `recovery/shadow-process` |
| Domain binding (kind, operaciones con clase de efecto, contrato) | El pack (`agents/sales/src/shadow/bindings.ts`); la implementación declara su `bindingKind` | Configuración declarada; clasificada por `ShadowExecutionPolicy` | Código + fingerprint en cada ShadowRun | Cambio ⇒ nueva versión | — | — | `contract/shadow-boundaries` |
| ShadowExecutionPolicy (dónde se materializa un efecto) | `@r4/shadow` | Autoridad de plataforma (pura); **no autoriza** — eso es R4-D | Código | — | — | — | `unit/shadow/mode-and-bindings` |
| WorkloadCase / corpus | Pack (`agents/sales/src/shadow/corpus.ts` + lock) sobre el esquema de `@r4/shadow` | Configuración versionada (id@versión + fingerprint) | Código | Cambio ⇒ nueva versión (lock) | — | — | `unit/shadow/workload-privacy-cost` |
| ShadowRun (metadata de una ejecución) | `@r4/shadow` (`runShadowSuite`) + `WorkloadExecutor` del pack | Evidencia derivada; **no reemplaza AgentTask** (la referencia) | `workload-results.jsonl` | Inmutable | por ejecución | Reproducible desde corpus + perfiles + SHA | `unit/shadow/suite-and-model` |
| ShadowSuiteRun | `@r4/shadow` | Evaluación/experimento (sin score) | `artifacts/shadow/<suiteRunId>/` | Inmutable (nuevo id por corrida) | por suite | — | `unit/shadow/suite-and-model`, `shadow/shadow-suite` |
| Side-effect manifest + chequeos de seguridad | `@r4/shadow` (`buildSideEffectManifest`, `evaluateShadowSafety`) | Evidencia derivada (guard + ledger + sink); blocker ⇒ stop condition | `side-effects.jsonl` | Inmutable | por ejecución | — | `unit/shadow/manifest-and-safety` |
| ShadowOutbound (lo que se habría enviado) | `ShadowOutboundSink` (`@r4/shadow`), única implementación de `OutboundDelivery` | Evidencia; `actualDelivery = false` por esquema | `outbound.jsonl` (redactado, destinatario seudónimo) | Inmutable | por respuesta | — | `unit/shadow/workload-privacy-cost`, `contract/shadow-boundaries` |
| Quote en shadow | `ShadowQuoteService` (`adapters/domains`) detrás del `QuoteService` port | **Dominio simulado record-only** (nunca emite documento) | En el proceso que lo compone | — | por ejecución | Se pierde con el proceso (el E2E emite sus registros) | `shadow/shadow-suite`, `recovery/shadow-process` |
| ArchitectureGapCandidate | Observadas: `@r4/shadow` (`observeGapCandidates`, conservador); revisadas: persona (`agents/sales/src/shadow/gaps.ts`) | Conocimiento revisado; sólo una entrada revisada y repetida puede ser gap arquitectónico | `architecture-gap-candidates.jsonl` + código | — | — | — | `unit/shadow/workload-privacy-cost` |

## 2. Planificado (sin implementar; owner candidato)

| Concepto | Fase | Owner candidato | Autoridad |
|---|---|---|---|
| Escritura de working/episodic memory desde el loop | R4-G+ (F no la necesitó: el estado Sales estructurado cubre lo durable) | `agent-kernel` + contracts (decisión nueva) | Cognición (nunca verdad) |
| Fuentes de estado de dominio | F: primera (`sales.workspace`, §1f); fuentes de owners reales pendientes | Adapters de dominio / packs vía `ContextSource` | Owner del estado (AUTHORITATIVE) |
| Decisión Delegate | con evidencia (F no la necesitó; sin subagentes) | `agent-kernel` + contracts | Cognición (propuesta) |
| Cancelación cooperativa de efectos en vuelo | con un caso de uso | `task-runtime` + capability | Plataforma |
| Verificación de identidad (`identityAssurance = verified`) e IAM de operadores | con el primer servicio de identidad | servicio de identidad + plataforma | Plataforma |
| Artifact | R4-C/E (a decidir) | `artifacts` | Evidencia versionada |
| Outbox / eventos públicos | con primer consumidor | `persistence-postgres` + `observability` | Plataforma |
| FailureCluster / KnowledgeCandidate / ImprovementProposal | post-H (G implementó Evaluation y Finding, §1g; H sólo observaciones conservadoras, §1h) | `evaluation` | Plataforma + rúbricas de packs |
| Quality Auditor (agente) | cuando haya volumen de evaluación continua | `agents/quality-auditor` sobre la frontera semántica de G | Juicio (nunca autoridad) |
| Adapters live de Customer / Catalog / Shipping / Quote | cuando exista contrato documentado + endpoint + credencial configurados en R4 (H soporta `live-read` en el framework; ninguno disponible, §1h) | `adapters/domains/*` | **Dominio** |
| Adapter de canal (mensajería) y entrega de `respond` | R4-I+ (H sólo registra en `ShadowOutboundSink`, sin entrega) | `adapters/channels/*` | Transporte |
