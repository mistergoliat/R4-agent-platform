---
title: R4 — Ownership Matrix
status: implemented (R4-B, R4-C1, R4-C2, R4-D) + planned rows
owner: architecture
last_reviewed: 2026-09-23
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
| Resultado incierto | `task-runtime` | Plataforma (declara que no sabe) | `action_executions.status = needs_reconciliation` | Hasta resolución (R4-E+) | run `suspended`, task `blocked` | Nunca se asume éxito ni fallo | `integration/governed-execution-recovery` |

## 2. Planificado (sin implementar; owner candidato)

| Concepto | Fase | Owner candidato | Autoridad |
|---|---|---|---|
| Escritura de working/episodic memory desde el loop | R4-D+ | `agent-kernel` + contracts (decisión nueva) | Cognición (nunca verdad) |
| Fuentes de estado de dominio | R4-F+ | Adapters de dominio vía `ContextSource` | Owner del dominio (AUTHORITATIVE) |
| Decisiones Delegate / Wait / Consult / Approval / Handoff | R4-E+ | `agent-kernel` + contracts | Cognición (propuesta) |
| ApprovalRequest / resolución de `REQUIRE_APPROVAL` | R4-E | `human-collaboration` | Humano (decisión) + plataforma (estado) |
| Reconciliador de ejecuciones `needs_reconciliation`; cancelación cooperativa de efectos en vuelo | R4-E+ | `task-runtime` | Plataforma |
| Verificación de identidad (`identityAssurance = verified`) | con el primer servicio de identidad | servicio de identidad + plataforma | Plataforma |
| Consultation / Approval / Handoff | R4-E | `human-collaboration` | Humano (decisión) + plataforma (estado) |
| Scheduler / wake-ups | R4-E | `scheduler` | Plataforma (despierta; no decide) |
| Artifact | R4-C/E (a decidir) | `artifacts` | Evidencia versionada |
| Outbox / eventos públicos | con primer consumidor | `persistence-postgres` + `observability` | Plataforma |
| Evaluation / Finding / FailureCluster | R4-G | `evaluation` | Plataforma + rúbricas de packs |
| Conceptos Sales (quote, cart, …) | R4-F | `agents/sales` + domain adapters | **Dominio**, nunca Core |
